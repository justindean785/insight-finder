/**
 * unproven-linkage — PROMOTION quarantine: collect everywhere, promote nowhere.
 *
 * ## What changed, and why the old rule is not simply "wrong"
 *
 * Until now `subject_unlinked` was a DISPATCH gate: a quarantined selector
 * could not reach a live tool call at all (#518, hardened by #519). That
 * closed a real hole — a name-only collision harvest was spending paid calls
 * enumerating strangers — and it is why this module does not delete that
 * machinery, only re-points it.
 *
 * The cost, measured on the 2026-09-11 person-seed run (`d4873abc`): the guard
 * refused `username_sweep` on `ufland40` and refused breach lookups on the
 * emails harvested beside it, so the run was **structurally forbidden from
 * proving or disproving the very link it was investigating** — and then
 * reported "no authoritative findings". Refusing to look is not the same as
 * looking and finding nothing, but the case file could not tell them apart.
 *
 * Operator decision (2026-09-12): flip it. Always collect; never auto-promote.
 *
 * ## The invariant that makes this safe
 *
 * Dispatch is allowed. **Authority is not inherited.** A call made against a
 * selector whose linkage to the subject is unproven produces findings whose
 * linkage is equally unproven, so every finding it yields is stamped
 * `subject_unlinked` with a reason naming the parent selector.
 *
 * Without that stamp this change would be a straight regression to the hole
 * #433 closed: `username_sweep` on a harvested username is not a name-only
 * query, so the write-path quarantine gate in `auto-persist-findings.ts` —
 * which keys on QUERY SHAPE — would not have fired, and a stranger's profiles
 * would have persisted at full subject authority, entered identity clusters
 * and reached the report. The taint is not a nicety; it is the thing that
 * makes dispatch safe to open.
 *
 * The four boundaries now read:
 *   write     (#433) — unchanged. Query-shape quarantine still stamps.
 *   pivot     (#436) — relaxed to a WARNING: the card runs, and says why it is weak.
 *   promote   (#448) — unchanged, and now load-bearing for dispatch too.
 *   dispatch  (#518/#519) — quarantine no longer refuses; ANALYST REJECTION STILL DOES.
 *
 * ## Analyst rejection is NOT affected
 *
 * A Dismiss is a human ruling about reality; quarantine is a machine claim
 * about provenance. Spending the analyst's money re-investigating a row they
 * struck out is the product arguing with them, and that refusal stays exactly
 * where it was.
 *
 * Zero imports on purpose: this sits under both the dispatch wrapper and the
 * write path and must not pull either into a cycle.
 */

/** Where the dispatch wrapper records that a call went out on a quarantined
 *  selector. Lives under `_runtime` on the tool result, so it travels with the
 *  output into the step envelope the extractor reads. */
export const UNPROVEN_LINKAGE_KEY = "unproven_linkage";

export interface UnprovenLinkage {
  /** Canonical selector type the refusal keyed on (`username`, `email`, …). */
  parent_type: string;
  /** Normalized selector the call was dispatched against. */
  parent_value: string;
  /** The parent artifact's recorded `subject_unlinked_reason`, when known. */
  parent_reason: string | null;
}

/** Build the marker the wrapper attaches to a permitted quarantined dispatch. */
export function unprovenLinkageMarker(
  parentType: string,
  parentValue: string,
  parentReason?: string | null,
): UnprovenLinkage {
  return {
    parent_type: String(parentType ?? "").trim().toLowerCase(),
    parent_value: String(parentValue ?? "").trim(),
    parent_reason: parentReason ? String(parentReason) : null,
  };
}

/**
 * Read the marker back off a tool result. Defensive about shape because this
 * runs over whatever the step envelope carried, including replayed cache rows
 * and timeout stubs.
 */
export function unprovenLinkageFromOutput(output: unknown): UnprovenLinkage | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) return null;
  const runtime = (output as Record<string, unknown>)._runtime;
  if (!runtime || typeof runtime !== "object" || Array.isArray(runtime)) return null;
  const raw = (runtime as Record<string, unknown>)[UNPROVEN_LINKAGE_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const parentType = typeof r.parent_type === "string" ? r.parent_type : "";
  const parentValue = typeof r.parent_value === "string" ? r.parent_value : "";
  if (!parentValue) return null;
  return {
    parent_type: parentType,
    parent_value: parentValue,
    parent_reason: typeof r.parent_reason === "string" ? r.parent_reason : null,
  };
}

/**
 * The quarantine context stamped on EVERY finding derived from a call made
 * against an unproven-linkage selector.
 *
 * Shaped exactly like the write path's own stamps (`subject_unlinked` +
 * `subject_unlinked_reason`) so every existing reader — `isExcluded` in
 * `lib/cluster.ts`, `isClusterIneligible` on the frontend, the dispatch guard
 * itself, the report's collision section — honours it with no new plumbing.
 * That reuse is the point: a NEW flag would have to be taught to six readers,
 * and the one that was missed would be the leak.
 *
 * The reason names the parent so an analyst reading the Evidence board can see
 * WHY a row they recognise has no authority, and what would release it.
 */
export function derivedUnlinkedContext(parent: UnprovenLinkage): Record<string, unknown> {
  const parentLabel = parent.parent_type
    ? `${parent.parent_type} "${parent.parent_value}"`
    : `"${parent.parent_value}"`;
  const because = parent.parent_reason ? ` — the parent was quarantined because: ${parent.parent_reason}` : "";
  return {
    subject_unlinked: true,
    subject_unlinked_reason:
      `derived from a lookup on ${parentLabel}, whose own linkage to the subject is unproven${because}. ` +
      `The lookup was allowed so the link can be tested, but nothing it returned inherits subject authority ` +
      `until the parent selector is corroborated or an analyst confirms the linkage.`,
    /** Machine-readable provenance, so a release path can find the whole set. */
    unproven_linkage_parent: `${parent.parent_type}:${parent.parent_value}`,
  };
}
