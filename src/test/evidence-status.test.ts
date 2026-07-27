import { describe, expect, it } from "vitest";
import { evidenceStatus, isSharedInfrastructure, EVIDENCE_STATUS_RANK, EVIDENCE_STATUS_LEGEND, EVIDENCE_STATUS_ORDER } from "@/lib/evidence-status";
import type { Artifact } from "@/hooks/useThreadArtifacts";

describe("EVIDENCE_STATUS_LEGEND — one shared vocabulary", () => {
  it("covers every canonical status, in order, with label + hint", () => {
    expect(EVIDENCE_STATUS_LEGEND.map((e) => e.status)).toEqual(EVIDENCE_STATUS_ORDER);
    for (const entry of EVIDENCE_STATUS_LEGEND) {
      expect(entry.label.length).toBeGreaterThan(0);
      expect(entry.hint.length).toBeGreaterThan(10);
      expect(entry.tone).toBeTruthy();
    }
  });

  it("matches the label/tone a real artifact resolves to (legend == chips)", () => {
    const verified = EVIDENCE_STATUS_LEGEND.find((e) => e.status === "verified")!;
    expect(verified.label).toBe("Verified");
  });
});

function art(partial: Partial<Artifact>): Artifact {
  return {
    id: partial.id ?? "x",
    kind: partial.kind ?? "domain",
    value: partial.value ?? "example.com",
    confidence: partial.confidence ?? 50,
    source: partial.source ?? null,
    created_at: partial.created_at ?? "2026-06-15T17:22:52Z",
    metadata: partial.metadata ?? null,
  };
}

