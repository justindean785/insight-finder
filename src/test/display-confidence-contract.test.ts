import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import {
  displayConfidence,
  effectiveConfidence,
  effectiveConfidenceOrZero,
} from "@/lib/display-confidence";
import { effectiveFindingConfidence } from "@/lib/authoritative-findings";

/**
 * ONE ARTIFACT, ONE NUMBER.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * On 21c3403 an artifact's confidence reached the screen through five different
 * pipelines. Measured, not inferred: `j.harker@northgate-logistics.com` (stored
 * 88, no recorded cap) rendered
 *
 *     88   Evidence board          raw a.confidence
 *     93   Evidence table          adjustedConfidence() — +5 corroboration bonus
 *     88   Report, unreviewed      review ? adjustedConfidence : raw
 *     93   Report, once reviewed   …the same expression, other branch
 *      ?   ConfidenceExplain       explainConfidence().final — a full
 *                                  re-derivation that never reads a.confidence,
 *                                  rendered inches from the board's own figure
 *
 * in a single session with no analyst action. Inside one EvidenceMatrixTab tile
 * the bar width came from the raw value while the numeral beside it came from
 * the adjusted one.
 *
 * THE CONTRACT (operator-approved 2026-08-31)
 *
 *     effective = cap === null ? stored : min(stored, cap)
 *
 * `displayConfidence` owns it and every surface renders `effective`.
 *
 * TWO KINDS OF TEST, AND BOTH ARE LOAD-BEARING. The unit tests below pin the
 * SEMANTICS. They cannot, on their own, stop a component from going back to
 * `a.confidence` — so the last block is a source guard, the same `readFileSync`
 * idiom sixteen files in this suite already use, and the only way anything about
 * `ResourcesPanel.tsx` has ever been asserted (it has never been rendered under
 * test). Semantics without wiring is how this divergence survived three audits.
 */

const SRC = resolve(__dirname, "..");
const read = (p: string) => readFileSync(resolve(SRC, p), "utf8");

let seq = 0;
function art(over: Partial<Artifact> = {}): Artifact {
  seq += 1;
  return {
    id: `d${seq}`,
    kind: "email",
    value: `row${seq}@example.com`,
    confidence: 88,
    source: "hunter_verify",
    created_at: "2026-08-09T04:00:00.000Z",
    metadata: {},
    ...over,
  } as Artifact;
}

describe("displayConfidence — the formula", () => {
  it("passes the stored value through when no cap is recorded", () => {
    expect(effectiveConfidence(art({ confidence: 88 }))).toBe(88);
  });

  it("clamps to the recorded cap when one is lower", () => {
    const a = art({ confidence: 88, metadata: { confidence_cap_applied: 60 } });
    expect(effectiveConfidence(a)).toBe(60);
    expect(displayConfidence(a).clamped).toBe(true);
  });

  it("does not RAISE a value to meet a higher cap", () => {
    // A cap is a ceiling, never a floor. This is the direction that matters:
    // a cap that could raise a number would be an inflation channel.
    const a = art({ confidence: 40, metadata: { confidence_cap_applied: 90 } });
    expect(effectiveConfidence(a)).toBe(40);
    expect(displayConfidence(a).clamped).toBe(false);
  });

  it("HONOURS A CAP OF ZERO — the truthiness trap", () => {
    // `cap ? … : …` or `cap ?? stored` silently un-caps every 0-capped row and
    // breaks only this assertion. Every comparison in the module is `=== null`.
    const a = art({ confidence: 88, metadata: { confidence_cap_applied: 0 } });
    expect(effectiveConfidence(a)).toBe(0);
    expect(displayConfidence(a).cap).toBe(0);
    expect(displayConfidence(a).clamped).toBe(true);
  });

  it("ignores an unusable cap rather than trusting it", () => {
    for (const bad of [null, undefined, "60", NaN, Infinity, -1, 101, {}, []]) {
      const a = art({ confidence: 70, metadata: { confidence_cap_applied: bad } });
      expect(displayConfidence(a).cap, `cap ${String(bad)}`).toBeNull();
      expect(effectiveConfidence(a), `cap ${String(bad)}`).toBe(70);
    }
  });

  it("reports an unreadable stored value as null, never as a fabricated zero", () => {
    for (const bad of [null, undefined, "88", NaN, -5, 140]) {
      expect(effectiveConfidence(art({ confidence: bad as never })), `stored ${String(bad)}`).toBeNull();
    }
    // …and the or-zero helper exists for meters and sort keys, which cannot
    // express "unknown".
    expect(effectiveConfidenceOrZero(art({ confidence: null }))).toBe(0);
  });

  it("survives absent or hostile metadata", () => {
    expect(effectiveConfidence(art({ metadata: null }))).toBe(88);
    expect(effectiveConfidence(art({ metadata: undefined as never }))).toBe(88);
    expect(effectiveConfidence(null)).toBeNull();
    expect(effectiveConfidence(undefined)).toBeNull();
  });

  it("never mutates the stored value — both are reported side by side", () => {
    const a = art({ confidence: 88, metadata: { confidence_cap_applied: 55 } });
    const d = displayConfidence(a);
    expect(d.stored).toBe(88);
    expect(d.effective).toBe(55);
    expect(a.confidence).toBe(88);
  });
});

