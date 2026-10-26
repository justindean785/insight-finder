import { describe, it, expect } from "vitest";
import { explainConfidence, BADGE_TONE_CLASS, type ConfidenceComponent } from "@/lib/confidence";
import { displayConfidence } from "@/lib/display-confidence";
import { authorityFor } from "@/lib/authority";
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

const component = (components: ConfidenceComponent[], label: string) =>
  components.find((c) => c.label === label);

const DAY = 86_400_000;

/**
 * `explainConfidence` DISCLOSES what the row recorded. It never re-derives a
 * score: the pre-repair version rebuilt a total from a hardcoded provider-tier
 * table, +6/-8 corroboration arithmetic, recency deltas and a -50
 * false-positive penalty, none of which the server ever wrote — so the popover
 * could explain a number the row did not carry.
 */
describe("explainConfidence — recorded evidence, not a re-derivation", () => {
  it("reports the stored score as raw and the canonical effective score as final", () => {
    const capped = art({ confidence: 80, metadata: { confidence_cap_applied: 50 } });
    const exp = explainConfidence(capped);
    expect(exp.raw).toBe(80);
    expect(exp.final).toBe(50);
    expect(exp.final).toBe(displayConfidence(capped).effective);

    const uncapped = art({ confidence: 73, metadata: null });
    expect(explainConfidence(uncapped).raw).toBe(73);
    expect(explainConfidence(uncapped).final).toBe(73);
  });

  it("honours a recorded cap of 0 instead of treating it as no cap", () => {
    const exp = explainConfidence(art({ confidence: 60, metadata: { confidence_cap_applied: 0 } }));
    expect(exp.final).toBe(0);
    expect(component(exp.components, "Recorded cap")?.value).toBe("0/100");
  });

  it("reports an unusable stored score as unknown, never a fabricated 0", () => {
    for (const confidence of [null, 150, -4, Number.NaN] as const) {
      const exp = explainConfidence(art({ confidence: confidence as number | null }));
      expect(exp.raw, String(confidence)).toBeNull();
      expect(exp.final, String(confidence)).toBeNull();
      expect(component(exp.components, "Stored machine score")?.value, String(confidence)).toBe("Unknown");
    }
  });

  it("states the stored score and the recorded cap with the server's reason", () => {
    const exp = explainConfidence(
      art({
        confidence: 80,
        metadata: { confidence_cap_applied: 50, reason_for_confidence: "only one independent source class" },
      }),
    );
    expect(component(exp.components, "Stored machine score")?.value).toBe("80/100");
    const cap = component(exp.components, "Recorded cap");
    expect(cap?.value).toBe("50/100");
    expect(cap?.why).toBe("only one independent source class");
  });

  it("says a cap is not recorded rather than implying there is none", () => {
    const cap = component(explainConfidence(art({ metadata: null })).components, "Recorded cap");
    expect(cap?.value).toBe("Not recorded");
    expect(cap?.why).toBe("No usable numeric cap is recorded on this row.");

    const noReason = component(
      explainConfidence(art({ metadata: { confidence_cap_applied: 40 } })).components,
      "Recorded cap",
    );
    expect(noReason?.value).toBe("40/100");
    expect(noReason?.why).toBe("The row records this limit; its reason is not recorded.");
  });

  it("invents no arithmetic: no component carries a delta", () => {
    const exp = explainConfidence(
      art({ metadata: { sources: ["hibp", "whois", "github"], false_positive: true } }),
      "confirmed",
    );
    expect(exp.components.length).toBeGreaterThan(0);
    for (const c of exp.components) expect(c, c.label).not.toHaveProperty("delta");
  });

  it("does not move the score for provider names, age or a false_positive flag", () => {
    const baseline = explainConfidence(art({ source: "hibp", metadata: { confidence_cap_applied: 70 } })).final;
    expect(baseline).toBe(60);

    const otherProvider = explainConfidence(art({ source: "some_random_vendor", metadata: { confidence_cap_applied: 70 } }));
    expect(otherProvider.final).toBe(baseline);
    expect(otherProvider.components.some((c) => /^Source:/.test(c.label))).toBe(false);

    const stale = art({ created_at: new Date(Date.now() - 40 * DAY).toISOString(), metadata: { confidence_cap_applied: 70 } });
    const fresh = art({ created_at: new Date().toISOString(), metadata: { confidence_cap_applied: 70 } });
    expect(explainConfidence(stale).final).toBe(baseline);
    expect(explainConfidence(stale).components).toEqual(explainConfidence(fresh).components);

    const flagged = explainConfidence(art({ metadata: { confidence_cap_applied: 70, false_positive: true } }));
    expect(flagged.final).toBe(baseline);
    expect(flagged.components.some((c) => /false positive/i.test(c.label))).toBe(false);
  });

  describe("independent source classes", () => {
    it("says 'Not recorded' when the row never recorded source classes, even with many provider names", () => {
      const exp = explainConfidence(art({ metadata: { sources: ["hibp", "whois", "github"] } }));
      const classes = component(exp.components, "Independent source classes");
      expect(classes?.value).toBe("Not recorded");
      expect(classes?.why).toBe(
        "Source classes were not recorded. Provider names alone do not establish independence.",
      );
    });

    it("treats an empty or blank source_category as not recorded", () => {
      for (const source_category of [[], [""], ["  "], "   ", ""] as const) {
        const exp = explainConfidence(art({ metadata: { source_category } }));
        expect(component(exp.components, "Independent source classes")?.value, JSON.stringify(source_category)).toBe(
          "Not recorded",
        );
      }
    });

    it("counts the recorded independent classes and lists them", () => {
      const exp = explainConfidence(
        art({ metadata: { sources: ["hunter_verify", "whois_lookup"], source_category: ["official_profile_match", "infra_registry"] } }),
      );
      const classes = component(exp.components, "Independent source classes");
      expect(classes?.value).toBe("2");
      expect(classes?.why).toContain("official_profile_match");
      expect(classes?.why).toContain("infra_registry");
      expect(classes?.why).toContain("This count does not establish identity.");
    });

    it("counts providers repeating one recorded class once", () => {
      const exp = explainConfidence(art({ metadata: { sources: ["hibp", "dehashed"], source_category: ["breach"] } }));
      const classes = component(exp.components, "Independent source classes");
      expect(classes?.value).toBe("1");
      expect(classes?.why).toContain("Providers repeating one class do not add independent support.");
    });

    it("reports a recorded but non-corroborating class as zero qualifying classes, not as unrecorded", () => {
      const exp = explainConfidence(art({ metadata: { source_category: ["ai_summary"] } }));
      const classes = component(exp.components, "Independent source classes");
      expect(classes?.value).toBe("0");
      expect(classes?.why).toBe("No qualifying class was identified by the existing source taxonomy for this row.");
    });
  });

  it("discloses subject authority from authorityFor, naming the quarantine reason", () => {
    const plain = art({ metadata: { confidence_cap_applied: 60, source_category: ["official_profile_match"] } });
    expect(component(explainConfidence(plain).components, "Subject authority")?.value).toBe(authorityFor(plain).label);

    const quarantined = art({
      metadata: {
        confidence_cap_applied: 60,
        subject_unlinked: true,
        subject_unlinked_reason: "harvested from a name-only query — linkage to the subject is unproven",
      },
    });
    const authority = component(explainConfidence(quarantined).components, "Subject authority");
    expect(authority?.value).toBe("Quarantined");
    expect(authority?.why).toContain("linkage to the subject is unproven");
    // Disclosed, never applied: quarantine does not lower the machine score.
    expect(explainConfidence(quarantined).final).toBe(60);
  });

  it("discloses an analyst decision WITHOUT scoring it (a decision is not evidence)", () => {
    const row = art({ metadata: { confidence_cap_applied: 60 } });
    const baseline = explainConfidence(row).final;
    const expected: Record<string, [string, RegExp]> = {
      confirmed: ["Analyst confirmed", /machine score is unchanged/i],
      key: ["Marked key", /machine score is unchanged/i],
      recheck: ["Recheck requested", /machine score is unchanged/i],
      dismissed: ["Rejected by analyst", /original score is preserved/i],
      wrong: ["Rejected by analyst", /original score is preserved/i],
    };
    for (const [review, [label, why]] of Object.entries(expected)) {
      const exp = explainConfidence(row, review as Parameters<typeof explainConfidence>[1]);
      expect(exp.final, review).toBe(baseline);
      const disclosed = component(exp.components, label);
      expect(disclosed, review).toBeDefined();
      expect(disclosed!.value, review).toBe("");
      expect(disclosed!.why, review).toMatch(why);
    }
  });

  it("surfaces a recorded contradiction with the server's note", () => {
    const withNote = explainConfidence(art({ metadata: { conflict: true, conflict_note: "profile location contradicts the seed" } }));
    expect(component(withNote.components, "Recorded contradiction")?.why).toBe("profile location contradicts the seed");

    const bare = explainConfidence(art({ metadata: { conflict: true } }));
    expect(component(bare.components, "Recorded contradiction")?.why).toBe(
      "This row is marked as conflicting; details were not recorded.",
    );

    expect(component(explainConfidence(art({ metadata: null })).components, "Recorded contradiction")).toBeUndefined();
  });

  it("shows the recorded rationale only when no cap already carries it", () => {
    const noCap = explainConfidence(art({ metadata: { reason_for_confidence: "single profile page, no corroboration" } }));
    expect(component(noCap.components, "Recorded rationale")?.why).toBe("single profile page, no corroboration");

    const capped = explainConfidence(
      art({ metadata: { confidence_cap_applied: 50, reason_for_confidence: "single profile page, no corroboration" } }),
    );
    expect(component(capped.components, "Recorded rationale")).toBeUndefined();
    expect(component(capped.components, "Recorded cap")?.why).toBe("single profile page, no corroboration");
  });
});

