// lib/dead-target.ts — per-CASE memory of tool+selector pairs that keep failing.
//
// The circuit breaker is per isolate: `clearRuntime(threadId)` wipes it on every
// request, and an investigation is 2–12 requests. So a target that failed in run 1
// is brand new to run 3. Measured 2026-09-20 on thread d72fa44a: `socialfetch_web_read`
// aborted SEVEN times on one YouTube channel across three runs, the model narrating
// "YouTube continues to time out (3 attempts now)" while nothing durable said so.
//
// `tool_usage_log` IS durable (three months, CLAUDE.md), so this reads the case's
// own attempt history once per run and refuses the (tool, selector) pairs that have
// failed DEAD_TARGET_FLOOR+ times SINCE THAT PAIR LAST SUCCEEDED. Same idea as
// `run_budget_prior` — a prior built from the log — but this one gates.
//
// Design rules, shared with the two dispatch boundaries beside it:
//   • key by tool AND normalised selector, never by value alone;
//   • a later success CLEARS the streak — see buildDeadTargets. The gate is about
//     what is failing now, never about what once failed;
//   • it sits AFTER every cache layer, so a free replay is always served: a dead
//     target costs nothing to answer from cache, and refusing one would throw away
//     a result the run already paid for;
//   • the refusal is a legible governance SKIP (it never ran, nothing is charged,
//     `outcome` = skipped via SKIP_RE in tool-outcome.ts), with a constant message
//     so caller-controlled text can never be regex-matched into anything else;
//   • `force` DOES override it — an analyst deliberately re-running a pivot card is
//     the one legitimate reason to try a dead target again;
//   • FAILS OPEN on a read error, like the other loaders in cache.ts: this is a
//     cost control, not an authorization boundary;
//   • kill switch DEAD_TARGET_MEMORY_DISABLED=true, read at call time.

/** Failed attempts on one (tool, selector) in a case before it is refused. */
export const DEAD_TARGET_FLOOR = 2;

/** Constant refusal text. `dead target` is in tool-outcome.ts SKIP_RE. */
export const DEAD_TARGET_REFUSAL_ERROR =
  "dead target: this tool already failed on this selector in this case; not retried";

export const DEAD_TARGET_REFUSAL_MARKER = "dead_target_memory";

// ---- Paging for the history read (cache.ts loadDeadTargets) --------------------
// An unbounded PostgREST select returns at most `db-max-rows` with NO error, so the
// read MUST page. The ceiling is a safety bound, not an expected size: the biggest
// production case measured 130 calls in one invocation over ~12 invocations, so
// 10,000 rows is roughly an order of magnitude of headroom. Hitting it means
// something is wrong, and the loader fails OPEN and says so.
/** Rows per page. */
export const DEAD_TARGET_PAGE = 500;
/** Pages before the loader gives up and fails open. */
export const DEAD_TARGET_MAX_PAGES = 20;
/**
 * Outcomes worth reading. `skipped` rows are excluded at the DB — they neither
 * count nor reset, and on a long case they are the bulk of the table.
 */
export const DEAD_TARGET_READ_OUTCOMES = ["failed", "ok", "empty"] as const;

export function deadTargetMemoryEnabled(): boolean {
  return (Deno.env.get("DEAD_TARGET_MEMORY_DISABLED") ?? "").trim().toLowerCase() !== "true";
}

export function deadTargetKey(tool: string, normalizedSelector: string): string {
  return `${tool}|${normalizedSelector}`;
}

/** A `tool_usage_log` row, as far as this module reads it. */
export type UsageRow = {
  tool_name?: unknown;
  outcome?: unknown;
  input_json?: unknown;
  created_at?: unknown;
};

/**
 * Outcomes that RESET a pair's failure streak. Both mean the call really ran and
 * the provider answered: `ok` returned a record, `empty` returned a clean negative
 * ("no usable result" / "not found"). Either one proves the target is reachable,
 * so the streak that preceded it is history, not evidence.
 *
 * `skipped` is deliberately in neither set — a governance refusal never ran, so it
 * is not a failure and it is not proof of reach. Counting our OWN refusals here
 * would also make the gate self-amplifying.
 */
