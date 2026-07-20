import { describe, expect, it } from "vitest";
import { hasReportShape, stripReasoning } from "@/lib/report-shape";

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
