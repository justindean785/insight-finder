// lib/artifact-hygiene.ts — write-path accuracy gates for `record_artifacts`.
//
// Measured on a real run (thread 2d0dcd03, build 8c6184b): 54 persisted
// artifacts, of which ~20 were not distinct observations. The Evidence counter
// therefore overstated the evidence by roughly 2x, and "Needs review 48" was
// mostly reviewing rows that never should have existed.
//
// These gates sit next to `validateArtifact` and feed the SAME `rejected[]`
// channel, so a refusal is legible as a refusal. That is deliberate: an earlier
// silent sink returned ok:true for a disabled tool and put a completed call
// into the chain of custody. A dropped row must always say why it was dropped.
//
// SCOPE — what these gates do NOT touch:
//   - No confidence math. confidence.ts and applyEvidenceCaps are the only
//     things that compute a number, and they were correct on every row of the
//     measured run. Nothing here re-scores anything.
//   - No masking, no redaction, no credential handling. Values are preserved
//     verbatim except for the one status word in G2, which is a label the UI
//     owns — never evidence, never PII, never a breach value.
//   - No quarantine. `subject_unlinked` is decided elsewhere and is untouched.

/** Any snake_case token, e.g. `serus_darkweb_scan` — but ALSO `2021_cv_01188`. */
const SNAKE_TOKEN_RE = /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/g;

/**
 * G5 — the identity of a recorded observation: (kind, value, authoritative source).
 *
 * ONE function so the in-batch key and the thread-wide key cannot drift. They
 * were previously the same expression written once; the moment a second copy
 * existed for the thread-wide lookup, a runtime key that disagreed with the
 * stored key would silently stop deduping and nothing would fail.
 *
 * `source` is part of the identity ON PURPOSE, and it is the same reason G4
 * states: four corpora returning the same answer is four coverage facts, and
 * collapsing them erases breadth — the data-loss shape flagged on #189's
 * migration and, later, the reason #305/#307's dedup work was abandoned.
 *
 * ⚠️ THE VALUE IS IN THE KEY, WHOLE AND UNPARSED. That is what makes this safe
 * to run thread-wide. `violations_total 670`, `violations_total 676` and
 * `violations_total 28` are three different values, therefore three different
 * keys, therefore three surviving rows. They are a CONTRADICTION, not a
 * duplicate, and `detectContradictions` is what should speak to them. Any future
 * change that normalises, rounds or fuzzy-matches the value here would convert a
 * visible disagreement into a silent merge. Do not.
 */
export function artifactDedupKey(input: {
  kind: string;
  value: string;
  source?: string | null;
}): string {
  return JSON.stringify([
    input.kind,
    input.value,
    (input.source ?? "").trim().toLowerCase(),
  ]);
}

/**
 * G1 — a QUEUED tool call is not an observation.
 *
 * The run persisted ten rows like `hawkcapo - socialfetch_lookup (pending
 * Instagram)`, each written before its tool returned and each carrying
 * `status: "observed"`. They are false at the moment of writing, they are
 * guaranteed duplicates once the real result lands, and they join the subject
 * cluster — so they also feed promoteConfidence's peer set.
 *
 * Keyed on a REAL TOOL NAME next to a parenthesised "pending"/"queued", never on
 * the word alone and never on snake_case SHAPE.
 *
 * WHY THE VOCABULARY IS REQUIRED. The first implementation accepted any
 * `word_word` token, which is also the shape of a docket number. Executed
 * against the shipped predicate, these three real records were all discarded as
 * "queued-tool placeholder, not an observation":
 *
 *     "Docket 2021_cv_01188 (pending appeal) — Anne Arundel"
 *     "Asylum application (pending decision) ref uscis_2024_88231"
 *     "Sentencing (queued) for case_number 19_cr_457"
 *
 * `(pending appeal)` and `(pending decision)` are ordinary court and immigration
 * language, so the shape heuristic destroys exactly the harm-bearing records this
 * product exists to collect.
 *
 * FAILS CLOSED — no vocabulary means no discard. An unrecognised value is kept,
 * because a duplicated placeholder is a counting error while a dropped court
 * record is evidence loss, and those are not symmetric.
 */
