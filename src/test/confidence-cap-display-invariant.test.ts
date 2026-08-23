import { describe, it, expect } from "vitest";
import { adjustedConfidence, POSSIBLE_MINOR_CEILING, QUARANTINE_CEILING } from "@/lib/intel";
import type { Artifact } from "@/hooks/useThreadArtifacts";

/**
 * The display may never publish a number the server refused to persist.
 *
 * `metadata.confidence_cap_applied` is written server-side by
 * auto-record-integrity.ts (`confidence_cap_applied: cap.cap`) and encodes a
 * specific claim: *this row's source classes cannot support more than N*
 * (breach-only <=60, username_sweep-only <=45, social_profile_passive <=40,
 * ai_summary <=55). `adjustedConfidence` was adding REVIEW_DELTA and its own
 * corroboration bonus on top of that already-capped number.
 *
 * Measured on thread 2d0dcd03, live build 8c6184b: Key Findings published 95
 * for rows stored at 70 — and 95 clears the CONFIRMED threshold (>=80), so
 * unadjudicated community posts about a named private individual were shown as
 * confirmed-grade findings.
 *
 * The corroboration bonus is also a DOUBLE COUNT: the server already measured
 * independence via countIndependentClasses, using the authoritative taxonomy,
 * before setting the cap.
 *
 * These tests drive the real exported `adjustedConfidence`. They must never be
 * rewritten to re-describe the arithmetic inline — an earlier version of
 * intel-logic.test.ts did exactly that and silently diverged from production.
 */

const art = (over: Partial<Artifact> = {}): Artifact => ({
  id: "1",
  kind: "email",
  value: "a@b.com",
  confidence: 60,
  source: "whois",
  created_at: new Date().toISOString(),
  metadata: null,
  ...over,
});

describe("confidence_cap_applied is a display ceiling", () => {
  it("an analyst 'confirmed' verdict cannot lift a row above its recorded cap", () => {
    // base 45 + REVIEW_DELTA.confirmed (+20) = 65 without the clamp.
    const a = art({ source: "username_sweep", confidence: 45, metadata: { confidence_cap_applied: 45 } });
    expect(adjustedConfidence(a, "confirmed")).toBe(45);
  });

  it("the corroboration bonus cannot lift a row above its recorded cap", () => {
    // Three distinct classes would add +10; the server already counted them.
    const a = art({
      source: "whois",
      confidence: 40,
      metadata: { confidence_cap_applied: 40, sources: ["whois", "virustotal", "github_user"] },
    });
    expect(adjustedConfidence(a)).toBe(40);
  });

  it("never CLEARS the CONFIRMED threshold on a capped row", () => {
    // The measured defect: stored 70, published 95, which reads as CONFIRMED.
    const a = art({ source: "socialfetch_web_read", confidence: 70, metadata: { confidence_cap_applied: 70 } });
    expect(adjustedConfidence(a, "key")).toBeLessThan(80);
  });

  it("is a ceiling, never a floor — it cannot RAISE a low row", () => {
    const a = art({ source: "whois", confidence: 30, metadata: { confidence_cap_applied: 90 } });
    expect(adjustedConfidence(a)).toBe(30);
  });

  it("keeps negative signals working underneath the cap", () => {
    // 'wrong' is -40. The clamp is an upper bound only; downgrades must survive.
    const a = art({ source: "whois", confidence: 45, metadata: { confidence_cap_applied: 45 } });
    expect(adjustedConfidence(a, "wrong")).toBe(5);
  });

  it("floors at zero rather than going negative", () => {
    const a = art({ source: "whois", confidence: 10, metadata: { confidence_cap_applied: 50 } });
    expect(adjustedConfidence(a, "wrong")).toBe(0);
  });
});

describe("confidence_cap_applied composes with the existing ceilings", () => {
  it("the STRICTER of cap and the possible-minor ceiling wins", () => {
    const a = art({
      source: "whois",
      confidence: 90,
      metadata: { possible_minor: true, confidence_cap_applied: 40 },
    });
    expect(adjustedConfidence(a)).toBe(40);
    expect(adjustedConfidence(a)).toBeLessThan(POSSIBLE_MINOR_CEILING);
  });

  it("the possible-minor ceiling still wins when it is the stricter one", () => {
    const a = art({
      source: "whois",
      confidence: 90,
      metadata: { possible_minor: true, confidence_cap_applied: 80 },
    });
    expect(adjustedConfidence(a)).toBe(POSSIBLE_MINOR_CEILING);
  });

  it("the STRICTER of cap and the quarantine ceiling wins", () => {
    const a = art({
      source: "whois",
      confidence: 90,
      metadata: { subject_unlinked: true, confidence_cap_applied: 40 },
    });
    expect(adjustedConfidence(a)).toBe(40);
    expect(adjustedConfidence(a)).toBeLessThan(QUARANTINE_CEILING);
  });

  it("quarantine's asymmetry is preserved — negatives still bite under a cap", () => {
    const a = art({
      source: "whois",
      confidence: 50,
      metadata: { subject_unlinked: true, confidence_cap_applied: 50 },
    });
    expect(adjustedConfidence(a, "recheck")).toBe(30);
  });
});

