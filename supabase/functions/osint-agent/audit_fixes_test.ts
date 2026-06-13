// Regression tests for the cross-seed-type audit fixes (2026-06-13):
//  1. source-class normalization (parenthetical suffix no longer defeats caps)
//  2. different-person / unrelated-entity gate
//  3. reserved / fiction / invalid phone detection
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifySource } from "./artifact_types.ts";
import { applyEvidenceCaps, isUnrelatedEntity, isBioCrossLinkName, BIO_CROSS_LINK_NAME_CAP } from "./confidence.ts";
import { isReservedOrInvalidPhone, validateArtifact } from "./validation.ts";

Deno.test("classifySource strips parenthetical qualifier before lookup", () => {
  assertEquals(classifySource("socialfetch_lookup (instagram)"), "social_profile_passive");
  assertEquals(classifySource("bosint_email_lookup (drizly.com breach)"), "breach");
  assertEquals(classifySource("bosint_phone_lookup"), "social_profile_passive");
});

Deno.test("passive-social hit no longer leaks to unknown cap (40 not 50)", () => {
  // keita.iq from the phone trace: source was 'socialfetch_lookup (instagram)'
  // which used to classify as unknown (cap 50). Must now cap at 40.
  const cap = applyEvidenceCaps({ rawConfidence: 50, sources: ["socialfetch_lookup (instagram)"] });
  assertEquals(cap.confidence, 40);
});

Deno.test("isUnrelatedEntity detects note-based and explicit flags", () => {
  assertEquals(isUnrelatedEntity({ note: "CONFIRMED DIFFERENT COMPANY - GEO platform" }), true);
  assertEquals(isUnrelatedEntity({ note: "UNRELATED individual collision" }), true);
  assertEquals(isUnrelatedEntity({ note: "DIFFERENT company Anon.com" }), true);
  assertEquals(isUnrelatedEntity({ different_person: true }), true);
  assertEquals(isUnrelatedEntity({ unrelated: true }), true);
  // Negatives — normal artifacts must not be flagged.
  assertEquals(isUnrelatedEntity({ note: "CEO and founder" }), false);
  assertEquals(isUnrelatedEntity({}), false);
  assertEquals(isUnrelatedEntity(null), false);
});

Deno.test("isReservedOrInvalidPhone flags fiction/invalid ranges", () => {
  // 555-01xx fiction range.
  assertEquals(isReservedOrInvalidPhone("+14155550171").reserved, true);
  assertEquals(isReservedOrInvalidPhone("+12025550123").reserved, true);
  // 555 with a line number outside 0100-0199 is a real assignable line.
  assertEquals(isReservedOrInvalidPhone("+14155552671").reserved, false);
  assertEquals(isReservedOrInvalidPhone("+14155558888").reserved, false);
  // Invalid NANP: area/exchange cannot start with 0 or 1.
  assertEquals(isReservedOrInvalidPhone("+10155551234").reserved, true);
  // Degenerate numbers.
  assertEquals(isReservedOrInvalidPhone("1111111").reserved, true);
});

Deno.test("phone validation attaches reserved_number metaPatch", () => {
  const v = validateArtifact("phone", "+14155550171");
  assertEquals(v.ok, true);
  assertEquals((v as { metaPatch?: Record<string, unknown> }).metaPatch?.reserved_number, true);
});

Deno.test("isBioCrossLinkName flags bio-linked names only", () => {
  // The real misidentification: a Facebook name pulled from a SoundCloud bio.
  assertEquals(isBioCrossLinkName("name", { from_bio: true, platform: "facebook" }), true);
  assertEquals(isBioCrossLinkName("name", { bio_link: "true" }), true);
  assertEquals(isBioCrossLinkName("name", { linked_from_bio: true }), true);
  // A bio-linked username/handle is plausibly the subject's own alt — not gated here.
  assertEquals(isBioCrossLinkName("username", { from_bio: true }), false);
  // The subject's OWN display name (no bio flag) must NOT be gated.
  assertEquals(isBioCrossLinkName("name", { from_bio: false }), false);
  assertEquals(isBioCrossLinkName("name", {}), false);
  assertEquals(isBioCrossLinkName("name", null), false);
});

Deno.test("bio-linked name cap keeps it below corroborated signals", () => {
  // A bio name reaching for confidence 50 must be held under the cap so it can
  // never sit co-equal with the subject's display name / corroborated identity.
  const cap = Math.min(applyEvidenceCaps({ rawConfidence: 50, sources: ["jina_reader_scrape"] }).confidence, BIO_CROSS_LINK_NAME_CAP);
  assertEquals(cap, BIO_CROSS_LINK_NAME_CAP);
  assertEquals(BIO_CROSS_LINK_NAME_CAP < 50, true);
});