export function isQueuedPlaceholder(rawValue: string, knownTools?: ReadonlySet<string>): boolean {
  const value = (rawValue ?? "").trim();
  if (!value) return false;
  if (!/\((?:pending|queued)\b/i.test(value)) return false;
  if (!knownTools || knownTools.size === 0) return false;
  for (const m of value.toLowerCase().matchAll(SNAKE_TOKEN_RE)) {
    if (knownTools.has(m[0])) return true;
  }
  return false;
}

/**
 * The analyst label vocabulary. These words are the UI's to assign from a
 * stored confidence — they are never part of an observation.
 */
const STATUS_ASSERTION_RE = /\b(?:CONFIRMED|VERIFIED|CORRELATED|INFERRED|VERIFY)\b\s*/g;

/**
 * G2 — a status word inside the VALUE outranks the number beside it.
 *
 * The run stored `Instagram @hawkcapo - CONFIRMED active profile` at
 * confidence 40, with `reason_not_confirmed: "needs second independent class of
 * evidence"` on the same row. Because the value is rendered verbatim by every
 * surface — evidence table, graph, export, and any generated findings table —
 * the word survives every downstream control that was built to prevent exactly
 * that claim. Stripping it at the write layer is the only place that fixes all
 * of them at once.
 *
 * Matches ALL-CAPS only, so quoted source text ("nobody confirmed that story")
 * is evidence and is left alone.
 */
export function stripStatusAssertions(rawValue: string): { value: string; stripped: boolean } {
  const original = rawValue ?? "";
  const next = original.replace(STATUS_ASSERTION_RE, "").replace(/[ \t]{2,}/g, " ").trim();
  return { value: next, stripped: next !== original.trim() };
}

/** Zero-result phrasings: "0 hits", "no breach hits", "no records", … */
const NULL_RESULT_RE = /\b(?:0|no|zero)\s+(?:hit|breach|result|record|paste|match|exposure)s?\b/i;

/**
 * G4 — one null result is one row.
 *
 * `checkpointKey` is `kind:value` on the exact string, so the same fact worded
 * two ways writes two rows. The run recorded breach_check's single null result
 * twice — "no breach hits (breach_check)" and "0 hits (breach_check)", 33
 * seconds apart, both at confidence 60, both in the subject cluster.
 *
 * A null result is identified by WHAT WAS CHECKED, not by how it was phrased:
 * (kind, tool, selector). `source` is part of the key on purpose — four corpora
 * returning zero is four coverage facts, and an earlier dedup attempt that
 * omitted `source` would have collapsed them and erased breadth.
 *
 * Returns null for rows that actually found something; a hit is never
 * canonicalised by this path.
 */
export function nullResultKey(input: {
  kind: string;
  source?: string | null;
  value: string;
  selector?: string | null;
}): string | null {
  const raw = input.value ?? "";
  if (!NULL_RESULT_RE.test(raw)) return null;
  // A pure null result says ONLY "this corpus returned nothing for this
  // selector". If anything of substance survives removing the zero phrase, the
  // tool name and the selector, then the row names a SPECIFIC record and must
  // never share a key with a different specific record.
  //
  // Executed against the first implementation, these two distinct court records
  // canonicalised identically and the second was rejected as a "duplicate":
  //
  //   "Case 2021-CV-01188 (Anne Arundel Cty): no records of prior conviction"
  //   "Case 2019-CR-00457 (Baltimore Cty): no records of appeal"
  //
  // Different courts, different dockets, different dispositions — one row.
  if (nullResultResidue(input) !== "") return null;
  const tool = (input.source ?? "unknown").trim().toLowerCase();
  const selector = (input.selector ?? "").trim().toLowerCase();
  return `${input.kind.trim().toLowerCase()}:${tool}:${selector}:no-hits`;
}

/** Global twin of NULL_RESULT_RE. Separate object: a /g regex carries lastIndex
 *  state across .test() calls, which would make the gate order-dependent. */
const NULL_RESULT_RE_G = /\b(?:0|no|zero)\s+(?:hit|breach|result|record|paste|match|exposure)s?\b/gi;

/** Connectives that carry no record identity, so their presence must not make a
 *  plain null result look substantive. */
const NULL_RESULT_FILLER_RE =
  /\b(?:for|on|in|of|the|a|an|from|found|returned|via|with|and|to|at|by|any|were|was|there|this|that|query|lookup|search|check|against|across)\b/g;

/** The result nouns themselves. NULL_RESULT_RE consumes only the quantifier and
 *  ONE noun ("no breach" out of "no breach hits"), so the trailing noun survives
 *  and would otherwise read as substance — which wrongly un-canonicalised a
 *  plain "no breach hits (breach_check)" and broke G4's intended dedup. */
const NULL_RESULT_NOUN_RE =
  /\b(?:hits?|breach(?:es)?|results?|records?|pastes?|match(?:es)?|exposures?)\b/g;

/**
 * What remains of a value once the zero phrase, the tool and the selector are
 * removed. Empty means "nothing but the null statement" — safe to canonicalise.
 */
function nullResultResidue(input: {
  source?: string | null;
  value: string;
  selector?: string | null;
}): string {
  let s = (input.value ?? "").toLowerCase();
  s = s.replace(NULL_RESULT_RE_G, " ");
  for (const token of [input.source, input.selector]) {
    const t = (token ?? "").trim().toLowerCase();
    if (t) s = s.split(t).join(" ");
  }
  s = s.replace(NULL_RESULT_NOUN_RE, " ");
  s = s.replace(NULL_RESULT_FILLER_RE, " ");
  return s.replace(/[^a-z0-9]+/g, " ").trim();
}
