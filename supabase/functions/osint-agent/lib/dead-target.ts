// lib/dead-target.ts — per-CASE memory of tool+selector pairs that keep failing.
//
// The circuit breaker is per isolate: `clearRuntime(threadId)` wipes it on every
// request, and an investigation is 2–12 requests. So a target that failed in run 1
// is brand new to run 3. Measured 2026-09-20 on thread d72fa44a: `socialfetch_web_read`
// aborted SEVEN times on one YouTube channel across three runs, the model narrating
// "YouTube continues to time out (3 attempts now)" while nothing durable said so.
//
// `tool_usage_log` IS durable (three months, CLAUDE.md), so this reads the case's
// own failed rows once per run and refuses the (tool, selector) pairs that already
// failed DEAD_TARGET_FLOOR+ times. Same idea as `run_budget_prior` — a prior built
// from the log — but this one gates.
//
// Design rules, shared with the two dispatch boundaries beside it:
//   • key by tool AND normalised selector, never by value alone;
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
};

/**
 * Count FAILED attempts per (tool, selector). `normalizedSelectorOf` is injected
 * (the wrapper passes its own detectSelectorType/Value + circuit.normalizeSelector
 * composition) so the key is computed by the same functions dispatch uses.
 *
 * Rows the wrapper wrote carry the tool input under `input_json.input` (the
 * refusal/skip shape) or as the input itself (the live-call shape); both are read.
 */
export function buildDeadTargets(
  rows: readonly UsageRow[],
  normalizedSelectorOf: (input: Record<string, unknown>) => string,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const r of rows) {
    if (r.outcome !== "failed") continue;
    const tool = typeof r.tool_name === "string" ? r.tool_name.trim() : "";
    if (!tool) continue;
    const input = unwrapInput(r.input_json);
    if (!input) continue;
    const sel = normalizedSelectorOf(input);
    if (!sel) continue;
    const k = deadTargetKey(tool, sel);
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
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
