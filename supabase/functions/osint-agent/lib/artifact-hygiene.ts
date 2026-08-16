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

/** A snake_case tool slug: two or more segments, e.g. `serus_darkweb_scan`. */
const TOOL_SLUG_RE = /\b[a-z0-9]+(?:_[a-z0-9]+)+\b/;

/**
 * G1 — a QUEUED tool call is not an observation.
 *
 * The run persisted ten rows like `hawkcapo - socialfetch_lookup (pending
 * Instagram)`, each written before its tool returned and each carrying
 * `status: "observed"`. They are false at the moment of writing, they are
 * guaranteed duplicates once the real result lands, and they join the subject
 * cluster — so they also feed promoteConfidence's peer set.
 *
 * Keyed on a tool slug NEXT TO a parenthesised "pending", never on the word
 * alone: "disposition pending" and "suspended pending appeal" are real
 * findings and must still record.
 */
export function isQueuedPlaceholder(rawValue: string): boolean {
  const value = (rawValue ?? "").trim();
  if (!value) return false;
  if (!/\((?:pending|queued)\b/i.test(value)) return false;
  return TOOL_SLUG_RE.test(value.toLowerCase());
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
  if (!NULL_RESULT_RE.test(input.value ?? "")) return null;
  const tool = (input.source ?? "unknown").trim().toLowerCase();
  const selector = (input.selector ?? "").trim().toLowerCase();
  return `${input.kind.trim().toLowerCase()}:${tool}:${selector}:no-hits`;
}
