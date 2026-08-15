/**
 * quarantine.ts — the frontend half of the `subject_unlinked` authority boundary.
 *
 * This is the deliberate mirror of `supabase/functions/osint-agent/lib/quarantine.ts`.
 * The edge module owns the WRITE and backend-read sides; this one owns every
 * frontend read. They must agree on the predicate, so both are strictly
 * `=== true` and both refuse to infer quarantine from a truthy-ish value.
 *
 * THE CONTRACT — authority, not evidence. A quarantined row stays persisted,
 * visible and auditable on the Evidence board and in the report's collision
 * section. It may not become an actionable pivot, and it may not steer the next
 * run. Making it inert is the fix; hiding it would be a different bug.
 *
 * WHY THE FRONTEND NEEDS ITS OWN COPY. The backend gate stops rows from entering
 * the graph and from counting as corroboration, but it never stops them being
 * PERSISTED — quarantine is disclosure, so the rows reach the client by design.
 * `useThreadArtifacts` reads `public.artifacts` directly, so the client sees the
 * quarantined rows exactly as stored and has to make its own authority decision.
 */

/**
 * Is this artifact's metadata marked `subject_unlinked`?
 *
 * Strictly `=== true`, matching the edge module: a string "true", a truthy
 * number, or absent metadata are all NOT accusations — a legacy row written
 * before the gate existed must keep its authority rather than be silently
 * disenfranchised by a coercion.
 */
export function isSubjectUnlinked(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  return (metadata as Record<string, unknown>).subject_unlinked === true;
}

/**
 * Is this row quarantined for AUTHORITY purposes — i.e. may it not be promoted
 * to subject evidence?
 *
 * `subject_unlinked` AND no explicit linkage decision. This is the one predicate
 * every promotion path must consult, and it exists because there is more than one
 * such path: `labelForArtifact` decides the integrity LABEL, `evidenceStatus`
 * decides the display STATUS, and each had its own independent
 * `attested -> promoted` short-circuit. They agreed only by coincidence, and when
 * the label gate landed first they disagreed outright — one row reading
 * CORRELATED on its confidence pill and "Verified" on its status chip, while the
 * Confirmed KPI counted it. Two doors into the same room need one lock.
 *
 * WHY ORDINARY ATTESTATION DOES NOT CLEAR IT. `reviewed`/"confirmed"/"key" answer
 * "is this value real?" — they are set by flows that never adjudicated PROVENANCE.
 * Quarantine is a machine claim about provenance, so only an explicit human claim
 * about provenance clears it: `linkage_confirmed`. Operator-approved, 2026-08-10.
 *
 * AUTHORITY, NOT DELETION. A quarantined row stays persisted, visible, exportable
 * and reviewable, and keeps its `subject_unlinked_reason`. Only the promotion is
 * withheld.
 */
export function isQuarantined(metadata: unknown): boolean {
  if (!isSubjectUnlinked(metadata)) return false;
  return (metadata as Record<string, unknown>).linkage_confirmed !== true;
}

/**
 * The pipeline's own words for WHY this row is unlinked.
 *
 * Quarantine is disclosure, so every surface that shows a quarantined row has to
 * be able to state the reason — and it must be the BACKEND'S reason, quoted, not
 * a paraphrase invented at the presentation layer. The precedence and the
 * fallback sentence are deliberately identical to the `subject_unlinked` branch
 * of `conflictNote` in `intel.ts` (the report's collision section), so the
 * Evidence board and the report never explain the same row two different ways.
 * The quarantine test suite pins them to the same string.
 *
 * Returns `null` for a row that is not quarantined — there is nothing to
 * disclose, and an empty caveat must not render as one.
 */
export function quarantineReason(metadata: unknown): string | null {
  if (!isSubjectUnlinked(metadata)) return null;
  const m = metadata as Record<string, unknown>;
  const recorded = m.subject_unlinked_reason;
  if (typeof recorded === "string" && recorded.trim()) return recorded.trim();
  return "harvested from a name-only query — linkage to the subject is unproven";
}

/** The artifact shape this module needs — structural, so callers can pass either
 *  a full `Artifact` or a lighter projection. */
export type QuarantineInput = {
  kind: string;
  value: string;
  metadata?: Record<string, unknown> | null;
};

