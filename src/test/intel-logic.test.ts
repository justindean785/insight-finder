import { describe, it, expect } from "vitest";
import {
  groupForKind,
  GROUP_LABEL,
  GROUP_ORDER,
  adjustedConfidence,
  labelForArtifact,
  isBreachSource,
  isUsernameSweepSource,
  isDirectProfileSource,
  isSensitiveKind,
} from "@/lib/intel";
import type { Artifact } from "@/hooks/useThreadArtifacts";

// Rewritten to import the REAL src/lib/intel exports. The previous version of
// this file re-implemented the logic inline and had silently diverged from
// production (e.g. it claimed groupForKind("username") === "contact" and
// groupForKind("github") === "social"; the real mapping returns "social" and
// "other" respectively).

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

describe("groupForKind", () => {
  it("maps identity kinds", () => {
    expect(groupForKind("name")).toBe("identity");
    expect(groupForKind("person")).toBe("identity");
    expect(groupForKind("avatar")).toBe("identity");
  });

  it("maps contact kinds", () => {
    expect(groupForKind("email")).toBe("contact");
    expect(groupForKind("phone")).toBe("contact");
    expect(groupForKind("address")).toBe("contact");
  });

  it("maps social kinds (username is social, not contact)", () => {
    expect(groupForKind("username")).toBe("social");
    expect(groupForKind("handle")).toBe("social");
    expect(groupForKind("social")).toBe("social");
  });

  it("maps infrastructure kinds", () => {
    expect(groupForKind("ip")).toBe("infrastructure");
    expect(groupForKind("domain")).toBe("infrastructure");
    expect(groupForKind("subdomain")).toBe("infrastructure");
  });

  it("maps breach / web / crypto kinds", () => {
    expect(groupForKind("breach")).toBe("breach");
    expect(groupForKind("password")).toBe("breach");
    expect(groupForKind("url")).toBe("web");
    expect(groupForKind("wallet")).toBe("crypto");
    expect(groupForKind("crypto")).toBe("crypto");
  });

  it("is case-insensitive", () => {
    expect(groupForKind("EMAIL")).toBe("contact");
    expect(groupForKind("Domain")).toBe("infrastructure");
  });

  it("returns other for unmapped kinds (incl. platform names)", () => {
    expect(groupForKind("github")).toBe("other");
    expect(groupForKind("twitter")).toBe("other");
    expect(groupForKind("unknown_thing")).toBe("other");
    expect(groupForKind("")).toBe("other");
  });

  it("every group in GROUP_ORDER has a non-empty label", () => {
    expect(GROUP_ORDER).toHaveLength(8);
    for (const g of GROUP_ORDER) {
      expect(typeof GROUP_LABEL[g]).toBe("string");
      expect(GROUP_LABEL[g].length).toBeGreaterThan(0);
    }
  });
});

describe("source classifiers", () => {
  it("identifies breach-only sources", () => {
    expect(isBreachSource("breach_check")).toBe(true);
    expect(isBreachSource("leakcheck_lookup")).toBe(true);
    expect(isBreachSource("whois")).toBe(false);
    expect(isBreachSource(null)).toBe(false);
  });

  it("identifies username-sweep sources", () => {
    expect(isUsernameSweepSource("username_sweep")).toBe(true);
    expect(isUsernameSweepSource("github_user")).toBe(false);
  });

  it("identifies direct-profile sources", () => {
    expect(isDirectProfileSource("github_user")).toBe(true);
    expect(isDirectProfileSource("socialfetch_lookup")).toBe(true);
    expect(isDirectProfileSource("whois")).toBe(false);
  });

  it("identifies sensitive kinds and metadata flags", () => {
    expect(isSensitiveKind("name")).toBe(true);
    expect(isSensitiveKind("phone")).toBe(true);
    expect(isSensitiveKind("domain")).toBe(false);
    expect(isSensitiveKind("domain", { pii: true })).toBe(true);
  });
});

