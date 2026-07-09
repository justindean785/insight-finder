/**
 * Frontend-runnable regression tests that mirror the backend confidence engine
 * behavior for infrastructure sub-class corroboration. These import the backend
 * source files directly (they're plain TS, Deno-compatible but also Node-readable).
 */
import { describe, expect, it } from "vitest";
import {
  classifySource,
  classifySourceLabel,
} from "../../supabase/functions/osint-agent/artifact_types.ts";
import { applyEvidenceCaps } from "../../supabase/functions/osint-agent/confidence.ts";

describe("infrastructure source sub-class classification", () => {
  it("maps WHOIS to infra_registry", () => {
    expect(classifySource("whois_lookup")).toBe("infra_registry");
    expect(classifySource("hunter_domain_search")).toBe("infra_registry");
  });
  it("maps DNS/cert to infra_dns", () => {
    expect(classifySource("dns_records")).toBe("infra_dns");
    expect(classifySource("crtsh_subdomains")).toBe("infra_dns");
  });
  it("maps scanning tools to infra_scan", () => {
    expect(classifySource("shodan_internetdb")).toBe("infra_scan");
    expect(classifySource("hackertarget")).toBe("infra_scan");
    expect(classifySource("http_fingerprint")).toBe("infra_scan");
    expect(classifySource("ip_intel")).toBe("infra_scan");
  });
  it("maps reputation tools to infra_reputation", () => {
    expect(classifySource("virustotal_lookup")).toBe("infra_reputation");
    expect(classifySource("urlscanner_scan")).toBe("infra_reputation");
    expect(classifySource("ipqualityscore_lookup")).toBe("infra_reputation");
  });
  it("still strips parenthetical qualifiers", () => {
    expect(classifySource("socialfetch_lookup (instagram)")).toBe("social_profile_passive");
    expect(classifySource("bosint_email_lookup (drizly.com breach)")).toBe("breach");
  });
});

describe("OathNet classifies as breach, never public_record", () => {
  // OathNet is a breach/leaked-data aggregator (TOOL_CLASS.oathnet_lookup = "breach").
  // It used to be listed in the public_record people-search regex, which runs before
  // the breach regex, so any "oathnet"-containing free-text provenance mis-classified
  // as public_record (cap 75, an OFFICIAL class) instead of breach (cap 60). Regression
  // guard for the de-inflation fix.
  it("internal slug → breach (unchanged)", () => {
    expect(classifySource("oathnet_lookup")).toBe("breach");
  });
  it("bare free-text label → breach (not public_record, not unknown)", () => {
    expect(classifySource("OathNet")).toBe("breach");
    expect(classifySourceLabel("OathNet")).toEqual(["breach"]);
  });
  it("free-text with breach keyword → breach", () => {
    expect(classifySource("OathNet breach")).toBe("breach");
  });
  it("compound source string → includes breach, never public_record", () => {
    const classes = classifySourceLabel("breach_check+oathnet");
    expect(classes).toContain("breach");
    expect(classes).not.toContain("public_record");
  });
  it("does not regress the public_record branch for legit people-search labels", () => {
    expect(classifySource("public records search")).toBe("public_record");
    expect(classifySource("whitepages")).toBe("public_record");
  });
});

