import { describe, it, expect } from "vitest";
import { explainConfidence, BADGE_TONE_CLASS } from "@/lib/confidence";
import type { Artifact } from "@/hooks/useThreadArtifacts";

const art = (over: Partial<Artifact> = {}): Artifact => ({
  id: "1",
  kind: "email",
  value: "a@b.com",
  confidence: 60,
  source: "hibp",
  created_at: new Date().toISOString(),
  metadata: null,
  ...over,
});

describe("explainConfidence", () => {
  it("uses a high source-tier baseline for breach corpora", () => {
    const { components, final } = explainConfidence(art({ source: "hibp" }));
    const base = components.find((c) => c.label.startsWith("Source:"));
    expect(base?.delta).toBe(92);
    expect(final).toBeGreaterThan(0);
  });

  it("falls back to 55 for an unknown source", () => {
    const { components } = explainConfidence(art({ source: "some_random_vendor", metadata: null }));
    const base = components.find((c) => c.label.startsWith("Source:"));
    expect(base?.delta).toBe(55);
  });

  it("penalizes single-source and rewards corroboration", () => {
    const single = explainConfidence(art({ source: "hibp", metadata: null }));
    expect(single.components.some((c) => c.label === "Single source" && c.delta === -8)).toBe(true);

    const multi = explainConfidence(
      art({ source: "hibp", metadata: { sources: ["hibp", "whois", "github"] } }),
    );
    const corro = multi.components.find((c) => c.label.startsWith("Corroboration"));
    expect(corro?.delta).toBe(12); // 2 extra sources * 6
  });

  it("caps corroboration at +18", () => {
    const many = explainConfidence(
      art({ source: "a", metadata: { sources: ["a", "b", "c", "d", "e", "f"] } }),
    );
    expect(many.components.find((c) => c.label.startsWith("Corroboration"))?.delta).toBe(18);
  });

  it("adds a freshness bonus for <24h artifacts", () => {
    const { components } = explainConfidence(art({ created_at: new Date().toISOString() }));
    expect(components.some((c) => c.label === "Fresh (<24h)" && c.delta === 4)).toBe(true);
  });

  it("penalizes stale (>30d) artifacts", () => {
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const { components } = explainConfidence(art({ created_at: old }));
    expect(components.some((c) => c.label === "Stale (>30d)" && c.delta === -10)).toBe(true);
  });

  it("applies analyst review deltas", () => {
    expect(explainConfidence(art(), "confirmed").components.some((c) => c.delta === 15)).toBe(true);
    expect(explainConfidence(art(), "key").components.some((c) => c.delta === 18)).toBe(true);
    expect(explainConfidence(art(), "recheck").components.some((c) => c.delta === -12)).toBe(true);
    expect(explainConfidence(art(), "dismissed").components.some((c) => c.delta === -40)).toBe(true);
  });

  it("applies a heavy false-positive metadata penalty", () => {
    const { components } = explainConfidence(art({ metadata: { false_positive: true } }));
    expect(components.some((c) => c.label === "False positive" && c.delta === -50)).toBe(true);
  });

  it("clamps the final score to [0, 100]", () => {
    const floored = explainConfidence(art({ source: "inference", metadata: { false_positive: true } }), "wrong");
    expect(floored.final).toBe(0);

    const ceiled = explainConfidence(
      art({ source: "hibp", metadata: { sources: ["a", "b", "c", "d", "e"] } }),
      "key",
    );
    expect(ceiled.final).toBeLessThanOrEqual(100);
  });

  it("final equals the clamped sum of component deltas", () => {
    const { components, final } = explainConfidence(art({ source: "hibp", metadata: null }));
    const sum = components.reduce((s, c) => s + c.delta, 0);
    expect(final).toBe(Math.max(0, Math.min(100, sum)));
  });

  it("emits a multi-source badge when corroborated, single-source otherwise", () => {
    const multi = explainConfidence(art({ metadata: { sources: ["a", "b"] } }));
    expect(multi.badges.some((b) => b.key === "multi-source")).toBe(true);

    const single = explainConfidence(art({ metadata: null }));
    expect(single.badges.some((b) => b.key === "single-source")).toBe(true);
  });

  it("emits a stale-breach badge for breach artifacts older than a year", () => {
    const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
    const { badges } = explainConfidence(art({ kind: "breach", created_at: old, metadata: null }));
    expect(badges.some((b) => b.key === "stale-breach")).toBe(true);
  });

  it("reports the stored confidence as raw", () => {
    expect(explainConfidence(art({ confidence: 73 })).raw).toBe(73);
    expect(explainConfidence(art({ confidence: null })).raw).toBe(0);
  });
});