/**
 * Split a set of artifacts into the PIVOT IDENTITIES that are quarantined and
 * those that carry at least one un-quarantined observation.
 *
 * WHY BOTH SETS. Quarantine is a statement about a ROW's provenance, not about a
 * string. The same phone number can arrive twice: once from a name-only sweep
 * (unproven linkage) and once from a provider that matched on the subject's own
 * email (linkage by construction). Blocking the value outright would discard the
 * second, legitimately-linked observation and suppress a real lead — over-blocking
 * is its own integrity failure, just a quieter one. So a selector is inert only
 * while EVERY row carrying it is quarantined; `isInert` below encodes exactly that.
 *
 * WHY THE KEY IS TYPE-AWARE, AND WHY THAT IS LOAD-BEARING. The first version of
 * this module keyed on the normalized VALUE alone, which is not an identity.
 * `normalizeTarget` collapses every non-alphanumeric run to a single space — that
 * is deliberate, so "O'Brien" / "O Brien" / "O.Brien" agree — but it also means
 *
 *     username  jordan.vale   ->  "jordan vale"
 *     name      Jordan Vale   ->  "jordan vale"
 *
 * collide. An ordinary `name` row then landed in `linked` and RESTORED authority
 * to a quarantined `username`, silently undoing the quarantine through a row that
 * says nothing about it. Keying on `type:value` — the same canonical pivot
 * identity `canonicalKey` uses — is what makes the two sets talk about the same
 * thing the pivot engine does.
 *
 * WHY NON-PIVOTABLE KINDS ARE EXCLUDED ENTIRELY. `toPivotType` returns null for
 * kinds that can never become a pivot (address, organization, breach_exposure…).
 * Such a row cannot be the subject of an authority decision, so it must neither
 * quarantine an identity nor restore one — letting it into `linked` was the same
 * collision bug by a second route.
 *
 * `normalize` and `toPivotType` are injected rather than imported so this module
 * stays free of the pivot layer's dependencies; callers pass the same
 * `normalizeTarget` and `KIND_TO_PIVOT` lookup they key their own sets with,
 * which keeps every set in one keyspace.
 */
export function quarantineSets(
  artifacts: readonly QuarantineInput[],
  normalize: (value: string) => string,
  toPivotType: (kind: string) => string | null,
): { quarantined: Set<string>; linked: Set<string> } {
  const quarantined = new Set<string>();
  const linked = new Set<string>();
  for (const a of artifacts) {
    const type = toPivotType(a.kind ?? "");
    if (!type) continue; // not a pivotable identity — no authority to grant or deny
    const value = normalize(a.value ?? "");
    if (!value) continue;
    const key = `${type}:${value}`;
    // ACTIVE quarantine, not the historical flag. `isQuarantined` — never
    // `isSubjectUnlinked` — is what "quarantined" means for an AUTHORITY
    // decision, and dispatching a pivot is an authority decision.
    //
    // This used to read `isSubjectUnlinked`, which silently made this the one
    // authority boundary that ignored `linkage_confirmed`. A row an analyst had
    // explicitly adjudicated came back CONFIRMED at the label
    // (`labelForArtifact`), Verified on its chip (`evidenceStatus`) and uncapped
    // in its number (`adjustedConfidence`) — and then landed in `quarantined`
    // here, so `isInert` still refused to offer it as a pivot. The release was
    // real everywhere except on the one surface where the analyst could act on
    // it, which is a split brain of exactly the kind this module exists to
    // prevent. It also made the docstring above ("carry at least one
    // un-quarantined observation") false.
    if (isQuarantined(a.metadata)) quarantined.add(key);
    else linked.add(key);
  }
  return { quarantined, linked };
}

/**
 * Is this pivot identity inert — quarantined with no surviving linked observation
 * to restore it? `key` must be a `type:normalizedValue` key from the same
 * keyspace `quarantineSets` built (i.e. `canonicalKey`).
 */
export function isInert(
  key: string,
  sets: { quarantined: Set<string>; linked: Set<string> },
): boolean {
  return sets.quarantined.has(key) && !sets.linked.has(key);
}

/**
 * Should a same-kind cluster start expanded?
 *
 * Large clusters fold by default — EXCEPT when one of the rows inside is
 * quarantined. A warning the analyst has to expand to find is a warning that
 * does not exist, and the collapsed subheader shows only a count, never the
 * quarantined values or the pipeline's recorded reason for distrusting them.
 *
 * DEFAULT ONLY: an explicit toggle in `openClusters` still wins, because an
 * analyst who has read the rows is entitled to fold them away again.
 *
 * It lives HERE, beside the predicate it depends on, because it is a disclosure
 * rule rather than layout trivia — when quarantine may be hidden is a quarantine
 * decision. Pinned by `evidence-disclosure.test.ts`. The call site carried this
 * exact promise in a comment for a while and never implemented it. (Cursor
 * review, PR #462.)
 */
export function clusterDefaultOpen(collapsible: boolean, quarantinedCount: number): boolean {
  return !collapsible || quarantinedCount > 0;
}
