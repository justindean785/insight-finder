/**
 * asserted-confidence.ts — a confidence figure written INTO an artifact's value.
 *
 * On a live case (2026-09-11) the model recorded artifacts whose TEXT carried
 * its own verdict: "Norman … — primary identity cluster confirmed at 92%
 * confidence by minimax_correlate", "… identity cluster now at 90%+ via breach
 * phone match + IP geolocation". The engine had scored those rows 55 and 80 —
 * its confidence is the artifact's `confidence`, capped by the evidence rules —
 * but every surface printed the value verbatim, so the report, the evidence
 * board and the Markdown export all read "92% confidence" beside a 55.
 *
 * This finds such a claim so a surface can print it AS a claim, next to the
 * engine's score. Display only: nothing reads the claim as a score, and the
 * value is never edited — it is the record.
 *
 * Deliberately narrow. It needs a percentage tied to confidence/certainty
 * vocabulary, or a "confirmed / verified / corroborated / cluster … at N%"
 * phrasing. A bare percentage ("51% of records"), a breach count ("exposed in
 * 17 breaches") or a tool's own match score ("face match 87%") is not a
 * self-asserted confidence and is left alone.
 */

export interface AssertedConfidence {
  /** The figure the text asserts, 0–100. */
  pct: number;
  /** The phrase it was asserted in, for a tooltip. */
  phrase: string;
}

const PCT = String.raw`(\d{1,3}(?:\.\d+)?)\s?%\+?`;
const CLAIM_RE = new RegExp(
  String.raw`${PCT}\s*(?:confidence|confident|certainty|certain|probability|likelihood)\b` +
    "|" +
    String.raw`\b(?:confirmed|verified|corroborated|confidence|certainty|cluster)\b[^.;:\n]{0,40}?\b(?:at|to)\s+${PCT}`,
  "i",
);

export function findAssertedConfidence(value: unknown): AssertedConfidence | null {
  if (typeof value !== "string" || !value) return null;
  const m = CLAIM_RE.exec(value);
  if (!m) return null;
  const pct = Number(m[1] ?? m[2]);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  return { pct, phrase: m[0].trim() };
}

/** One line for exports: "claims 92% in its text; engine confidence 55". */
export function describeAssertedConfidence(claim: AssertedConfidence, engine: number | null | undefined): string {
  const e = typeof engine === "number" && Number.isFinite(engine) ? `; engine confidence ${Math.round(engine)}` : "";
  return `claims ${claim.pct}% in its text — not a score${e}`;
}
