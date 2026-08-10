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
  value: string;
  metadata?: Record<string, unknown> | null;
};

/**
 * Split a set of artifacts into the normalized selector values that are
 * quarantined and those that carry at least one un-quarantined observation.
 *
 * WHY BOTH SETS. Quarantine is a statement about a ROW's provenance, not about a
 * string. The same phone number can arrive twice: once from a name-only sweep
 * (unproven linkage) and once from a provider that matched on the subject's own
 * email (linkage by construction). Blocking the value outright would discard the
 * second, legitimately-linked observation and suppress a real lead — over-blocking
 * is its own integrity failure, just a quieter one. So a selector is inert only
 * while EVERY row carrying it is quarantined; `isInert` below encodes exactly that.
 *
 * `normalize` is injected rather than imported so this module stays free of the
 * pivot layer's dependencies; callers pass the same `normalizeTarget` they key
 * their own skip/seed/queried sets with, which keeps every set in one keyspace.
 */
export function quarantineSets(
  artifacts: readonly QuarantineInput[],
  normalize: (value: string) => string,
): { quarantined: Set<string>; linked: Set<string> } {
  const quarantined = new Set<string>();
  const linked = new Set<string>();
  for (const a of artifacts) {
    const key = normalize(a.value ?? "");
    if (!key) continue;
    if (isSubjectUnlinked(a.metadata)) quarantined.add(key);
    else linked.add(key);
  }
  return { quarantined, linked };
}

/**
 * Is this normalized selector inert — quarantined with no surviving linked
 * observation to restore it?
 */
export function isInert(
  key: string,
  sets: { quarantined: Set<string>; linked: Set<string> },
): boolean {
  return sets.quarantined.has(key) && !sets.linked.has(key);
}
