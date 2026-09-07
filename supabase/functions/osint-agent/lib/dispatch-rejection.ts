/**
 * dispatch-rejection.ts — the DISPATCH half of the ANALYST-REJECTION boundary.
 *
 * `reviews.ts` makes a `dismissed` / `wrong` verdict bind at every READ that feeds
 * the model (prompt block, salvage, cache write, clustering, recovery, synthesis).
 * It never bound at DISPATCH: nothing stopped the model — or a manual "Run this
 * pivot" click — from starting a paid tool call on a selector the analyst had
 * already ruled out. A prompt instruction ("DO NOT USE") is not enforcement; this
 * module is the runtime guard.
 *
 * It is the deliberate twin of `dispatch-quarantine.ts` and keeps the same two
 * design rules:
 *
 *   1. KEY BY `type:normalizedValue`, NEVER BY VALUE ALONE. A rejected `username`
 *      must not silently disable a same-text `name`, and an ordinary `name` must
 *      not restore a rejected `username`. Artifact kinds are folded onto the
 *      selector types the wrapper actually computes (`handle`/`social` →
 *      `username`, `subdomain` → `domain`, …) so the key matches what dispatch
 *      sees.
 *
 *   2. A REFUSAL MUST READ AS A REFUSAL. `ok: false`, no `skipped`, no `dropped`,
 *      and none of the `SKIP_REASON_RE` vocabulary (in particular the word
 *      "gated"), so `deriveOk` logs it as a non-success and it never disappears
 *      into the intentional-skip bucket the way the unknown-tool sink did.
 *
 * WHAT IT IS NOT. It is not a change to what a rejection MEANS: the row stays
 * persisted, stays on the Evidence board, and keeps its forensic history. Only
 * its authority to START WORK is withheld — and an analyst can restore that by
 * resetting the verdict.
 */

import { dispatchKey } from "./dispatch-quarantine.ts";
import { kindAliases } from "./kind-alias.ts";

/** The refusal marker, on the payload and in the log, so it is greppable. */
export const REJECTED_DISPATCH_REFUSAL_MARKER = "analyst_rejected_dispatch_boundary";

/**
 * Every selector type a rejected artifact of this kind should refuse under.
 * The alias table itself lives in `lib/kind-alias.ts` — the ONE table the
 * write-side dedup keys, the read-side rejection key and this dispatch guard
 * all share, so a kind spelling honoured here is honoured everywhere.
 */
export function rejectedTypeAliases(kind: string): string[] {
  return kindAliases(kind);
}

/** An artifact row the analyst rejected, as `loadReviewsForThread` resolves it. */
export type RejectedSelectorRow = {
  id?: unknown;
  kind?: unknown;
  value?: unknown;
};

/**
 * Build the refused-key set from the analyst's rejected rows.
 *
 * `normalize` is injected (callers pass `circuit.normalizeSelector`) so the key
 * is computed by the SAME function dispatch uses, and so this module stays free
 * of the circuit/cache import graph.
 */
export function buildRejectedDispatchKeys(
  rows: readonly RejectedSelectorRow[] | null | undefined,
  normalize: (kind: string, raw: unknown) => string,
): Set<string> {
  const out = new Set<string>();
  for (const row of rows ?? []) {
    const kind = typeof row?.kind === "string" ? row.kind : "";
    const raw = typeof row?.value === "string" ? row.value : "";
    if (!kind || !raw) continue;
    for (const t of rejectedTypeAliases(kind)) {
      const norm = normalize(t, raw);
      if (norm) out.add(dispatchKey(t, norm));
    }
  }
  return out;
}

/**
 * Is this dispatch refused because the analyst rejected the selector?
 * Fails OPEN on an empty selector — a call with no target is not a rejected-
 * selector call (finalize, record_finding, the planner).
 */
export function isRejectedDispatch(
  rejected: ReadonlySet<string>,
  candidateTypes: readonly string[],
  normalizedValue: string,
): string | null {
  if (!normalizedValue) return null;
  for (const t of candidateTypes) {
    if (rejected.has(dispatchKey(t, normalizedValue))) return t;
  }
  return null;
}

/**
 * The refusal payload. Explicitly NOT a success and explicitly NOT a skip — see
 * rule 2 in the header.
 */
export function rejectionRefusal(
  tool: string,
  selectorType: string,
  normalizedValue: string,
): Record<string, unknown> {
  return {
    ok: false,
    refused: true,
    refused_by: REJECTED_DISPATCH_REFUSAL_MARKER,
    tool,
    selector_type: selectorType,
    selector: normalizedValue,
    error:
      `refused: ${selectorType} "${normalizedValue}" was marked FALSE / unrelated by the analyst ` +
      `and may not start a tool call. The row remains in the evidence history; only its ` +
      `authority to drive work is withheld. Do not re-derive or re-propose it. ` +
      `An analyst can restore it by resetting the review.`,
  };
}
