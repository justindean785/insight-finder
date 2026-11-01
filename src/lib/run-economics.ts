/**
 * run-economics.ts — pure summaries over `orchestrator_invocations` /
 * `orchestrator_step_metrics` for the Intelligence → Credits tab.
 *
 * WHAT THIS IS, AND IS NOT
 *  - `credits_micro_usd` is the app's INTERNAL METER: model tokens at flat rates plus
 *    the tool charges, per invocation. It is not a provider invoice and the model rate
 *    is not model-aware. Callers must say so on screen.
 *  - A run that died before it finished wrote no row, so every figure here describes
 *    SURVIVING runs only.
 *  - Nothing here reads tool-call rows, so there is deliberately no tool-vs-model cost
 *    split: attributing tool_usage_log rows to an invocation by case + time window is
 *    ambiguous when runs overlap. That split waits for `invocation_id` on those rows.
 *
 * THE RULE THAT MATTERS: a null is "not recorded", never zero. A null cost is counted
 * as unknown and left out of averages; a step with no token usage marks the run's
 * token total as partial. This is the same trap `runCost.ts` documents for
 * `charged_micro_usd`.
 */

export interface InvocationRow {
  id: string;
  thread_id: string;
  started_at: string;
  duration_ms: number | null;
  step_count: number | null;
  tool_call_count: number | null;
  stop_reason: string | null;
  credits_micro_usd: number | null;
  model_id: string | null;
  persist_ms: number | null;
  salvage_ms: number | null;
  salvage_outcome: string | null;
  unfinished_steps: number | null;
}

export interface StepTokenRow {
  invocation_id: string;
  input_tokens: number | null;
  output_tokens: number | null;
}

export type EndingTone = "ok" | "info" | "warn" | "bad";

const DAY_MS = 86_400_000;
const MICRO = 1_000_000;

const ENDINGS: Record<string, { label: string; tone: EndingTone }> = {
  natural_stop: { label: "Ended on its own", tone: "ok" },
  // A forced finalization is the run reaching its time window and being told to write
  // the report. It is not evidence the investigation failed.
  finalize_forced: { label: "Time limit — report forced", tone: "warn" },
  length_limit: { label: "Length limit", tone: "warn" },
  budget_exhausted: { label: "Budget reached", tone: "warn" },
  stream_error: { label: "Stream error", tone: "bad" },
};

