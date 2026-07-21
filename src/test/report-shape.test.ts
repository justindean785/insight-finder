import { describe, expect, it } from "vitest";
import { hasReportShape, joinAssistantTranscript, selectClosingAssistantProse, stripReasoning, stripReasoningPerPart } from "@/lib/report-shape";

describe("stripReasoning", () => {
  it("removes a closed <think> block", () => {
    expect(stripReasoning("<think>internal chatter</think>Final answer.")).toBe("Final answer.");
  });

  it("removes a dangling unclosed <think> block (truncated stream)", () => {
    expect(stripReasoning("Before.\n<think>never closed, cut off mid")).toBe("Before.");
  });

  it("passes through text with no reasoning block unchanged", () => {
    expect(stripReasoning("## Findings report\n\nConfirmed.")).toBe("## Findings report\n\nConfirmed.");
  });
});

describe("hasReportShape", () => {
  it("true on a report/findings heading", () => {
    expect(hasReportShape("## Findings report\n\nBody.")).toBe(true);
    expect(hasReportShape("### Investigation summary")).toBe(true);
  });

  it("true on a markdown table separator", () => {
    expect(hasReportShape("| # | Kind |\n|---:|---|\n| 1 | email |")).toBe(true);
  });

  it("true on 2+ tier labels", () => {
    expect(hasReportShape("[Confirmed] a@example.com\n[Verify] b@example.com")).toBe(true);
  });

  it("false on a single tier label alone", () => {
    expect(hasReportShape("[Confirmed] a@example.com")).toBe(false);
  });

  it("false on the recovery 'Run interrupted' stub — the exact regression this guards", () => {
    const stub = [
      "### Run interrupted",
      "",
      "The investigation for **example.com** stopped before it finished, and no findings had been saved at that point.",
      "Last heartbeat: 2026-07-20T00:00:00.000Z.",
    ].join("\n");
    expect(hasReportShape(stub)).toBe(false);
  });

  it("false on bare inter-step narration with no synthesis", () => {
    expect(hasReportShape("Going deeper into the breach corpora now, checking a few more sources.")).toBe(false);
  });

  it("false on empty/null-ish input", () => {
    expect(hasReportShape("")).toBe(false);
  });
});

describe("selectClosingAssistantProse", () => {
  it("shows one closing report instead of concatenating repeated model-step narration", () => {
    expect(selectClosingAssistantProse([
      "Let me run the opening breach sweep.",
      "New seed: Marina Mondot. Let me investigate.",
      "## Findings report\n\n- [VERIFY] supported observation.",
    ])).toBe("## Findings report\n\n- [VERIFY] supported observation.");
  });

  it("shows the latest status while no report exists yet", () => {
    expect(selectClosingAssistantProse([
      "Opening sweep.",
      "Checking the final bounded pivot.",
    ])).toBe("Checking the final bounded pivot.");
  });
});

describe("joinAssistantTranscript (chat bubble — full transcript, nothing hidden)", () => {
  it("joins every non-empty step in order with blank lines (keeps narration AND the closing report)", () => {
    expect(joinAssistantTranscript([
      "Let me run the opening breach sweep.",
      "New seed: Marina Mondot. Let me investigate.",
      "## Findings report\n\n- [VERIFY] supported observation.",
    ])).toBe(
      "Let me run the opening breach sweep.\n\nNew seed: Marina Mondot. Let me investigate.\n\n## Findings report\n\n- [VERIFY] supported observation.",
    );
  });

  it("drops empty / whitespace-only parts", () => {
    expect(joinAssistantTranscript(["Step one.", "", "  ", "Step two."])).toBe("Step one.\n\nStep two.");
  });

  it("collapses ADJACENT duplicate parts (SDK re-emit) but keeps a later non-adjacent repeat", () => {
    expect(joinAssistantTranscript(["Same.", "Same.", "Different.", "Same."]))
      .toBe("Same.\n\nDifferent.\n\nSame.");
  });

  it("returns empty string for no parts", () => {
    expect(joinAssistantTranscript([])).toBe("");
    expect(joinAssistantTranscript(["", "   "])).toBe("");
  });
});

// Message shapes below are INFERRED from the code that produces them
// (supabase/functions/osint-agent/index.ts persistFinalMessages + recovery.ts
// buildRecoveredAssistantText) — no operator-supplied failing message was
// available when these tests were written.
describe("stripReasoningPerPart (Next-steps gate input assembly)", () => {
  const salvageReport = [
    "## Findings Report",
    "",
    "| # | Kind | Value | Confidence |",
    "|---:|---|---|---:|",
    "| 1 | email | jane@example.com | 90 |",
    "",
    "Summary: one strong lead identified [CONFIRMED], one pending [VERIFY].",
  ].join("\n");

  it("normal completion: report text passes the gate", () => {
    const parts = [salvageReport];
    expect(hasReportShape(stripReasoningPerPart(parts))).toBe(true);
  });

  it("recovered-run shape passes the gate (heading + findings table)", () => {
    // Verbatim structure of recovery.ts buildRecoveredAssistantText.
    const recovered = [
      "## Findings report — recovered run",
      "",
      "The investigation for **jane@example.com** was interrupted before the agent could write its closing response. The saved evidence below was recovered from durable artifacts already written during the run.",
      "Last heartbeat: 2026-07-20T10:00:00.000Z.",
      "",
      "### Recovered findings",
      "| # | Kind | Value | Confidence | Source |",
      "|---:|---|---|---:|---|",
      "| 1 | email | jane@example.com | 90 | breach_check |",
      "",
      "Recovered 1 artifact.",
      "",
      "### Gaps",
      "- The run was closed by stale-run recovery, so this is not a full model-written synthesis.",
    ].join("\n");
    expect(hasReportShape(stripReasoningPerPart([recovered]))).toBe(true);
  });

  it("regression: salvage report appended AFTER a truncated part survives the gate", () => {
    // A CPU-/token-capped turn leaves an unclosed <think> in its last text part.
    // The backend salvage path (index.ts persistFinalMessages) appends the
    // salvaged report as a NEW part. Joining BEFORE stripping let
    // REASONING_DANGLING_RE eat the report to end-of-string → gate false →
    // Next steps panel never rendered. Per-part stripping keeps it.
    const truncatedPart =
      "Going deeper into the breach corpora now.\n<think>checking oathnet next, the handle resolves to";
    const parts = [truncatedPart, salvageReport];
    // Old behavior (join then strip) — documents the bug:
    expect(hasReportShape(stripReasoning(parts.join("\n")))).toBe(false);
    // Fixed behavior (strip per part, then join):
    expect(hasReportShape(stripReasoningPerPart(parts))).toBe(true);
  });

  it("guard preserved: truncated reasoning with NO report anywhere stays gated off", () => {
    const truncatedPart =
      "Going deeper into the breach corpora now.\n<think>checking oathnet next, the handle resolves to";
    expect(hasReportShape(stripReasoningPerPart([truncatedPart]))).toBe(false);
  });

  it("drops empty parts and joins the rest with newlines", () => {
    expect(stripReasoningPerPart(["", "  ", "Body."])).toBe("Body.");
  });
});
