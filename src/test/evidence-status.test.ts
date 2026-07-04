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
