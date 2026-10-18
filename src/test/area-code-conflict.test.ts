import { describe, it, expect } from "vitest";
import { areaCodesDisagreeAcrossClusters, buildIdentityClusters } from "@/lib/intel";
import type { Artifact } from "@/hooks/useThreadArtifacts";

/**
 * The area-code warning fired on a UNION across every cluster, so ONE cluster holding two phones from
 * different area codes (one person, two numbers) printed "Phone area codes across clusters disagree —
 * likely different people" and also raised the same-name-collision banner. An area code is where a
 * number was ISSUED, not where its holder lives.
 *
 * Every value is fictitious (RFC 2606 / 555-01xx numbers).
 */
function mk(p: { id: string; kind: string; value: string; metadata?: Record<string, unknown>; source?: string }): Artifact {
  return {
    id: p.id, kind: p.kind, value: p.value, confidence: 60, source: p.source ?? "serus_darkweb_scan",
    created_at: "2026-10-06T12:00:00Z", metadata: p.metadata ?? null,
  };
}

/** One person: an email, a record that carries the email + its phones, and the phone artifacts. */
function person(tag: string, email: string, phones: string[]): Artifact[] {
  return [
    mk({ id: `${tag}-e`, kind: "email", value: email }),
    mk({
      id: `${tag}-r`, kind: "breach_exposure", value: `${email} - 3 breaches`,
      metadata: { email, phones: phones.map((p) => p.replace(/\D/g, "").slice(-10)) },
    }),
    ...phones.map((ph, i) => mk({ id: `${tag}-p${i}`, kind: "phone", value: ph })),
  ];
}

const AREA_WARNING = /^Phone area codes/;
const has = (warnings: string[]) => warnings.some((w) => AREA_WARNING.test(w));

describe("areaCodesDisagreeAcrossClusters", () => {
  it("one cluster's own mix of codes is not a disagreement", () => {
    expect(areaCodesDisagreeAcrossClusters([["213", "415"]])).toBe(false);
    expect(areaCodesDisagreeAcrossClusters([["213", "415"], []])).toBe(false);
  });
  it("two clusters that each have a code and share none disagree", () => {
    expect(areaCodesDisagreeAcrossClusters([["213"], ["415"]])).toBe(true);
    expect(areaCodesDisagreeAcrossClusters([["213", "415"], ["617"]])).toBe(true);
  });
  it("two clusters that share any code do not", () => {
    expect(areaCodesDisagreeAcrossClusters([["213"], ["213"]])).toBe(false);
    expect(areaCodesDisagreeAcrossClusters([["213", "415"], ["415", "617"]])).toBe(false);
  });
  it("clusters without a phone are ignored", () => {
    expect(areaCodesDisagreeAcrossClusters([[], [], ["213"]])).toBe(false);
  });
});

describe("buildIdentityClusters — the area-code warning", () => {
  it("ONE cluster with phones from two area codes raises no area-code warning (the false alarm)", () => {
    const arts = person("a", "casey.sample@example.test", ["+12135550101", "+14155550102"]);
    const r = buildIdentityClusters(arts, "casey.sample@example.test");
    const one = r.clusters.find((c) => c.artifacts.some((a) => a.id === "a-e"));
    expect(one?.areaCodes.sort()).toEqual(["213", "415"]);
    expect(has(r.warnings)).toBe(false);
  });

  it("two separate clusters with different area codes DO warn — in wording that never asserts it", () => {
    const arts = [
      ...person("a", "casey.sample@example.test", ["+12135550101"]),
      ...person("b", "morgan.sample@example.test", ["+16175550103"]),
    ];
    const r = buildIdentityClusters(arts, "sample");
    const w = r.warnings.find((x) => AREA_WARNING.test(x));
    expect(w).toBeTruthy();
    expect(w).toContain("not where its holder lives");
    expect(w!.toLowerCase()).not.toContain("likely different people");
  });

  it("two separate clusters that share an area code do not warn", () => {
    const arts = [
      ...person("a", "casey.sample@example.test", ["+12135550101"]),
      ...person("b", "morgan.sample@example.test", ["+12135550104"]),
    ];
    expect(has(buildIdentityClusters(arts, "sample").warnings)).toBe(false);
  });
});
