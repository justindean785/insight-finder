/**
 * pivot-target-shape — is this string SHAPED like a selector of this type?
 *
 * ONE table, consulted by both ends of the pivot pipeline:
 *
 *   producer  `recommended-pivots.extractRecommendedPivots` — may this report
 *             line become a suggestion at all?
 *   validator `pivot-schema.pivotSuggestionSchema`          — may this
 *             suggestion get a Run button?
 *
 * WHY IT IS SHARED. The validator was already correct and the producer was
 * not, so every prose line the parser scraped arrived as a "name" pivot and
 * rendered as a dead "Suggestion needs repair" card. Measured on the
 * 2026-09-12 `baig_azhar` case: three of the four Next-steps cards were
 * unusable, with targets like `the "freelance writer" claim` and two 30-word
 * sentences. `extractTarget` falls back to the WHOLE LINE when it finds no
 * identifier, and `pivotType` maps an unrecognised value to `name` — so a
 * sentence became a name, every time.
 *
 * Two copies of this predicate would let the producer emit what the validator
 * refuses (dead cards, today's bug) or — far worse — emit what the validator
 * would have refused had it been asked. One table cannot disagree with itself.
 *
 * Zero imports on purpose: it sits under both modules, which already import
 * each other transitively (pivot-schema → pivot-engine → recommended-pivots).
 */

export const PIVOT_TARGET_TYPES = ["email", "username", "domain", "url", "ip", "name", "wallet", "phone"] as const;
export type PivotTargetType = (typeof PIVOT_TARGET_TYPES)[number];

/** A name is a few words. A sentence, a clause or a label with a colon is not. */
export const MAX_NAME_WORDS = 6;

export const TARGET_SHAPE: Record<PivotTargetType, { re: RegExp; problem: string }> = {
  // Backticks, quotes and brackets are Markdown around a selector, never part
  // of one — "`jane@uni.example`" must not validate as runnable (2026-10-01).
  // An apostrophe BETWEEN local-part characters is legal ("o'connor@…").
  email: { re: /^[^\s@`'"()<>[\],;]+(?:'[^\s@`'"()<>[\],;]+)*@[^\s@`'"()<>[\],;]+\.[^\s@`'"()<>[\],;]{2,}$/, problem: "is not an email address" },
  username: { re: /^@?[\p{L}\p{N}._-]{2,40}$/u, problem: "is not a single username" },
  domain: { re: /^(?=.{3,253}$)(?:[a-z0-9-]+\.)+[a-z]{2,}$/i, problem: "is not a domain name" },
  url: { re: /^https?:\/\/[^\s]+$/i, problem: "is not a URL" },
  ip: { re: /^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-f:]{3,39}$/i, problem: "is not an IP address" },
  wallet: { re: /^[A-Za-z0-9]{20,100}$/, problem: "is not a wallet address" },
  phone: { re: /^\+?[\d\s().-]{7,24}$/, problem: "is not a phone number" },
  name: { re: /^[\p{L}][\p{L}\p{M}'’.\-\s]{0,60}$/u, problem: "is not a name" },
};

/**
 * Every reason `target` fails to be a well-formed `type` selector, in the same
 * wording the analyst sees on a "Suggestion needs repair" card. Empty ⇒ valid.
 *
 * This is SHAPE only. Whether the value is boilerplate, a template placeholder
 * or a Markdown table cell stays in `pivot-schema`'s BOILERPLATE list, and
 * whether the pivot may RUN (quarantine, analyst rejection, rerun cost) stays
 * in `pivotEligibility`. Three separate questions, deliberately not merged.
 */
export function targetShapeProblems(type: PivotTargetType, target: string): string[] {
  const value = String(target ?? "").trim();
  const problems: string[] = [];
  const shape = TARGET_SHAPE[type];
  if (!shape) return [`target type "${type}" is not a pivotable selector`];
  if (!shape.re.test(value)) problems.push(`target ${shape.problem}`);
  const words = value.split(/\s+/).filter(Boolean).length;
  if (type === "name" && words > MAX_NAME_WORDS) {
    problems.push(`target is ${words} words — a sentence, not a name`);
  }
  if (type === "phone" && (value.match(/\d/g) ?? []).length < 7) {
    problems.push("target has too few digits for a phone number");
  }
  return problems;
}

/** True when `target` is a well-formed selector of `type`. */
export function isWellFormedTarget(type: PivotTargetType, target: string): boolean {
  return targetShapeProblems(type, target).length === 0;
}
