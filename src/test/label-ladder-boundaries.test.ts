import { describe, it, expect } from "vitest";
import { labelForArtifact, adjustedConfidence } from "@/lib/intel";
import { effectiveConfidence } from "@/lib/display-confidence";
import type { Artifact } from "@/hooks/useThreadArtifacts";

/**
 * EVERY RUNG OF THE LABEL LADDER, AT threshold-1 / threshold / threshold+1.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Splitting display confidence out of `adjustedConfidence` was very nearly done
 * the wrong way. The first attempt deleted the corroboration bonus from the
 * scoring function and then lowered the CONFIRMED comparison 85 -> 80 to
 * compensate, reasoning that a two-class row scored +5 so the effective bar had
 * always been 80. The arithmetic was correct. The change was still wrong, for a
 * reason no existing test could have caught:
 *
 *   - It re-tuned CLASSIFICATION as a side effect of a DISPLAY fix.
 *   - It compensated the ONE rung that happened to have a test. The same +5 also
 *     lifted rows over the 70 CORRELATED rung and the identity branch's own 70,
 *     and the separate direct-profile +5 lifted rows over 85 / 65 / 40. Those
 *     four rungs would have moved silently, in production, with a green suite.
 *
 * The resolution keeps the two concerns apart instead of trading between them:
 * `adjustedConfidence` remains the CLASSIFICATION score and keeps every term the
 * ladder was tuned against, and `displayConfidence` — `min(stored, cap)` — is the
 * only thing rendered. `intel.ts` therefore has ZERO executable change; its whole
 * diff is comments.
 *
 * These tests exist so that stays true. They pin each rung from both sides, so a
 * future compensation cannot move one without turning something red. Nothing here
 * asserts new behaviour: every expectation below is what `origin/main` already
 * does.
 */

let seq = 0;

/**
 * A row whose classification score is EXACTLY its stored confidence.
 *
 * Getting this right is the whole test. `adjustedConfidence` adds +5/+10 for
 * coarse source classes derived from `[a.source, ...metadata.sources]`, so a
 * single `source` and no `metadata.sources` gives bonus 0. `whois` is not a
 * breach source, not a sweep source and not a direct profile, so no penalty and
 * no direct-profile bonus. `kind: "email"` avoids the identity branch. No review,
 * so no delta; no conflict or false_positive, so no CONFLICT/FAILED short-circuit.
 *
 * `independentClasses` is controlled SEPARATELY via `metadata.source_category`,
 * which `artifactSourceClasses` reads and which does not feed `allSources` — so
 * the two knobs move independently, which is what lets these tests sit on a rung.
 */
function row(confidence: number, classes: string[], over: Partial<Artifact> = {}): Artifact {
  seq += 1;
  return {
    id: `L${seq}`,
    kind: "email",
    value: `ladder${seq}@example.com`,
    confidence,
    source: "whois",
    created_at: "2026-08-09T04:00:00.000Z",
    metadata: { source_category: classes },
    ...over,
  } as Artifact;
}

const TWO = ["infra_registry", "independent_public"];
const ONE = ["infra_registry"];

describe("the fixture itself scores what it says it scores", () => {
  // If this drifts, every boundary below is measuring the wrong number and the
  // failures would look like ladder bugs. Assert the premise first.
  it("classification score equals stored confidence for these rows", () => {
    for (const c of [39, 40, 64, 65, 69, 70, 84, 85, 86]) {
      expect(adjustedConfidence(row(c, TWO)), `two-class @${c}`).toBe(c);
      expect(adjustedConfidence(row(c, ONE)), `one-class @${c}`).toBe(c);
    }
  });
});

describe("rung: CONFIRMED — c >= 85 with >= 2 independent classes", () => {
  it("84 is below the rung", () => expect(labelForArtifact(row(84, TWO))).toBe("CORRELATED"));
  it("85 is on the rung", () => expect(labelForArtifact(row(85, TWO))).toBe("CONFIRMED"));
  it("86 is above the rung", () => expect(labelForArtifact(row(86, TWO))).toBe("CONFIRMED"));

  it("needs the classes as well as the number — 85 with one class does not confirm", () => {
    expect(labelForArtifact(row(85, ONE))).not.toBe("CONFIRMED");
  });
});

describe("rung: CORRELATED — c >= 70 with >= 2 independent classes", () => {
  it("69 is below the rung", () => expect(labelForArtifact(row(69, TWO))).toBe("INFERRED"));
  it("70 is on the rung", () => expect(labelForArtifact(row(70, TWO))).toBe("CORRELATED"));
  it("71 is above the rung", () => expect(labelForArtifact(row(71, TWO))).toBe("CORRELATED"));
});

describe("rung: INFERRED — c >= 65, single class", () => {
  it("64 is below the rung", () => expect(labelForArtifact(row(64, ONE))).toBe("VERIFY"));
  it("65 is on the rung", () => expect(labelForArtifact(row(65, ONE))).toBe("INFERRED"));
  it("66 is above the rung", () => expect(labelForArtifact(row(66, ONE))).toBe("INFERRED"));
});

