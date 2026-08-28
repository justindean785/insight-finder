/**
 * finding-synthesis.ts — derive analyst findings from artifacts already persisted.
 *
 * ## Why this exists
 *
 * Measured in production 2026-08-28: **9,615 artifacts across 181 threads and 13
 * `kind='finding'` rows in the product's entire lifetime**, the last written
 * 2026-08-17. Only 6 of 181 threads with artifacts ever produced a single analyst
 * conclusion. Meanwhile 0 of 9,615 rows exceed their own `confidence_cap_applied`
 * — the write-side scorer is exact end to end.
 *
 * So the integrity engine is correct and almost never invoked. `workflow_prompt.ts`
 * draws the right distinction ("an artifact is a collected data point… a finding is
 * an analyst conclusion supported by >=1 artifact") and then makes calling
 * `record_finding` **advisory**: it "may run whenever source-backed evidence
 * exists." The model almost never does, so 96.7% of investigations end with zero
 * conclusions and the analyst gets a data dump.
 *
 * This module closes that gap deterministically: findings are DERIVED from rows
 * that already exist, not requested from a model that may or may not comply.
 *
 * ## What it is not
 *
 * - **Not a second scorer.** Candidate selection happens here; every number comes
 *   from `buildFindingRow` (lib/finding-row.ts), which is `record_finding`'s own
 *   chain moved verbatim. This module decides only WHICH clusters are eligible and
 *   what the conclusion sentence says.
 * - **Not a volume test.** A cluster with forty artifacts from one source class
 *   yields nothing. The bar is >=2 INDEPENDENT source classes
 *   (`countIndependentClasses`, which subtracts `NON_CORROBORATING_CLASSES`:
 *   unknown, web_search, ai_summary, username_sweep, social_profile_passive,
 *   social_review, infra_shared_host, threat_intel). Two mirrors of one leak are
 *   one class and do not clear it — pinned by test.
 * - **Not a quarantine bypass.** `clusterArtifacts` already refuses to let an
 *   `isExcluded` row bridge subjects; this module additionally drops those rows
 *   before clustering so they cannot contribute a source class to the bar. A
 *   quarantined row stays in the artifact table with its reason — withheld from
 *   authority, not hidden.
 * - **Not in the finalize path.** It performs no I/O and is invoked from the
 *   health sweep, a separate request from any run. It cannot fail finalize and it
 *   adds nothing to the finalize reserve window, which owns this project's worst
 *   incidents (INCIDENT_2026-07-26).
 *
 * ## The empty result is the common case
 *
 * On the measured corpus most threads will synthesize zero or one finding. That is
 * the correct outcome, not a failure: "no conclusion met the corroboration bar" is
 * a true statement about thin evidence, and the read side (`authoritative-findings.ts`)
 * already renders it. Returning [] must always be cheap and silent.
 */
import { clusterArtifacts, isExcluded, type Artifact as ClusterArtifact } from "./lib/cluster.ts";
import { classifySource, countIndependentClasses } from "./source-classification.ts";
import type { FindingScoringInput } from "./lib/finding-row.ts";

/** A persisted artifact row, as selected from the `artifacts` table. */
export interface PersistedArtifact {
  id?: string | null;
  kind?: unknown;
  value?: unknown;
  source?: unknown;
  confidence?: unknown;
  metadata?: unknown;
  created_at?: unknown;
}

/** One synthesized candidate: the scorer's input plus the provenance to attach. */
export interface SynthesizedFinding {
  input: FindingScoringInput;
  /** DB ids of the artifacts this conclusion rests on. Persisted as provenance. */
  supportingArtifactIds: string[];
  /** The cluster this came from, for disclosure. */
  clusterId: string;
  /** Independent source classes actually counted — the reason it cleared the bar. */
  independentClasses: number;
}

/**
 * The corroboration bar. Two independent source classes, matching the
 * `[CONFIRMED]` contract in system-prompt.ts and the `>=2 EFFECTIVE sources`
 * rule that mirrors of one leak deliberately fail.
 */
export const MIN_INDEPENDENT_CLASSES = 2;

