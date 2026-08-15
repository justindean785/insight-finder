import { describe, it, expect } from "vitest";
import { adjustedConfidence, QUARANTINE_CEILING, POSSIBLE_MINOR_CEILING } from "@/lib/intel";
import type { Artifact } from "@/hooks/useThreadArtifacts";

/**
 * THE SERVER'S CAP IS A CEILING ON WHAT WE DISPLAY.
 *
 * Measured on a real run (thread 2d0dcd03, live build 8c6184b). The report's
 * "Key Findings" section published numbers ABOVE the value persisted for the
 * very same row, which the Artifact Table on the same page showed correctly:
 *
 *   row                                   stored   published
 *   Reddit r/CaliBanging post              70       95
 *   "DPH Blood Rapper" event               70       95
 *   username hawkcapo                      50       75
 *   DPH territory (weak_lead)              35       60
 *   "beef with 3300QP" (weak_lead)         40       65
 *
 * 95 crosses the CONFIRMED threshold (>=80), so unadjudicated community posts
 * about a named private individual were published as confirmed-grade findings.
 *
 * The cause is not the engine. Every one of those rows carries a server-computed
 * `confidence_cap_applied` that encodes "this row's source classes cannot support
 * more than N" — and the client then adds REVIEW_DELTA (key: +25, confirmed:
 * +20) plus its own corroboration bonus (+10/+5/+5) ON TOP, using a cruder
 * source-class split than the server's classifySource. That double-counts
 * corroboration the server already counted, and it re-opens the exact defect
 * "published above the server's own cap" that the report work exists to close.
 *
 * `intel.ts` already enforces this shape TWICE — POSSIBLE_MINOR_CEILING and the
 * quarantine ceiling — with the argument stated in its own comment: "the backend
 * already enforces this ceiling on write ... so an uncapped client value is the
 * display contradicting the persisted record." What was missing is the GENERAL
 * case. These tests add it.
 *
 * Asymmetric on purpose, exactly like the quarantine ceiling: a CEILING, never a
 * floor. Negative signals still apply in full below it.
 */

function artifact(over: Partial<Artifact> = {}): Artifact {
  return {
    id: "a1",
    thread_id: "t1",
    kind: "legal_record",
    value: "Reddit r/CaliBanging post",
    confidence: 70,
    source: "socialfetch_web_read",
    created_at: new Date(0).toISOString(),
    metadata: { confidence_cap_applied: 70 },
    ...over,
  } as Artifact;
}

describe("display confidence never exceeds the server's recorded cap", () => {
  it("does not publish 95 for a row the server capped at 70", () => {
    // The headline regression. `key` is the strongest analyst review (+25).
    expect(adjustedConfidence(artifact(), "key")).toBeLessThanOrEqual(70);
  });

  it("holds the cap for every review state that adds confidence", () => {
    for (const review of ["key", "confirmed"] as const) {
      expect(adjustedConfidence(artifact(), review)).toBeLessThanOrEqual(70);
    }
  });

  it("holds the cap against the corroboration bonus", () => {
    // Three source classes would add +10, and a direct profile source +5. The
    // server already counted independence when it computed the cap, so adding
    // it again on the client is double-counting, not new evidence.
    const multi = artifact({
      confidence: 50,
      metadata: {
        confidence_cap_applied: 50,
        sources: ["seed", "memory_recall", "socialfetch_lookup"],
      },
    });
    expect(adjustedConfidence(multi)).toBeLessThanOrEqual(50);
  });

  it("holds the cap for the weak_lead rows that were published +25", () => {
    const weak = artifact({
      kind: "weak_lead",
      confidence: 35,
      metadata: { confidence_cap_applied: 35 },
    });
    expect(adjustedConfidence(weak, "key")).toBeLessThanOrEqual(35);
  });

  it("is a CEILING, not a floor — negatives still apply beneath it", () => {
    // A capped row that an analyst marked wrong must still fall.
    const wrong = adjustedConfidence(artifact(), "wrong");
    expect(wrong).toBeLessThan(70);
    expect(wrong).toBeGreaterThanOrEqual(0);
  });

  it("leaves rows with no recorded cap exactly as they were", () => {
    // Do not invent a ceiling where the server recorded none — that would be a
    // silent behaviour change on every legacy row.
    const uncapped = artifact({ metadata: {} });
    const withReview = adjustedConfidence(uncapped, "key");
    expect(withReview).toBeGreaterThan(70);
  });

  it("ignores a malformed cap rather than clamping to nonsense", () => {
    for (const bad of ["70", null, undefined, Number.NaN, -5] as unknown[]) {
      const row = artifact({ metadata: { confidence_cap_applied: bad } });
      // Falls back to unclamped behaviour; must not throw and must not pin to 0.
      expect(adjustedConfidence(row, "key")).toBeGreaterThan(70);
    }
  });

  it("keeps the quarantine ceiling winning when it is lower", () => {
    // Two ceilings must compose to the STRICTER one, not fight.
    const q = artifact({
      confidence: 55,
      metadata: {
        confidence_cap_applied: 70,
        subject_unlinked: true,
        subject_unlinked_reason: "UNLINKED_ECHO_CTX",
      },
    });
    expect(adjustedConfidence(q, "key")).toBeLessThanOrEqual(QUARANTINE_CEILING);
  });

  it("keeps the possible-minor ceiling winning when it is lower", () => {
    const minor = artifact({
      confidence: 70,
      metadata: { confidence_cap_applied: 70, possible_minor: true },
    });
    expect(adjustedConfidence(minor, "key")).toBeLessThanOrEqual(POSSIBLE_MINOR_CEILING);
  });

  it("lets adjudicated linkage clear the cap, as it clears quarantine", () => {
    // Parity with #448's escape hatch. `linkage_confirmed` is the one review
    // that answers "is this THIS SUBJECT'S?" rather than "is this value real?",
    // so it is the one that may exceed a source-class ceiling.
    const adjudicated = artifact({
      metadata: { confidence_cap_applied: 70, linkage_confirmed: true },
    });
    expect(adjustedConfidence(adjudicated, "key")).toBeGreaterThan(70);
  });
});
