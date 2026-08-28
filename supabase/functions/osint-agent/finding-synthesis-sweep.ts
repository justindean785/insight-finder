/**
 * finding-synthesis-sweep.ts — the I/O half of finding synthesis.
 *
 * `finding-synthesis.ts` decides WHICH clusters have earned a conclusion and
 * `lib/finding-row.ts` scores them; this module is the only part that touches the
 * database, and it is deliberately thin.
 *
 * ## Why it runs here and not at the end of a run
 *
 * The obvious host — write the findings when the run finalizes — is the one place
 * this must not go. `CLAUDE.md`'s termination invariants and
 * `INCIDENT_2026-07-26_termination-and-ghost-recovery.md` are both about work
 * added inside the finalize window, and the standing rule is that synthesis "must
 * never be able to fail finalize."
 *
 * The health sweep satisfies that structurally rather than by promise: it is a
 * SEPARATE REQUEST from any run, already runs on pg_cron every 60s, and its
 * caller already wraps it in try/catch and reports the outcome as a check. A
 * synthesis failure there degrades to "no findings written this minute" and
 * cannot touch a live run's control flow.
 *
 * It also gets the backfill for free: 175 of 181 threads with artifacts have never
 * produced a conclusion, and they are as eligible as tomorrow's runs.
 *
 * ## Idempotence
 *
 * Two levels, because "the thread has no findings" is too coarse to re-run safely:
 *
 *   1. A MODEL-authored finding (`finding_origin !== 'synthesis'`) takes the whole
 *      thread out of the queue. The model's own conclusion outranks a derived one;
 *      synthesis fills silence, it does not argue with a conclusion that exists.
 *   2. Otherwise the dedup key is **`metadata.synthesis_cluster_id`** — the cluster
 *      the conclusion was drawn from. A re-run skips every cluster already
 *      represented, so sweeping the same thread twice cannot produce a second
 *      finding for the same cluster, and a thread that grows a NEW corroborated
 *      cluster later can still gain a conclusion for it.
 *
 * ## Chain of custody — verified, not assumed
 *
 * Writing a finding does NOT touch `evidence_log`. Verified three ways on
 * 2026-08-28: there is no trigger on `artifacts` (the only artifact-adjacent
 * trigger in the migrations is `update_artifact_reviews_updated_at`, a timestamp
 * trigger on `artifact_reviews`); `evidence_log` is written only through the
 * explicit `append_evidence(...)` RPC, which this module never calls; and
 * `evidence-export/index.ts` selects from `threads` and `evidence_log` ONLY — it
 * never reads the `artifacts` table. So a case exported before synthesis
 * re-exports identically after it, and the tamper-evident chain is untouched.
 *
 * ## Gating
 *
 * Ships DARK. Both switches default OFF and are independent, so the forward path
 * can be enabled without the backfill and either can be revoked alone:
 *
 *   FINDING_SYNTHESIS_ENABLED           forward path (recently-finished threads)
 *   FINDING_SYNTHESIS_BACKFILL_ENABLED  historical threads — a production write
 *                                       into closed cases, so it is separate
 *   FINDING_SYNTHESIS_DRY_RUN           compute and REPORT, write nothing
 *
 * Backfill is a write into 175 closed cases. `dryRun` exists so that distribution
 * can be measured — how many threads yield 0 / 1 / 2+ findings — before any row
 * lands.
 */
import { synthesizeFindings, type PersistedArtifact } from "./finding-synthesis.ts";
import { buildFindingRow } from "./lib/finding-row.ts";
/**
 * The MINIMUM this sweep needs from a Supabase client, declared structurally.
 *
 * Deliberately not `ReturnType<typeof createClient>`: the generated Database
 * generic makes the concrete client type incompatible across call sites (the
 * same mismatch `recoverStaleActiveThreads(admin, …)` already reports at
 * health-handler.ts), so importing it would have added a second copy of a known
 * error rather than typing anything usefully. A structural type says exactly
 * which four calls this module makes, which is the useful information, and it
 * accepts any client that can serve them.
 */
/** What a PostgREST call resolves to, for the three shapes this module issues. */
interface PgResult {
  data?: unknown;
  error?: { message?: string } | null;
  count?: number | null;
}

