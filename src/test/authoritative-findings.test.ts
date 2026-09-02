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
import { authorityStatement, selectAuthoritativeFindings } from "@/lib/authoritative-findings";
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

describe("authorityStatement: the wording both producers share", () => {
  const R = (over: Partial<import("@/lib/authoritative-findings").AuthoritativeFindings>) =>
    ({ state: "complete", findings: [], rejectedCount: 0, totalArtifacts: 0, ...over }) as never;

  it("says NONE ADJUDICATED, not 'no findings', on the common empty case", () => {
    const s = authorityStatement(R({ totalArtifacts: 49 }));
    expect(s).toContain("adjudicated no findings");
    expect(s).toContain("49 artifacts were collected");
    expect(s).toContain("lead, not an adjudicated finding");
  });

  it("distinguishes all-rejected from none-recorded", () => {
    const rejected = authorityStatement(R({ rejectedCount: 2 }));
    expect(rejected).toContain("after analyst review");
    expect(rejected).not.toContain("adjudicated no findings");
  });

  it("never says 'none' when an input was unreadable", () => {
    for (const state of ["retrieval_unavailable", "reviews_unavailable"] as const) {
      const s = authorityStatement(R({ state }));
      expect(s).toContain("unavailable");
      expect(s).not.toContain("adjudicated no findings");
      expect(s).not.toContain("after analyst review:");
    }
  });

  it("distinguishes a SYNTHESIZED conclusion from a model-asserted one", () => {
    // Acceptance requirement: an analyst must be able to tell a derived
    // conclusion from one the orchestrator asserted. Both are scored by the
    // identical engine chain, so the number is not the discriminator — the
    // origin marker is.
    const out = sel([
      art({ id: "s", value: "derived", confidence: 62, metadata: { finding_origin: "synthesis" } }),
      art({ id: "m", value: "asserted", confidence: 62, metadata: { status: "observed" } }),
    ]);
    const byId = Object.fromEntries(out.findings.map((f) => [f.id, f.origin]));
    expect(byId.s).toBe("synthesis");
    expect(byId.m).toBe("model");
  });

  it("defaults origin to model — never attributes an unreadable row to synthesis", () => {
    // The 13 findings that predate synthesis carry no marker, and every one of
    // them came from record_finding. Guessing "synthesis" on an unreadable row
    // would credit a machine derivation that never happened.
    const out = sel([
      art({ id: "a", value: "old" }),
      art({ id: "b", value: "junk", metadata: "not-an-object" as never }),
      art({ id: "c", value: "wrong", metadata: { finding_origin: 7 } as never }),
    ]);
    expect(out.findings.map((f) => f.origin)).toEqual(["model", "model", "model"]);
  });

  it("discloses a ceiling on every state that can carry one", () => {
    expect(authorityStatement(R({ state: "ceiling_hit" }))).toContain("may be incomplete");
    expect(authorityStatement(R({ state: "ceiling_hit", rejectedCount: 1 }))).toContain("may be incomplete");
    expect(authorityStatement(R({ state: "ceiling_hit", findings: [{ id: "a", value: "v", confidence: 50, tier: "weak" as const, origin: "model" as const }] })))
      .toContain("may be incomplete");
  });

  it("reports the adjudicated count and any review exclusions", () => {
    const s = authorityStatement(R({ findings: [{ id: "a", value: "v", confidence: 50, tier: "weak" as const, origin: "model" as const }], rejectedCount: 3 }));
    expect(s).toContain("adjudicated 1 finding");
    expect(s).toContain("3 further recorded findings were excluded");
  });

  it("is total against a malformed result", () => {
    for (const bad of [null, undefined, 42, "x"]) {
      expect(typeof authorityStatement(bad as never)).toBe("string");
    }
  });
});
