import { describe, expect, it } from "vitest";
import { displayKind, isReputationArtifact, extractFailedAndSkipped, type RawMessage } from "@/lib/intel";
import type { Artifact } from "@/hooks/useThreadArtifacts";

function art(p: Partial<Artifact>): Artifact {
  return {
    id: p.id ?? "x", kind: p.kind ?? "domain", value: p.value ?? "x.com",
    confidence: p.confidence ?? 50, source: p.source ?? null,
    created_at: p.created_at ?? "2026-06-15T00:00:00Z", metadata: p.metadata ?? null,
  };
}

describe("displayKind / isReputationArtifact (review #4)", () => {
  it("VirusTotal breach row displays as threat_reputation", () => {
    const a = art({ kind: "breach", value: "doxbyte.com", source: "virustotal", metadata: { source_category: ["unknown"] } });
    expect(isReputationArtifact(a)).toBe(true);
    expect(displayKind(a)).toBe("threat_reputation");
  });
  it("infra_reputation source_category triggers reputation", () => {
    const a = art({ kind: "breach", value: "x", source: "urlscan_search", metadata: { source_category: ["infra_reputation"] } });
    expect(displayKind(a)).toBe("threat_reputation");
  });
  it("a real credential breach stays breach", () => {
    const a = art({ kind: "breach", value: "x@y.com", source: "leakcheck_lookup", metadata: { source_category: ["breach"] } });
    expect(isReputationArtifact(a)).toBe(false);
    expect(displayKind(a)).toBe("breach");
  });
  it("non-breach kinds pass through unchanged", () => {
    expect(displayKind(art({ kind: "domain", source: "whois_lookup" }))).toBe("domain");
  });
});

describe("extractFailedAndSkipped parity (review #3)", () => {
  function msg(parts: unknown[]): RawMessage {
    return { id: "m1", role: "assistant", parts, created_at: "2026-06-15T00:00:00Z" };
  }
  it("catches ok:false budget rows and labels them gated (not failed)", () => {
    const out = extractFailedAndSkipped([
      msg([{ type: "tool-memory_save", state: "output-available", output: { ok: false, reason: "paid-call budget exhausted" } }]),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("gated");
  });
  it("classifies provider-disabled as degraded", () => {
    const out = extractFailedAndSkipped([
      msg([{ type: "tool-ipqualityscore_lookup", state: "output-error", errorText: "unavailable: disabled (provider disabled)" }]),
    ]);
    expect(out[0].kind).toBe("degraded");
  });
  it("real errors remain failed", () => {
    const out = extractFailedAndSkipped([
      msg([{ type: "tool-whois_lookup", state: "output-error", errorText: "validation: invalid domain" }]),
    ]);
    expect(out[0].kind).toBe("failed");
  });
  it("clean successes are not listed", () => {
    const out = extractFailedAndSkipped([
      msg([{ type: "tool-dns_records", state: "output-available", output: { ok: true } }]),
    ]);
    expect(out).toHaveLength(0);
  });
});

import { buildReportMarkdown } from "@/lib/intel";

describe("report network grouping routes reputation correctly (Codex P2)", () => {
  it("threat_reputation-kinded VirusTotal row appears under Threat / Reputation, not Other", () => {
    const md = buildReportMarkdown({
      seedValue: "doxbyte.com", seedType: "domain",
      artifacts: [
        art({ id: "1", kind: "threat_reputation", value: "doxbyte.com", source: "virustotal", confidence: 30, metadata: { source_category: ["infra_reputation"] } }),
        art({ id: "2", kind: "domain", value: "doxbyte.net", source: "whois_lookup", confidence: 70, metadata: { source_category: ["infra_registry"] } }),
      ],
    });
    const repIdx = md.indexOf("Threat / Reputation");
    expect(repIdx).toBeGreaterThan(-1);
    // the VT value must appear after the Threat/Reputation header
    expect(md.indexOf("doxbyte.com", repIdx)).toBeGreaterThan(repIdx);
  });

  it("breach-kinded VirusTotal row is also pulled out of Breach / Exposure", () => {
    const md = buildReportMarkdown({
      seedValue: "x.com", seedType: "domain",
      artifacts: [
        art({ id: "1", kind: "breach", value: "x.com", source: "virustotal", confidence: 30, metadata: { source_category: ["unknown"] } }),
      ],
    });
    expect(md).toContain("Threat / Reputation");
  });
});