describe("displayConfidence — disclosure for the inspector", () => {
  it("carries the server's own reason for the cap", () => {
    const d = displayConfidence(
      art({ metadata: { confidence_cap_applied: 60, reason_for_confidence: "single source class: breach" } }),
    );
    expect(d.capReason).toBe("single source class: breach");
    expect(d.ceilings).toEqual([
      { kind: "recorded", value: 60, reason: "single source class: breach" },
    ]);
  });

  it("discloses the quarantine ceiling without applying it to the number", () => {
    // Authority is a STATE, carried by the chip and the label. Folding it into
    // the figure is how a quarantined row got a confident-looking number.
    const a = art({
      confidence: 65,
      metadata: { subject_unlinked: true, subject_unlinked_reason: "name-only harvest" },
    });
    const d = displayConfidence(a);
    expect(d.effective).toBe(65);
    expect(d.ceilings).toContainEqual({ kind: "quarantine", value: 55, reason: "name-only harvest" });
  });

  it("stops disclosing quarantine once linkage is confirmed", () => {
    const d = displayConfidence(
      art({ metadata: { subject_unlinked: true, linkage_confirmed: true } }),
    );
    expect(d.ceilings.some((c) => c.kind === "quarantine")).toBe(false);
  });

  it("discloses a possible-minor ceiling", () => {
    const d = displayConfidence(art({ metadata: { possible_minor: true } }));
    expect(d.ceilings.some((c) => c.kind === "possible_minor")).toBe(true);
  });

  it("lists every applicable ceiling at once", () => {
    const d = displayConfidence(
      art({
        confidence: 90,
        metadata: { confidence_cap_applied: 45, subject_unlinked: true, possible_minor: true },
      }),
    );
    expect(d.ceilings.map((c) => c.kind)).toEqual(["recorded", "quarantine", "possible_minor"]);
    expect(d.effective).toBe(45);
  });
});

describe("displayConfidence generalises the function that was already correct", () => {
  it("agrees with effectiveFindingConfidence on every shape", () => {
    // `effectiveFindingConfidence` (authoritative-findings.ts) implemented this
    // exact formula for `kind='finding'` rows, was tested, handled a cap of 0 —
    // and had zero callers. This module is that function promoted to every row,
    // so the two must never disagree; if they ever do, one of them has drifted.
    const shapes: Array<Partial<Artifact>> = [
      { confidence: 88, metadata: {} },
      { confidence: 88, metadata: { confidence_cap_applied: 60 } },
      { confidence: 88, metadata: { confidence_cap_applied: 0 } },
      { confidence: 40, metadata: { confidence_cap_applied: 90 } },
      { confidence: 0, metadata: {} },
      { confidence: 100, metadata: { confidence_cap_applied: 100 } },
      { confidence: 70, metadata: { confidence_cap_applied: "nonsense" as never } },
    ];
    for (const s of shapes) {
      const a = art(s);
      expect(effectiveConfidence(a), JSON.stringify(s)).toBe(effectiveFindingConfidence(a));
    }
  });
});