describe("evidenceStatus — never overstates, always textual", () => {
  it("single-source infra domain reads as Needs corroboration, not Verified", () => {
    const s = evidenceStatus(art({
      kind: "domain", value: "doxbyte.net", confidence: 70, source: "whois_lookup",
      metadata: { sources: ["whois_lookup"] },
    }));
    expect(s.status).toBe("needs_corroboration");
    expect(s.label).toBe("Needs corroboration");
    expect(s.basis).toContain("Single-source");
  });

  it("VirusTotal reads as Threat/reputation, not Breach (review #4)", () => {
    const s = evidenceStatus(art({
      kind: "breach", value: "doxbyte.com", confidence: 30, source: "virustotal",
      metadata: { sources: ["virustotal"], source_category: ["unknown"] },
    }));
    expect(s.status).toBe("manual_review");
    expect(s.basis).toContain("Threat/reputation");
    expect(s.basis).not.toContain("Breach/exposure");
  });

  it("real breach source reads as Breach/exposure manual review", () => {
    const s = evidenceStatus(art({
      kind: "breach_exposure", value: "x@y.com", confidence: 55, source: "leakcheck_lookup",
      metadata: { sources: ["leakcheck_lookup"], source_category: ["breach"] },
    }));
    expect(s.status).toBe("manual_review");
    expect(s.basis).toContain("Breach/exposure");
  });

  it("threat_intel (ransomware-victim) reads as Threat intel manual review, not Breach", () => {
    const s = evidenceStatus(art({
      kind: "breach", value: "acme corp", confidence: 50, source: "ransomwarelive_lookup",
      metadata: { sources: ["ransomwarelive_lookup"], source_category: ["threat_intel"] },
    }));
    expect(s.status).toBe("manual_review");
    expect(s.basis).toMatch(/Threat intel/i);
    expect(s.basis).not.toContain("Breach/exposure");
  });

  it("rapidapi_breach_search hit reads as Breach/exposure manual review (primary breach source)", () => {
    // The backend classifies rapidapi_breach_search as the `breach` source class
    // (source-classification.ts) and writes metadata.source_category:["breach"].
    // The Evidence board must surface it like every other breach source — manual
    // review, never auto-confirmed identity off a single exposure hit.
    const s = evidenceStatus(art({
      kind: "breach", value: "owner@example.com", confidence: 55,
      source: "rapidapi_breach_search",
      metadata: { sources: ["rapidapi_breach_search"], source_category: ["breach"] },
    }));
    expect(s.status).toBe("manual_review");
    expect(s.basis).toContain("Breach/exposure");
    expect(["verified", "verified_infrastructure", "probable"]).not.toContain(s.status);
  });

  it("infra-only multi-source reads as Verified infrastructure, not generic Verified (review #1)", () => {
    const s = evidenceStatus(art({
      kind: "domain", value: "doxbyte.net", confidence: 85, source: "whois_lookup",
      metadata: { sources: ["whois_lookup", "dns_records"], source_category: ["infra_registry", "infra_dns"] },
    }));
    expect(s.status).toBe("verified_infrastructure");
    expect(s.label).toBe("Verified infrastructure");
    expect(s.basis).toContain("not ownership proof");
  });

  it("Cloudflare-hosted IP reads as Shared infrastructure (review #2)", () => {
    const s = evidenceStatus(art({
      kind: "ip", value: "104.26.0.99", confidence: 70, source: "dns_records",
      metadata: { asn: "AS13335 (Cloudflare)", source_category: ["infra_dns"] },
    }));
    expect(s.status).toBe("shared_infrastructure");
    expect(s.basis).toContain("not ownership proof");
  });

  it("single-source breach data is Manual review even at higher confidence", () => {
    const s = evidenceStatus(art({
      kind: "email", value: "a@b.com", confidence: 60, source: "breach_check",
      metadata: { sources: ["breach_check"] },
    }));
    expect(s.status).toBe("manual_review");
  });

  it("excluded_collision / shared host reads as Shared infrastructure", () => {
    const s = evidenceStatus(art({
      kind: "excluded_collision", value: "104.26.1.99", confidence: 15,
      source: "hackertarget/reverseiplookup",
      metadata: { shared_hosting: true, excluded_collision: true },
    }));
    expect(s.status).toBe("shared_infrastructure");
    expect(s.basis).toContain("not ownership proof");
    expect(isSharedInfrastructure(art({ kind: "excluded_collision", value: "x" }))).toBe(true);
  });

  it("low-confidence AI-summary username reads as Lead", () => {
    const s = evidenceStatus(art({
      kind: "username", value: "doxbytes", confidence: 40, source: "gemini_deep_dork",
      metadata: { sources: ["gemini_deep_dork"], platform: "Telegram" },
    }));
    // username sweep/ai-summary single-source caps at VERIFY → needs_corroboration,
    // but low confidence keeps it a lead-level signal.
    expect(["lead", "needs_corroboration"]).toContain(s.status);
  });

  it("analyst-confirmed review elevates to Verified", () => {
    const s = evidenceStatus(
      art({ kind: "email", value: "a@b.com", confidence: 60, source: "whois_lookup" }),
      "confirmed",
    );
    expect(s.status).toBe("verified");
  });

  it("analyst-dismissed review reads as Rejected", () => {
    const s = evidenceStatus(
      art({ kind: "domain", value: "x.com", confidence: 70, source: "whois_lookup" }),
      "dismissed",
    );
    expect(s.status).toBe("rejected");
  });

  it("multi-source-class non-breach data can read as Probable/Verified", () => {
    const s = evidenceStatus(art({
      kind: "domain", value: "x.com", confidence: 90, source: "whois_lookup",
      metadata: { sources: ["whois_lookup", "jina_reader_scrape"] },
    }));
    expect(["probable", "verified"]).toContain(s.status);
    expect(s.basis).toContain("Multi-source");
  });

  it("every status carries a non-empty textual label and hint (no color-only)", () => {
    const samples = [
      art({ kind: "breach", value: "b", source: "virustotal" }),
      art({ kind: "domain", value: "d", source: "whois_lookup" }),
      art({ kind: "excluded_collision", value: "c", metadata: { shared_hosting: true } }),
    ];
    for (const a of samples) {
      const s = evidenceStatus(a);
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.hint.length).toBeGreaterThan(0);
      expect(EVIDENCE_STATUS_RANK[s.status]).toBeGreaterThanOrEqual(0);
    }
  });

  it("rank orders findings before leads before excluded", () => {
    expect(EVIDENCE_STATUS_RANK.verified).toBeLessThan(EVIDENCE_STATUS_RANK.lead);
    expect(EVIDENCE_STATUS_RANK.lead).toBeLessThan(EVIDENCE_STATUS_RANK.rejected);
  });
});

