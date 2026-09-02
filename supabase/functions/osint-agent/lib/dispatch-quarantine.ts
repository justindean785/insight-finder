/**
 * dispatch-quarantine.ts — the DISPATCH half of the `subject_unlinked` boundary.
 *
 * Quarantine already binds at WRITE (`auto-persist-findings.ts`) and at READ-BACK
 * (`lib/cluster.ts`, `graph.ts`, the report). It never bound at DISPATCH. So a
 * name-only harvest left its quarantined selectors sitting in the model's context
 * window, each one eligible to seed its own paid multi-tool stack — the real
 * driver of run spam and paid-cap pressure, not a cap that is too low.
 *
 * THE CONTRACT is the same one the other two halves keep: authority, not
 * deletion. A quarantined row stays persisted, visible on the Evidence board and
 * present in the report's collision section. What it may not do is START WORK.
 *
 * ── TWO DESIGN HAZARDS, both deliberate ──────────────────────────────────────
 *
 * 1. KEY BY `type:normalizedValue`, NEVER BY VALUE ALONE. Selector normalizers
 *    collapse text, so a `name` and a `username` can land on the same string.
 *    Keying by value alone lets an ordinary name RESTORE AUTHORITY to a
 *    quarantined username (and, inversely, lets a quarantined name silently
 *    disable an unrelated username). `src/lib/quarantine.ts` already gets this
 *    right; this mirrors it on the dispatch side.
 *
 * 2. A REFUSAL MUST READ AS A REFUSAL. `repairUnknownTool` → `UNKNOWN_TOOL_SINK`
 *    returns `{ ok: true, dropped: true }`, which is how a call to a tool
 *    disabled since 2026-07-09 reached a chain-of-custody record as `completed`.
 *    This module returns `ok: false` and deliberately avoids the vocabulary
 *    `isIntentionalSkip` matches — in particular the word "gated", which
 *    `SKIP_REASON_RE` treats as an intentional no-op. `deriveOk` consults
 *    `isIntentionalSkip` BEFORE `ok`, so a refusal phrased with that word would
 *    be logged `ok=true` and disappear from the failure metric.
 */

import { isSubjectUnlinked } from "./quarantine.ts";

/** The refusal marker, on the payload and in the log, so it is greppable. */
export const DISPATCH_REFUSAL_MARKER = "subject_unlinked_dispatch_boundary";

/**
 * The dispatch key. `type` and `value` BOTH participate — see hazard 1 above.
 * The value is expected to be already normalized by `circuit.normalizeSelector`,
 * which is type-aware; this only lower-cases and trims to stay idempotent.
 */
export function dispatchKey(selectorType: string, normalizedValue: string): string {
  return `${(selectorType ?? "").trim().toLowerCase()}:${(normalizedValue ?? "").trim().toLowerCase()}`;
}

/**
 * Is this (type, value) pair quarantined for DISPATCH?
 *
 * Fails OPEN on an empty selector: a call with no selector at all is not a
 * quarantined-selector call, and refusing it would break every tool that takes
 * no target (finalize, record_finding, the planner).
 */
export function isDispatchRefused(
  quarantined: ReadonlySet<string>,
  selectorType: string | readonly string[],
  normalizedValue: string,
): boolean {
  if (!normalizedValue) return false;
  const types = typeof selectorType === "string" ? [selectorType] : selectorType;
  return types.some((t) => quarantined.has(dispatchKey(t, normalizedValue)));
}

/**
 * The selector types to test for one dispatch, in priority order.
 *
 * WHY THIS EXISTS — a real gap, not a convenience. The wrapper's
 * `detectSelectorType` reads `input.kind` / `input.selector_type` and **never
 * `input.type`**, then falls through to the generic literal `"value"`. But the
 * paid breach tools' own schemas take `{ type, value }` — `breach_check`,
 * `oathnet_lookup` and friends. So a quarantined `username` arriving as
 * `{ type: "username", value: "…" }` is classified `value:…` by the wrapper, and
 * a key built from the artifact's `kind` (`username:…`) would never match it.
 * The boundary would hold for cheap tools and leak on exactly the expensive ones
 * it exists to stop.
 *
 * THIS IS STILL TYPE-KEYED, NOT VALUE-KEYED. Only types the CALLER actually
 * declared are considered — the wrapper's computed type, plus a literal
 * `input.type` when present. A quarantined `username` is still NOT refused when
 * the same text is dispatched as a `name`, because `name` is neither of those
 * candidates. That is hazard 1 above, and it stays closed.
 *
 * Deliberately NOT fixed here: `detectSelectorType` itself. It also keys the
 * circuit breaker, the dedup cache and telemetry, so teaching it `type` would
 * silently repartition all three. That is a separate change with its own
 * evidence, not a drive-by inside this boundary.
 */
