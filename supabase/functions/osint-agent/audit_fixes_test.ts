// Regression tests for the cross-seed-type audit fixes (2026-06-13):
//  1. source-class normalization (parenthetical suffix no longer defeats caps)
//  2. different-person / unrelated-entity gate
//  3. reserved / fiction / invalid phone detection
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { classifySource, inferKind } from "./artifact_types.ts";
import { applyEvidenceCaps, isUnrelatedEntity, isBioCrossLinkName, BIO_CROSS_LINK_NAME_CAP } from "./confidence.ts";
import { isReservedOrInvalidPhone, validateArtifact } from "./validation.ts";

Deno.test("classifySource strips parenthetical qualifier before lookup", () => {
  assertEquals(classifySource("socialfetch_lookup (instagram)"), "social_profile_passive");
  assertEquals(classifySource("bosint_email_lookup (drizly.com breach)"), "breach");
  assertEquals(classifySource("bosint_phone_lookup"), "social_profile_passive");
});

Deno.test("classifySource maps infra tools to sub-classes", () => {
  assertEquals(classifySource("whois_lookup"), "infra_registry");
  assertEquals(classifySource("dns_records"), "infra_dns");
  assertEquals(classifySource("crtsh_subdomains"), "infra_dns");
  assertEquals(classifySource("shodan_internetdb"), "infra_scan");
  assertEquals(classifySource("hackertarget"), "infra_scan");
  assertEquals(classifySource("http_fingerprint"), "infra_scan");
  assertEquals(classifySource("virustotal_lookup"), "infra_reputation");
  assertEquals(classifySource("ipqualityscore_lookup"), "infra_reputation");
  assertEquals(classifySource("urlscanner_scan"), "infra_reputation");
  assertEquals(classifySource("hunter_domain_search"), "infra_registry");
});

Deno.test("classifySource maps passive + shared-host sources", () => {
  assertEquals(classifySource("urlscan_search"), "infra_passive");
  assertEquals(classifySource("wayback_snapshots"), "infra_passive");
  assertEquals(classifySource("archive_url"), "infra_passive");
  // Reverse-IP / shared-host lookups never prove ownership.
  assertEquals(classifySource("hackertarget/reverseiplookup"), "infra_shared_host");
  assertEquals(classifySource("reverse_ip_lookup"), "infra_shared_host");
  assertEquals(classifySource("shared-host scan"), "infra_shared_host");
});

Deno.test("shared-host source is capped at 35 and never corroborates", () => {
  const r = applyEvidenceCaps({ rawConfidence: 90, sources: ["hackertarget/reverseiplookup"] });
  assertEquals(r.confidence, 35);
  // Adding a shared-host class does NOT lift a WHOIS finding.
  const combo = applyEvidenceCaps({ rawConfidence: 90, sources: ["whois_lookup", "hackertarget/reverseiplookup"] });
  assertEquals(combo.confidence, 75); // whois cap only; shared-host adds nothing
});

Deno.test("infra + weak ai_summary cannot exceed infra-safe 85", () => {
  const r = applyEvidenceCaps({
    rawConfidence: 100,
    sources: ["whois_lookup", "dns_records", "shodan_internetdb", "gemini_deep_dork"],
  });
  assertEquals(r.confidence <= 85, true);
});

Deno.test("infra + trusted class CAN lift past 85", () => {
  // whois (infra) + a court record (trusted non-infra) → cross-class unlock.
  const r = applyEvidenceCaps({ rawConfidence: 100, sources: ["whois_lookup", "pacer_docket"] });
  assertEquals(r.confidence > 85, true);
  // whois + independent_public alone tops out at its own caps (infra-safe-ish).
  const r2 = applyEvidenceCaps({ rawConfidence: 100, sources: ["whois_lookup", "jina_reader_scrape"] });
  assertEquals(r2.confidence <= 85, true);
});

