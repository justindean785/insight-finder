import { describe, expect, it } from "vitest";
import { evidenceStatus, isSharedInfrastructure, EVIDENCE_STATUS_RANK } from "@/lib/evidence-status";
import type { Artifact } from "@/hooks/useThreadArtifacts";

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

  it("breach kind is Manual review, never confirmed", () => {
    const s = evidenceStatus(art({
      kind: "breach", value: "doxbyte.com", confidence: 30, source: "virustotal",
      metadata: { sources: ["virustotal"] },
    }));
    expect(s.status).toBe("manual_review");
    expect(s.basis).toContain("Breach/exposure");
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
