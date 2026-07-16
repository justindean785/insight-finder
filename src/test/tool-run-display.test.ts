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

  // A governance/gated stop surfaces as ok:false with a gate reason but WITHOUT
  // the skipped flag. It is an intentional control decision, not a fault, so it
  // must read as a neutral skip — not get counted into the cycle "failed" tally.
  it("treats a gated ok:false result as a skip, not a failure", () => {
    expect(deriveToolTone({
      state: "output-available",
      output: { ok: false, reason: "expected value 42 below 70" },
    })).toBe("skip");
    expect(deriveToolTone({
      state: "output-available",
      output: { ok: false, reason: "burst limit reached for this investigation" },
    })).toBe("skip");
  });

  it("treats a guard/no-op skip reason (ok:false, no flag) as a skip", () => {
    expect(deriveToolTone({
      state: "output-available",
      output: { ok: false, reason: "duplicate call — already used this seed" },
    })).toBe("skip");
  });

  it("still flags a genuine provider fault as an error", () => {
    expect(deriveToolTone({
      state: "output-available",
      output: { ok: false, error: "provider returned malformed payload" },
    })).toBe("error");
  });

  it("keeps a hard stream error as an error even with a gate-like reason", () => {
    expect(deriveToolTone({
      state: "output-error",
      errorText: "over-budget",
      output: null,
    })).toBe("error");
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
