import { describe, it, expect } from "vitest";
import {
  checkIndependence,
  computeEffectiveSourceCount,
  type Source,
} from "@/lib/audit/source-independence";

const src = (over: Partial<Source> & Pick<Source, "id">): Source => ({
  type: "unknown",
  retrievedAt: "2026-06-07T00:00:00Z",
  confidence: 70,
  ...over,
});

describe("computeEffectiveSourceCount", () => {
  it("collapses sources that share an origin", () => {
    const sources = [
      src({ id: "S1", origin: "MyDriveSure-2019" }),
      src({ id: "S2", origin: "MyDriveSure-2019" }),
      src({ id: "S3", origin: "Zynga-2019" }),
    ];
    expect(computeEffectiveSourceCount(sources)).toBe(2);
  });

  it("pools anonymous re-host mirrors into one source", () => {
    // scribd/pastebin/anonfiles with no origin can't be told apart — treat as one dump.
    const sources = [
      src({ id: "S1", url: "https://scribd.com/doc/y" }),
      src({ id: "S2", url: "https://pastebin.com/x" }),
      src({ id: "S3", url: "https://anonfiles.com/z" }),
    ];
    expect(computeEffectiveSourceCount(sources)).toBe(1);
  });

  it("keeps distinct aggregators distinct, collapses repeats of the same one (H2)", () => {
    // Two DIFFERENT aggregators are not automatically the same leak — they index
    // many breaches, so LeakCheck + Dehashed should count as 2, not fuse to 1.
    expect(
      computeEffectiveSourceCount([
        src({ id: "S1", url: "https://leakcheck.io/x" }),
        src({ id: "S2", url: "https://dehashed.com/y" }),
      ]),
    ).toBe(2);
    // …but two hits from the SAME aggregator host collapse to one.
    expect(
      computeEffectiveSourceCount([
        src({ id: "S1", url: "https://leakcheck.io/x" }),
        src({ id: "S2", url: "https://leakcheck.io/y" }),
      ]),
    ).toBe(1);
  });

  it("keeps genuinely distinct sources separate", () => {
    const sources = [
      src({ id: "S1", type: "court", url: "https://courts.example.gov/a" }),
      src({ id: "S2", type: "registry", url: "https://sos.example.gov/b" }),
    ];
    expect(computeEffectiveSourceCount(sources)).toBe(2);
  });
});

describe("checkIndependence", () => {
  it("warns and reports the collapse when sources share an origin", () => {
    const findings = checkIndependence([
      src({ id: "S1", type: "breach", origin: "MyDriveSure-2019", url: "https://leakcheck.io/x" }),
      src({ id: "S2", type: "scribd", origin: "MyDriveSure-2019", url: "https://scribd.com/doc/y" }),
    ]);
    const sameOrigin = findings.find(
      (f) => f.severity === "warn" && f.message.includes("share origin"),
    );
    expect(sameOrigin).toBeDefined();
    expect(sameOrigin!.declaredCount).toBe(2);
    expect(sameOrigin!.effectiveCount).toBe(1);
  });

  it("warns when a breach is mixed with a mirror domain", () => {
    const findings = checkIndependence([
      src({ id: "S1", type: "breach", url: "https://leakcheck.io/x" }),
      src({ id: "S2", type: "scribd", url: "https://scribd.com/doc/y" }),
    ]);
    expect(findings.some((f) => f.severity === "warn" && f.message.includes("mirror"))).toBe(true);
  });

  it("warns when there is no primary source and >=2 aggregators", () => {
    const findings = checkIndependence([
      src({ id: "S1", type: "breach", url: "https://leakcheck.io/x" }),
      src({ id: "S2", type: "breach", url: "https://dehashed.com/y" }),
    ]);
    expect(findings.some((f) => f.message.includes("No primary source"))).toBe(true);
  });

  it("emits an info finding when effective < declared", () => {
    const findings = checkIndependence([
      src({ id: "S1", origin: "MyDriveSure-2019" }),
      src({ id: "S2", origin: "MyDriveSure-2019" }),
      src({ id: "S3", origin: "Zynga-2019" }),
    ]);
    const info = findings.find((f) => f.severity === "info");
    expect(info).toBeDefined();
    expect(info!.effectiveCount).toBe(2);
    expect(info!.declaredCount).toBe(3);
  });

  it("returns no collapse findings for fully independent primary sources", () => {
    const findings = checkIndependence([
      src({ id: "S1", type: "court", url: "https://courts.example.gov/a" }),
      src({ id: "S2", type: "registry", url: "https://sos.example.gov/b" }),
    ]);
    expect(findings).toHaveLength(0);
  });
});
