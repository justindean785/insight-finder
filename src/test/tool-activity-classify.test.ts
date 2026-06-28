import { describe, it, expect } from "vitest";
import { classifyActivityRow } from "@/hooks/useThreadToolActivity";

describe("classifyActivityRow (#22 — tool_usage_log → activity)", () => {
  it("ok / empty outcomes read as succeeded", () => {
    expect(classifyActivityRow("ok", true, null).status).toBe("succeeded");
    expect(classifyActivityRow("empty", true, null).status).toBe("succeeded");
  });

  it("a gated skip (missing key / unavailable) reads as gated", () => {
    expect(classifyActivityRow("skipped", false, "unavailable: missing_key (HIBP_API_KEY not set)").status).toBe("gated");
    expect(classifyActivityRow("skipped", false, "provider disabled in config").status).toBe("gated");
  });

  it("a throttle/budget skip reads as degraded", () => {
    expect(classifyActivityRow("skipped", false, "burst limit reached for jina_reader_scrape").status).toBe("degraded");
    expect(classifyActivityRow("skipped", false, "duplicate call: prior other").status).toBe("degraded");
  });

  it("a plain governance skip reads as skipped", () => {
    expect(classifyActivityRow("skipped", false, "execution plan required for this cycle").status).toBe("skipped");
  });

  it("failed outcome reads as failed", () => {
    expect(classifyActivityRow("failed", false, "upstream returned HTTP 500").status).toBe("failed");
  });

  it("legacy rows (null outcome) fall back to the ok boolean", () => {
    expect(classifyActivityRow(null, true, null).status).toBe("succeeded");
    expect(classifyActivityRow(null, false, "boom").status).toBe("failed");
  });
});