export function endingLabel(stopReason: string | null | undefined): { label: string; tone: EndingTone } {
  return (stopReason && ENDINGS[stopReason]) || { label: "Not recorded", tone: "info" };
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface RunTimeSplit {
  totalMs: number;
  /** time before persistence started: the tool loop plus its between-step overhead */
  loopMs: number;
  /** the report-salvage model call, which runs inside persistence */
  salvageMs: number;
  /** the rest of persistence (writes, clustering) */
  persistOtherMs: number;
}

/**
 * Where a run's wall time went, from the recorder's timing columns. Returns null for a
 * run that was never timed: `unfinished_steps` is the discriminator the recorder writes
 * whenever timing is on (same rule as `reconcileTimeline` in the edge function), so a
 * legacy row with NULL timing columns is never shown as "0 s of salvage".
 */
export function splitRunTime(row: InvocationRow): RunTimeSplit | null {
  if (!isNum(row.unfinished_steps)) return null;
  if (!isNum(row.duration_ms)) return null;
  const totalMs = Math.max(0, row.duration_ms);
  const persist = clamp(isNum(row.persist_ms) ? row.persist_ms : 0, 0, totalMs);
  const salvage = clamp(isNum(row.salvage_ms) ? row.salvage_ms : 0, 0, persist);
  return { totalMs, loopMs: totalMs - persist, salvageMs: salvage, persistOtherMs: persist - salvage };
}

export interface RunTokens {
  input: number;
  output: number;
  /** true when at least one step carried no usage, so the totals are a floor */
  partial: boolean;
}

export function sumTokens(steps: StepTokenRow[]): Map<string, RunTokens> {
  const out = new Map<string, RunTokens>();
  for (const s of steps) {
    const cur = out.get(s.invocation_id) ?? { input: 0, output: 0, partial: false };
    if (isNum(s.input_tokens)) cur.input += s.input_tokens; else cur.partial = true;
    if (isNum(s.output_tokens)) cur.output += s.output_tokens; else cur.partial = true;
    out.set(s.invocation_id, cur);
  }
  return out;
}

export interface RunEconomics {
  /** invocations started in the last 30 days */
  runs: number;
  spend14Usd: number;
  spend30Usd: number;
  /** runs in the 30-day window with no recorded cost; left out of every cost figure */
  costUnknownRuns: number;
  avgRunUsd: number | null;
  /** share of runs with a recorded ending that were forced to finalize; null with none */
  forcedShare: number | null;
  /** salvage time / total run time over timed runs only; null with none */
  salvageShareOfTime: number | null;
  timedRuns: number;
}

export function summarizeRuns(rows: InvocationRow[], nowMs: number): RunEconomics {
  const cutoff30 = nowMs - 30 * DAY_MS;
  const cutoff14 = nowMs - 14 * DAY_MS;
  let runs = 0;
  let spend14 = 0;
  let spend30 = 0;
  let recorded = 0;
  let unknown = 0;
  let endingKnown = 0;
  let forced = 0;
  let timed = 0;
  let salvageMs = 0;
  let timedTotalMs = 0;

  for (const r of rows) {
    const t = new Date(r.started_at).getTime();
    if (!Number.isFinite(t) || t < cutoff30) continue;
    runs += 1;

    if (isNum(r.credits_micro_usd)) {
      recorded += 1;
      spend30 += r.credits_micro_usd;
      if (t >= cutoff14) spend14 += r.credits_micro_usd;
    } else {
      unknown += 1;
    }

    if (r.stop_reason && r.stop_reason !== "unknown") {
      endingKnown += 1;
      if (r.stop_reason === "finalize_forced") forced += 1;
    }

    const split = splitRunTime(r);
    if (split) {
      timed += 1;
      salvageMs += split.salvageMs;
      timedTotalMs += split.totalMs;
    }
  }

  return {
    runs,
    spend14Usd: spend14 / MICRO,
    spend30Usd: spend30 / MICRO,
    costUnknownRuns: unknown,
    avgRunUsd: recorded > 0 ? spend30 / MICRO / recorded : null,
    forcedShare: endingKnown > 0 ? forced / endingKnown : null,
    salvageShareOfTime: timed > 0 && timedTotalMs > 0 ? salvageMs / timedTotalMs : null,
    timedRuns: timed,
  };
}

/** Recorded cost per whole day, oldest first; `days` buckets ending today. */
export function dailySpendUsd(rows: InvocationRow[], days: number, nowMs: number): number[] {
  const buckets = new Array<number>(days).fill(0);
  for (const r of rows) {
    if (!isNum(r.credits_micro_usd)) continue;
    const t = new Date(r.started_at).getTime();
    if (!Number.isFinite(t)) continue;
    const age = Math.floor((nowMs - t) / DAY_MS);
    if (age < 0 || age >= days) continue;
    buckets[days - 1 - age] += r.credits_micro_usd / MICRO;
  }
  return buckets;
}

/** "2m 34s", "9s", "<1s"; an em dash when the duration was never recorded. */
export function formatDuration(ms: number | null | undefined): string {
  if (!isNum(ms)) return "—";
  if (ms < 1_000) return "<1s";
  const total = Math.round(ms / 1_000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/** "950", "3.0k", "141.5k", "1.25M". */
export function formatTokens(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Three decimals under a dollar, two from a dollar up; an em dash for "not recorded". */
export function formatUsd(usd: number | null | undefined): string {
  if (!isNum(usd)) return "—";
  return usd < 1 ? `$${usd.toFixed(3)}` : `$${usd.toFixed(2)}`;
}
