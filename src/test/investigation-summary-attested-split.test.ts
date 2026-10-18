/**
 * investigation-summary-attested-split — `buildInvestigationSummary` used to add ATTESTED (an analyst's
 * decision, not a second source) into the CONFIRMED figure and to ignore the analyst's reviews entirely.
 * It now counts the two apart, the way Tool Coverage (#743) and the report do.
 */
import { describe, it, expect } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { buildInvestigationSummary } from "@/lib/intel";

const row = (over: Partial<Artifact> = {}): Artifact => ({
  id: over.id ?? "r1", kind: "email", value: "qa.summary@example.invalid", confidence: 40,
  source: "hunter_email_verifier", created_at: "2026-10-14T00:00:00Z",
  metadata: { source_category: ["infra_registry"], confidence_cap_applied: 65 }, ...over,
} as Artifact);

const strong = (id: string) =>
  row({ id, value: `${id}@example.invalid`, confidence: 90, metadata: { source_category: ["official", "independent_public"], sources: ["court_records", "news_archive"] } });

const summary = (artifacts: Artifact[], reviews?: Record<string, "confirmed" | "key">) =>
  buildInvestigationSummary({ seedValue: "qa.summary@example.invalid", seedType: "email", artifacts, messages: [], reviews } as never);

describe("investigation summary: CONFIRMED and ATTESTED are counted apart", () => {
  it("one corroborated row and one analyst-confirmed row are one of each, not two Confirmed", () => {
    const text = summary([strong("a"), row({ id: "b", value: "b@example.invalid" })], { b: "confirmed" });
    expect(text).toContain("Confirmed: 1  Analyst-confirmed: 1");
    expect(text).not.toContain("Confirmed: 2");
  });

  it("an analyst Confirm in the reviews map counts (it was ignored before)", () => {
    const text = summary([row({ id: "b" })], { b: "confirmed" });
    expect(text).toContain("Confirmed: 0  Analyst-confirmed: 1");
  });

  it("an attestation on top of real corroboration keeps the evidence rung: CONFIRMED, not double counted", () => {
    const text = summary([strong("a")], { a: "confirmed" });
    expect(text).toContain("Confirmed: 1  Analyst-confirmed: 0");
  });

  it("an unreviewed weak row stays out of both", () => {
    const text = summary([row({ id: "c" })]);
    expect(text).toContain("Confirmed: 0  Analyst-confirmed: 0  Verify: 1");
  });
});
