// Verifies the record-time output-integrity gates (WP2) against the exact
// artifact metadata from the live @pjsmakka run. The module (and its one
// dependency, classifySource/source-classification.ts + catalog.ts) is pure TS
// (no Deno deps) so it runs under vitest here and under `deno test` in CI.
import { describe, it, expect } from "vitest";
import {
  isDisprovenReason,
  isZeroBreachExposure,
  isCrossSubjectContactLaundering,
  isHumanInputProvenance,
  humanInputCorroborated,
  countIndependentObservations,
  sourceProfileHandle,
} from "../../supabase/functions/osint-agent/output-integrity";

describe("WP2-#4 disproven-lead suppression", () => {
  it("catches the underscore-joined reason tokens the word-bounded regex missed", () => {
    // From the live run: pjmak.com and Aleksandra Pajmakoska.
    expect(isDisprovenReason({ reason: "domain_similar_letters_not_same_entity" })).toBe(true);
    expect(isDisprovenReason({ reason: "single_source_collision_not_correlated" })).toBe(true);
  });
  it("catches spaced phrasing and structured dispositions", () => {
    expect(isDisprovenReason({ note: "not the same entity as the seed" })).toBe(true);
    expect(isDisprovenReason({ disposition: "namesake" })).toBe(true);
    expect(isDisprovenReason({ not_correlated: true })).toBe(true);
    expect(isDisprovenReason({ reason: "same-name collision" })).toBe(true);
  });
  it("does NOT fire on a bare or benign 'collision' (review finding — was overbroad)", () => {
    expect(isDisprovenReason({ reason: "no collision detected" })).toBe(false);
    expect(isDisprovenReason({ note: "collision cleared" })).toBe(false);
    expect(isDisprovenReason({ note: "collision review passed" })).toBe(false);
    expect(isDisprovenReason({ reason: "possible collision requires review" })).toBe(false);
    expect(isDisprovenReason({ disposition: "collision" })).toBe(false); // bare, ambiguous
  });
  it("does not fire on a benign reason", () => {
    expect(isDisprovenReason({ reason: "single source class: breach" })).toBe(false);
    expect(isDisprovenReason(null)).toBe(false);
    expect(isDisprovenReason({ relationship_to_subject: "co_appears_in_serp_with_seed" })).toBe(false);
  });
});

describe("WP2-#5 zero-breach relabel", () => {
  it("flags a breach_exposure whose scan found nothing (the live pjsmakka case)", () => {
    expect(isZeroBreachExposure("breach_exposure", {
      isBreached: false, totalBreaches: 0, totalPastes: 0,
    })).toBe(true);
  });
  it("accepts string-typed zero counts and the `breach` alias kind", () => {
    expect(isZeroBreachExposure("breach", { isBreached: false, totalBreaches: "0", totalPastes: "0" })).toBe(true);
  });
  it("does NOT relabel a real exposure", () => {
    expect(isZeroBreachExposure("breach_exposure", { isBreached: true, totalBreaches: 3, totalPastes: 0 })).toBe(false);
    expect(isZeroBreachExposure("breach_exposure", { totalBreaches: 2, totalPastes: 1 })).toBe(false);
  });
  it("does not touch non-breach kinds, or breach rows with no count metadata", () => {
    expect(isZeroBreachExposure("email", { totalBreaches: 0, totalPastes: 0 })).toBe(false);
    expect(isZeroBreachExposure("breach_exposure", {})).toBe(false);
  });
});

