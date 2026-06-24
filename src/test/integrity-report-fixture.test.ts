// Integration regression — the REPORT-RENDER half of the chain where the original
// bug surfaced: buildReportMarkdown over a small, fully synthetic, NON-SENSITIVE
// fixture. No live tools, no network, no real-person seed, no deploy dependency.
// Pairs with supabase/functions/osint-agent/integrity_report_fixture_test.ts,
// which proves the backend half (safety scrub + evidence-cap) on the same values.
//
// The fixture represents what the FIXED backend stores: a date-like DOB WITHOUT
// a possible_minor flag, an adult-platform handle, and the two Synthient breach
// name-variants from the same source pair.
import { describe, it, expect } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { buildReportMarkdown } from "@/lib/intel";

function art(p: Partial<Artifact> & { kind: string; value: string }): Artifact {
  return {
    id: p.id ?? p.value,
    kind: p.kind,
    value: p.value,
    source: p.source ?? null,
    confidence: p.confidence ?? 50,
    created_at: p.created_at ?? "2026-06-20T00:00:00.000Z",
    metadata: p.metadata ?? {},
  } as Artifact;
}

const SYN_SRC = "deepfind_email_breach+serus_darkweb_scan";
const SYN_EXPOSURE = "Synthient Credential Stuffing 2025 (1.9B)";
const SYN_WEAK = "Synthient Credential Stuffing Threat Data (1.9B records, April 2025)";

function fixtureArtifacts(): Artifact[] {
  return [
    // Date-like DOB as the FIXED backend stores it — no possible_minor flag.
    art({ kind: "other", value: "1958-10-11", source: "leakcheck_lookup/Acme breach", metadata: { original_kind: "dob", cluster_id: "c1" } }),
    // Adult-platform handle in the same cluster (synthetic).
    art({ kind: "username", value: "qa_fixture_handle", source: "oathnet_lookup/AdultFriendFinder breach", metadata: { platform: "AdultFriendFinder", cluster_id: "c1" } }),
    // The two Synthient name-variants from the same source pair.
    art({ kind: "breach_exposure", value: SYN_EXPOSURE, source: SYN_SRC, metadata: { breach_date: "2025-04" } }),
    art({ kind: "weak_lead", value: SYN_WEAK, source: SYN_SRC, metadata: { reclassified_from: "other" } }),
    // Compound-breach seed email (synthetic).
    art({ kind: "email", value: "qa.fixture@example.com", source: "breach_check+leakcheck+oathnet_lookup+deepfind_email_breach+serus_darkweb_scan", metadata: { source_category: ["breach"] } }),
  ];
}

const report = (arts: Artifact[]) =>
  buildReportMarkdown({ seedValue: "qa.fixture@example.com", seedType: "email", artifacts: arts, messages: [] });

describe("integrity fixture — report path", () => {
  it("does NOT raise a minor / adult-platform safety collision for a date-like DOB", () => {
    const md = report(fixtureArtifacts());
    expect(md).not.toContain("SAFETY COLLISION");
    expect(md).not.toContain("Possible minor-related signal");
  });

  it("control: the banner DOES appear when a DOB is (wrongly) flagged possible_minor", () => {
    // Proves the assertion above is meaningful — the only thing keeping the banner
    // away is the absence of possible_minor, which is exactly what the fix guarantees.
    const arts = fixtureArtifacts();
    arts[0] = { ...arts[0], metadata: { ...arts[0].metadata, possible_minor: true } };
    const md = report(arts);
    expect(md).toContain("SAFETY COLLISION");
    expect(md).toContain("Possible minor-related signal");
  });

  it("collapses the two Synthient breach name-variants to a single report entry", () => {
    const md = report(fixtureArtifacts());
    // The richer breach_exposure representative survives; the weak_lead variant is gone.
    expect(md).toContain(SYN_EXPOSURE);
    expect(md).not.toContain("Threat Data (1.9B records, April 2025)");
    const present = [SYN_EXPOSURE, SYN_WEAK].filter((v) => md.includes(v));
    expect(present).toHaveLength(1);
  });

  it("renders without throwing on the minimal fixture input", () => {
    expect(typeof report(fixtureArtifacts())).toBe("string");
  });
});
