/**
 * analyst-decisions.ts — the PURE half of analyst review semantics.
 *
 * `review.ts` owns persistence (Supabase, the hook, the cache). Everything a
 * consumer needs in order to HONOUR a decision — without touching the network —
 * lives here, so the pivot engine, the report and the dispatch guard can import
 * it without dragging the Supabase client into a pure module or a unit test.
 *
 * THE FOUR DECISIONS, and what each one is allowed to change:
 *
 *   confirmed  an analyst-accepted PROPOSITION. It reaches the next run's context
 *              as something not to re-litigate. It is NOT a second source: it
 *              never raises evidence confidence, never manufactures corroboration,
 *              and never clears `subject_unlinked` quarantine (only an explicit
 *              `linkage_confirmed` does that).
 *   key        a PRIORITY. It ranks above comparable ordinary selectors in pivot
 *              planning and is named as a priority in model context. Priority
 *              only — not confidence, not source classes, not corroboration.
 *   recheck    a WORKFLOW TASK. The persisted row is the durable verification
 *              task; the next run sees it as a recheck task in context and the
 *              pivot surfaces render it as a verification card. Nothing about the
 *              evidence changes.
 *   dismissed  a REJECTION (the visible "False" action). The selector leaves the
 *   wrong      working set, the pivot set, dispatch, clustering and every
 *              authoritative report section — by artifact id AND by normalized
 *              `kind:value`, so a re-record under a new id cannot revive it. The
 *              row itself is preserved in forensic history. `wrong` is `dismissed`
 *              plus a cross-investigation memory lesson.
 *
 * `metadata.false_positive` is a LEGACY per-artifact flag with the same meaning
 * as `dismissed`. It is read here as a rejection so old rows keep their status,
 * but it is no longer written by the product — the review verdict is the one
 * contract.
 */

export type ReviewState =
  | "new"
  | "confirmed"
  | "recheck"
  | "key"
  | "dismissed"
  | "wrong";

/** Verdicts that mean "the analyst rejected this" — mirrors reviews.ts on the edge function. */
export const REJECTED_REVIEW_STATES: ReadonlySet<ReviewState> = new Set(["dismissed", "wrong"]);

/** Any recorded verdict at all — everything except the absence of one. */
export const NON_NEW_REVIEW_STATES: ReadonlySet<ReviewState> = new Set([
  "confirmed", "key", "recheck", "dismissed", "wrong",
]);

/**
 * Did the analyst reject this row?
 *
 * Accepts a loose string so callers holding a `ReviewAdjustment` (which also
 * admits "new" | null | undefined) can ask without a cast. One predicate on
 * purpose: a second inline `r === "dismissed" || r === "wrong"` is how two
 * signals drift apart.
 */
export function isRejectedReview(state: string | null | undefined): boolean {
  return !!state && REJECTED_REVIEW_STATES.has(state as ReviewState);
}

export function isNonNewReview(state: string | null | undefined): boolean {
  return !!state && NON_NEW_REVIEW_STATES.has(state as ReviewState);
}

/** The minimal artifact shape a decision can be evaluated against. */
export type DecisionInput = {
  id: string;
  kind: string;
  value: string;
  metadata?: Record<string, unknown> | null;
};

/**
 * Is this ROW rejected — by analyst verdict, or by the legacy metadata flag?
 * The one predicate every frontend consumer uses to decide "may this row still
 * carry authority?". Keeping the legacy flag here (rather than in each caller)
 * is what makes the two signals one contract.
 */
export function isRejectedArtifact(
  a: Pick<DecisionInput, "id" | "metadata">,
  review: string | null | undefined,
): boolean {
  if (isRejectedReview(review)) return true;
  const meta = a.metadata;
  return !!meta && typeof meta === "object" && (meta as Record<string, unknown>).false_positive === true;
}

/**
 * Scoped re-investigation prompt for a single artifact an analyst flagged
 * "recheck". Phrased so the agent runs *fresh, independent* corroboration on
 * exactly this value rather than restating what it already found.
 */
export function recheckPrompt(value: string, kind?: string): string {
  const k = kind ? ` (${kind})` : "";
  return (
    `Re-verify this specific finding: "${value}"${k}. ` +
    `An analyst flagged it for another look — run additional independent ` +
    `tools/sources to confirm or refute it, then report whether it holds up ` +
    `and at what confidence.`
  );
}