/** A PostgREST query builder: chainable, and awaitable at any point. */
interface PgQuery extends PromiseLike<PgResult> {
  select(cols?: string, opts?: { count?: string; head?: boolean }): PgQuery;
  eq(col: string, val: unknown): PgQuery;
  gte(col: string, val: unknown): PgQuery;
  lt(col: string, val: unknown): PgQuery;
  order(col: string, opts?: { ascending?: boolean }): PgQuery;
  limit(n: number): PgQuery;
  insert(rows: Record<string, unknown>[]): PromiseLike<PgResult>;
}

interface DbClient {
  from(table: string): PgQuery;
}

export interface SynthesisSweepResult {
  threadsScanned: number;
  threadsWithFindings: number;
  /** Rows actually inserted. Always 0 in a dry run. */
  findingsWritten: number;
  /** Rows that WOULD be inserted. Equals findingsWritten outside a dry run. */
  findingsProposed: number;
  /** Distribution of proposals per scanned thread: how many yielded 0, 1, 2+. */
  distribution: { zero: number; one: number; twoPlus: number };
  dryRun: boolean;
  errors: number;
}

export interface SynthesisSweepOptions {
  limit?: number;
  maxFindingsPerThread?: number;
  /** Compute and report; write nothing. */
  dryRun?: boolean;
  /**
   * `forward` — threads finished inside FORWARD_WINDOW_HOURS (the ordinary path).
   * `backfill` — threads older than that (closed cases; separately gated).
   */
  scope?: "forward" | "backfill";
}

/** A finished thread is "forward" for this long after its last update. */
export const FORWARD_WINDOW_HOURS = 24;

function envFlag(name: string): boolean {
  const env = (globalThis as { Deno?: { env?: { get?(k: string): string | undefined } } }).Deno?.env;
  const v = env?.get?.(name);
  return v === "true" || v === "1";
}

/** Whether either path is switched on. Both default OFF — this ships dark. */
export function synthesisEnabled(scope: "forward" | "backfill"): boolean {
  return scope === "forward"
    ? envFlag("FINDING_SYNTHESIS_ENABLED")
    : envFlag("FINDING_SYNTHESIS_BACKFILL_ENABLED");
}

export function synthesisDryRun(): boolean {
  return envFlag("FINDING_SYNTHESIS_DRY_RUN");
}

/** Artifact columns the synthesizer and the scorer between them need. */
const ARTIFACT_COLUMNS = "id,kind,value,source,confidence,metadata,created_at";

/**
 * Rows per thread. Above this the thread is skipped rather than partially read:
 * a truncated artifact set would silently change which clusters clear the bar,
 * and a wrong finding is worse than a missing one. 22 threads exceed 100
 * artifacts in production and the largest holds 351, so 1000 clears the corpus
 * with room to spare.
 */
export const MAX_ARTIFACTS_PER_THREAD = 1000;

/**
 * Synthesize findings for finished threads that have none.
 *
 * Best-effort by contract. Every failure is counted and swallowed: this runs on a
 * health probe whose job is to report, and a thread that fails today is still a
 * candidate on the next sweep.
 */
