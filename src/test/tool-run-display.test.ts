import { describe, expect, it } from "vitest";
import { deriveToolCharge, deriveToolPreview, deriveToolReason, deriveToolTone } from "@/lib/tool-run";

describe("deriveToolTone", () => {
  it("treats structured ok:false outputs as failures", () => {
    expect(deriveToolTone({
      state: "output-available",
      output: { ok: false, status: "timeout", error: { code: "poll_exhausted" } },
    })).toBe("error");
  });

  it("keeps skipped outputs neutral", () => {
    expect(deriveToolTone({
      state: "output-available",
      output: { ok: false, skipped: true, reason: "duplicate query" },
    })).toBe("skip");
  });
});

describe("deriveToolCharge", () => {
  it("shows no-charge for cached and skipped runs", () => {
    expect(deriveToolCharge({ _cached: true }).label).toBe("0 cr");
    expect(deriveToolCharge({ skipped: true }).label).toBe("0 cr");
  });

  it("uses reported credits instead of a fake 1-credit heuristic", () => {
    expect(deriveToolCharge({ creditsUsed: 0.25 }).label).toBe("0.25 cr");
    expect(deriveToolCharge({ creditsUsed: 0.25, revealRequested: true }).label).toBe("0.25+ cr");
    expect(deriveToolCharge({ ok: true }).label).toBeNull();
  });
});

describe("deriveToolReason", () => {
  it("prefers nested provider errors when present", () => {
    expect(deriveToolReason({
      error: { code: "forbidden", message: "Reveal scope missing" },
    })).toBe("Reveal scope missing");
  });
});

describe("deriveToolPreview", () => {
  it("summarizes Serus scan outcomes credibly", () => {
    expect(deriveToolPreview("serus_darkweb_scan", { status: "timeout" })).toBe("scan timed out");
    expect(deriveToolPreview("serus_darkweb_scan", { status: "success", totalBreaches: 2, totalPastes: 1 }))
      .toBe("2 breaches · 1 paste");
  });
});
