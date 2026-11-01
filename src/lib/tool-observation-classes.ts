/**
 * tool-observation-classes.ts — what each tool's recent calls say about whether it works.
 *
 * READ-ONLY OBSERVATION. Nothing here writes a memory, a lesson or a verdict, and nothing
 * here tells the agent to do anything. The "needs attention" flag is a figure on a screen.
 *
 * COUNTING RULES (same as the `tool_health` view and `source-reliability.ts`)
 *  - live calls only (`cached` false), outcome `ok` or `failed` are the real attempts;
 *  - `skipped` (governance, dispatch refusal) and `empty` (a valid "no record") are shown but
 *    never counted for or against a tool;
 *  - a NULL outcome is pre-outcome-column history and is dropped, never guessed from `ok`.
 *
 * FAILURE KINDS are read from `status_code` and the redacted `error_msg`. 62% of failed
 * calls on the owner account carry NO status code (measured 2026-11-01), so the text matters,
 * and a text match is a HEURISTIC: the screen says so. Kinds, in the order they are tried:
 *   rate_limited     429 / "rate limit" / "too many requests"
 *   credential_plan  401 402 403 / plan, quota, credit, balance, key, permission refusals
 *   transport        408, 5xx / timeouts, aborts, connection and DNS failures
 *   input_rejected   400 422 / the tool refused the INPUT the model sent (schema, validation)
 *   other            everything else, shown as such rather than forced into a kind
 * `input_rejected` splits the plan's §4.8 "other": a tool refusing a malformed call is a
 * different lesson from a provider being down. A future aggregator should share this module's
 * classes so the screen and the lessons cannot disagree.
 *
 * A 403 is NOT a dead credential (CLAUDE.md): the credential_plan label says "refusals", and the
 * panel repeats that a refusal can be a plan limit, a blocked datacenter IP or a policy decision.
 */

export type FailureClass = "transport" | "credential_plan" | "rate_limited" | "input_rejected" | "other";

/** Tie-break order for "dominant kind", and the order kinds are listed on screen. */
export const FAILURE_CLASS_ORDER: readonly FailureClass[] = [
  "credential_plan",
  "transport",
  "rate_limited",
  "input_rejected",
  "other",
];

export const FAILURE_CLASS_LABEL: Record<FailureClass, string> = {
  credential_plan: "Plan or credential refusals",
  transport: "Timeouts and server errors",
  rate_limited: "Rate limited",
  input_rejected: "Input rejected",
  other: "Other",
};

/** Plan §4.8 lesson thresholds, applied to the last RECENT_DAYS. */
export const ATTENTION_MIN_ATTEMPTS = 5;
export const ATTENTION_MIN_FAILURE_SHARE = 0.6;
export const ATTENTION_MIN_THREADS = 2;
export const OBSERVATION_WINDOW_DAYS = 30;
export const OBSERVATION_RECENT_DAYS = 14;

const RATE_RE = /rate.?limit|too many requests|\b429\b/i;
const CREDENTIAL_RE =
  /unauthori[sz]ed|forbidden|api.?key|permission|subscription|\bplan\b|quota|credit|balance|payment|billing|\b40[123]\b/i;
const TRANSPORT_RE =
  /timeout|timed out|abort|econn|enotfound|etimedout|fetch failed|network|socket|\bdns\b|unreachable|connection|\b5\d\d\b/i;
const INPUT_RE =
  /invalid|validation|schema|expected|required|unrecognized|malformed|bad request|must be|not a valid|input/i;

export function classifyFailure(r: { status_code: number | null; error_msg: string | null }): FailureClass {
  const code = r.status_code;
  const text = r.error_msg ?? "";
  if (code === 429 || RATE_RE.test(text)) return "rate_limited";
  if (code === 401 || code === 402 || code === 403 || CREDENTIAL_RE.test(text)) return "credential_plan";
  if (code === 408 || (code != null && code >= 500 && code <= 599) || TRANSPORT_RE.test(text)) return "transport";
  if (code === 400 || code === 422 || INPUT_RE.test(text)) return "input_rejected";
  return "other";
}

export type ObservationRow = {
  tool_name: string;
  outcome: string | null;
  cached: boolean | null;
  status_code: number | null;
  error_msg: string | null;
  thread_id: string | null;
  created_at: string;
};

export type ClassCounts = Record<FailureClass, number>;
const emptyCounts = (): ClassCounts => ({ transport: 0, credential_plan: 0, rate_limited: 0, input_rejected: 0, other: 0 });

export type ToolObservation = {
  tool: string;
  /** real attempts in the 30-day window: outcome ok or failed, live calls */
  attempts: number;
  ok: number;
  failed: number;
  /** shown, never counted */
  skipped: number;
  empty: number;
  /** 0-100 over real attempts, null when there are none */
  reliability: number | null;
  classes: ClassCounts;
  /** failures by kind in the last OBSERVATION_RECENT_DAYS, which is what the flag sentence describes */
  recentClasses: ClassCounts;
  /** the most common failure kind (30-day window, or the recent window when flagged) */
  dominantClass: FailureClass | null;
  /** the last OBSERVATION_RECENT_DAYS, which is what the flag is judged on */
  recent: { attempts: number; failed: number; failureShare: number | null; threads: number };
  attention: boolean;
};

export type ObservationSummary = {
  tools: ToolObservation[];
  totals: { tools: number; attempts: number; failed: number; classes: ClassCounts };
};

