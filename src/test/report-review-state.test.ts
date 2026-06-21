import { describe, it, expect } from "vitest";
import { buildReportMarkdown } from "@/lib/intel";

const artifact = (over: Partial<{ id: string; kind: string; value: string; source: string | null; confidence: number | null; created_at: string; metadata: Record<string, unknown> | null }> = {}) => ({
  id: over.id ?? "a1",
  thread_id: "t1",
  kind: over.kind ?? "email",
  value: over.value ?? "x@y.com",
  source: over.source ?? "breach_check",
  confidence: over.confidence ?? 60,
  created_at: over.created_at ?? "2026-06-01T10:00:00Z",
  updated_at: over.created_at ?? "2026-06-01T10:00:00Z",
  metadata: over.metadata ?? null,
  label: "VERIFY" as const,
  is_key: false,
  is_dismissed: false,
  notes: null,
  review_state: null,
  group: "contact" as const,
});

// The bug: analyst Verified/Rejected marks showed in Evidence but never in the
// report. buildReportMarkdown now takes `reviews` and threads them into the
// label/confidence + an "Analyst review" line.
describe("buildReportMarkdown — analyst review state reaches the report", () => {
  it("surfaces an analyst-review tally in the executive summary", () => {
    const arts = [
      artifact({ id: "v1", value: "verified@y.com" }),
      artifact({ id: "r1", value: "rejected@y.com" }),
      artifact({ id: "k1", value: "key@y.com" }),
    ];
    const md = buildReportMarkdown({
      seedValue: "x@y.com",
      seedType: "email",
      artifacts: arts,
      reviews: { v1: "confirmed", r1: "wrong", k1: "key" },
    });
    expect(md).toContain("Analyst review:");
    expect(md).toContain("2 analyst-verified"); // confirmed + key
    expect(md).toContain("1 analyst-rejected"); // wrong
  });

  it("a rejected artifact is not promoted as a strong lead", () => {
    const arts = [artifact({ id: "r1", kind: "name", value: "Wrong Person", confidence: 60 })];
    const withReject = buildReportMarkdown({
      seedValue: "x@y.com", seedType: "email", artifacts: arts, reviews: { r1: "wrong" },
    });
    const without = buildReportMarkdown({
      seedValue: "x@y.com", seedType: "email", artifacts: arts,
    });
    // Without review it's a CORRELATED/INFERRED lead; once rejected it drops out
    // of the "strongest leads" list (label forced toward FAILED).
    expect(without).not.toEqual(withReject);
    expect(withReject).toContain("1 analyst-rejected");
  });

  it("omits the analyst-review line when nothing is reviewed", () => {
    const md = buildReportMarkdown({
      seedValue: "x@y.com", seedType: "email", artifacts: [artifact()],
    });
    expect(md).not.toContain("Analyst review:");
  });
});