describe("adjustedConfidence", () => {
  it("passes through the base confidence with a single source", () => {
    expect(adjustedConfidence(art({ source: "whois", confidence: 50 }))).toBe(50);
  });

  it("adds a corroboration bonus for ≥2 distinct source classes", () => {
    expect(
      adjustedConfidence(art({ source: "whois", confidence: 50, metadata: { sources: ["whois", "virustotal"] } })),
    ).toBe(55);
  });

  // Audit finding F11: the bonus previously counted classes via a naive
  // first-token split of raw source strings, so two SAME-CLASS providers
  // (census_geocode + nominatim_geocode, both public-record lookups; or
  // exa_search + gemini_deep_dork, both AI-summary discovery) each counted as
  // a separate "source class" and inflated the bonus — even though
  // labelForArtifact's independently-derived class count correctly saw only
  // one (or zero). These use metadata.source_category, the same authoritative
  // field labelForArtifact reads, to prove the two functions now agree.
  it("does NOT bonus two same-class providers reported via source_category (public_record)", () => {
    const bonused = adjustedConfidence(
      art({ source: "whois", confidence: 50, metadata: { sources: ["whois", "virustotal"] } }),
    );
    const sameClass = adjustedConfidence(
      art({
        source: "census_geocode",
        confidence: 50,
        metadata: { sources: ["census_geocode", "nominatim_geocode"], source_category: ["public_record", "public_record"] },
      }),
    );
    expect(sameClass).toBe(50); // no bonus — one independent class, not two
    expect(sameClass).toBeLessThan(bonused);
  });

  it("does NOT bonus two discovery-only (ai_summary) providers — non-corroborating class excluded entirely", () => {
    expect(
      adjustedConfidence(
        art({
          source: "exa_search",
          confidence: 50,
          metadata: { sources: ["exa_search", "gemini_deep_dork"], source_category: ["ai_summary", "ai_summary"] },
        }),
      ),
    ).toBe(50); // zero independent classes — ai_summary never corroborates alone
  });

  it("DOES bonus two genuinely distinct source_category classes", () => {
    expect(
      adjustedConfidence(
        art({
          source: "breach_check",
          confidence: 50,
          metadata: { sources: ["breach_check", "whois"], source_category: ["breach", "public_record"] },
        }),
      ),
    ).toBe(55);
  });

  it("rewards a direct-profile observation", () => {
    expect(adjustedConfidence(art({ kind: "username", source: "github_user", confidence: 60 }))).toBe(65);
  });

  it("penalizes breach-only and sweep-only signals", () => {
    expect(adjustedConfidence(art({ source: "breach_check", confidence: 60 }))).toBe(55);
    expect(adjustedConfidence(art({ source: "username_sweep", confidence: 60 }))).toBe(50);
  });

  it("applies analyst review deltas", () => {
    expect(adjustedConfidence(art({ source: "whois", confidence: 50 }), "confirmed")).toBe(70);
    expect(adjustedConfidence(art({ source: "whois", confidence: 50 }), "wrong")).toBe(10);
  });

  it("subtracts for explicit conflict metadata", () => {
    expect(adjustedConfidence(art({ source: "whois", confidence: 80, metadata: { conflict: true } }))).toBe(65);
  });

  it("caps possible-minor artifacts at 55", () => {
    expect(adjustedConfidence(art({ source: "whois", confidence: 90, metadata: { possible_minor: true } }))).toBe(55);
  });
});

describe("labelForArtifact", () => {
  it("forces FAILED for dismissed/wrong/false_positive", () => {
    expect(labelForArtifact(art(), "dismissed")).toBe("FAILED");
    expect(labelForArtifact(art({ metadata: { false_positive: true } }))).toBe("FAILED");
  });

  it("returns CONFLICT for conflict/collision metadata", () => {
    expect(labelForArtifact(art({ metadata: { conflict: true } }))).toBe("CONFLICT");
  });

  it("short-circuits analyst attestations to CONFIRMED", () => {
    expect(labelForArtifact(art(), "confirmed")).toBe("CONFIRMED");
    expect(labelForArtifact(art({ metadata: { reviewed: true } }))).toBe("CONFIRMED");
  });

  it("caps sweep-only handles at VERIFY", () => {
    expect(labelForArtifact(art({ kind: "username", source: "username_sweep", confidence: 95 }))).toBe("VERIFY");
  });

  it("keeps breach-only sensitive PII at VERIFY unless seed-linked", () => {
    expect(labelForArtifact(art({ kind: "name", source: "breach_check", confidence: 90 }))).toBe("VERIFY");
    expect(
      labelForArtifact(art({ kind: "name", source: "breach_check", confidence: 90, metadata: { parent: "seed@x.com" } })),
    ).toBe("CORRELATED");
  });

  it("lifts a breach-corroborated email to CORRELATED", () => {
    expect(
      labelForArtifact(
        art({ kind: "email", source: "breach_check", confidence: 80, metadata: { sources: ["breach_check", "leakcheck"] } }),
      ),
    ).toBe("CORRELATED");
  });

  it("rates identity handles without a direct profile by confidence", () => {
    expect(labelForArtifact(art({ kind: "username", source: "exa", confidence: 60 }))).toBe("INFERRED");
    expect(labelForArtifact(art({ kind: "username", source: "exa", confidence: 30 }))).toBe("VERIFY");
  });

  it("promotes multi-source-class corroboration", () => {
    expect(
      labelForArtifact(
        art({ kind: "username", source: "github_user", confidence: 85, metadata: { sources: ["github_user", "whois"] } }),
      ),
    ).toBe("CONFIRMED");
    expect(
      labelForArtifact(art({ kind: "email", source: "whois", confidence: 75, metadata: { sources: ["whois", "virustotal"] } })),
    ).toBe("CORRELATED");
  });

  it("falls back to INFERRED / LOW for single-source non-identity", () => {
    expect(labelForArtifact(art({ kind: "email", source: "whois", confidence: 90 }))).toBe("INFERRED");
    expect(labelForArtifact(art({ kind: "email", source: "whois", confidence: 30 }))).toBe("LOW");
  });
});
