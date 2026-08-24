/**
 * authoritative-findings.test.ts — #499.
 *
 * THE DEFECT. The deterministic Report has no concept of an adjudicated finding.
 * `grep "finding" src/lib/intel.ts` returns prose only; "Key Findings" is built
 * from `labelForArtifact(a) === "CONFIRMED"` over ALL artifacts — a source-tier
 * label. So on a run where `record_finding` never fired, the Report can still
 * present a populated Key Findings section, and the analyst has no way to see
 * that the engine adjudicated nothing.
 *
 * Measured production shape: 49 artifacts, 0 of kind='finding', deterministic UI
 * 0 Confirmed / 47 Leads — while the model's stored prose claimed 90-95% CONFIRMED.
 *
 * This selector is the single source of truth both live producers consume
 * (`intel.ts:buildReportMarkdown` and `CaseReport.tsx`). It deliberately does NOT
 * reuse `adjustedConfidence`: that adds review deltas and a corroboration bonus,
 * and the authoritative number must stay exactly min(confidence, recorded cap) —
 * the contract settled in #479.
 */
import { describe, it, expect } from "vitest";
import { selectAuthoritativeFindings } from "@/lib/authoritative-findings";
import type { Artifact } from "@/hooks/useThreadArtifacts";

const art = (over: Partial<Artifact> & { id: string }): Artifact => ({
  kind: "finding", value: "the adjudicated conclusion", confidence: 50,
  source: "oathnet_lookup", created_at: "2026-08-24T00:00:00Z", metadata: {},
  ...over,
} as Artifact);

const OK = { ceilingHit: false, retrievalFailed: false, reviewsAvailable: true };
const sel = (artifacts: Artifact[], reviews = {}, opts = {}) =>
  selectAuthoritativeFindings(artifacts, reviews, { ...OK, ...opts });

describe("population: recorded findings, not best artifacts", () => {
  it("selects only kind='finding'", () => {
    const r = sel([
      art({ id: "f1", value: "adjudicated" }),
      art({ id: "e1", kind: "email", value: "a@b.c", confidence: 88 }),
      art({ id: "n1", kind: "name", value: "A Name", confidence: 92 }),
    ]);
    expect(r.findings.map((f) => f.value)).toEqual(["adjudicated"]);
  });

  it("PRODUCTION SHAPE: many ordinary artifacts, zero findings", () => {
    // The repro. Several rows above the Likely boundary; none is a finding.
    const rows = Array.from({ length: 49 }, (_, i) =>
      art({ id: `a${i}`, kind: ["name", "email", "breach_exposure", "legal_record"][i % 4],
            value: `ordinary ${i}`, confidence: 60 + (i % 29),
            metadata: { label: "CONFIRMED" } }));
    const r = sel(rows);
    expect(r.state).toBe("complete");
    expect(r.findings).toEqual([]);
    expect(r.rejectedCount).toBe(0);
    expect(r.totalArtifacts).toBe(49);
  });
});

