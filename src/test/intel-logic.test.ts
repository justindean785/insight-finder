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
  detectNameLocationSeed,
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

  it("minor-safety hard floor: attestation never promotes a possible_minor to CONFIRMED", () => {
    // Bypass fix: adjustedConfidence caps possible_minor at 55, but the label's
    // attestation short-circuit used to return CONFIRMED regardless — rendering a
    // potential minor as a confirmed finding. Attestation must not override the floor.
    const minor = art({ kind: "name", confidence: 40, metadata: { possible_minor: true } });
    expect(labelForArtifact(minor, "confirmed")).not.toBe("CONFIRMED");
    expect(labelForArtifact(minor, "key")).not.toBe("CONFIRMED");
    expect(labelForArtifact(art({ kind: "name", metadata: { possible_minor: true, reviewed: true } }))).not.toBe("CONFIRMED");
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

  // ---- Source independence (over-counting fix) ----------------------------
  // The backend collapses same-class geocoders/discovery tools into ONE
  // source_category; the label engine must count independence from that, not
  // from a naive first-token split that reads census+nominatim as 2 classes.
  describe("independent source-class counting", () => {
    it("does NOT promote census+nominatim (same public_record class) to CONFIRMED", () => {
      // Two geocoders backing one address = ONE independent class. Before the
      // fix the naive split ("census", "nominatim") read as 2 → CONFIRMED.
      const a = art({
        kind: "location",
        value: "1600 Pennsylvania Ave",
        source: "census_geocode",
        confidence: 90,
        metadata: { sources: ["census_geocode", "nominatim_geocode"], source_category: ["public_record"] },
      });
      expect(labelForArtifact(a)).toBe("INFERRED");
      expect(labelForArtifact(a)).not.toBe("CONFIRMED");
      expect(labelForArtifact(a)).not.toBe("CORRELATED");
    });

    it("does NOT promote exa+gemini (discovery-only ai_summary) to CORRELATED", () => {
      // Discovery/search sources never independently corroborate → 0 independent
      // classes. Naive split ("exa", "gemini") previously read as 2.
      const a = art({
        kind: "email",
        value: "lead@example.com",
        source: "exa_search",
        confidence: 90,
        metadata: { sources: ["exa_search", "gemini_deep_dork"], source_category: ["ai_summary"] },
      });
      expect(labelForArtifact(a)).toBe("INFERRED");
      expect(labelForArtifact(a)).not.toBe("CONFIRMED");
      expect(labelForArtifact(a)).not.toBe("CORRELATED");
    });

    it("STILL confirms two genuinely-independent source classes", () => {
      // A registry hit AND an independent public page = 2 real classes → the
      // corroboration path must still fire (no under-counting).
      const a = art({
        kind: "email",
        value: "owner@example.com",
        source: "whois_lookup",
        confidence: 80,
        metadata: {
          sources: ["whois_lookup", "jina_reader_scrape"],
          source_category: ["infra_registry", "independent_public"],
        },
      });
      expect(labelForArtifact(a)).toBe("CONFIRMED");
    });

    it("STILL correlates two genuinely-independent classes below the CONFIRMED bar", () => {
      const a = art({
        kind: "email",
        value: "owner@example.com",
        source: "whois_lookup",
        confidence: 70,
        metadata: {
          sources: ["whois_lookup", "news_article"],
          source_category: ["infra_registry", "news"],
        },
      });
      expect(labelForArtifact(a)).toBe("CORRELATED");
    });
  });

  // ---- Breach-email corroboration must be DISTINCT corpora (FIX #20) -------
  describe("breach-email distinct-corpus gate", () => {
    it("does NOT correlate a single breach corpus that repeats a.source in meta.sources", () => {
      // allSources = ["breach_check", "breach_check"] → one distinct corpus.
      // Before the fix the raw length (2) promoted this to CORRELATED.
      const a = art({
        kind: "email",
        value: "victim@example.com",
        source: "breach_check",
        confidence: 80,
        metadata: { sources: ["breach_check"], source_category: ["breach"] },
      });
      expect(labelForArtifact(a)).toBe("INFERRED");
      expect(labelForArtifact(a)).not.toBe("CORRELATED");
    });

    it("STILL correlates an email seen across two DISTINCT breach corpora", () => {
      const a = art({
        kind: "email",
        value: "victim@example.com",
        source: "breach_check",
        confidence: 80,
        metadata: { sources: ["breach_check", "leakcheck_lookup"], source_category: ["breach"] },
      });
      expect(labelForArtifact(a)).toBe("CORRELATED");
    });
  });
});

describe("detectNameLocationSeed — URL seeds must not produce a phantom subject", () => {
  it("a clean URL seed yields no name search (kind=url)", () => {
    expect(detectNameLocationSeed("https://youtu.be/30gJKcyQlFU")).toBeNull();
  });

  it("the live 3gfgct case: URL fragments never become the subject name", () => {
    // This exact string produced "Detected subject: 3gfgct https youtu" on every
    // cluster in the live report. URL tokens must be stripped → no phantom name.
    const r = detectNameLocationSeed("3gfgct https://youtu.be/30gJKcyQlFU");
    // A single real token ("3gfgct") + a URL is not a name search — no phantom.
    expect(r).toBeNull();
  });

  it("strips an embedded URL but keeps a genuine multi-word name", () => {
    const r = detectNameLocationSeed("John Smith https://x.com/johnsmith");
    expect(r).not.toBeNull();
    expect(r!.name).toBe("john smith");
    // no URL fragment leaked into the name
    expect(r!.name).not.toContain("https");
    expect(r!.name).not.toContain("com");
  });

  it("a real name + state still resolves name and state", () => {
    const r = detectNameLocationSeed("Jane Doe California");
    expect(r!.name).toBe("jane doe");
    expect(r!.state).toBe("CA");
  });

  it("a bare handle/URL host yields no name (would-be fragments dropped)", () => {
    expect(detectNameLocationSeed("watch youtu be")).toBeNull();
  });
});