describe("a malformed cap is ignored rather than trusted", () => {
  // metadata is untyped JSON off the wire and is partly model-authored, so the
  // reader must be total. Note the cap can only ever LOWER a number, so even a
  // hostile value cannot inflate a row — the failure mode is fail-safe.
  const cases: Array<[string, unknown]> = [
    ["a string", "45"],
    ["null", null],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative", -10],
    ["above 100", 140],
    ["an object", { cap: 45 }],
  ];

  for (const [name, value] of cases) {
    it(`ignores ${name} and falls back to normal scoring`, () => {
      const a = art({ source: "whois", confidence: 50, metadata: { confidence_cap_applied: value } });
      expect(adjustedConfidence(a, "confirmed")).toBe(70);
    });
  }

  it("honours a legitimate cap of 0", () => {
    const a = art({ source: "whois", confidence: 50, metadata: { confidence_cap_applied: 0 } });
    expect(adjustedConfidence(a, "confirmed")).toBe(0);
  });

  it("leaves rows with no cap completely unchanged", () => {
    const a = art({ source: "whois", confidence: 50 });
    expect(adjustedConfidence(a, "confirmed")).toBe(70);
  });
});

describe("linkage_confirmed releases the quarantine ceiling but NOT the recorded cap", () => {
  /**
   * Operator decision, 2026-08-23, settling the Graphify advisory on this PR
   * ("linkage_confirmed no longer bypasses recorded confidence cap").
   *
   * The two flags answer different questions and are not interchangeable:
   *
   *   linkage_confirmed        WHOSE this row is    — provenance, adjudicated by a human
   *   confidence_cap_applied   HOW STRONG it is     — source classes, measured by the server
   *
   * Adjudicating that a breach record belongs to the subject does not turn one
   * breach corpus into two independent source classes, so the evidence ceiling
   * keeps binding after release. Note there was never a bypass to lose: before
   * this change nothing in the scoring path read `confidence_cap_applied` at all.
   *
   * `source: "whois"` with no `sources` array is a deterministic zero bonus —
   * pinned by "leaves rows with no cap completely unchanged" above (50 + 20 = 70).
   */
  const released = (over: Record<string, unknown> = {}): Artifact =>
    art({
      source: "whois",
      confidence: 60,
      metadata: {
        subject_unlinked: true,
        subject_unlinked_reason: "harvested from a name-only query",
        linkage_confirmed: true,
        ...over,
      },
    });

  it("release still restores the number above the quarantine ceiling when no cap is recorded", () => {
    // #448's escape hatch has to survive this change: an adjudicated row is not
    // quarantined, so 60 + 25 lands at 85 rather than being pinned to 55.
    expect(adjustedConfidence(released(), "key")).toBe(85);
    expect(adjustedConfidence(released(), "key")).toBeGreaterThan(QUARANTINE_CEILING);
  });

  it("the recorded cap still binds on a released row", () => {
    // The discriminating case, and the one the advisory asked about. 60 + 25 = 85
    // uncapped. Landing on exactly 65 proves BOTH halves at once: above
    // QUARANTINE_CEILING, so the release happened; at the cap, so the evidence
    // ceiling still bound. Neither a re-quarantine nor a cap bypass can produce 65.
    const a = released({ confidence_cap_applied: 65 });
    expect(adjustedConfidence(a, "key")).toBe(65);
    expect(adjustedConfidence(a, "key")).toBeGreaterThan(QUARANTINE_CEILING);
  });

  it("a low cap still holds a released row below CONFIRMED", () => {
    const a = released({ confidence_cap_applied: 45 });
    expect(adjustedConfidence(a, "key")).toBe(45);
    expect(adjustedConfidence(a, "key")).toBeLessThan(80);
  });

  it("without release the quarantine ceiling is the stricter limit on the same row", () => {
    // Same row, release withdrawn. 55 (quarantine) beats the 65 cap, and the
    // positive review delta is DROPPED rather than clamped — quarantine's
    // asymmetry, not the cap, is what does that.
    const a = released({ confidence_cap_applied: 65, linkage_confirmed: false });
    expect(adjustedConfidence(a, "key")).toBe(QUARANTINE_CEILING);
  });
});
