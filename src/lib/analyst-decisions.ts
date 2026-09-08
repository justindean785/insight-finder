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
 *   dismissed  a REJECTION (the visible "Dismiss" action). The selector leaves the
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
 * The cross-investigation carrier of a `wrong` verdict: the memory lesson that
 * teaches every future run to skip the selector. ONE builder, because the edge
 * function's memory reader (supabase/functions/osint-agent/lib/memory-supersession.ts,
 * `ANALYST_FALSE_LESSON_RE`) recognises THIS wording to tell a human ruling apart
 * from the agent's own identity theories — and to let the ruling supersede them at
 * recall time. Production rows already carry this text; change the wording only
 * together with that regex and the test that pins both.
 */
export const ANALYST_FALSE_POSITIVE_MARKER = "as FALSE / incorrect data";

export function buildFalsePositiveLesson(value: string, kind?: string | null): {
  kind: "lesson";
  subject: string;
  subject_kind: string | null;
  related_values: string[];
  content: string;
  confidence: number;
} {
  const kindHint = kind ? ` (${kind})` : "";
  return {
    kind: "lesson",
    subject: String(value).trim().toLowerCase(),
    subject_kind: kind ?? null,
    related_values: [],
    content:
      `Analyst marked "${value}"${kindHint} ${ANALYST_FALSE_POSITIVE_MARKER}. ` +
      `Do NOT re-propose this artifact in future investigations for the same user. ` +
      `Treat as a confirmed false positive even if a tool surfaces it again.`,
    confidence: 95,
  };
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
 * Rejection follows PROVENANCE, not just the row.
 *
 * A rejection says "this is not the subject's". The row the analyst clicked is
 * only one expression of that; the tool output derived FROM it is the rest, and
 * on 2026-09-08 that gap put two plaintext breach passwords into the exported
 * report's "Network Connections — Breach / Exposure" section as part of the
 * subject's network, minutes after the analyst had rejected the email they were
 * derived from and the agent itself had written "this is a completely different
 * identity profile from what the breach data suggested".
 *
 * The join is `metadata.parent_selector` / `metadata.queried_selector` — the
 * pipeline's own record of which selector a tool was run against. That is
 * deliberately NOT the same thing as matching on value: `normalizeTarget`
 * collapses punctuation, so a value-keyed rejection lets an ordinary `name`
 * "Jordan Vale" disable a `username` "jordan.vale" (the hazard CLAUDE.md
 * documents for the quarantine keyspace). An explicit provenance edge carries
 * no such collision — it was written by the code that made the call.
 *
 * Guards: the parent value must be short enough to be a selector rather than a
 * prose artifact value, and the match is exact after normalization. Derivation
 * is closed transitively (bounded), so rejecting a seed also drops a
 * grandchild.
 */
export function buildRejectedDerivationIds(
  artifacts: readonly DecisionInput[],
  rejectedIds: ReadonlySet<string>,
  normalize: (value: string) => string,
): Set<string> {
  const derived = new Set<string>();
  const parentsOf = new Map<string, string[]>();
  for (const a of artifacts) {
    const meta = (a.metadata ?? {}) as Record<string, unknown>;
    const parents = ["parent_selector", "queried_selector"]
      .map((field) => meta[field])
      .filter((value): value is string =>
        typeof value === "string" && value.trim().length > 0 && value.trim().length <= MAX_SELECTOR_VALUE_LEN
      )
      .map(normalize)
      .filter(Boolean);
    if (parents.length) parentsOf.set(a.id, parents);
  }
  // Selector VALUES that are currently out — seeded from the analyst's rejected
  // rows, then grown as their descendants are pulled in.
  const out = new Set<string>();
  const seed = (a: DecisionInput) => {
    const v = (a.value ?? "").trim();
    if (v && v.length <= MAX_SELECTOR_VALUE_LEN) out.add(normalize(v));
  };
  for (const a of artifacts) if (rejectedIds.has(a.id)) seed(a);
  out.delete("");

  for (let round = 0; round < MAX_DERIVATION_ROUNDS; round++) {
    let grew = false;
    for (const a of artifacts) {
      if (rejectedIds.has(a.id) || derived.has(a.id)) continue;
      const parents = parentsOf.get(a.id) ?? [];
      if (!parents.some((parent) => out.has(parent))) continue;
      derived.add(a.id);
      const before = out.size;
      seed(a);
      out.delete("");
      if (out.size !== before) grew = true;
    }
    if (!grew) break;
  }
  return derived;
}

/** A provenance selector is not a sentence — longer values are artifact prose. */
const MAX_SELECTOR_VALUE_LEN = 120;
/** Derivation chains are shallow in practice; the bound just makes the fixpoint total. */
const MAX_DERIVATION_ROUNDS = 5;

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