describe("wiring — no surface may render its own number", () => {
  // The source guard. Semantics tests cannot catch a component reverting to
  // `a.confidence`; this can. Same `readFileSync` idiom as evidence-bands.test.ts
  // and evidence-disclosure.test.ts, which is how ResourcesPanel has always been
  // asserted — it has never been rendered under test.
  // Surfaces that render a PER-ARTIFACT confidence. This guard is about one
  // artifact's own number; it deliberately says nothing about aggregates.
  const SURFACES = [
    "components/ResourcesPanel.tsx",
    "components/panel/EvidenceMatrixTab.tsx",
    "components/workspace/OverviewTab.tsx",
    "components/panel/CaseReport.tsx",
  ];

  // NOT IN SCOPE, and the distinction is load-bearing rather than a convenience.
  // `ClustersTab` renders `c.confidence` where `c` is an `IdentityCluster` — an
  // AGGREGATE computed by `buildIdentityClusters` from its members, not any one
  // row's stored value. Re-deriving it from effective member confidences would
  // change identity-cluster SCORING, which is engine behaviour and belongs to the
  // relationship work, not to a display fix. Listed here so its absence is a
  // recorded decision rather than an oversight.
  const AGGREGATE_SURFACES = ["components/panel/ClustersTab.tsx"];

  // DERIVED-MODEL surfaces render a field off a model that `intel.ts` built from
  // an artifact — `TimelineItem.confidence`, `Pivot.confidence`. They never touch
  // `a.confidence`, so requiring an import here would be theatre; the correct
  // enforcement point is the BUILDER, pinned below.
  const DERIVED_SURFACES = ["components/panel/TimelineTab.tsx", "components/workspace/GraphTab.tsx"];

  it("every per-artifact confidence surface imports the canonical helper", () => {
    for (const f of SURFACES) {
      expect(read(f), `${f} must import display-confidence`).toMatch(
        /from "@\/lib\/display-confidence"/,
      );
    }
  });

  it("the cluster aggregate is still an aggregate — not silently re-pointed", () => {
    // If someone later swaps `c.confidence` for a per-row read here, that is a
    // scoring change wearing a display fix's clothes. Fail loudly instead.
    const src = read(AGGREGATE_SURFACES[0]);
    expect(src).toMatch(/ConfidenceTag score=\{c\.confidence\}/);
    expect(src).not.toMatch(/from "@\/lib\/display-confidence"/);
  });

  it("no surface calls adjustedConfidence — that path is the label ladder's alone", () => {
    // `adjustedConfidence` still exists and is still correct for what it now does:
    // it feeds `labelForArtifact`, where the corroboration and direct-profile
    // terms, the review delta and the quarantine / possible-minor ceilings all
    // legitimately live. Classification may weigh source independence; a rendered
    // figure may not re-derive it. Comment lines are skipped — several of these
    // files explain the old expression in prose, and that prose is the record.
    for (const f of [...SURFACES, ...DERIVED_SURFACES]) {
      const calls = read(f)
        .split("\n")
        .map((line, i) => [i + 1, line] as const)
        .filter(([, line]) => /adjustedConfidence\s*\(/.test(line))
        .filter(([, line]) => !/^\s*(\/\/|\*|\/\*)/.test(line));
      expect(calls, `${f} must not call adjustedConfidence: ${JSON.stringify(calls)}`).toHaveLength(0);
    }
  });

  it("the derived-model builders carry the effective value, not the raw one", () => {
    // TimelineTab renders `it.confidence` and PivotCard reads `p.confidence`;
    // both come from intel.ts. Pin the assignment, because that is the only place
    // a raw value could re-enter a rendered number without any component naming
    // `a.confidence` at all.
    const graph = read("lib/entity-graph.ts");
    expect(graph).toMatch(/confidence: effectiveConfidenceOrZero\(a\),/);
    expect(graph).not.toMatch(/confidence: a\.confidence \?\? 0,/);
    const intel = read("lib/intel.ts");
    expect(intel).toMatch(/confidence: effectiveConfidence\(a\),/);
    expect(intel).toMatch(/confidence: effectiveConfidenceOrZero\(a\),/);
    expect(intel).not.toMatch(/confidence: a\.confidence,/);
    expect(intel).not.toMatch(/confidence: a\.confidence \?\? 0,/);
  });

  it("no surface reads a raw `.confidence` for display", () => {
    // Narrow on purpose: this matches the exact raw-read idioms that produced the
    // divergence (`a.confidence ?? 0`, `x.confidence != null`, `.confidence}%`),
    // not every mention of the word.
    const RAW = /\.confidence\s*(\?\?|\|\||!=|===|==|\}|\))/;
    for (const f of SURFACES) {
      const offending = read(f)
        .split("\n")
        .map((line, i) => [i + 1, line] as const)
        .filter(([, line]) => RAW.test(line))
        .filter(([, line]) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        // `displayConfidence(...).stored` is the sanctioned disclosure read.
        .filter(([, line]) => !/displayConfidence|\.stored/.test(line))
        // `f.confidence` is an AuthoritativeFinding, whose confidence IS
        // `effectiveFindingConfidence` — the same `min(stored, cap)` formula,
        // applied at construction in authoritative-findings.ts. The
        // "agrees with effectiveFindingConfidence" test above pins the two
        // together, so this read is already canonical.
        .filter(([, line]) => !/\bf\.confidence\b/.test(line));
      expect(offending, `${f} raw confidence reads: ${JSON.stringify(offending)}`).toHaveLength(0);
    }
  });
});
