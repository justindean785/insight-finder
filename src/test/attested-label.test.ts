/**
 * attested-label — the analyst's Confirm / Key decision is its OWN label rung.
 *
 * Before: `labelForArtifact` short-circuited an attested row to CONFIRMED, so a
 * row at recorded confidence 40 read "CONFIRMED" beside a legend that defines
 * CONFIRMED as two independent source classes. ATTESTED renders as
 * ANALYST-CONFIRMED, counts as verified on the board, never touches the figure,
 * and still loses to the two hard floors (possible minor, quarantine).
 */
import { describe, it, expect } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { CONF_LABEL_CLASS, CONF_LABEL_HELP, buildReportMarkdown, labelForArtifact } from "@/lib/intel";
import { evidenceStatus } from "@/lib/evidence-status";
import { effectiveConfidence } from "@/lib/display-confidence";

const row = (over: Partial<Artifact> = {}): Artifact => ({
  id: over.id ?? "r1", kind: "email", value: "qa.attest@example.invalid", confidence: 40,
  source: "hunter_email_verifier", created_at: "2026-09-02T00:00:00Z",
  metadata: { source_category: ["infra_registry"], confidence_cap_applied: 65 }, ...over,
} as Artifact);

describe("ATTESTED label", () => {
  it("Confirm / Key / reviewed → ATTESTED, never CONFIRMED, figure unchanged", () => {
    expect(labelForArtifact(row())).toBe("VERIFY");
    expect(labelForArtifact(row(), "confirmed")).toBe("ATTESTED");
    expect(labelForArtifact(row(), "key")).toBe("ATTESTED");
    expect(labelForArtifact(row({ metadata: { reviewed: true } }))).toBe("ATTESTED");
    expect(effectiveConfidence(row())).toBe(40);
  });

  it("CONFIRMED is reserved for two independent source classes at >=85", () => {
    const strong = row({ confidence: 90, metadata: { source_category: ["official", "independent_public"], sources: ["court_records", "news_archive"] } });
    expect(labelForArtifact(strong)).toBe("CONFIRMED");
    // an attestation on top of real corroboration never downgrades the evidence rung
    expect(labelForArtifact(strong, "confirmed")).toBe("CONFIRMED");
  });

  it("the hard floors still win: possible minor and quarantine are never attested away", () => {
    expect(labelForArtifact(row({ kind: "name", metadata: { possible_minor: true } }), "confirmed")).not.toBe("ATTESTED");
    expect(labelForArtifact(row({ metadata: { subject_unlinked: true } }), "confirmed")).not.toBe("ATTESTED");
    expect(labelForArtifact(row({ metadata: { subject_unlinked: true, linkage_confirmed: true } }), "confirmed")).toBe("ATTESTED");
  });

  it("board status: an attested row is verified, with the analyst named as the basis", () => {
    const s = evidenceStatus(row(), "confirmed");
    expect(s.status).toBe("verified");
  });

  it("the legend distinguishes the two rungs", () => {
    expect(CONF_LABEL_HELP.CONFIRMED).not.toMatch(/analyst/i);
    expect(CONF_LABEL_HELP.ATTESTED).toMatch(/analyst/i);
    expect(CONF_LABEL_CLASS.ATTESTED).toBeTruthy();
  });

  it("the report counts and lists attested rows separately from corroborated ones", () => {
    const arts = [row({ id: "a" }), row({ id: "b", value: "qa.other@example.invalid" })];
    const md = buildReportMarkdown({ seedValue: "qa.attest@example.invalid", seedType: "email", artifacts: arts, messages: [], reviews: { a: "confirmed" } });
    expect(md).toContain("1 item analyst-confirmed (a decision, not a second source)");
    expect(md).not.toContain("observed in multiple sources or analyst-reviewed");
    expect(md).toMatch(/ATTESTED/);
    expect(md).not.toMatch(/\| CONFIRMED \|/);
  });
});
