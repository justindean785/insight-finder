import { describe, expect, it } from "vitest";
import {
  looksLikeReasoning,
  stripInlineTags,
  stripReasoningMarkup,
  stripToolCallMarkup,
  sanitizeChatText,
} from "@/lib/sanitize-agent-text";

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

describe("stripToolCallMarkup (Phase C1 — leaked tool-call syntax)", () => {
  it("removes a full <function_calls><invoke>…</invoke></function_calls> block (hallucinated exify)", () => {
    const leaked =
      'Here is what I found.\n<function_calls>\n<invoke name="exify">\n<parameter name="url">https://x.com/a</parameter>\n</invoke>\n</function_calls>\nDone.';
    const out = stripToolCallMarkup(leaked);
    expect(out).not.toContain("invoke");
    expect(out).not.toContain("exify");
    expect(out).not.toContain("function_calls");
    expect(out).not.toContain("parameter");
    expect(out).toContain("Here is what I found.");
    expect(out).toContain("Done.");
  });

  it("removes a standalone <invoke name=\"hackerone_lookup\">…</invoke> block", () => {
    const out = stripToolCallMarkup('Lead:\n<invoke name="hackerone_lookup">\n<parameter name="handle">bob</parameter>\n</invoke>');
    expect(out).toBe("Lead:");
    expect(out).not.toContain("hackerone_lookup");
  });

  it("removes a trailing unclosed <invoke> block still streaming in", () => {
    const out = stripToolCallMarkup('Report ready.\n<invoke name="exify">\n<parameter name="url">http://x');
    expect(out).toBe("Report ready.");
    expect(out).not.toContain("exify");
  });

  it("removes a stray </invoke> fragment", () => {
    expect(stripToolCallMarkup("Verified the handle</invoke>")).toBe("Verified the handle");
  });

  it("removes a '# Not a real tool' self-correction heading", () => {
    const out = stripToolCallMarkup("# Not a real tool\nThe email is confirmed.");
    expect(out).not.toMatch(/not a real tool/i);
    expect(out).toContain("The email is confirmed.");
  });

  it("does NOT strip a legitimate prose line that merely contains the phrase", () => {
    // Only heading-form self-corrections are stripped — real findings survive.
    const text = "The vendor claims their scanner is not a real tool for OSINT.";
    expect(stripToolCallMarkup(text)).toBe(text);
  });

  it("also handles antml:-prefixed tool-call tags", () => {
    const out = stripToolCallMarkup('ok <invoke name="exify">x</invoke> done');
    expect(out).not.toContain("exify");
    expect(out).toContain("ok");
    expect(out).toContain("done");
  });

  it("leaves clean report text untouched", () => {
    const text = "**Findings**\n- alice@example.com — CONFIRMED via github_user + WHOIS";
    expect(stripToolCallMarkup(text)).toBe(text);
  });

  it("does NOT swallow a real finding that follows an example invoke snippet", () => {
    // A report showing example tool-call syntax then real findings after a blank
    // line: the trailing-open stripper stops at the blank line, findings survive.
    const text = 'Example syntax: <invoke name="x">\n\nalice@example.com is CONFIRMED.';
    const out = stripToolCallMarkup(text);
    expect(out).toContain("alice@example.com is CONFIRMED.");
    expect(out).not.toContain("invoke");
  });

  it("does not mistake a hyphenated word like <invoke-endpoint> for a tool call", () => {
    const text = "The <invoke-endpoint> route returns 200.";
    // The tag itself isn't a real tool-call container, so the sentence is preserved
    // (the stray-tag pass may drop the bare token, but the words stay).
    expect(stripToolCallMarkup(text)).toContain("route returns 200");
  });

  it("strips MiniMax's provider-namespaced <minimax:tool_call> leak (exact live case, seed 'dizosint')", () => {
    const leaked =
      'Now saving memory and writing the final report: <minimax:tool_call>{"name":"record_artifacts","arguments":{"x":1}}</minimax:tool_call>';
    const out = stripToolCallMarkup(leaked);
    expect(out).toBe("Now saving memory and writing the final report:");
    expect(out).not.toContain("minimax:tool_call");
    expect(out).not.toContain("record_artifacts");
  });

  it("strips a stray/unclosed <minimax:tool_call> and an orphan closing tag", () => {
    expect(stripToolCallMarkup("Report done.\n<minimax:tool_call>{...")).toBe("Report done.");
    expect(stripToolCallMarkup("Report done.</minimax:tool_call>")).toBe("Report done.");
  });

  it("does NOT match an unrelated namespaced tag like <mx:tool_callback>", () => {
    // (?![\\w-]) boundary: `tool_callback` is not `tool_call`, so prose survives.
    expect(stripToolCallMarkup("See <mx:tool_callback> in the docs.")).toContain("docs");
  });
});

describe("sanitizeChatText (chat timeline entry point)", () => {
  it("strips BOTH reasoning and leaked tool-call markup so neither reaches the timeline", () => {
    const leaked =
      'Findings ready.\n<think>let me call exify</think>\n<function_calls>\n<invoke name="exify">\n<parameter name="q">bob</parameter>\n</invoke>\n</function_calls>\n# Not a real tool';
    const out = sanitizeChatText(leaked);
    expect(out).toBe("Findings ready.");
    expect(out).not.toContain("exify");
    expect(out).not.toContain("invoke");
    expect(out).not.toMatch(/not a real tool/i);
    expect(out).not.toContain("<think>");
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
