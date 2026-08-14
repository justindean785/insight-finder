import { describe, it, expect } from "vitest";
import { adjustedConfidence, labelForArtifact, QUARANTINE_CEILING } from "@/lib/intel";
import type { Artifact } from "@/hooks/useThreadArtifacts";

/**
 * RESIDUAL-GAP PROBE — is there anything left for a client-side quarantine PR
 * after #448, or is it fully covered?
 *
 * #448 bound `subject_unlinked` at clustering (isClusterIneligible x5) and at the
 * LABEL ladder (labelForArtifact's hard floor). It did not touch the NUMBER.
 * `adjustedConfidence` special-cases `possible_minor` with a 55 cap and penalises
 * conflict/collision by -15, but has no quarantine branch at all — so a quarantined
 * row still collects the corroboration bonus and a positive review delta.
 *
 * That number is not internal: `EvidenceMatrixTab.tsx:41` renders it as the
 * analyst-facing score. The backend caps quarantined rows at 55 (canary run
 * 4d0193c7 observed max 55 across 24 quarantined artifacts), so any client value
 * above 55 is the display contradicting the persisted ceiling.
 */

function quarantined(over: Partial<Artifact> = {}): Artifact {
  return {
    id: "q1",
    thread_id: "t1",
    kind: "phone",
    value: "+1 209 555 0117",
    confidence: 55,
    source: "oathnet_lookup",
    created_at: new Date(0).toISOString(),
    metadata: {
      subject_unlinked: true,
      subject_unlinked_reason: "harvested from a name-only query",
      // three distinct source classes => +10 corroboration, plus a direct
      // profile observation => +5. Ordinary, unremarkable provenance.
      sources: ["oathnet_lookup", "indicia_person", "socialfetch"],
      source_category: ["breach_corpus", "data_broker", "social_profile"],
    },
    ...over,
  } as unknown as Artifact;
}

describe("residual gap after #448: the confidence NUMBER", () => {
  it("caps a quarantined row's displayed confidence at the 55 ceiling the backend enforces", () => {
    const score = adjustedConfidence(quarantined());
    expect(score).toBeLessThanOrEqual(55);
  });

  it("does not let an analyst attestation inflate a quarantined row's number", () => {
    const score = adjustedConfidence(quarantined(), "confirmed");
    expect(score).toBeLessThanOrEqual(55);
  });

  it("still applies NEGATIVE adjustments to quarantined rows", () => {
    // Quarantine is a CEILING, not a floor: it must not lift a row that other
    // signals push down. A sweep-only quarantined row carries -10, so it has to
    // land strictly below the 55 cap rather than being pinned to it.
    const sweepOnly = quarantined({
      source: "username_sweep",
      metadata: {
        subject_unlinked: true,
        sources: ["username_sweep"],
        source_category: ["username_sweep"],
      },
    } as Partial<Artifact>);
    expect(adjustedConfidence(sweepOnly)).toBeLessThan(55);
  });
});

describe("control: #448's behaviour must be preserved, not regressed", () => {
  it("LABEL floor already holds — ordinary attestation cannot CONFIRM a quarantined row", () => {
    expect(labelForArtifact(quarantined(), "confirmed")).not.toBe("CONFIRMED");
  });

  it("linkage_confirmed STILL clears quarantine — the deliberate escape hatch", () => {
    const adjudicated = quarantined({
      metadata: { ...(quarantined().metadata as object), linkage_confirmed: true },
    } as Partial<Artifact>);
    expect(labelForArtifact(adjudicated, "confirmed")).toBe("CONFIRMED");
  });

  it("linkage_confirmed restores the NUMBER too, not just the label", () => {
    // Caught by mutation testing: gating the cap on `isSubjectUnlinked` instead of
    // `isQuarantined` leaves every other assertion green while silently deleting
    // #448's escape hatch at this boundary. Adjudicated provenance must restore
    // full authority to the score exactly as it does to the label.
    const adjudicated = quarantined({
      metadata: { ...(quarantined().metadata as object), linkage_confirmed: true },
    } as Partial<Artifact>);
    expect(adjustedConfidence(adjudicated)).toBeGreaterThan(QUARANTINE_CEILING);
  });

  it("an un-quarantined row still receives its corroboration bonus", () => {
    const linked = quarantined({ metadata: { sources: ["oathnet_lookup", "indicia_person", "socialfetch"] } } as Partial<Artifact>);
    expect(adjustedConfidence(linked)).toBeGreaterThan(55);
  });
});
