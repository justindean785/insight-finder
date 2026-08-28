// lib/selector-normalize.ts — canonical selector spelling, at WRITE time.
//
// WHY THIS IS A LEAF MODULE. `normPhoneE164` used to live in `lib/cluster.ts`,
// which imports `../reviews.ts` (a DB module). The auto-persist extractor needs
// the fold and nothing else, so importing it from `cluster.ts` would drag a
// database module into the extractor's graph for one pure function. Same
// reasoning `reveal-policy.ts` gives for its own existence. `cluster.ts`
// re-exports `normPhoneE164`, so its existing consumers are unaffected.
//
// MEASURED 2026-08-26 — the production run this module exists to fix.
// Seed "Jesus Acosta, age 31" → pivot +19172915568. ONE phone became FOUR
// artifacts:
//
//     +19172915568   seed
//     19172915568    clus_45d02dea
//     9172915568     clus_45d02dea
//     79172915568    clus_65fc6d70   ← Russian +7 prefix, a DIFFERENT number
//
// The first three are one number written three ways. Dedup everywhere is
// `checkpointKey(kind, value)` — exact equality on the lowercased value — so
// three spellings meant three rows, three cluster memberships and three entries
// in an Evidence count that is supposed to count distinct facts.
//
// The fold below already existed and already got this right; it simply ran at
// CLUSTER time and never at write time, so the clusterer and the artifact table
// disagreed about what "one phone" is. Calling it at write time closes that
// split-brain and makes the existing dedup do the rest.

/**
 * Fold a phone to E.164 for identity comparison.
 *
 * Moved verbatim from `lib/cluster.ts` — behaviour is unchanged, only the call
 * sites grew. Note what it does and does NOT collapse on the measured values:
 *
 *     +19172915568 → +19172915568
 *      19172915568 → +19172915568     (11 digits, leading 1)
 *       9172915568 → +19172915568     (10 digits, NANP assumption)
 *      79172915568 → +79172915568     ← stays DISTINCT
 *
 * The `+7` number shares ten digits with the subject's US number and is a
 * different number in a different country. Collapsing those would be a false
 * identity claim, which is worse than the duplicate this module exists to fix.
 *
 * ⚠️ The 10-digit → `+1` branch is a NANP guess and mislabels a foreign
 * 10-digit number. That is pre-existing shipped semantics, not a new opinion:
 * it is what the clusterer has always done. Adopting it at write time makes the
 * two agree. Changing it is a separate decision with its own evidence.
 *
 * Returns null when no confident fold exists (fewer than 8 or more than 15
 * digits) — callers decide what to do with the raw value in that band.
 */
export function normPhoneE164(v: string): string | null {
  const digits = String(v ?? "").replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  return null;
}

/**
 * STORAGE canonicaliser — the form a phone is PERSISTED in.
 *
 * `normPhoneE164` is a comparison fold and returns null outside 8–15 digits,
 * but both write paths have always accepted 7. Substituting it directly would
 * silently stop persisting 7-digit local numbers, turning an identity fix into
 * an admission change. Falling back to the raw digits-and-plus form keeps
 * today's accept/reject set exactly: only the SPELLING of an 8–15 digit number
 * moves.
 *
 * Returns null only for what the write paths already rejected (<7 digits).
 */
export function canonicalPhoneValue(raw: string): string | null {
  const digitsAndPlus = String(raw ?? "").replace(/[^\d+]/g, "");
  if (digitsAndPlus.replace(/\D/g, "").length < 7) return null;
  return normPhoneE164(digitsAndPlus) ?? digitsAndPlus;
}

/** Secondary-unit designators. Stripped ONLY when comparing two street lines for
 *  redundancy — never from the value that gets persisted. "APT" is the entire
 *  difference between the two spellings in the measured row below, so a
 *  comparison that keeps it sees two distinct lines and concatenates them. */
const UNIT_DESIGNATOR_RE = /\b(?:apt|apartment|unit|ste|suite|rm|room|fl|floor|no|num|number)\b/gi;

