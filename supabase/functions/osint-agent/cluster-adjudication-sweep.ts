/**
 * cluster-adjudication-sweep.ts — the I/O half of the Claude cluster adjudicator.
 *
 * `lib/cluster-adjudication.ts` decides which contradicted clusters are worth a
 * question and checks the answer; this module reads the threads, makes the one
 * model call per cluster, and writes an ADVISORY row to
 * `public.cluster_adjudications` (migration 20261102120000).
 *
 * ## Authority
 *
 * The only table this module writes is `cluster_adjudications`. It never writes
 * `artifacts`, and nothing here touches a confidence, a cap, a tier, a quarantine
 * flag, `linkage_confirmed` or `subject_unlinked`. The analyst's review overrides
 * a verdict on every surface. `cluster_adjudication_sweep_test.ts` records every
 * table and write verb the sweep uses and asserts exactly that set.
 *
 * ## Why it runs here
 *
 * Same reasoning as `finding-synthesis-sweep.ts`: the health sweep is a SEPARATE
 * REQUEST from any run, fired by pg_cron every 60s, wrapped in a try/catch whose
 * outcome is reported as a check. It cannot reach a live run's finalize window.
 *
 * ## What is different from synthesis: every unit of work COSTS money
 *
 *   - IDEMPOTENCE is read BEFORE the call, not only enforced on insert. The
 *     `(thread_id, cluster_id, input_hash)` key is looked up first; an unchanged
 *     cluster is never sent twice. An unreadable lookup skips the thread — a blind
 *     call is a repeat bill.
 *   - DRY RUN makes NO model call. A dry run writes no row, so nothing would ever
 *     mark a cluster answered and the same clusters would be re-billed each minute.
 *     It reports what is QUEUED instead.
 *   - A per-sweep CALL CAP (default 3, hard ceiling 10) and a wall-clock DEADLINE
 *     (25s, well under the 60s cron) stop new calls. The cron has no lease, so an
 *     overrunning sweep is overlapped by the next one, and unlike synthesis the
 *     loser of that race has already paid. A duplicate-key insert (23505) therefore
 *     counts as SUCCESS: the verdict exists.
 *   - A reply that is not a clean verdict is counted and LOGGED
 *     (`cluster_adjudication_unparseable`) and never stored. Storing it as
 *     `insufficient` would dress a refusal as a result. Ceiling on a cluster that
 *     persistently fails to parse: one small call per minute until the 24h forward
 *     window ages it out. A durable failure marker would be a schema change.
 *   - One structured log line per call carries the token usage, because dry-run
 *     cannot show what enabling costs.
 *
 * ## Gating — ships DARK
 *
 *   CLUSTER_ADJUDICATION_ENABLED     default OFF
 *   CLUSTER_ADJUDICATION_DRY_RUN     compute and report the queue; call nothing
 *   CLUSTER_ADJUDICATION_MAX_CALLS   default 3, clamped to 1..10
 *   CLUSTER_ADJUDICATION_MODEL       default claude-sonnet-5-5
 *
 * Read at CALL TIME, so flipping a secret takes effect without a deploy.
 *
 * ## Known gap
 *
 * `lib/cluster.ts` joins a contradicted cluster by EMAIL (and the marker row
 * itself). A contradiction about a Discord id or a username becomes a cluster of
 * one marker and no evidence, and is counted as `undersize`, not adjudicated.
 */
import { FORWARD_WINDOW_HOURS } from "./finding-synthesis-sweep.ts";
import {
  ADJUDICATION_PROMPT_VERSION,
  adjudicationInputHash,
  buildAdjudicationPrompt,
  parseAdjudication,
  selectAdjudicationCandidates,
  type AdjudicationCandidate,
} from "./lib/cluster-adjudication.ts";
import { dropRejectedArtifacts, loadReviewsForThread, type ReviewDb } from "./reviews.ts";

export const DEFAULT_ADJUDICATION_MODEL = "claude-sonnet-5-5";
const DEFAULT_MAX_CALLS = 3;
const HARD_MAX_CALLS = 10;
const DEFAULT_DEADLINE_MS = 25_000;
const CALL_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_TOKENS = 400;
const THREADS_PER_SWEEP = 5;
/** Same rule as synthesis: a truncated read would change which clusters exist. */
const MAX_ARTIFACTS_PER_THREAD = 1000;
const ARTIFACT_COLUMNS = "id,kind,value,source,confidence,metadata,created_at";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

function envRaw(name: string): string | undefined {
  const env = (globalThis as { Deno?: { env?: { get?(k: string): string | undefined } } }).Deno?.env;
  try { return env?.get?.(name); } catch { return undefined; }
}
function envFlag(name: string): boolean {
  const v = envRaw(name);
  return v === "true" || v === "1";
}