Deno.test("court_record + news still reaches 95 (unchanged)", () => {
  // Input must genuinely classify as `news` — "nytimes_article" is actually
  // `unknown` (the underscore blocks the \b boundary) and only hit 95 via the
  // now-removed unknown-corroboration +10 boost. court_record + real news → 95
  // via the dedicated court_record+news rule, unaffected by the unknown change.
  const r = applyEvidenceCaps({ rawConfidence: 100, sources: ["pacer_docket", "nytimes news article"] });
  assertEquals(r.confidence, 95);
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

Deno.test("inferKind coerces whitespace 'username' to name instead of rejecting", () => {
  const r = inferKind("username", "raheem abdul bey");
  assertEquals(r.kind, "name");
  assertEquals(r.reclassified_from, "username");
  // A real handle is left untouched.
  assertEquals(inferKind("username", "onerich4life4").kind, "username");
});

Deno.test("record-site hostnames OCR'd as 'username' reclassify to domain, not a handle", () => {
  // Regression: gemini_vision read the URL bar of an uploaded CDCR/LASD record page
  // and recorded the host as a username → identity cluster → username-sweep pivot.
  for (const host of ["app5.lasd.org", "ciris.mt.cdcr.ca.gov"]) {
    const v = validateArtifact("username", host);
    assertEquals(v.ok, true);
    assertEquals((v as { kind?: string }).kind, "domain", `${host} must reclassify to domain`);
    assertEquals((v as { metaPatch?: Record<string, unknown> }).metaPatch?.reclassified_from, "username");
  }
  // Ordinary handles — including dotted ones without a public suffix — stay usernames.
  assertEquals(validateArtifact("username", "cameronlawson").kind, "username");
  assertEquals(validateArtifact("username", "john.doe").kind, "username");
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

// ── Infrastructure sub-class corroboration regression tests ──

Deno.test("WHOIS only: capped at 75, does not confirm", () => {
  const r = applyEvidenceCaps({ rawConfidence: 90, sources: ["whois_lookup"] });
  assertEquals(r.confidence, 75);
  assertEquals(r.confidence < 90, true);
  assertEquals(r.reason_not_confirmed !== undefined, true);
});

Deno.test("DNS only: capped at 75, does not confirm", () => {
  const r = applyEvidenceCaps({ rawConfidence: 90, sources: ["dns_records"] });
  assertEquals(r.confidence, 75);
  assertEquals(r.reason_not_confirmed !== undefined, true);
});

Deno.test("WHOIS + DNS (2 infra sub-classes): gets cross-subclass boost", () => {
  const r = applyEvidenceCaps({ rawConfidence: 85, sources: ["whois_lookup", "dns_records"] });
  // Base cap max(75,75) + 8 boost = 83. Raw 85 capped to 83.
  assertEquals(r.confidence >= 80, true);
  assertEquals(r.confidence <= 85, true);
  assertEquals(r.reason_for_confidence.includes("infra"), true);
});

Deno.test("WHOIS + DNS + Shodan (3 infra sub-classes): stronger boost, can reach 85", () => {
  const r = applyEvidenceCaps({ rawConfidence: 90, sources: ["whois_lookup", "dns_records", "shodan_internetdb"] });
  // Base cap max(75,75,70) + 15 boost = 90, clamped by infra-only ceiling to 85.
  assertEquals(r.confidence, 85);
  assertEquals(r.reason_for_confidence.includes("3 sub-classes"), true);
});

Deno.test("infra-only never exceeds 85 (no identity confirmation from infra alone)", () => {
  const r = applyEvidenceCaps({
    rawConfidence: 100,
    sources: ["whois_lookup", "dns_records", "shodan_internetdb", "virustotal_lookup"],
  });
  assertEquals(r.confidence <= 85, true);
  assertEquals(r.reason_not_confirmed?.includes("ownership or identity"), true);
});

Deno.test("VirusTotal reputation only: capped at 65, does not confirm", () => {
  const r = applyEvidenceCaps({ rawConfidence: 80, sources: ["virustotal_lookup"] });
  assertEquals(r.confidence, 65);
  assertEquals(r.reason_not_confirmed !== undefined, true);
});

Deno.test("infra + non-infra class unlocks standard cross-class boost (not infra ceiling)", () => {
  // WHOIS + a news source: cap = max(75,80) + 10 = 90, no infra ceiling.
  const r = applyEvidenceCaps({ rawConfidence: 90, sources: ["whois_lookup", "minimax_web_search (news article)"] });
  assertEquals(r.confidence >= 85, true);
});

Deno.test("Doxbyte regression: whois + dns + shodan + virustotal gives meaningful confidence", () => {
  // Simulates the Doxbyte.com scenario: 4 infra tools, all different sub-classes.
  const r = applyEvidenceCaps({
    rawConfidence: 85,
    sources: ["whois_lookup", "dns_records", "shodan_internetdb", "virustotal_lookup"],
  });
  // 4 sub-classes → base 75 + 15 = 90, clamped to infra-only 85. Raw 85 = 85.
  assertEquals(r.confidence, 85);
  assertEquals(r.reason_for_confidence.includes("4 sub-classes"), true);
  // But ownership/identity still not confirmed.
  assertEquals(r.reason_not_confirmed?.includes("ownership or identity"), true);
});

Deno.test("Doxbyte regression: single-source whois produces higher cap than before", () => {
  // Before: whois_lookup → infra cap 70. After: infra_registry cap 75.
  const r = applyEvidenceCaps({ rawConfidence: 80, sources: ["whois_lookup"] });
  assertEquals(r.confidence, 75);
  assertEquals(r.confidence > 70, true);
});