describe("rung: VERIFY — c >= 40", () => {
  it("39 is below the rung", () => expect(labelForArtifact(row(39, ONE))).toBe("LOW"));
  it("40 is on the rung", () => expect(labelForArtifact(row(40, ONE))).toBe("VERIFY"));
  it("41 is above the rung", () => expect(labelForArtifact(row(41, ONE))).toBe("VERIFY"));
});

describe("rung: identity handle without a direct profile — c >= 70 with >= 2 classes", () => {
  // A separate branch with its OWN 70, and one of the rungs the abandoned
  // compensation would have moved without any test noticing.
  const handle = (c: number, classes: string[]) =>
    row(c, classes, { kind: "username", value: `handle${seq}` });

  it("69 is below the rung", () => expect(labelForArtifact(handle(69, TWO))).toBe("INFERRED"));
  it("70 is on the rung", () => expect(labelForArtifact(handle(70, TWO))).toBe("CORRELATED"));
  it("71 is above the rung", () => expect(labelForArtifact(handle(71, TWO))).toBe("CORRELATED"));
  it("49/50 straddle the branch's own INFERRED floor", () => {
    expect(labelForArtifact(handle(49, ONE))).toBe("VERIFY");
    expect(labelForArtifact(handle(50, ONE))).toBe("INFERRED");
  });
});

describe("caps reach the LADDER as well as the figure", () => {
  it("a recorded cap lowers the classification score, so it can lower the label", () => {
    // Stored 90 with two classes would CONFIRM. Capped to 60 it must not, and the
    // displayed number must agree with the cap.
    const capped = row(90, TWO, {
      metadata: { source_category: TWO, confidence_cap_applied: 60 },
    });
    expect(adjustedConfidence(capped)).toBe(60);
    expect(effectiveConfidence(capped)).toBe(60);
    expect(labelForArtifact(capped)).not.toBe("CONFIRMED");
  });

  it("a cap of 0 clamps both the label input and the displayed figure", () => {
    const zero = row(90, TWO, { metadata: { source_category: TWO, confidence_cap_applied: 0 } });
    expect(adjustedConfidence(zero)).toBe(0);
    expect(effectiveConfidence(zero)).toBe(0);
    expect(labelForArtifact(zero)).toBe("LOW");
  });
});

describe("reviews move the LABEL, never the displayed figure", () => {
  it("an attestation confirms the label and leaves the number alone", () => {
    const a = row(40, ONE);
    expect(labelForArtifact(a)).toBe("VERIFY");
    // ATTESTED, not CONFIRMED: the analyst's decision is its own rung so the
    // label never claims a second source class the evidence does not have.
    expect(labelForArtifact(a, "confirmed")).toBe("ATTESTED");
    // …and the figure an analyst reads is untouched by that click.
    expect(effectiveConfidence(a)).toBe(40);
  });

  it("a negative verdict fails the label and still leaves the number alone", () => {
    const a = row(88, TWO);
    expect(labelForArtifact(a, "dismissed")).toBe("FAILED");
    expect(effectiveConfidence(a)).toBe(88);
  });
});

describe("quarantine: the ceiling, and its explicit restoration", () => {
  const quarantined = (over: Record<string, unknown> = {}) =>
    row(88, TWO, {
      kind: "phone",
      value: "+1 209 555 0117",
      metadata: { source_category: TWO, subject_unlinked: true, subject_unlinked_reason: "name-only harvest", ...over },
    });

  it("a quarantined row cannot reach CONFIRMED, with or without an attestation", () => {
    // And the mechanism is worth naming, because it is not the CORRELATED
    // downgrade in the >=85 branch — the 55 ceiling gets there first. A row
    // stored at 88 arrives at the ladder as 55, which is below the 70 CORRELATED
    // rung and below the 65 INFERRED rung, so it lands on VERIFY. Two independent
    // controls, and the ceiling is the one that binds.
    expect(labelForArtifact(quarantined())).toBe("VERIFY");
    expect(labelForArtifact(quarantined(), "confirmed")).not.toBe("CONFIRMED");
  });

  it("linkage_confirmed restores the label — the #448 escape hatch", () => {
    // The released row is corroborated (two classes, 88): evidence-derived
    // CONFIRMED outranks the analyst rung and is what the escape hatch restores.
    expect(labelForArtifact(quarantined({ linkage_confirmed: true }), "confirmed")).toBe("CONFIRMED");
  });

  it("the quarantine ceiling clamps the classification score but not the figure", () => {
    // Deliberate, and the reason is in display-confidence.ts: authority is a STATE
    // (the chip, the label), not a discount on the evidence. The row's stored 88
    // is what the evidence said; the chip is what says not to trust it as this
    // subject's.
    expect(adjustedConfidence(quarantined())).toBeLessThanOrEqual(55);
    expect(effectiveConfidence(quarantined())).toBe(88);
  });
});
