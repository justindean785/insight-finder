// Pure policy for the post-deploy benchmark audit. No I/O, no network, no DB.
//
// WHY THIS EXISTS. The benchmark audit was repeatedly done by hand, and the
// hand version made a specific, recurring class of mistake: reading SILENCE as
// SUCCESS. On 2026-08-17 the Indicia ledger showed 14 failures all aborting at
// 18.0-18.3s — the exact signature of the timeout #469 had just raised to 30s.
// It reads as a live regression. It was not: every one of those calls predated
// the deploy, and ZERO indicia calls had happened since. The fix was
// unexercised, not broken.
//
// The inverse error is the same shape: after a deploy with no traffic, "no
// cluster_decision rows were written" is not evidence the producer stopped.
//
// So `exerciseStatus` is the load-bearing function here, not the counters. It
// makes "we cannot tell yet" a first-class outcome that a report cannot quietly
// round up to "fixed".
//
// The runner that feeds this is scripts/benchmark-audit.mjs; it holds all the
// I/O so everything below stays unit-testable against fixtures.

// Engine bookkeeping, not observations. MUST stay in step with
// META_ARTIFACT_KINDS in src/hooks/useThreadArtifacts.ts — that module imports
// the supabase client, so it cannot be imported from a node script. The
// agreement is pinned by src/test/benchmark-audit-policy.test.ts instead, the
// same way #472 pins the SQL list against the TS list.
export const META_KINDS = ["triage_decision", "cluster_decision"] as const;

const META = new Set<string>(META_KINDS);

export interface ArtifactRow {
  id?: string;
  thread_id?: string;
  kind: string;
  value: string | null;
  confidence?: number | null;
  source?: string | null;
  created_at?: string;
  metadata?: Record<string, unknown> | null;
}

export interface ToolCallRow {
  tool_name: string;
  outcome?: string | null;
  ok?: boolean | null;
  duration_ms?: number | null;
  error_msg?: string | null;
  status_code?: number | null;
  created_at: string;
}

const md = (r: ArtifactRow): Record<string, unknown> => r.metadata ?? {};

export function isMetaKind(kind: string): boolean {
  return META.has(kind.toLowerCase());
}

/* ------------------------------------------------------------------ *
 * Exercise status — the reason this module exists.
 * ------------------------------------------------------------------ */

export type ExerciseStatus = "exercised" | "unexercised" | "inconclusive";

export interface ExerciseInput {
  /** ISO timestamp the fix went live. */
  deployedAt: string;
  /** Events of ANY kind observed after `deployedAt` (was there traffic at all?). */
  totalEventsAfter: number;
  /** Events that would actually run the changed code path. */
  relevantEventsAfter: number;
  /**
   * How often the relevant event occurred BEFORE the deploy, as a rate per
   * event. A path that fired twice in a thousand calls cannot be shown absent
   * by eighty calls of traffic, so absence there is inconclusive, not proof.
   */
  priorRatePerEvent?: number;
}

export interface ExerciseVerdict {
  status: ExerciseStatus;
  /** Safe to state the fix works from this evidence alone? */
  provesFix: boolean;
  reason: string;
}

/**
 * Decide whether a deployed change actually ran in production.
 *
 * Never returns a passing verdict from absence alone: `provesFix` is true only
 * when the changed path genuinely executed.
 */
