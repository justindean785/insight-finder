import { describe, it, expect } from "vitest";
import { isVacuous } from "@/lib/timeline-explanation";

/**
 * The predicate was inverted, and the comment above it described the correct
 * behaviour the whole time — so review read the intent, not the boolean.
 *
 * "Recorded email from hunter_verify." under a row already TITLED
 * `hunter_verify` is the same string twice. That is the vacuous case. The old
 * test required the explanation NOT to end with the title, which kept the
 * redundant line and dropped the one variant that adds information: a
 * different source than the row names.
 */
describe("isVacuous", () => {
  it("drops an explanation that just restates the row's own title", () => {
    expect(isVacuous("Recorded email from hunter_verify.", "hunter_verify")).toBe(true);
  });

  it("KEEPS an explanation naming a different source than the row", () => {
    // This is the informative case the inverted test was throwing away.
    expect(isVacuous("Recorded email from clearbit.", "hunter_verify")).toBe(false);
  });

  it("drops the templated no-content phrasings", () => {
    for (const e of ["Tool returned.", "tool call", "No summary", "TOOL RETURNED"]) {
      expect(isVacuous(e, "hunter_verify"), e).toBe(true);
    }
  });

  it("keeps anything a tool or analyst actually wrote", () => {
    expect(isVacuous("Provider returned 403 — key missing.", "hunter_verify")).toBe(false);
    expect(isVacuous("Matched 2 of 3 selectors.", "hunter_verify")).toBe(false);
  });

  it("is case- and trailing-period-insensitive", () => {
    expect(isVacuous("  Recorded EMAIL from Hunter_Verify.  ", "HUNTER_VERIFY")).toBe(true);
  });

  it("never drops anything when the row has no title to restate", () => {
    expect(isVacuous("Recorded email from hunter_verify.", "")).toBe(false);
    expect(isVacuous("Recorded email from hunter_verify.", "   ")).toBe(false);
  });
});