export function clusterAdjudicationEnabled(): boolean { return envFlag("CLUSTER_ADJUDICATION_ENABLED"); }
export function clusterAdjudicationDryRun(): boolean { return envFlag("CLUSTER_ADJUDICATION_DRY_RUN"); }
export function clusterAdjudicationModel(): string {
  return (envRaw("CLUSTER_ADJUDICATION_MODEL") ?? "").trim() || DEFAULT_ADJUDICATION_MODEL;
}
/** A typo in a secret must not be able to unbound the spend. */
export function clusterAdjudicationMaxCalls(): number {
  const n = Number.parseInt(envRaw("CLUSTER_ADJUDICATION_MAX_CALLS") ?? "", 10);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_CALLS;
  return Math.min(n, HARD_MAX_CALLS);
}

// ---- Structural DB type (same reasoning as finding-synthesis-sweep.ts) ----------

interface PgResult {
  data?: unknown;
  error?: { message?: string; code?: string } | null;
}
interface PgQuery extends PromiseLike<PgResult> {
  select(cols?: string): PgQuery;
  eq(col: string, val: unknown): PgQuery;
  gte(col: string, val: unknown): PgQuery;
  order(col: string, opts?: { ascending?: boolean }): PgQuery;
  limit(n: number): PgQuery;
  insert(row: Record<string, unknown>): PromiseLike<PgResult>;
}
interface DbClient { from(table: string): PgQuery }

export interface AdjudicationSweepOptions {
  apiKey: string;
  model?: string;
  dryRun?: boolean;
  maxCalls?: number;
  deadlineMs?: number;
  threadLimit?: number;
  /** Injected for tests. */
  fetchFn?: typeof fetch;
  now?: () => number;
}

export interface AdjudicationSweepResult {
  threadsScanned: number;
  /** Contradicted clusters that still need an answer (or would, in a dry run). */
  queued: number;
  alreadyAdjudicated: number;
  /** Model calls actually made. Always 0 in a dry run. */
  calls: number;
  written: number;
  /** Another sweep answered the same cluster first (unique-key hit). */
  duplicates: number;
  unparseable: number;
  undersize: number;
  oversize: number;
  deadlineHit: boolean;
  inputTokens: number;
  outputTokens: number;
  dryRun: boolean;
  errors: number;
}

function emptyResult(dryRun: boolean): AdjudicationSweepResult {
  return {
    threadsScanned: 0, queued: 0, alreadyAdjudicated: 0, calls: 0, written: 0, duplicates: 0,
    unparseable: 0, undersize: 0, oversize: 0, deadlineHit: false, inputTokens: 0, outputTokens: 0,
    dryRun, errors: 0,
  };
}

interface ModelAnswer { text: string; inputTokens: number; outputTokens: number }