/**
 * The analyst's decisions projected onto PIVOT IDENTITIES (`type:normalizedValue`)
 * and artifact ids, in the same keyspace the pivot engine and the quarantine
 * sets use.
 *
 * Rejection is keyed BOTH ways on purpose. Id-only exclusion is bypassable: the
 * same selector re-recorded under a fresh id (a later tool run, a cache clone)
 * would sail through. Value-only exclusion is over-broad: `normalizeTarget`
 * collapses punctuation, so a rejected `username` "jordan.vale" must not disable
 * an ordinary `name` "Jordan Vale". `type:value` is the identity; the id is the
 * direct expression of the verdict. Both are checked.
 *
 * `normalize` and `toPivotType` are injected so this module stays free of the
 * pivot layer's dependencies; callers pass `normalizeTarget` and the
 * `KIND_TO_PIVOT` lookup they key their own sets with.
 */
export type DecisionSets = {
  rejectedIds: Set<string>;
  rejectedKeys: Set<string>;
  keyKeys: Set<string>;
  recheckKeys: Set<string>;
  confirmedKeys: Set<string>;
  /** artifact id → the review state that produced the entry above (non-new only) */
  stateById: Map<string, ReviewState>;
};

export function buildDecisionSets(
  artifacts: readonly DecisionInput[],
  reviews: Record<string, string | null | undefined> | null | undefined,
  normalize: (value: string) => string,
  toPivotType: (kind: string) => string | null,
): DecisionSets {
  const out: DecisionSets = {
    rejectedIds: new Set(),
    rejectedKeys: new Set(),
    keyKeys: new Set(),
    recheckKeys: new Set(),
    confirmedKeys: new Set(),
    stateById: new Map(),
  };
  for (const a of artifacts) {
    const state = reviews?.[a.id] ?? null;
    const rejected = isRejectedArtifact(a, state);
    if (!rejected && !isNonNewReview(state)) continue;
    if (state && isNonNewReview(state)) out.stateById.set(a.id, state as ReviewState);
    const type = toPivotType(a.kind ?? "");
    const value = normalize(a.value ?? "");
    const key = type && value ? `${type}:${value}` : null;
    if (rejected) {
      out.rejectedIds.add(a.id);
      if (key) out.rejectedKeys.add(key);
      continue;
    }
    if (!key) continue;
    if (state === "key") out.keyKeys.add(key);
    else if (state === "recheck") out.recheckKeys.add(key);
    else if (state === "confirmed") out.confirmedKeys.add(key);
  }
  // A rejection outranks any positive decision on the SAME identity: if one
  // row of a selector was marked false and another row of the same selector
  // was marked key, the selector is still out of the working set. Rejection is
  // the analyst saying "not this"; a later positive mark on a duplicate row is
  // not a release.
  for (const k of out.rejectedKeys) {
    out.keyKeys.delete(k);
    out.recheckKeys.delete(k);
    out.confirmedKeys.delete(k);
  }
  return out;
}

/**
 * Should a MANUAL dispatch (a "Run this pivot" click, a queued pivot, a recheck
 * launch) of this selector be refused because the analyst rejected it?
 *
 * `type` may be a pivot type or an artifact kind — both arrive on the pivot bus
 * — so it is folded through `toPivotType` first. Keyed on `type:value`; an
 * unknown or non-pivotable type cannot match and is allowed through, because a
 * selector that could never have been reviewed as this identity was never
 * rejected as it either.
 */
export function isManualDispatchRefused(
  sets: Pick<DecisionSets, "rejectedKeys">,
  type: string | null | undefined,
  value: string,
  normalize: (value: string) => string,
  toPivotType: (kind: string) => string | null,
): boolean {
  const t = type ? (toPivotType(type) ?? type.trim().toLowerCase()) : null;
  const v = normalize(value ?? "");
  if (!t || !v) return false;
  return sets.rejectedKeys.has(`${t}:${v}`);
}

/** Result of a review write. A write either landed or it did not — there is no
 *  "probably" — and every caller that does something DEPENDENT on the verdict
 *  (launching a recheck, invalidating a cache) must branch on this. */
export type ReviewWriteResult =
  | { ok: true; state: ReviewState; /** false when the memory lesson did not persist (verdict still did) */ memoryTaught?: boolean }
  | { ok: false; error: string };
