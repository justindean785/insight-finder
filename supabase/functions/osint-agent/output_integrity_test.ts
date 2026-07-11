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

Deno.test("WP2-#8 corroboration lifts the human-input cap (review finding)", () => {
  assert(!humanInputCorroborated({ provenance: "human_input" }));
  assert(humanInputCorroborated({ provenance: "human_input", independently_verified: true }));
  assert(humanInputCorroborated({ sources: ["user_correction", "socialfetch_lookup"] }));
  assert(!humanInputCorroborated({ sources: ["user_correction"] }));
});