describe("data broker records are never presented as breach disclosures", () => {
  // THE LIVE INCIDENT (case a2192c55, 2026-07-26): one `indicia_address` lookup
  // returned eleven people associated with an address. Every one rendered
  // "Breach/exposure · single-source" at 45-50% — a false factual claim that a
  // private citizen's data appeared in a breach. One was a bank-fraud
  // investigator, in a bank-fraud case. Broker association != breach disclosure.
  const brokerName = art({
    kind: "name",
    value: "Some Uninvolved Person",
    confidence: 45,
    source: "indicia_address",
    metadata: { source_category: ["data_broker"] },
  });

  it("labels an indicia_address hit as a data broker record, not breach/exposure", () => {
    const s = evidenceStatus(brokerName);
    expect(s.basis).toContain("Data broker record");
    expect(s.basis).toContain("not breach data");
    expect(s.basis).not.toContain("Breach/exposure");
  });

  it("still forces analyst review — the weight is unchanged by the rename", () => {
    expect(evidenceStatus(brokerName).status).toBe("manual_review");
  });

  it("keeps a genuine breach corpus hit labelled as breach/exposure", () => {
    const breach = art({
      kind: "breach",
      value: "SomeCorp",
      confidence: 55,
      source: "rapidapi_breach_search",
      metadata: { source_category: ["breach"] },
    });
    const s = evidenceStatus(breach);
    expect(s.basis).toContain("Breach/exposure");
    expect(s.status).toBe("manual_review");
  });
});

describe("analyst-confirmed findings name their actual basis", () => {
  // NOT a bug, and worth recording so it is not "fixed" again: a single-source
  // artifact CAN legitimately read Verified when an analyst attests to it —
  // STATUS_HINT.verified promises exactly that. On case a2192c55 the 12 "Verified"
  // chips were 11 `confirmed` + 1 `key` review rows: the analyst's own decisions,
  // working correctly. An earlier attempt to force single-source out of Verified
  // would have silently demoted those attestations.
  // The real defect was narrower: the chip read "Single-source · unknown" beside a
  // green Verified, which looks like corroborated EVIDENCE rather than a human
  // vouching. Name the basis instead.
  const singleSource = art({
    kind: "name",
    value: "Dioban J. Pineda-Urdaneta",
    confidence: 50,
    source: "ada_county_sheriff_press_release",
    metadata: { source_category: ["news"] },
  });

  it("says Analyst-confirmed rather than implying corroboration", () => {
    const s = evidenceStatus(singleSource, "confirmed");
    expect(s.status).toBe("verified");
    expect(s.basis).toContain("Analyst-confirmed");
    expect(s.basis).toContain("single-source");
  });

  it("treats a persisted metadata.reviewed attestation the same way", () => {
    const reviewed = art({
      kind: "name",
      value: "Attested Person",
      confidence: 50,
      source: "news_article",
      metadata: { source_category: ["news"], reviewed: true },
    });
    expect(evidenceStatus(reviewed).basis).toContain("Analyst-confirmed");
  });

  it("leaves an unreviewed single-source finding as-is", () => {
    const s = evidenceStatus(singleSource);
    expect(s.status).not.toBe("verified");
    expect(s.basis).toContain("Single-source");
  });
});