const dominant = (c: ClassCounts): FailureClass | null => {
  let best: FailureClass | null = null;
  for (const k of FAILURE_CLASS_ORDER) if (c[k] > 0 && (best === null || c[k] > c[best])) best = k;
  return best;
};

export function summarizeToolObservations(rows: readonly ObservationRow[], nowMs: number): ObservationSummary {
  const cutoff = nowMs - OBSERVATION_WINDOW_DAYS * 86_400_000;
  const recentCutoff = nowMs - OBSERVATION_RECENT_DAYS * 86_400_000;

  type Acc = {
    ok: number; failed: number; skipped: number; empty: number;
    classes: ClassCounts; recentClasses: ClassCounts;
    rAttempts: number; rFailed: number; rThreads: Set<string>;
  };
  const by = new Map<string, Acc>();
  const acc = (tool: string): Acc => {
    let a = by.get(tool);
    if (!a) {
      a = { ok: 0, failed: 0, skipped: 0, empty: 0, classes: emptyCounts(), recentClasses: emptyCounts(), rAttempts: 0, rFailed: 0, rThreads: new Set() };
      by.set(tool, a);
    }
    return a;
  };

  for (const r of rows) {
    if (r.cached !== false) continue; // live calls only; a replay is not an attempt
    const t = new Date(r.created_at).getTime();
    if (!Number.isFinite(t) || t < cutoff) continue;
    // NULL / unknown outcome: dropped, never guessed — and dropped BEFORE the accumulator exists,
    // so a tool whose only rows are legacy cannot appear as a zero-attempt ghost that inflates
    // `totals.tools` and implies the tool was exercised when nothing about it was recorded.
    const o = r.outcome;
    if (o !== "ok" && o !== "failed" && o !== "skipped" && o !== "empty") continue;
    const a = acc(r.tool_name);
    if (o === "skipped") { a.skipped++; continue; } // surfaced on purpose, not an attempt
    if (o === "empty") { a.empty++; continue; }

    const isRecent = t >= recentCutoff;
    if (isRecent) {
      a.rAttempts++;
      if (r.thread_id) a.rThreads.add(r.thread_id);
    }
    if (r.outcome === "ok") { a.ok++; continue; }
    a.failed++;
    const cls = classifyFailure(r);
    a.classes[cls]++;
    if (isRecent) { a.rFailed++; a.recentClasses[cls]++; }
  }

  const totalsClasses = emptyCounts();
  let totalAttempts = 0;
  let totalFailed = 0;

  const tools = Array.from(by.entries())
    .map(([tool, a]): ToolObservation => {
      const attempts = a.ok + a.failed;
      const failureShare = a.rAttempts > 0 ? a.rFailed / a.rAttempts : null;
      const attention =
        a.rAttempts >= ATTENTION_MIN_ATTEMPTS &&
        failureShare !== null &&
        failureShare >= ATTENTION_MIN_FAILURE_SHARE &&
        a.rThreads.size >= ATTENTION_MIN_THREADS;
      totalAttempts += attempts;
      totalFailed += a.failed;
      for (const k of FAILURE_CLASS_ORDER) totalsClasses[k] += a.classes[k];
      return {
        tool,
        attempts,
        ok: a.ok,
        failed: a.failed,
        skipped: a.skipped,
        empty: a.empty,
        reliability: attempts > 0 ? Math.round((a.ok / attempts) * 100) : null,
        classes: a.classes,
        recentClasses: a.recentClasses,
        dominantClass: dominant(attention ? a.recentClasses : a.classes),
        recent: { attempts: a.rAttempts, failed: a.rFailed, failureShare, threads: a.rThreads.size },
        attention,
      };
    })
    .sort(
      (x, y) =>
        Number(y.attention) - Number(x.attention) ||
        y.attempts - x.attempts ||
        y.skipped + y.empty - (x.skipped + x.empty) ||
        x.tool.localeCompare(y.tool),
    );

  return { tools, totals: { tools: tools.length, attempts: totalAttempts, failed: totalFailed, classes: totalsClasses } };
}

const MOSTLY: Record<FailureClass, string> = {
  credential_plan: "plan or credential refusals",
  transport: "timeouts and server errors",
  rate_limited: "rate limiting",
  input_rejected: "input the tool rejected",
  other: "unclassified failures",
};

/**
 * One plain sentence for a flagged tool, over the RECENT window the flag is judged on. "Mostly X"
 * only when one kind strictly leads the recent failures; a tie for the lead is "a mix", so the
 * label cannot depend on the order the kinds happen to be listed in.
 */
export function describeAttention(o: ToolObservation): string {
  const { attempts, failed, failureShare } = o.recent;
  const pct = failureShare === null ? 0 : Math.round(failureShare * 100);
  return `${failed} of ${attempts} real attempts failed in the last ${OBSERVATION_RECENT_DAYS} days (${pct}%) · ${leadPhrase(o)}`;
}

function leadPhrase(o: ToolObservation): string {
  const c = o.recentClasses;
  const sorted = FAILURE_CLASS_ORDER.map((k) => [k, c[k]] as const).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) return "no failure kind recorded";
  if (sorted.length > 1 && sorted[0][1] === sorted[1][1]) return "a mix of failure kinds";
  return `mostly ${MOSTLY[sorted[0][0]]}`;
}