describe("the number: min(confidence, recorded cap), no deltas", () => {
  it("clamps to the recorded cap", () => {
    const r = sel([art({ id: "f1", confidence: 95, metadata: { confidence_cap_applied: 70 } })]);
    expect(r.findings[0].confidence).toBe(70);
    expect(r.findings[0].tier).toBe("possible");
  });

  it("leaves a row under its cap alone, and ignores an unusable cap", () => {
    expect(sel([art({ id: "f1", confidence: 40, metadata: { confidence_cap_applied: 70 } })]).findings[0].confidence).toBe(40);
    for (const bad of [null, "70", NaN, -1, 101]) {
      expect(sel([art({ id: "f1", confidence: 60, metadata: { confidence_cap_applied: bad } })]).findings[0].confidence).toBe(60);
    }
  });

  it("mirrors the 90/75/55/35 ladder at every boundary", () => {
    const cases: Array<[number, string]> = [
      [90, "confirmed"], [89, "likely"], [75, "likely"], [74, "possible"],
      [55, "possible"], [54, "weak"], [35, "weak"], [34, "unverified"],
    ];
    for (const [c, tier] of cases) {
      expect(sel([art({ id: "f1", confidence: c })]).findings[0].tier).toBe(tier);
    }
  });

  it("an out-of-range stored score can never publish the top tier", () => {
    // A corrupt 101 must not read as Confirmed. tierOf() alone would say it does.
    const r = sel([art({ id: "f1", confidence: 101 })]);
    expect(r.findings[0].tier).not.toBe("confirmed");
  });

  it("ignores metadata.label — the model's own unchecked pick", () => {
    const r = sel([art({ id: "f1", value: "the real value", confidence: 50,
                         metadata: { label: "CONFIRMED", status: "confirmed" } })]);
    expect(r.findings[0].confidence).toBe(50);
    expect(r.findings[0].tier).toBe("weak");
    // Not just the number: no model-authored string may reach this surface at
    // all. Asserting only confidence/tier let a mutant that renders
    // metadata.label AS THE VALUE survive.
    expect(r.findings[0].value).toBe("the real value");
    expect(JSON.stringify(r)).not.toContain("CONFIRMED");
    expect(JSON.stringify(r)).not.toContain("confirmed");
  });

  it("a positive analyst verdict does NOT move the number", () => {
    // Guards against anyone reaching for adjustedConfidence here.
    for (const state of ["confirmed", "key", "recheck"]) {
      const r = sel([art({ id: "f1", confidence: 50 })], { f1: state });
      expect(r.findings[0].confidence).toBe(50);
      expect(r.findings[0].tier).toBe("weak");
    }
  });
});

describe("analyst rejection", () => {
  it("excludes dismissed and wrong, and counts them", () => {
    const r = sel(
      [art({ id: "f1", value: "rejected one" }), art({ id: "f2", value: "standing one" })],
      { f1: "dismissed" },
    );
    expect(r.findings.map((f) => f.value)).toEqual(["standing one"]);
    expect(r.rejectedCount).toBe(1);
  });

  it("all findings rejected is distinguishable from none recorded", () => {
    const allRejected = sel([art({ id: "f1" }), art({ id: "f2" })], { f1: "wrong", f2: "dismissed" });
    expect(allRejected.findings).toEqual([]);
    expect(allRejected.rejectedCount).toBe(2);

    const noneRecorded = sel([art({ id: "e1", kind: "email", value: "a@b.c" })]);
    expect(noneRecorded.findings).toEqual([]);
    expect(noneRecorded.rejectedCount).toBe(0);
  });
});

describe("failure states never read as clean", () => {
  it("reviews unavailable withholds findings entirely", () => {
    const r = sel([art({ id: "f1", value: "possibly rejected" })], {}, { reviewsAvailable: false });
    expect(r.state).toBe("reviews_unavailable");
    expect(r.findings).toEqual([]);
    expect(r.rejectedCount).toBe(0);
  });

  it("a failed artifact read is not an empty case", () => {
    const r = sel([], {}, { retrievalFailed: true });
    expect(r.state).toBe("retrieval_unavailable");
    expect(r.findings).toEqual([]);
  });

  it("retrieval failure outranks a ceiling hit", () => {
    expect(sel([], {}, { retrievalFailed: true, ceilingHit: true }).state).toBe("retrieval_unavailable");
  });

  it("a filled fetch discloses its ceiling but is still a read", () => {
    const r = sel([art({ id: "f1" })], {}, { ceilingHit: true });
    expect(r.state).toBe("ceiling_hit");
    expect(r.findings).toHaveLength(1);
  });
});

describe("determinism", () => {
  it("orders strongest first, id as tiebreak, stable under input order", () => {
    const rows = [
      art({ id: "ccc", value: "third", confidence: 40 }),
      art({ id: "aaa", value: "first", confidence: 70 }),
      art({ id: "bbb", value: "second", confidence: 40 }),
    ];
    const order = sel(rows).findings.map((f) => f.value);
    expect(order).toEqual(["first", "second", "third"]);
    expect(sel([...rows].reverse()).findings.map((f) => f.value)).toEqual(order);
  });

  it("is total against malformed rows", () => {
    const r = sel([null, undefined, 42, {}, { id: "f1", kind: "finding" }] as unknown as Artifact[]);
    expect(Array.isArray(r.findings)).toBe(true);
  });
});
