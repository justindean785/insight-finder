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

import { deriveToolStatus } from "@/lib/tool-run";

describe("deriveToolStatus — gated/degraded distinctions (review #6)", () => {
  it("flags hard errors as failed", () => {
    expect(deriveToolStatus({ state: "output-error", errorText: "boom" })).toBe("failed");
    expect(deriveToolStatus({ state: "output-available", output: { ok: false } })).toBe("failed");
  });

  it("distinguishes a plain skip from a gated skip", () => {
    expect(deriveToolStatus({ state: "output-available", output: { skipped: true, reason: "duplicate query" } })).toBe("skipped");
    expect(deriveToolStatus({ state: "output-available", output: { skipped: true, reason: "blocked by triage gate" } })).toBe("gated");
    expect(deriveToolStatus({ state: "output-available", output: { gated: true } })).toBe("gated");
  });

  it("treats budget/policy/rate-limit skips as gated", () => {
    expect(deriveToolStatus({ state: "output-available", output: { skipped: true, reason: "over budget for this run" } })).toBe("gated");
    expect(deriveToolStatus({ state: "output-available", output: { skipped: true, _runtime: { rejection_reason: "policy: tool not promoted" } } })).toBe("gated");
  });

  it("flags partial / stale / timeout results as degraded", () => {
    expect(deriveToolStatus({ state: "output-available", output: { partial: true } })).toBe("degraded");
    expect(deriveToolStatus({ state: "output-available", output: { status: "timeout" } })).toBe("degraded");
    expect(deriveToolStatus({ state: "output-available", output: { _runtime: { stale_cache: true } } })).toBe("degraded");
  });

  it("maps clean results to succeeded and in-flight to pending", () => {
    expect(deriveToolStatus({ state: "output-available", output: { ok: true } })).toBe("succeeded");
    expect(deriveToolStatus({ state: "input-available" })).toBe("pending");
  });
});