describe("WP2-#6 cross-subject contact laundering", () => {
  const seed = "pjsmakka";
  it("suppresses a geo lead about the seed sourced from a different account (the 530 case)", () => {
    // From the live run: value "530 area code Sacramento/Yuba City",
    // source "barlozblendz Instagram bio", note ties it to pjsmakka.
    const meta = {
      source: "barlozblendz Instagram bio",
      note: "pjsmakka appeared in search results near this geographic area",
    };
    expect(sourceProfileHandle(meta)).toBe("barlozblendz");
    expect(isCrossSubjectContactLaundering("weak_lead", "530 area code Sacramento/Yuba City", meta, seed)).toBe(true);
  });
  it("leaves a contact scoped to its OWN account alone (barlozblendz's phone)", () => {
    const meta = { handle: "barlozblendz", source_profile: "barlozblendz", location: "Sacramento / Yuba City CA" };
    expect(isCrossSubjectContactLaundering("phone", "(530) 981-7453", meta, seed)).toBe(false);
  });
  it("allows a cross-account contact when an EXPLICIT link connects them", () => {
    const meta = { source_profile: "barlozblendz", note: "pjsmakka tagged barlozblendz in a shared post" };
    expect(isCrossSubjectContactLaundering("phone", "(530) 981-7453", meta, seed)).toBe(false);
  });
  it("does not touch non-contact kinds", () => {
    const meta = { source_profile: "barlozblendz", note: "pjsmakka" };
    expect(isCrossSubjectContactLaundering("username", "barlozblendz", meta, seed)).toBe(false);
  });
});

describe("WP2-#8 human-input provenance", () => {
  it("flags a fact derived from a user-typed correction (the Prestan Jackson case)", () => {
    expect(isHumanInputProvenance({ handles_derived: "prestan jackson full name derived from user correction" })).toBe(true);
    expect(isHumanInputProvenance({ provenance: "human_input" })).toBe(true);
    expect(isHumanInputProvenance({ human_input: true })).toBe(true);
  });
  it("does not fire on an agent-found artifact", () => {
    expect(isHumanInputProvenance({ provenance: "read_from_profile", source: "socialfetch_lookup" })).toBe(false);
    expect(isHumanInputProvenance(null)).toBe(false);
  });
  it("corroboration lifts the cap only on INDEPENDENT evidence, not distinct source strings", () => {
    // Uncorroborated human input stays capped.
    expect(humanInputCorroborated({ provenance: "human_input" })).toBe(false);
    // An explicit verified flag releases it.
    expect(humanInputCorroborated({ provenance: "human_input", independently_verified: true })).toBe(true);
    // Distinct source STRINGS alone no longer release it (the review finding).
    expect(humanInputCorroborated({ sources: ["user_correction", "socialfetch_lookup"] })).toBe(false);
    // A qualifying independent observation releases it.
    expect(humanInputCorroborated({ provenance: "human_input", corroborating_observations: [{ sourceClass: "official_profile_match", url: "https://instagram.com/x" }] })).toBe(true);
    // A contradiction blocks promotion regardless.
    expect(humanInputCorroborated({ independently_verified: true, contradictions: [{ note: "conflicts" }] })).toBe(false);
  });
});

describe("WP2-#5 independence model (review finding — not just distinct source names)", () => {
  it("two tools reading the SAME page are one observation, not two", () => {
    expect(countIndependentObservations([
      { sourceClass: "official_profile_match", url: "https://x.com/a" },
      { sourceClass: "independent_public", url: "https://www.x.com/a/" }, // same record
    ])).toBe(1);
  });
  it("a SERP summary plus its cited page is not two independent observations", () => {
    expect(countIndependentObservations([
      { sourceClass: "ai_summary", url: "https://serp/answer" }, // excluded class
      { sourceClass: "independent_public", url: "https://news.example.com/story" },
    ])).toBe(1);
  });
  it("a live page and its archive copy collapse to one", () => {
    expect(countIndependentObservations([
      { sourceClass: "independent_public", url: "https://ex.com/p" },
      { sourceClass: "independent_public", url: "https://web.archive.org/web/2020/https://ex.com/p" },
    ])).toBe(1);
  });
  it("repeated calls to the same profile are one", () => {
    expect(countIndependentObservations([
      { sourceClass: "social_profile_active", url: "https://ig.com/u" },
      { sourceClass: "social_profile_active", url: "https://ig.com/u" },
    ])).toBe(1);
  });
  it("two independent first-party profiles / a profile + public record count as two", () => {
    expect(countIndependentObservations([
      { sourceClass: "official_profile_match", url: "https://ig.com/u" },
      { sourceClass: "court_record", url: "https://courts.gov/case/1" },
    ])).toBe(2);
  });
  it("purely non-corroborating classes count as zero", () => {
    expect(countIndependentObservations([
      { sourceClass: "ai_summary", url: "https://a" },
      { sourceClass: "username_sweep", url: "https://b" },
      { sourceClass: "human_input" },
    ])).toBe(0);
  });
});