export function exerciseStatus(input: ExerciseInput): ExerciseVerdict {
  const { totalEventsAfter, relevantEventsAfter, priorRatePerEvent } = input;

  if (relevantEventsAfter > 0) {
    return {
      status: "exercised",
      provesFix: true,
      reason: `${relevantEventsAfter} event(s) ran the changed path after deploy`,
    };
  }
  if (totalEventsAfter === 0) {
    return {
      status: "unexercised",
      provesFix: false,
      reason: "no traffic of any kind since deploy — absence of the symptom is silence, not evidence",
    };
  }
  // Traffic existed but the path never fired. Whether that is meaningful
  // depends on how often the path fires at all.
  if (priorRatePerEvent !== undefined) {
    const expected = priorRatePerEvent * totalEventsAfter;
    if (expected < 1) {
      return {
        status: "inconclusive",
        provesFix: false,
        reason:
          `path is rare (prior rate ${priorRatePerEvent.toPrecision(2)}/event); ` +
          `${totalEventsAfter} events would only predict ${expected.toFixed(2)} occurrences — ` +
          `absence is weak evidence`,
      };
    }
  }
  return {
    status: "unexercised",
    provesFix: false,
    reason: `${totalEventsAfter} events since deploy, none of which ran the changed path`,
  };
}

/* ------------------------------------------------------------------ *
 * Failure classification — "it failed" is not a cause.
 * ------------------------------------------------------------------ */

export type FailureCause =
  | "our_timeout"
  | "provider_timeout"
  | "quota"
  | "serialization_mutex_skip"
  | "internal_cap"
  | "finalize_window_skip"
  | "provider_error"
  | "empty_result"
  | "none";

export interface FailureInput {
  errorMsg?: string | null;
  durationMs?: number | null;
  statusCode?: number | null;
  /** Our own configured abort budget for this tool, in ms. */
  ourCapMs?: number;
}

/**
 * Classify WHY a call did not succeed.
 *
 * The distinction that matters is our_timeout vs provider_timeout: the first is
 * self-inflicted and fixed by raising a cap, the second is the provider being
 * slow. #469 existed because 20 calls were misread as provider failures when
 * every one was our own 18s abort.
 */
export function classifyFailure(input: FailureInput): FailureCause {
  const e = (input.errorMsg ?? "").toLowerCase();
  const dur = input.durationMs ?? 0;

  if (!e) return "none";
  if (/already has a call in/.test(e)) return "serialization_mutex_skip";
  if (/paid-call cap reached|internal cap/.test(e)) return "internal_cap";
  if (/finalize window open/.test(e)) return "finalize_window_skip";
  if (/quota|rate limit|too many requests/.test(e) || input.statusCode === 429) return "quota";
  if (/no usable result|no records|not found|no result/.test(e)) return "empty_result";
  if (/timed out|timeout|abort/.test(e)) {
    // Attribute to ourselves only when the call died at our own budget. A
    // provider-side timeout lands somewhere else on the clock.
    if (input.ourCapMs && dur >= input.ourCapMs * 0.9) return "our_timeout";
    return "provider_timeout";
  }
  return "provider_error";
}

/* ------------------------------------------------------------------ *
 * Artifact reconciliation — persisted count vs real observations.
 * ------------------------------------------------------------------ */

export interface Reconciliation {
  total: number;
  metaBookkeeping: number;
  invalidPlaceholders: number;
  duplicateEquivalentNulls: number;
  exactDuplicates: number;
  distinctSubstantive: number;
  /** Percentage of the raw count that is real investigative evidence. */
  pctReal: number;
}

const NULL_RESULT_RE = /\b(no records?|not found|no results?|0 results?|nothing found)\b/i;
// A queued-tool placeholder names a REAL tool. Court language such as
// "(pending appeal)" is evidence and must survive — that was #470's G1 defect,
// so the caller passes the real tool vocabulary and we fail CLOSED without it.
const PLACEHOLDER_RE = /\b(queued|pending|in progress|awaiting)\b/i;

export function isQueuedPlaceholder(value: string, knownTools: readonly string[]): boolean {
  // Fail closed: no vocabulary, no discard. Note this guard is DEFENSIVE, not
  // load-bearing on its own — `[].some()` is already false, so deleting this
  // line changes nothing today (measured: the mutant survives). It is kept to
  // state the intent, and the test pins the behaviour that actually matters —
  // flipping this to `true` (fail OPEN) does fail the suite.
  if (!knownTools.length) return false;
  if (!PLACEHOLDER_RE.test(value)) return false;
  const v = value.toLowerCase();
  return knownTools.some((t) => t && v.includes(t.toLowerCase()));
}