describe("explainConfidence — trust badges", () => {
  it("emits a multi-source badge when corroborated, single-source otherwise", () => {
    const multi = explainConfidence(art({ metadata: { sources: ["a", "b"] } }));
    expect(multi.badges.some((b) => b.key === "multi-source")).toBe(true);

    const single = explainConfidence(art({ metadata: null }));
    expect(single.badges.some((b) => b.key === "single-source")).toBe(true);
  });

  it("emits a stale-breach badge for breach artifacts older than a year", () => {
    const old = new Date(Date.now() - 400 * DAY).toISOString();
    const { badges } = explainConfidence(art({ kind: "breach", created_at: old, metadata: null }));
    expect(badges.some((b) => b.key === "stale-breach")).toBe(true);
  });

  it("emits a fresh badge inside 24h and the analyst badges for review verdicts", () => {
    expect(explainConfidence(art()).badges.some((b) => b.key === "fresh")).toBe(true);
    expect(explainConfidence(art(), "confirmed").badges.some((b) => b.key === "analyst-confirmed")).toBe(true);
    expect(explainConfidence(art(), "wrong").badges.some((b) => b.key === "analyst-dismissed")).toBe(true);
  });
});

describe("BADGE_TONE_CLASS", () => {
  it("covers every tone", () => {
    for (const tone of ["high", "mid", "low", "neutral"] as const) {
      expect(BADGE_TONE_CLASS[tone]).toBeTruthy();
    }
  });
});