describe("infrastructure confidence caps", () => {
  it("WHOIS only: capped at 75", () => {
    const r = applyEvidenceCaps({ rawConfidence: 90, sources: ["whois_lookup"] });
    expect(r.confidence).toBe(75);
    expect(r.reason_not_confirmed).toBeDefined();
  });

  it("DNS only: capped at 75", () => {
    const r = applyEvidenceCaps({ rawConfidence: 90, sources: ["dns_records"] });
    expect(r.confidence).toBe(75);
  });

  it("VirusTotal only: capped at 65", () => {
    const r = applyEvidenceCaps({ rawConfidence: 80, sources: ["virustotal_lookup"] });
    expect(r.confidence).toBe(65);
  });

  it("WHOIS + DNS (2 sub-classes): gets boost, can reach 80+", () => {
    const r = applyEvidenceCaps({ rawConfidence: 85, sources: ["whois_lookup", "dns_records"] });
    expect(r.confidence).toBeGreaterThanOrEqual(80);
    expect(r.confidence).toBeLessThanOrEqual(85);
    expect(r.reason_for_confidence).toContain("infra");
  });

  it("WHOIS + DNS + Shodan (3 sub-classes): stronger boost, reaches 85", () => {
    const r = applyEvidenceCaps({ rawConfidence: 90, sources: ["whois_lookup", "dns_records", "shodan_internetdb"] });
    expect(r.confidence).toBe(85);
    expect(r.reason_for_confidence).toContain("3 sub-classes");
  });

  it("infra-only never exceeds 85, regardless of how many sub-classes", () => {
    const r = applyEvidenceCaps({
      rawConfidence: 100,
      sources: ["whois_lookup", "dns_records", "shodan_internetdb", "virustotal_lookup"],
    });
    expect(r.confidence).toBeLessThanOrEqual(85);
    expect(r.reason_not_confirmed).toContain("ownership or identity");
  });

  it("infra + non-infra class unlocks standard cross-class boost (no infra ceiling)", () => {
    const r = applyEvidenceCaps({ rawConfidence: 90, sources: ["whois_lookup", "jina_reader_scrape"] });
    expect(r.confidence).toBeGreaterThanOrEqual(85);
  });

  it("Doxbyte regression: 4 infra tools produce meaningful 85 confidence", () => {
    const r = applyEvidenceCaps({
      rawConfidence: 85,
      sources: ["whois_lookup", "dns_records", "shodan_internetdb", "virustotal_lookup"],
    });
    expect(r.confidence).toBe(85);
    expect(r.reason_for_confidence).toContain("4 sub-classes");
    expect(r.reason_not_confirmed).toContain("ownership or identity");
  });

  it("Cloudflare/shared-host IP from Shodan alone stays low", () => {
    const r = applyEvidenceCaps({ rawConfidence: 60, sources: ["shodan_internetdb"] });
    expect(r.confidence).toBeLessThanOrEqual(70);
    expect(r.reason_not_confirmed).toBeDefined();
  });

  it("infra corroboration does not upgrade to CONFIRMED (stays below 90)", () => {
    const r = applyEvidenceCaps({
      rawConfidence: 100,
      sources: ["whois_lookup", "dns_records", "shodan_internetdb", "virustotal_lookup", "hackertarget"],
    });
    expect(r.confidence).toBeLessThan(90);
  });

  it("single-source WHOIS is higher than old infra cap (75 > 70)", () => {
    const r = applyEvidenceCaps({ rawConfidence: 80, sources: ["whois_lookup"] });
    expect(r.confidence).toBe(75);
    expect(r.confidence).toBeGreaterThan(70);
  });
});

describe("shared-host, passive, and trusted-class guards (review #3/#5)", () => {
  it("reverse-IP / shared host classifies as infra_shared_host and caps at 35", () => {
    expect(classifySource("hackertarget/reverseiplookup")).toBe("infra_shared_host");
    const r = applyEvidenceCaps({ rawConfidence: 90, sources: ["hackertarget/reverseiplookup"] });
    expect(r.confidence).toBe(35);
  });

  it("shared host adds no corroboration to a WHOIS finding", () => {
    const r = applyEvidenceCaps({ rawConfidence: 90, sources: ["whois_lookup", "hackertarget/reverseiplookup"] });
    expect(r.confidence).toBe(75); // whois cap only
  });

  it("passive sources classify as infra_passive", () => {
    expect(classifySource("urlscan_search")).toBe("infra_passive");
    expect(classifySource("wayback_snapshots")).toBe("infra_passive");
  });

  it("infra + weak ai_summary cannot exceed infra-safe 85", () => {
    const r = applyEvidenceCaps({
      rawConfidence: 100,
      sources: ["whois_lookup", "dns_records", "shodan_internetdb", "gemini_deep_dork"],
    });
    expect(r.confidence).toBeLessThanOrEqual(85);
  });

  it("infra + trusted court_record CAN lift past 85", () => {
    const r = applyEvidenceCaps({ rawConfidence: 100, sources: ["whois_lookup", "pacer_docket"] });
    expect(r.confidence).toBeGreaterThan(85);
  });

  it("court_record + news still reaches 95", () => {
    // Input must genuinely classify as `news` (the "nytimes_article" underscore
    // blocks the \b word boundary → it was actually `unknown`, and only reached
    // 95 via the old unknown-corroboration +10 boost that has since been removed).
    const r = applyEvidenceCaps({ rawConfidence: 100, sources: ["pacer_docket", "nytimes news article"] });
    expect(r.confidence).toBe(95);
  });
});