export function reconcileArtifacts(
  rows: readonly ArtifactRow[],
  knownTools: readonly string[] = [],
): Reconciliation {
  const total = rows.length;
  let metaBookkeeping = 0;
  let invalidPlaceholders = 0;
  const nullKeys = new Map<string, number>();
  const seen = new Set<string>();
  let exactDuplicates = 0;

  for (const r of rows) {
    const value = r.value ?? "";
    if (isMetaKind(r.kind)) {
      metaBookkeeping++;
      continue;
    }
    if (isQueuedPlaceholder(value, knownTools)) {
      invalidPlaceholders++;
      continue;
    }
    const key = `${r.kind.toLowerCase()}|${value.toLowerCase().trim()}`;
    if (seen.has(key)) {
      exactDuplicates++;
      continue;
    }
    seen.add(key);
    // Equivalent zero-results collapse only when nothing substantive remains
    // after removing the zero phrase, the tool and the selector (#470 G4).
    if (NULL_RESULT_RE.test(value)) {
      const residue = value.replace(NULL_RESULT_RE, "").replace(/[^a-z0-9]+/gi, "");
      const nk = `${r.kind.toLowerCase()}|${(r.source ?? "").toLowerCase()}|${residue ? "substantive" : "bare"}`;
      nullKeys.set(nk, (nullKeys.get(nk) ?? 0) + 1);
    }
  }

  // Only BARE null results are interchangeable; a null carrying extra substance
  // is a distinct observation.
  let duplicateEquivalentNulls = 0;
  for (const [k, n] of nullKeys) if (k.endsWith("|bare") && n > 1) duplicateEquivalentNulls += n - 1;

  const distinctSubstantive =
    total - metaBookkeeping - invalidPlaceholders - exactDuplicates - duplicateEquivalentNulls;

  return {
    total,
    metaBookkeeping,
    invalidPlaceholders,
    duplicateEquivalentNulls,
    exactDuplicates,
    distinctSubstantive,
    pctReal: total === 0 ? 0 : Math.round((distinctSubstantive / total) * 1000) / 10,
  };
}

/* ------------------------------------------------------------------ *
 * G2 — hygiene must DISCLOSE, never silently mutate.
 * ------------------------------------------------------------------ */

export interface DisclosureRow {
  kind: string;
  before: string;
  after: string;
  retained: boolean;
}

export interface DisclosureAudit {
  strippedRows: DisclosureRow[];
  /** Rows flagged as stripped that did NOT retain the original — a violation. */
  invariantViolations: DisclosureRow[];
}

/**
 * #470 G2: a row whose value was altered must carry both
 * `status_assertion_stripped: true` and the original `value_before_hygiene`.
 * A stripped flag without the original IS the silent-mutation bug.
 */
export function auditDisclosure(rows: readonly ArtifactRow[]): DisclosureAudit {
  const strippedRows: DisclosureRow[] = [];
  for (const r of rows) {
    const m = md(r);
    if (m.status_assertion_stripped !== true) continue;
    const before = typeof m.value_before_hygiene === "string" ? m.value_before_hygiene : "";
    strippedRows.push({
      kind: r.kind,
      before,
      after: r.value ?? "",
      retained: before.length > 0,
    });
  }
  return { strippedRows, invariantViolations: strippedRows.filter((r) => !r.retained) };
}

/* ------------------------------------------------------------------ *
 * Authority distribution.
 * ------------------------------------------------------------------ */

export interface AuthorityDistribution {
  confidence: Record<string, number>;
  aboveRealCeiling: ArtifactRow[];
  quarantined: number;
  collisions: number;
}