export async function synthesizeMissingFindings(
  // Accepted as `unknown` and narrowed on the next line, deliberately. The
  // concrete supabase-js client type differs between call sites once the
  // generated Database generic is involved — that mismatch is what
  // `recoverStaleActiveThreads(admin, …)` already reports at health-handler.ts —
  // so demanding the nominal type here would import a known error rather than
  // add safety. `DbClient` above still documents exactly which calls are made.
  dbLike: unknown,
  opts?: SynthesisSweepOptions,
): Promise<SynthesisSweepResult> {
  const db = dbLike as DbClient;
  const limit = opts?.limit ?? 5;
  const scope = opts?.scope ?? "forward";
  const dryRun = opts?.dryRun ?? false;
  const out: SynthesisSweepResult = {
    threadsScanned: 0,
    threadsWithFindings: 0,
    findingsWritten: 0,
    findingsProposed: 0,
    distribution: { zero: 0, one: 0, twoPlus: 0 },
    dryRun,
    errors: 0,
  };

  const cutoff = new Date(Date.now() - FORWARD_WINDOW_HOURS * 3600_000).toISOString();
  let q = db.from("threads").select("id,user_id,updated_at").eq("status", "finished");
  // The scope split is what keeps a write into 175 CLOSED cases behind its own
  // switch. `forward` can be enabled alone and is the ordinary path.
  q = scope === "forward" ? q.gte("updated_at", cutoff) : q.lt("updated_at", cutoff);
  const { data: threads, error: threadErr } = await q
    .order("updated_at", { ascending: false })
    .limit(limit * 4);
  if (threadErr || !Array.isArray(threads)) {
    return { ...out, errors: 1 };
  }

  for (const t of threads) {
    if (out.threadsScanned >= limit) break;
    const threadId = (t as { id?: unknown })?.id;
    const userId = (t as { user_id?: unknown })?.user_id;
    if (typeof threadId !== "string" || typeof userId !== "string") continue;

    try {
      // Existing findings, with their metadata — the dedup key lives in there.
      const { data: existing, error: eErr } = await db
        .from("artifacts")
        .select("id,metadata")
        .eq("thread_id", threadId)
        .eq("kind", "finding");
      if (eErr) { out.errors++; continue; }

      const priors = Array.isArray(existing) ? existing : [];
      // A model-authored conclusion takes the thread out of the queue entirely.
      const hasModelFinding = priors.some((p) => {
        const m = ((p as { metadata?: unknown })?.metadata ?? {}) as Record<string, unknown>;
        return m.finding_origin !== "synthesis";
      });
      if (hasModelFinding) continue;

      // THE DEDUP KEY: clusters already represented by a synthesized finding.
      const seenClusters = new Set<string>();
      for (const p of priors) {
        const m = ((p as { metadata?: unknown })?.metadata ?? {}) as Record<string, unknown>;
        const cid = m.synthesis_cluster_id;
        if (typeof cid === "string" && cid) seenClusters.add(cid);
      }

      out.threadsScanned++;

      const { data: rows, error: aErr } = await db
        .from("artifacts")
        .select(ARTIFACT_COLUMNS)
        .eq("thread_id", threadId)
        .limit(MAX_ARTIFACTS_PER_THREAD + 1);
      if (aErr || !Array.isArray(rows)) { out.errors++; continue; }
      // Truncation would change the answer silently — decline instead.
      if (rows.length > MAX_ARTIFACTS_PER_THREAD) { out.distribution.zero++; continue; }

      const candidates = synthesizeFindings(rows as PersistedArtifact[], {
        maxFindings: opts?.maxFindingsPerThread ?? 3,
      }).filter((c) => !seenClusters.has(c.clusterId));

      const n = candidates.length;
      if (n === 0) out.distribution.zero++;
      else if (n === 1) out.distribution.one++;
      else out.distribution.twoPlus++;
      if (n === 0) continue;
      out.findingsProposed += n;

      // `contraRows` is the SAME thread set record_finding fetches, so the
      // contradiction scoping is identical on both paths.
      const contraRows = rows as unknown as Parameters<typeof buildFindingRow>[1]["contraRows"];

      const toInsert: Record<string, unknown>[] = [];
      for (const c of candidates) {
        const { row } = buildFindingRow(c.input, { threadId, userId, contraRows });
        const meta = (row.metadata ?? {}) as Record<string, unknown>;
        toInsert.push({
          ...row,
          metadata: {
            ...meta,
            // Provenance. An analyst must be able to tell a DERIVED conclusion
            // from one a model asserted — they carry the same engine number but
            // not the same origin, and conflating them would make the engine
            // look like it had adjudicated something a human never saw.
            finding_origin: "synthesis",
            // ALSO the idempotence key — see Idempotence in the header.
            synthesis_cluster_id: c.clusterId,
            synthesis_independent_classes: c.independentClasses,
            synthesis_scope: scope,
            supporting_artifact_ids: c.supportingArtifactIds.slice(0, 200),
          },
        });
      }

      // A dry run stops HERE, having computed everything and written nothing.
      if (dryRun) { out.threadsWithFindings++; continue; }

      const { error: insErr } = await db.from("artifacts").insert(toInsert);
      if (insErr) { out.errors++; continue; }
      out.threadsWithFindings++;
      out.findingsWritten += toInsert.length;
    } catch {
      out.errors++;
    }
  }

  return out;
}
