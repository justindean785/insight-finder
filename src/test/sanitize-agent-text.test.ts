import { describe, expect, it } from "vitest";
import { looksLikeReasoning, stripInlineTags, stripReasoningMarkup } from "@/lib/sanitize-agent-text";

describe("stripReasoningMarkup", () => {
  it("removes a closed <think> block but keeps surrounding text", () => {
    const out = stripReasoningMarkup("Before <think>secret chain of thought</think> after");
    expect(out).not.toContain("<think>");
    expect(out).not.toContain("chain of thought");
    expect(out).toContain("Before");
    expect(out).toContain("after");
  });

  it("removes a trailing unterminated think block that is still streaming", () => {
    const out = stripReasoningMarkup("Findings ready.\n<think>I should call detect_contradictions next");
    expect(out).toBe("Findings ready.");
    expect(out).not.toContain("detect_contradictions");
  });

  it("removes an orphan closing </think> tag", () => {
    const out = stripReasoningMarkup("Review lead</think>");
    expect(out).toBe("Review lead");
  });

  it("strips sibling reasoning tags (reasoning/scratchpad/analysis/internal/plan)", () => {
    for (const tag of ["reasoning", "scratchpad", "analysis", "internal", "plan"]) {
      const out = stripReasoningMarkup(`Keep <${tag}>drop this</${tag}> keep2`);
      expect(out).not.toContain("drop this");
      expect(out).toContain("Keep");
      expect(out).toContain("keep2");
    }
  });

  it("is case/space insensitive on tags", () => {
    expect(stripReasoningMarkup("a < THINK >x</ Think > b")).not.toContain("x");
  });

  it("returns empty string for empty/whitespace and pure-reasoning input", () => {
    expect(stripReasoningMarkup("")).toBe("");
    expect(stripReasoningMarkup("<think>only thoughts here</think>")).toBe("");
  });

  it("leaves clean report text untouched", () => {
    const text = "**Recommended next pivots:**\n- Investigate sam.cole@example.com — same person";
    expect(stripReasoningMarkup(text)).toBe(text);
  });
});

describe("stripInlineTags", () => {
  it("drops a lone surviving think fragment from a card field", () => {
    expect(stripInlineTags("Review lead</think>")).toBe("Review lead");
    expect(stripInlineTags("<think>The detect_contradictions tool flagged")).toBe("");
  });

  it("strips arbitrary inline html-ish tags but keeps the words", () => {
    expect(stripInlineTags("Verify <b>email</b> ownership")).toBe("Verify email ownership");
  });
});

describe("looksLikeReasoning", () => {
  it("flags first-person planning lines", () => {
    expect(looksLikeReasoning("Let me also call detect_contradictions to check")).toBe(true);
    expect(looksLikeReasoning("I'll verify the email next")).toBe(true);
    expect(looksLikeReasoning("I should pivot on the phone")).toBe(true);
  });

  it("flags lines carrying a reasoning tag", () => {
    expect(looksLikeReasoning("<think>distinct names")).toBe(true);
  });

  it("does not flag real recommendation lines", () => {
    expect(looksLikeReasoning("Investigate sam.cole@example.com — same person")).toBe(false);
    expect(looksLikeReasoning("Corroborate address with county records")).toBe(false);
  });
});