async function askModel(
  c: AdjudicationCandidate,
  o: { apiKey: string; model: string; fetchFn: typeof fetch },
): Promise<ModelAnswer> {
  const { system, user } = buildAdjudicationPrompt(c);
  const res = await o.fetchFn(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": o.apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: o.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      messages: [{ role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`anthropic http ${res.status}`);
  const body = await res.json() as {
    content?: Array<{ type?: string; text?: string }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  const text = (body.content ?? []).filter((b) => b?.type === "text").map((b) => b.text ?? "").join("");
  return { text, inputTokens: Number(body.usage?.input_tokens) || 0, outputTokens: Number(body.usage?.output_tokens) || 0 };
}

/**
 * Adjudicate contradicted clusters on recently finished threads.
 *
 * Best-effort by contract: every failure is counted and swallowed. This runs on a
 * health probe whose job is to report.
 */
export async function adjudicateContradictedClusters(
  dbLike: unknown,
  opts: AdjudicationSweepOptions,
): Promise<AdjudicationSweepResult> {
  const db = dbLike as DbClient;
  const dryRun = opts.dryRun ?? false;
  const maxCalls = Math.min(Math.max(1, opts.maxCalls ?? DEFAULT_MAX_CALLS), HARD_MAX_CALLS);
  const deadlineMs = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const now = opts.now ?? Date.now;
  const fetchFn = opts.fetchFn ?? fetch;
  const model = opts.model ?? DEFAULT_ADJUDICATION_MODEL;
  const threadLimit = opts.threadLimit ?? THREADS_PER_SWEEP;
  const startedAt = now();
  const out = emptyResult(dryRun);

  const cutoff = new Date(Date.now() - FORWARD_WINDOW_HOURS * 3600_000).toISOString();
  const { data: threads, error: threadErr } = await db
    .from("threads").select("id,user_id,updated_at")
    .eq("status", "finished").gte("updated_at", cutoff)
    .order("updated_at", { ascending: false }).limit(threadLimit * 4);
  if (threadErr || !Array.isArray(threads)) return { ...out, errors: 1 };

  for (const t of threads) {
    if (out.threadsScanned >= threadLimit) break;
    if (out.deadlineHit || out.calls >= maxCalls) break;
    const threadId = (t as { id?: unknown })?.id;
    const userId = (t as { user_id?: unknown })?.user_id;
    if (typeof threadId !== "string" || typeof userId !== "string") continue;

    try {
      // ⛔ ANALYST REJECTION, FAIL-CLOSED — same rule as synthesis and clustering:
      // "could not read the verdicts" is not "nothing rejected".
      const reviews = await loadReviewsForThread(db as unknown as ReviewDb, threadId, userId);
      if (!reviews.ok) {
        console.warn(JSON.stringify({
          event: "cluster_adjudication_skipped_review_state_unavailable", thread_id: threadId, error: reviews.error,
        }));
        out.errors++;
        continue;
      }

      const { data: rows, error: aErr } = await db
        .from("artifacts").select(ARTIFACT_COLUMNS)
        .eq("thread_id", threadId).limit(MAX_ARTIFACTS_PER_THREAD + 1);
      if (aErr || !Array.isArray(rows)) { out.errors++; continue; }
      if (rows.length > MAX_ARTIFACTS_PER_THREAD) continue; // truncation would change the clusters

      const admissible = dropRejectedArtifacts(rows as Array<Record<string, unknown>>, reviews);
      const sel = selectAdjudicationCandidates(admissible);
      out.undersize += sel.undersize;
      out.oversize += sel.oversize;
      if (sel.candidates.length === 0) { out.threadsScanned++; continue; }
      out.threadsScanned++;

      // Idempotence is read BEFORE the call. Unreadable → skip: a blind call is a repeat bill.
      const { data: prior, error: pErr } = await db
        .from("cluster_adjudications").select("cluster_id,input_hash").eq("thread_id", threadId);
      if (pErr || !Array.isArray(prior)) { out.errors++; continue; }
      const answered = new Set(
        prior.map((p) => `${(p as { cluster_id?: string }).cluster_id}|${(p as { input_hash?: string }).input_hash}`),
      );

      for (const c of sel.candidates) {
        const hash = await adjudicationInputHash(c);
        if (answered.has(`${c.clusterId}|${hash}`)) { out.alreadyAdjudicated++; continue; }
        out.queued++;
        // A dry run measures the queue and stops: it has no row to make the answer durable.
        if (dryRun) continue;
        if (out.calls >= maxCalls) continue;
        if (now() - startedAt >= deadlineMs) { out.deadlineHit = true; continue; }

        out.calls++;
        let answer: ModelAnswer;
        try {
          answer = await askModel(c, { apiKey: opts.apiKey, model, fetchFn });
        } catch (e) {
          out.errors++;
          console.warn(JSON.stringify({
            event: "cluster_adjudication_call_failed", thread_id: threadId, cluster_id: c.clusterId,
            error: String(e).slice(0, 160),
          }));
          continue;
        }
        out.inputTokens += answer.inputTokens;
        out.outputTokens += answer.outputTokens;
        console.log(JSON.stringify({
          event: "cluster_adjudication_call", thread_id: threadId, cluster_id: c.clusterId, model,
          input_tokens: answer.inputTokens, output_tokens: answer.outputTokens,
        }));

        const parsed = parseAdjudication(answer.text);
        if (!parsed.ok) {
          out.unparseable++;
          console.warn(JSON.stringify({
            event: "cluster_adjudication_unparseable", thread_id: threadId, cluster_id: c.clusterId,
            input_hash: hash, reason: parsed.reason,
          }));
          continue;
        }

        const { error: insErr } = await db.from("cluster_adjudications").insert({
          thread_id: threadId,
          user_id: userId,
          cluster_id: c.clusterId,
          input_hash: hash,
          verdict: parsed.verdict,
          probability: parsed.probability,
          rationale: parsed.rationale,
          member_artifact_ids: [...c.context, ...c.evidence].map((m) => m.id),
          model,
          prompt_version: ADJUDICATION_PROMPT_VERSION,
        });
        if (!insErr) { out.written++; continue; }
        // Another sweep answered this cluster first: the verdict exists. Success.
        if (insErr.code === "23505") { out.duplicates++; continue; }
        out.errors++;
      }
    } catch {
      out.errors++;
    }
  }
  return out;
}

/** One-line summary for `checks.cluster_adjudication`. */
export function describeAdjudication(r: AdjudicationSweepResult): string {
  const head = r.dryRun
    ? `DRY RUN — no model call, nothing written; ${r.queued} cluster(s) queued`
    : `${r.written} written, ${r.calls} call(s), ${r.queued} queued`;
  const bits = [
    `over ${r.threadsScanned} thread(s)`,
    `${r.alreadyAdjudicated} already answered`,
    r.duplicates ? `${r.duplicates} duplicate` : "",
    r.unparseable ? `${r.unparseable} unparseable` : "",
    r.undersize ? `${r.undersize} undersize (no evidence records beyond the marker)` : "",
    r.oversize ? `${r.oversize} oversize` : "",
    r.deadlineHit ? "deadline hit" : "",
    r.calls ? `tokens ${r.inputTokens} in / ${r.outputTokens} out` : "",
  ].filter(Boolean);
  return `${head}; ${bits.join("; ")}`;
}