/** Kinds that are bookkeeping, not evidence about the subject. */
const META_KINDS = new Set([
  "finding", "triage_decision", "cluster_decision", "coverage_audit",
  "collision_detector", "summary", "note",
]);

/** Kinds whose presence signals a ruled-out or unproven identity. */
const INELIGIBLE_KINDS = new Set([
  "excluded_collision", "possible_collision", "weak_lead", "contradiction",
]);

function str(v: unknown): string {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Rows this module will reason about.
 *
 * Deliberately conservative — every exclusion below removes a row from BOTH the
 * conclusion and the source-class count, so a dropped row can only ever make a
 * finding harder to reach, never easier. That direction is the safe one: the cost
 * of dropping a good row is a missing conclusion the analyst can still see the
 * evidence for; the cost of admitting a bad one is a false conclusion carrying
 * engine authority.
 */
export function eligibleArtifacts(rows: readonly PersistedArtifact[]): ClusterArtifact[] {
  const out: ClusterArtifact[] = [];
  for (const r of rows) {
    const kind = str(r.kind).trim().toLowerCase();
    if (!kind || META_KINDS.has(kind) || INELIGIBLE_KINDS.has(kind)) continue;
    const value = str(r.value).trim();
    if (!value) continue;
    // metaRaw is the stringified metadata: lib/cluster.ts's extractors regex over
    // it rather than parsing, so both a JSON string and an object round-trip here.
    const metaRaw = typeof r.metadata === "string" ? r.metadata : JSON.stringify(r.metadata ?? {});
    const a: ClusterArtifact = {
      id: r.id ?? undefined,
      created_at: str(r.created_at) || undefined,
      kind,
      value,
      source: str(r.source),
      confidence: num(r.confidence),
      metaRaw,
    };
    // The quarantine boundary. isExcluded covers excluded_collision, an explicit
    // `status: excluded`, and subject_unlinked — the last being the 405 rows (20%
    // of a week's collection) whose linkage to the subject is unproven.
    if (isExcluded(a)) continue;
    out.push(a);
  }
  return out;
}

/**
 * The source classes backing an artifact — PERSISTED first, recomputed only as a
 * fallback.
 *
 * `metadata.source_category` is written by the integrity layer at record time and
 * is the field every other consumer keys on (intel.ts, evidence-status.ts,
 * report-badges.ts, audit/from-artifacts.ts, AnalysisTab.tsx). Recomputing
 * `classifySource(row.source)` here is measurably WRONG: on the live argusint.net
 * run of 2026-08-28, `argus-intelligence.io` carries
 * `source: "minimax_web_search"` but `metadata.sources:
 * ["minimax_web_search","whois_lookup"]`, so the write path correctly classified
 * it `infra_registry` while a recomputation from the single `source` column gives
 * `ai_summary`. 1 of 18 rows in that run disagreed.
 *
 * Falls back to classifying the `source` string when the marker is absent or
 * unusable, which is what the 9,000+ rows written before `source_category` need.
 */
function classesFor(r: PersistedArtifact): string[] {
  const meta = (r.metadata ?? {}) as Record<string, unknown>;
  const persisted = meta.source_category;
  if (Array.isArray(persisted)) {
    const out = persisted.filter((c): c is string => typeof c === "string" && c.length > 0);
    if (out.length > 0) return out;
  }
  const src = str(r.source).trim();
  return src ? [classifySource(src)] : [];
}

/** Distinct tool/source labels backing a set of artifacts, order-stable. */
function distinctSources(members: readonly ClusterArtifact[]): string[] {
  const seen = new Set<string>();
  for (const m of members) {
    const s = m.source.trim();
    if (s) seen.add(s);
  }
  return [...seen].sort();
}

/**
 * A short, factual conclusion sentence.
 *
 * Deliberately mechanical. This is a DERIVED row, so its text must be something
 * the data supports literally — a count of corroborated selectors and what they
 * are. Anything more interpretive would be exactly the model prose this whole
 * change exists to stop treating as authority.
 */
function conclusionFor(members: readonly ClusterArtifact[], classes: number): string {
  const byKind = new Map<string, string[]>();
  for (const m of members) {
    const list = byKind.get(m.kind) ?? [];
    if (list.length < 3) list.push(m.value);
    byKind.set(m.kind, list);
  }
  const parts = [...byKind.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([kind, vals]) => `${kind}: ${vals.join(", ")}`);
  return `Corroborated identity cluster — ${members.length} artifact(s) across ` +
    `${classes} independent source classes. ${parts.join("; ")}`.slice(0, 500);
}

/**
 * Derive findings from persisted artifacts.
 *
 * Returns [] whenever nothing clears the bar, which on the measured corpus is the
 * majority of threads.
 */
export function synthesizeFindings(
  rows: readonly PersistedArtifact[],
  opts?: { maxFindings?: number; minIndependentClasses?: number },
): SynthesizedFinding[] {
  const minClasses = opts?.minIndependentClasses ?? MIN_INDEPENDENT_CLASSES;
  const maxFindings = opts?.maxFindings ?? 5;

  const eligible = eligibleArtifacts(rows);
  if (eligible.length === 0) return [];

  // id -> persisted source classes, so the bar is measured against what the
  // integrity layer recorded rather than against a second derivation.
  const classesById = new Map<string, string[]>();
  for (const r of rows) {
    if (typeof r.id === "string" && r.id) classesById.set(r.id, classesFor(r));
  }

  const clustered = clusterArtifacts(eligible);
  const out: SynthesizedFinding[] = [];

  for (const subject of clustered.subjects) {
    const members = subject.members as unknown as ClusterArtifact[];
    if (members.length === 0) continue;
    const sources = distinctSources(members);
    // Classes come from the persisted marker where it exists; `classifySource`
    // of the tool label is the documented fallback for older rows.
    const classes = new Set<string>();
    for (const m of members) {
      const persisted = m.id ? classesById.get(m.id) : undefined;
      for (const c of (persisted && persisted.length ? persisted : [classifySource(m.source)])) classes.add(c);
    }
    const independent = countIndependentClasses([...classes] as never);
    if (independent < minClasses) continue;

    const values = [...new Set(members.map((m) => m.value))];
    const ids = members.map((m) => m.id).filter((x): x is string => typeof x === "string" && x.length > 0);

    out.push({
      clusterId: subject.clusterId,
      independentClasses: independent,
      supportingArtifactIds: ids,
      input: {
        conclusion: conclusionFor(members, independent),
        cluster_label: subject.clusterId,
        supporting_sources: sources,
        supporting_artifact_values: values.slice(0, 50),
        drivers: [
          `${independent} independent source classes: ${[...classes].sort().join(", ")}`,
          `${members.length} corroborating artifact(s) sharing selector(s): ${subject.strongSelectors.slice(0, 5).join(", ") || "—"}`,
        ],
        reducers: [
          "Derived by deterministic synthesis from persisted artifacts, not from an analyst or model judgement.",
          "Cluster membership rests on shared selectors; a shared selector is not proof of shared identity.",
        ],
        // Left to the server. The scorer derives contradictions itself from the
        // thread's rows, and anything passed here would be a second opinion
        // competing with the one that carries authority.
        contradictions: [],
        unresolved: [],
        next_pivots: [],
        // The neutral defaults record_finding declares. Synthesis must not assert
        // an evidence strength it has no basis to judge; the axes are computed
        // from sources and corroboration, which is where its actual evidence is.
        identity_evidence_strength: 60,
        relationship_evidence_strength: 60,
        // Disclosure only — never read as authority (see #477). The server's
        // resolveRecordingStatus decides the real status.
        label: "INFERRED",
      },
    });
  }

  // Deterministic order: strongest corroboration first, then cluster id, so the
  // same thread synthesizes the same findings in the same order every sweep.
  out.sort((a, b) =>
    b.independentClasses - a.independentClasses ||
    b.supportingArtifactIds.length - a.supportingArtifactIds.length ||
    a.clusterId.localeCompare(b.clusterId)
  );
  return out.slice(0, maxFindings);
}