/**
 * Comparison form of a street line: lowercase, unit designators removed, then
 * every non-alphanumeric dropped. Punctuation and spacing carry no address
 * identity — `"1110 ANDERSON AVE3F"` and `"1110 ANDERSON AVE APT 3F"` are the
 * same line typed two ways, and both fold to `1110andersonave3f`.
 *
 * This is a COMPARISON key only. Nothing persists in this form.
 */
function addressFold(s: string): string {
  return s.toLowerCase().replace(UNIT_DESIGNATOR_RE, " ").replace(/[^a-z0-9]/g, "");
}

/** Collapse runs of whitespace; "" for anything that is not a usable string. */
function clean(v: unknown): string {
  return typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "";
}

/**
 * Is one street line redundant against the other — the same line, or a less
 * complete spelling of it?
 *
 * PREFIX, NEVER SUBSTRING. A substring test looks like the more thorough
 * choice and destroys data: `"APT 3F"` folds to `3f`, which appears inside
 * `1110andersonave3f`, so a genuinely distinct secondary line would be deleted
 * as a "duplicate" of the street it sits under. It would also merge neighbours
 * in corpora that store `12 Oak St` and `120 Oak St`. A prefix relation is the
 * only one that actually means "the same line, continued".
 */
function redundantAgainst(a: string, b: string): boolean {
  const fa = addressFold(a);
  const fb = addressFold(b);
  if (!fa || !fb) return false;
  if (fa === fb) return true;
  const [shorter, longer] = fa.length <= fb.length ? [fa, fb] : [fb, fa];
  return longer.startsWith(shorter);
}

/**
 * Compose a readable address from a provider's raw component fields.
 *
 * MEASURED 2026-08-26 — the value that shipped to the board, the report and the
 * export was:
 *
 *     1110 ANDERSON AVE3F 1110 ANDERSON AVE APT 3F BRONX NY 10452
 *
 * `address_street` ("1110 ANDERSON AVE3F", already corpus junk) and
 * `address_street2` ("1110 ANDERSON AVE APT 3F", the same line spelled
 * properly) were `.join(" ")`ed with city/state/zip and no separators, so the
 * street appeared twice and ran into the unit number. That string is the
 * artifact's `value`, which is what renders everywhere.
 *
 * TWO RULES, and the second is the important one:
 *
 *  1. When one street line is redundant against the other, keep the
 *     better-formed spelling — more whitespace-separated tokens wins (it
 *     carries the structure), length breaks a tie.
 *  2. When they are NOT redundant, KEEP BOTH. A genuinely distinct second line
 *     ("Building C", "c/o Ramirez") is evidence; an ugly string is a
 *     readability cost. Those are not symmetric, so this never drops on
 *     uncertainty — it only joins legibly.
 *
 * Returns "" when there is nothing usable; the caller's `normalizeFinding`
 * gate still has final say on whether the result is a valid address.
 */
export function composeAddress(input: {
  street?: unknown;
  street2?: unknown;
  city?: unknown;
  state?: unknown;
  postcode?: unknown;
}): string {
  const street = clean(input.street);
  const street2 = clean(input.street2);
  const city = clean(input.city);
  const state = clean(input.state);
  const postcode = clean(input.postcode);

  const streetLines: string[] = [];
  if (street && street2 && redundantAgainst(street, street2)) {
    // Same line twice. Keep the spelling that carries more structure.
    const tokens = (s: string) => s.split(" ").length;
    const better = tokens(street2) > tokens(street) ||
        (tokens(street2) === tokens(street) && street2.length > street.length)
      ? street2
      : street;
    streetLines.push(better);
  } else {
    if (street) streetLines.push(street);
    if (street2) streetLines.push(street2);
  }

  // `STATE ZIP` is one field to a reader ("NY 10452"), so it is joined with a
  // space and then treated as a single comma-separated component.
  const stateZip = [state, postcode].filter(Boolean).join(" ");
  return [...streetLines, city, stateZip].filter(Boolean).join(", ");
}
