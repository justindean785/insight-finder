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
    if (isSubjectUnlinked(a.metadata)) quarantined.add(key);
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