/**
 * The highest genuine artifact measured in production is 75; the breach cap is
 * 60 and the quarantine ceiling 55. Anything at 100 is bookkeeping wearing an
 * observation's clothes — that is how cluster_decision was found.
 */
export const REAL_CONFIDENCE_CEILING = 75;

export function authorityDistribution(rows: readonly ArtifactRow[]): AuthorityDistribution {
  const confidence: Record<string, number> = {};
  const aboveRealCeiling: ArtifactRow[] = [];
  let quarantined = 0;
  let collisions = 0;

  for (const r of rows) {
    const key = r.confidence === null || r.confidence === undefined ? "(null)" : String(r.confidence);
    confidence[key] = (confidence[key] ?? 0) + 1;
    if ((r.confidence ?? 0) > REAL_CONFIDENCE_CEILING) aboveRealCeiling.push(r);
    const m = md(r);
    if (m.subject_unlinked === true || m.subject_unlinked_reason) quarantined++;
    if (r.kind === "excluded_collision" || m.collision === true) collisions++;
  }
  return { confidence, aboveRealCeiling, quarantined, collisions };
}

/* ------------------------------------------------------------------ *
 * Tool ledger summary.
 * ------------------------------------------------------------------ */

export interface LedgerSummary {
  total: number;
  byOutcome: Record<string, number>;
  okRate: number;
}

export function summarizeLedger(rows: readonly ToolCallRow[]): LedgerSummary {
  const byOutcome: Record<string, number> = {};
  for (const r of rows) {
    const k = r.outcome ?? "(null)";
    byOutcome[k] = (byOutcome[k] ?? 0) + 1;
  }
  const ok = byOutcome.ok ?? 0;
  return {
    total: rows.length,
    byOutcome,
    okRate: rows.length === 0 ? 0 : Math.round((ok / rows.length) * 1000) / 10,
  };
}

/**
 * Split a tool's calls across a deploy boundary and refuse to grade the fix
 * from pre-deploy rows. This is the guard that stops "14 aborts at 18s" being
 * reported as a live regression when all 14 predate the change.
 */
export interface BoundaryReport {
  before: ToolCallRow[];
  after: ToolCallRow[];
  causesAfter: Record<string, number>;
  causesBefore: Record<string, number>;
  verdict: ExerciseVerdict;
}

export function reportAcrossDeploy(
  calls: readonly ToolCallRow[],
  opts: { deployedAt: string; ourCapMs?: number; totalEventsAfter: number },
): BoundaryReport {
  const before = calls.filter((c) => c.created_at <= opts.deployedAt);
  const after = calls.filter((c) => c.created_at > opts.deployedAt);
  const tally = (rows: ToolCallRow[]) => {
    const out: Record<string, number> = {};
    for (const c of rows) {
      const cause = classifyFailure({
        errorMsg: c.error_msg,
        durationMs: c.duration_ms,
        statusCode: c.status_code,
        ourCapMs: opts.ourCapMs,
      });
      out[cause] = (out[cause] ?? 0) + 1;
    }
    return out;
  };
  return {
    before,
    after,
    causesBefore: tally(before),
    causesAfter: tally(after),
    verdict: exerciseStatus({
      deployedAt: opts.deployedAt,
      totalEventsAfter: opts.totalEventsAfter,
      relevantEventsAfter: after.length,
    }),
  };
}

/* ------------------------------------------------------------------ *
 * Known error signatures.
 * ------------------------------------------------------------------ */

export const ERROR_SIGNATURES = {
  classifySource_type: /toLowerCase is not a function/i,
  postgrest_logic_tree: /failed to parse logic tree|PGRST/i,
} as const;

export function countErrorSignatures(rows: readonly ToolCallRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of Object.keys(ERROR_SIGNATURES)) out[name] = 0;
  for (const r of rows) {
    const e = r.error_msg ?? "";
    for (const [name, re] of Object.entries(ERROR_SIGNATURES)) if (re.test(e)) out[name]++;
  }
  return out;
}