const RESET_OUTCOMES: ReadonlySet<string> = new Set(["ok", "empty"]);

/**
 * Count failures per (tool, selector) SINCE THAT PAIR'S MOST RECENT SUCCESS.
 *
 * ⚠️ This is the whole correctness of the gate, and the first cut got it wrong:
 * it counted every `failed` row in the case, so a pair that failed twice on
 * Monday and succeeded on Tuesday stayed refused forever. A dead target is a
 * pair that is failing NOW, so the streak is read from the last proof of reach
 * forward — failure → failure → success leaves a live target, and the two
 * failures after a later success are what make it dead again.
 *
 * Rows are sorted by `created_at` here rather than trusted from the caller: the
 * reset semantics are order-dependent, and a silently unordered page would
 * invert the answer. Equal or missing timestamps keep their input order
 * (Array.prototype.sort is stable), so a caller that already ordered its read
 * loses nothing.
 *
 * `normalizedSelectorOf` is injected (the wrapper passes its own
 * detectSelectorType/Value + circuit.normalizeSelector composition) so the key is
 * computed by the same functions dispatch uses.
 *
 * Rows the wrapper wrote carry the tool input under `input_json.input` (the
 * refusal/skip shape) or as the input itself (the live-call shape); both are read.
 */
export function buildDeadTargets(
  rows: readonly UsageRow[],
  normalizedSelectorOf: (input: Record<string, unknown>) => string,
): Map<string, number> {
  const ordered = rows
    .map((row, index) => ({ row, index, at: timeOf(row.created_at) }))
    .sort((a, b) => (a.at === b.at ? a.index - b.index : a.at - b.at));

  const out = new Map<string, number>();
  for (const { row: r } of ordered) {
    const outcome = typeof r.outcome === "string" ? r.outcome : "";
    const failed = outcome === "failed";
    const reset = RESET_OUTCOMES.has(outcome);
    if (!failed && !reset) continue;
    const tool = typeof r.tool_name === "string" ? r.tool_name.trim() : "";
    if (!tool) continue;
    const input = unwrapInput(r.input_json);
    if (!input) continue;
    const sel = normalizedSelectorOf(input);
    if (!sel) continue;
    const k = deadTargetKey(tool, sel);
    if (reset) out.set(k, 0);
    else out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

/** Sortable epoch ms. An absent or unparseable timestamp sorts first, keeping input order. */
function timeOf(v: unknown): number {
  if (typeof v !== "string" || !v) return 0;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

function unwrapInput(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const inner = o.input;
  if (inner && typeof inner === "object") return inner as Record<string, unknown>;
  return o;
}

export function deadTargetCount(map: ReadonlyMap<string, number>, tool: string, normalizedSelector: string): number {
  return map.get(deadTargetKey(tool, normalizedSelector)) ?? 0;
}

export function isDeadTarget(map: ReadonlyMap<string, number>, tool: string, normalizedSelector: string, floor = DEAD_TARGET_FLOOR): boolean {
  return deadTargetCount(map, tool, normalizedSelector) >= floor;
}

/** The refusal payload. `skipped: true` — it is a governance skip, not a fault. */
export function deadTargetRefusal(tool: string, normalizedSelector: string, priorFailures: number) {
  return {
    ok: false as const,
    skipped: true as const,
    dead_target: true as const,
    refused_by: DEAD_TARGET_REFUSAL_MARKER,
    error: DEAD_TARGET_REFUSAL_ERROR,
    tool,
    selector: normalizedSelector,
    prior_failures: priorFailures,
    hint: "Pass force:true only if the analyst explicitly asked to retry this target.",
  };
}

/** `/health` → `checks.dead_target_memory`. Presence proves this build is deployed. */
export function describeDeadTargetMemory(): { ok: true; detail: string } {
  return deadTargetMemoryEnabled()
    ? { ok: true, detail: `enabled, floor=${DEAD_TARGET_FLOOR}` }
    : { ok: true, detail: "disabled — DEAD_TARGET_MEMORY_DISABLED=true" };
}