export function dispatchTypeCandidates(
  computedType: string,
  input: unknown,
): string[] {
  const out: string[] = [];
  const push = (t: unknown) => {
    if (typeof t !== "string") return;
    const v = t.trim().toLowerCase();
    if (v && !out.includes(v)) out.push(v);
  };
  push(computedType);
  const inp = (input ?? {}) as Record<string, unknown>;
  push(inp.type);
  return out;
}

/**
 * The refusal payload. Explicitly NOT a success and explicitly NOT a skip.
 *
 * `ok: false` makes `deriveOk` log it as a non-success; the absence of `skipped`
 * and of any `SKIP_REASON_RE` vocabulary keeps `isIntentionalSkip` false; the
 * absence of `dropped` keeps it distinguishable from the unknown-tool sink.
 */
export function quarantineRefusal(
  tool: string,
  selectorType: string,
  normalizedValue: string,
  reason?: string | null,
): Record<string, unknown> {
  return {
    ok: false,
    refused: true,
    refused_by: DISPATCH_REFUSAL_MARKER,
    tool,
    selector_type: selectorType,
    selector: normalizedValue,
    error:
      `refused: ${selectorType} "${normalizedValue}" is quarantined as subject_unlinked ` +
      `and may not start a tool call. ` +
      (reason ? `Quarantine reason: ${reason}. ` : "") +
      `The row remains on the Evidence board; only its authority to drive work is withheld. ` +
      `An analyst can clear it by confirming linkage.`,
  };
}

/** An artifact row as read back from `public.artifacts` for this purpose. */
export type QuarantineRow = {
  kind?: unknown;
  value?: unknown;
  metadata?: unknown;
};

/**
 * Build the refused-key set from persisted artifacts.
 *
 * `normalize` is injected rather than imported so this module stays free of the
 * circuit/cache import graph and can be unit-tested on its own; callers pass
 * `circuit.normalizeSelector` so the key matches what dispatch computes.
 *
 * Only `subject_unlinked === true` AND NOT `linkage_confirmed === true` refuses —
 * the same predicate as `src/lib/quarantine.ts`'s `isQuarantined`. An explicit
 * human linkage decision is the ONLY thing that clears it; ordinary attestation
 * (`reviewed`, "confirmed", "key") answers "is this value real?", never "does it
 * belong to the subject?".
 */
export function buildRefusedKeys(
  rows: readonly QuarantineRow[] | null | undefined,
  normalize: (kind: string, raw: unknown) => string,
): Set<string> {
  const out = new Set<string>();
  for (const row of rows ?? []) {
    const meta = row?.metadata;
    if (!isSubjectUnlinked(meta)) continue;
    if ((meta as Record<string, unknown> | null)?.linkage_confirmed === true) continue;
    const kind = typeof row.kind === "string" ? row.kind : "";
    const raw = typeof row.value === "string" ? row.value : "";
    if (!kind || !raw) continue;
    const norm = normalize(kind, raw);
    if (norm) out.add(dispatchKey(kind, norm));
  }
  return out;
}

/** The quarantine reason for a refused key, for the refusal message. */
export function reasonForKey(
  rows: readonly QuarantineRow[] | null | undefined,
  normalize: (kind: string, raw: unknown) => string,
  selectorType: string,
  normalizedValue: string,
): string | null {
  const want = dispatchKey(selectorType, normalizedValue);
  for (const row of rows ?? []) {
    const kind = typeof row.kind === "string" ? row.kind : "";
    const raw = typeof row.value === "string" ? row.value : "";
    if (!kind || !raw) continue;
    if (dispatchKey(kind, normalize(kind, raw)) !== want) continue;
    const r = (row.metadata as Record<string, unknown> | null)?.subject_unlinked_reason;
    if (typeof r === "string" && r.trim()) return r.trim();
  }
  return null;
}
