import { describe, it, expect } from "vitest";
import { countVerifiedByAnalyst, tallyAuthority, verifiedHint, verifiedLabel } from "@/lib/authority";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { ReviewState } from "@/lib/review";

const art = (id: string, over: Partial<Artifact> = {}): Artifact => ({
  id,
  thread_id: "t",
  kind: "social_profile",
  value: `https://example.com/${id}`,
  confidence: 30,
  source: "username_sweep",
  created_at: "2026-10-15T12:00:00Z",
  metadata: { source_category: ["username_sweep"] },
  ...over,
} as Artifact);

describe("countVerifiedByAnalyst", () => {
  it("dizosint shape: every verified row is an analyst confirmation", () => {
    const rows = Array.from({ length: 10 }, (_, i) => art(`a${i}`));
    const review = (_id: string): ReviewState => "confirmed";
    expect(tallyAuthority(rows, review).verified).toBe(10);
    expect(countVerifiedByAnalyst(rows, review)).toBe(10);
  });

  it("unconfirmed rows never count, and a confirmed but quarantined row is not verified", () => {
    const rows = [art("x"), art("q", { metadata: { subject_unlinked: true, source_category: ["breach"] } })];
    const review = (id: string): ReviewState => (id === "q" ? "confirmed" : "new");
    expect(countVerifiedByAnalyst(rows, review)).toBe(0);
  });

  it("a persisted metadata.reviewed counts as the analyst's verdict", () => {
    const rows = [art("p", { metadata: { reviewed: true, source_category: ["username_sweep"] } })];
    expect(countVerifiedByAnalyst(rows, () => "new")).toBe(tallyAuthority(rows, () => "new").verified);
  });
});

describe("verified label and hint", () => {
  it("says when the whole count is analyst clicks", () => {
    expect(verifiedLabel(10, 10)).toBe("verified (analyst-confirmed)");
    expect(verifiedLabel(10, 4)).toBe("verified (4 analyst-confirmed)");
    expect(verifiedLabel(3, 0)).toBe("verified");
    expect(verifiedLabel(10, 10, true)).toBe("confirmed");
  });
  it("the hint splits evidence from analyst decisions", () => {
    expect(verifiedHint(10, 10)).toContain("0 corroborated");
    expect(verifiedHint(10, 10)).toContain("10 confirmed by the analyst");
  });
});
