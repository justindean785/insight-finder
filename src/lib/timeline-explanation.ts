/**
 * True when an explanation carries nothing the row does not already show.
 *
 * The timeline's generated descriptions are templated from the row itself
 * ("Tool returned.", "Recorded email from hunter_verify."), so under a row
 * already labelled TOOL RESULT / titled `hunter_verify` they restate rather
 * than explain. Conservative by design: only phrasings that are provably
 * derived from the title or the type are dropped, and anything an analyst or a
 * tool actually wrote is kept.
 */
export function isVacuous(explanation: string, title: string): boolean {
  const e = explanation.trim().toLowerCase().replace(/\.$/, "");
  if (e === "tool returned" || e === "tool call" || e === "no summary") return true;
  // "Recorded email from hunter_verify." under a row TITLED `hunter_verify` is
  // the same string twice. It is vacuous precisely when it ENDS WITH the title —
  // the test was `=== false`, which inverted both halves: it kept the redundant
  // line and dropped "Recorded email from clearbit", which names a DIFFERENT
  // source than the row and is the one case that actually adds something.
  const t = title.trim().toLowerCase();
  return t.length > 0 && /^recorded .* from .+$/.test(e) && e.endsWith(t);
}
