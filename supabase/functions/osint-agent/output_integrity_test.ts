// output_integrity_test.ts — WP2 record-time integrity gates, tested against the
// exact artifact metadata from the live @pjsmakka run.
// Run: deno test --no-check output_integrity_test.ts
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  isDisprovenReason,
  isZeroBreachExposure,
  isCrossSubjectContactLaundering,
  isHumanInputProvenance,
  humanInputCorroborated,
  countIndependentObservations,
  sourceProfileHandle,
} from "./output-integrity.ts";

Deno.test("WP2-#4 disproven reason catches underscore-joined tokens the word regex missed", () => {
  assert(isDisprovenReason({ reason: "domain_similar_letters_not_same_entity" }));
  assert(isDisprovenReason({ reason: "single_source_collision_not_correlated" }));
  assert(isDisprovenReason({ note: "not the same entity" }));
  assert(isDisprovenReason({ disposition: "namesake" }));
  assert(!isDisprovenReason({ reason: "single source class: breach" }));
  assert(!isDisprovenReason({ relationship_to_subject: "co_appears_in_serp_with_seed" }));
});

Deno.test("WP2-#4 disproven reason does NOT fire on benign/negated 'collision' (review finding)", () => {
  assert(!isDisprovenReason({ reason: "no collision detected" }));
  assert(!isDisprovenReason({ note: "collision cleared" }));
  assert(!isDisprovenReason({ note: "collision review passed" }));
  assert(!isDisprovenReason({ reason: "possible collision requires review" }));
  assert(!isDisprovenReason({ disposition: "collision" }));
});

Deno.test("WP2-#5 zero-breach relabel flags empty scans, keeps real exposures", () => {
  assert(isZeroBreachExposure("breach_exposure", { isBreached: false, totalBreaches: 0, totalPastes: 0 }));
  assert(isZeroBreachExposure("breach", { isBreached: false, totalBreaches: "0", totalPastes: "0" }));
  assert(!isZeroBreachExposure("breach_exposure", { isBreached: true, totalBreaches: 3, totalPastes: 0 }));
  assert(!isZeroBreachExposure("breach_exposure", { totalBreaches: 2, totalPastes: 1 }));
  assert(!isZeroBreachExposure("email", { totalBreaches: 0, totalPastes: 0 }));
  assert(!isZeroBreachExposure("breach_exposure", {}));
});

Deno.test("WP2-#6 cross-subject contact laundering (the 530/barlozblendz case)", () => {
  const seed = "pjsmakka";
  const laundered = { source: "barlozblendz Instagram bio", note: "pjsmakka appeared in search results near this geographic area" };
  assertEquals(sourceProfileHandle(laundered), "barlozblendz");
  assert(isCrossSubjectContactLaundering("weak_lead", "530 area code Sacramento/Yuba City", laundered, seed));
  // barlozblendz's own phone, scoped to its own account → NOT laundering
  assert(!isCrossSubjectContactLaundering("phone", "(530) 981-7453", { handle: "barlozblendz", source_profile: "barlozblendz" }, seed));
  // an explicit link justifies the connection
  assert(!isCrossSubjectContactLaundering("phone", "(530) 981-7453", { source_profile: "barlozblendz", note: "pjsmakka tagged barlozblendz" }, seed));
  // non-contact kinds are untouched
  assert(!isCrossSubjectContactLaundering("username", "barlozblendz", { source_profile: "barlozblendz", note: "pjsmakka" }, seed));
});

Deno.test("WP2-#8 human-input provenance (the Prestan Jackson correction)", () => {
  assert(isHumanInputProvenance({ handles_derived: "prestan jackson full name derived from user correction" }));
  assert(isHumanInputProvenance({ provenance: "human_input" }));
  assert(isHumanInputProvenance({ human_input: true }));
  assert(!isHumanInputProvenance({ provenance: "read_from_profile", source: "socialfetch_lookup" }));
});

Deno.test("WP2-#8 corroboration lifts the human-input cap ONLY on independent evidence", () => {
  assert(!humanInputCorroborated({ provenance: "human_input" }));
  assert(humanInputCorroborated({ provenance: "human_input", independently_verified: true }));
  // distinct source STRINGS alone no longer release it (review finding #5)
  assert(!humanInputCorroborated({ sources: ["user_correction", "socialfetch_lookup"] }));
  assert(humanInputCorroborated({ corroborating_observations: [{ sourceClass: "court_record", url: "https://courts.gov/c/1" }] }));
  // a contradiction blocks promotion
  assert(!humanInputCorroborated({ independently_verified: true, contradictions: [{ note: "conflict" }] }));
});

Deno.test("independence model — same record collapses; distinct records count (review finding #5)", () => {
  assertEquals(countIndependentObservations([
    { sourceClass: "official_profile_match", url: "https://x.com/a" },
    { sourceClass: "independent_public", url: "https://www.x.com/a/" },
  ]), 1); // two tools, same page
  assertEquals(countIndependentObservations([
    { sourceClass: "independent_public", url: "https://ex.com/p" },
    { sourceClass: "independent_public", url: "https://web.archive.org/web/2020/https://ex.com/p" },
  ]), 1); // live + archive
  assertEquals(countIndependentObservations([
    { sourceClass: "ai_summary", url: "https://serp" },
    { sourceClass: "independent_public", url: "https://news.example.com/s" },
  ]), 1); // SERP summary excluded; only the cited page counts
  assertEquals(countIndependentObservations([
    { sourceClass: "official_profile_match", url: "https://ig.com/u" },
    { sourceClass: "court_record", url: "https://courts.gov/case/1" },
  ]), 2); // two genuinely independent records
  assertEquals(countIndependentObservations([{ sourceClass: "username_sweep", url: "https://a" }, { sourceClass: "human_input" }]), 0);
});
