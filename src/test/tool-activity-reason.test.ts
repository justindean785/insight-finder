import { describe, expect, it } from "vitest";
import { toolActivityReason } from "@/hooks/useThreadToolActivity";

describe("toolActivityReason", () => {
  it("returns undefined for ok and pending tones", () => {
    expect(toolActivityReason({ state: "output-available", output: { ok: true } }, "ok")).toBeUndefined();
    expect(toolActivityReason({ state: "input-available" }, "pending")).toBeUndefined();
  });

  it("prefers explicit errorText for failures", () => {
    expect(
      toolActivityReason({ state: "output-error", errorText: "  rate limited (429) " }, "error"),
    ).toBe("rate limited (429)");
  });

  it("falls back to a structured reason in the output", () => {
    expect(
      toolActivityReason({ state: "output-available", output: { ok: false, skipped: true, reason: "duplicate query" } }, "skip"),
    ).toBe("duplicate query");
  });

  it("returns undefined when no reason is available", () => {
    expect(toolActivityReason({ state: "output-available", output: { ok: false } }, "error")).toBeUndefined();
  });

  it("collapses whitespace and truncates long reasons", () => {
    const long = "x".repeat(300);
    const out = toolActivityReason({ state: "output-error", errorText: long }, "error");
    expect(out).toBeDefined();
    expect(out!.length).toBeLessThanOrEqual(160);
    expect(out!.endsWith("…")).toBe(true);
  });
});