describe("explainConfidence — server source-class ceiling", () => {
  // Every case below is taken from a real production run (thread f17ddf69, 2026-08-08)
  // where the displayed score sat ABOVE the ceiling the server had already applied.
  // The stored artifacts were correct; only this decomposition was not.

  it("never displays a score above the server's confidence_cap_applied", () => {
    const { final } = explainConfidence(
      art({ source: "serus_darkweb_scan", confidence: 60,
            metadata: { confidence_cap_applied: 60, source_category: ["breach"] } }),
      "confirmed",
    );
    expect(final).toBeLessThanOrEqual(60);
  });

  it("reproduces the Wattpad row: capped at 60, previously displayed 80", () => {
    const { final } = explainConfidence(
      art({ kind: "breach_exposure", source: "serus_darkweb_scan", confidence: 60,
            metadata: { confidence_cap_applied: 60, source_category: ["breach"] } }),
      "confirmed",
    );
    expect(final).toBe(60);
  });

  it("reproduces the oathnet row: capped at 60, previously displayed 70", () => {
    const { final } = explainConfidence(
      art({ kind: "breach_exposure", source: "oathnet_lookup", confidence: 55,
            metadata: { confidence_cap_applied: 60, source_category: ["breach"] } }),
      "confirmed",
    );
    expect(final).toBeLessThanOrEqual(60);
  });

  it("marking an artifact KEY cannot break the ceiling either", () => {
    // The +18 "key" bump is the largest upward adjustment an analyst can apply;
    // if anything escapes the cap it is this.
    const { final } = explainConfidence(
      art({ source: "hibp", confidence: 45, metadata: { confidence_cap_applied: 45 } }),
      "key",
    );
    expect(final).toBeLessThanOrEqual(45);
  });

  it("explains the shortfall so Confirm does not silently appear broken", () => {
    const { components, final } = explainConfidence(
      art({ source: "hibp", confidence: 60, metadata: { confidence_cap_applied: 60 } }),
      "confirmed",
    );
    const ceiling = components.find((c) => c.label.startsWith("Source-class ceiling"));
    expect(ceiling).toBeDefined();
    expect(ceiling!.delta).toBeLessThan(0);
    // The popover renders the header total and the component list separately —
    // they must reconcile, or the explanation is not auditable.
    expect(components.reduce((s, c) => s + c.delta, 0)).toBe(final);
  });

  it("is a CEILING, not a target — a dismissal still lands below it", () => {
    const { final } = explainConfidence(
      art({ source: "hibp", confidence: 60, metadata: { confidence_cap_applied: 60 } }),
      "dismissed",
    );
    expect(final).toBeLessThan(60);
  });

  it("a false-positive flag is not lifted up to the cap", () => {
    const { final } = explainConfidence(
      art({ source: "hibp", metadata: { confidence_cap_applied: 75, false_positive: true } }),
    );
    expect(final).toBeLessThan(75);
  });

  it("adds no ceiling component when the cap does not bind", () => {
    const { components } = explainConfidence(
      art({ source: "inference", confidence: 20, metadata: { confidence_cap_applied: 95 } }),
    );
    expect(components.some((c) => c.label.startsWith("Source-class ceiling"))).toBe(false);
  });

  it("leaves artifacts with no cap exactly as before (older rows)", () => {
    const withoutCap = explainConfidence(art({ source: "hibp", metadata: null }), "confirmed");
    const withEmptyMeta = explainConfidence(art({ source: "hibp", metadata: {} }), "confirmed");
    expect(withoutCap.final).toBe(withEmptyMeta.final);
    expect(withoutCap.components.some((c) => c.label.startsWith("Source-class ceiling"))).toBe(false);
  });


  it("the component list always reconciles to the displayed total", () => {
    // The popover renders the header total and the component list from the same
    // object; if they disagree the explanation is not auditable. Covers the
    // saturating, capped, floored and ordinary cases together.
    const cases: Array<[Partial<Artifact>, "confirmed" | "dismissed" | undefined]> = [
      [{ source: "hibp", metadata: { confidence_cap_applied: 60 } }, "confirmed"],
      [{ source: "hibp", metadata: null }, "confirmed"],
      [{ source: "inference", metadata: { confidence_cap_applied: 95, false_positive: true } }, "dismissed"],
      [{ source: "inference", metadata: null }, "dismissed"],
      [{ source: "github", metadata: { confidence_cap_applied: 40 } }, undefined],
    ];
    for (const [over, review] of cases) {
      const { components, final } = explainConfidence(art(over), review);
      expect(components.reduce((s, c) => s + c.delta, 0)).toBe(final);
      expect(final).toBeGreaterThanOrEqual(0);
      expect(final).toBeLessThanOrEqual(100);
    }
  });

  it("accepts a cap that arrives as a JSON string, and ignores a malformed one", () => {
    const asString = explainConfidence(
      art({ source: "hibp", metadata: { confidence_cap_applied: "60" } }), "confirmed");
    expect(asString.final).toBe(60);
    const malformed = explainConfidence(
      art({ source: "hibp", metadata: { confidence_cap_applied: "not-a-number" } }), "confirmed");
    expect(malformed.components.some((c) => c.label.startsWith("Source-class ceiling"))).toBe(false);
  });
});

describe("BADGE_TONE_CLASS", () => {
  it("covers every tone", () => {
    for (const tone of ["high", "mid", "low", "neutral"] as const) {
      expect(BADGE_TONE_CLASS[tone]).toBeTruthy();
    }
  });
});