// ── Finding #6: countIndependentObservations must fail closed on raw source ──
describe("finding #6: countIndependentObservations fails closed / uses the canonical classifier", () => {
  it("missing class entirely (no sourceClass, no source) is excluded", () => {
    expect(countIndependentObservations([{ url: "https://a" }])).toBe(0);
  });
  it("a genuinely unrecognized raw source string is excluded (fails closed, does NOT count merely because it's a distinct string)", () => {
    expect(countIndependentObservations([
      { source: "totally_made_up_tool_xyz_not_a_real_provider", url: "https://a" },
    ])).toBe(0);
  });
  it("an unrecognized explicit sourceClass string is excluded (not blindly trusted)", () => {
    expect(countIndependentObservations([
      { sourceClass: "not_a_real_class_at_all", url: "https://a" },
    ])).toBe(0);
  });
  it('the exact audit example — source:"gemini_deep_dork" with no sourceClass — no longer slips through as independent', () => {
    // Before the fix: `sourceClass ?? source ?? "unknown"` used the raw string
    // "gemini_deep_dork" directly, which isn't literally "unknown"/"ai_summary"/
    // etc., so NON_CORROBORATING_CLASSES.has("gemini_deep_dork") was false and it
    // incorrectly counted. classifySource("gemini_deep_dork") correctly resolves
    // it to "ai_summary" (source-classification.ts's TOOL_CLASS), which IS
    // non-corroborating — now correctly excluded.
    expect(countIndependentObservations([
      { source: "gemini_deep_dork", url: "https://a" },
    ])).toBe(0);
  });
  it("a raw source name the classifier DOES recognize as a real corroborating class still counts", () => {
    // oathnet_lookup classifies to "breach" — a real, corroborating class — so a
    // raw provider name that IS genuinely classifiable must still count. Fail
    // CLOSED means "reject the unrecognized", not "reject everything raw".
    expect(countIndependentObservations([
      { source: "oathnet_lookup", url: "https://oathnet.example/hit/1" },
    ])).toBe(1);
  });
  it("two tools backed by the SAME upstream provider/class collapse to one, even with different raw tool names and no explicit sourceClass", () => {
    // rapidapi_breach_search and breach_check both classify to "breach" — the
    // exact "shared upstream source, different tool names" case the audit
    // required: they must NOT each count as independent merely because their
    // raw tool-name strings differ.
    expect(countIndependentObservations([
      { source: "rapidapi_breach_search", domain: "breach-corpus-A" },
      { source: "breach_check", domain: "breach-corpus-A" },
    ])).toBe(1);
  });
  it("mixed valid explicit classes and invalid/unrecognized entries: only the valid ones count", () => {
    expect(countIndependentObservations([
      { sourceClass: "court_record", url: "https://courts.gov/case/9" },
      { source: "made_up_nonsense_provider" },
      { sourceClass: "" }, // empty string class
      { sourceClass: "official_profile_match", url: "https://ig.com/real" },
    ])).toBe(2);
  });
  it("duplicate explicit class, same underlying record, still collapses to one", () => {
    expect(countIndependentObservations([
      { sourceClass: "news", url: "https://news.example.com/a" },
      { sourceClass: "news", url: "https://news.example.com/a" },
    ])).toBe(1);
  });
});
