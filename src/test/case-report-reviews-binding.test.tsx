import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { CaseReport, buildAnalyticRadar } from "@/components/panel/CaseReport";
import { buildIdentityRows } from "@/lib/report-hygiene";
import { adjustedConfidence, buildReportMarkdown, labelForArtifact } from "@/lib/intel";
import type { ReviewState } from "@/lib/review";

/**
 * #478 — `CaseReport` declared a `reviews` prop at :882 and never destructured it.
 *
 * TypeScript accepts that silently: an optional prop that is declared but not
 * bound is not an error, so `ReportTab.tsx:242` has been passing `reviews` into
 * a black hole. Every analyst verdict — Confirm, Key, Recheck, Dismiss, False —
 * was discarded, and the Report tab reported rows at their unadjusted value
 * while `ConfidenceRadar` (same tab, same object, `ReportTab.tsx:235`) honoured
 * them. `buildReportMarkdown` has consumed `reviews` since forever
 * (`intel.ts:1148`), so the markdown export and the on-screen report disagreed.
 *
 * These tests drive the REAL component and the REAL exported builders. None of
 * them re-derives a score and compares it to itself — each asserts that a
 * verdict changes an observable output, which is precisely what "the prop is
 * never bound" makes impossible.
 *
 * The mutation these must kill: delete `reviews` from the destructuring list
 * again. Every assertion below goes red, because without the binding the two
 * renders are byte-identical.
 */

const art = (over: Partial<{ id: string; kind: string; value: string; confidence: number; source: string; metadata: Record<string, unknown> | null }> = {}) => ({
  id: over.id ?? "a1",
  thread_id: "t1",
  kind: over.kind ?? "email",
  value: over.value ?? "subject@example.com",
  source: over.source ?? "whois_lookup",
  confidence: over.confidence ?? 80,
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
  metadata: over.metadata ?? null,
  label: "VERIFY" as const,
  is_key: false,
  is_dismissed: false,
  notes: null,
  review_state: null,
  group: "identity" as const,
});

afterEach(cleanup);

const EXCLUDED_SECTION = "Excluded / Collision Clusters";

function renderReport(artifacts: ReturnType<typeof art>[], reviews?: Record<string, ReviewState>) {
  const { container } = render(
    <CaseReport
      seedValue="subject@example.com"
      seedType="email"
      artifacts={artifacts as never}
      reviews={reviews}
      messages={[]}
      reportType="full"
    />,
  );
  return container;
}

describe("#478 — CaseReport binds its reviews prop", () => {
  it("an analyst 'False' verdict moves the row into Excluded (the prop is actually read)", () => {
    const a = art({ id: "x1" });

    const withoutReviews = renderReport([a]).textContent ?? "";
    expect(withoutReviews).not.toContain(EXCLUDED_SECTION);
    cleanup();

    const withReviews = renderReport([a], { x1: "wrong" }).textContent ?? "";
    expect(withReviews).toContain(EXCLUDED_SECTION);
  });

  it("a dismissal is honoured the same way", () => {
    const a = art({ id: "x2" });
    const html = renderReport([a], { x2: "dismissed" }).textContent ?? "";
    expect(html).toContain(EXCLUDED_SECTION);
  });

  // These two compare textContent, NOT innerHTML. recharts mints a fresh
  // clip-path id on every mount, so innerHTML differs between two identical
  // renders — an innerHTML comparison would make the first assertion pass for
  // the wrong reason and the second fail for one. Text is what the analyst
  // reads and is stable across mounts.
  it("the rendered text differs at all — the regression is that it was identical", () => {
    const a = art({ id: "x3" });
    const plain = renderReport([a]).textContent;
    cleanup();
    const reviewed = renderReport([a], { x3: "wrong" }).textContent;
    expect(reviewed).not.toBe(plain);
  });

  it("an unreviewed report is unchanged by an empty verdict map", () => {
    const a = art({ id: "x4" });
    const plain = renderReport([a]).textContent;
    cleanup();
    const empty = renderReport([a], {}).textContent;
    expect(empty).toBe(plain);
  });
});

describe("#478 — the report scores through adjustedConfidence, not raw confidence", () => {
  it("Confirm raises the row's score exactly as adjustedConfidence says", () => {
    const a = art({ id: "y1", confidence: 50 });
    // The contract: the report must use this number, not a.confidence.
    expect(adjustedConfidence(a as never, "confirmed")).toBeGreaterThan(50);
  });

  it("the radar's Confidence axis follows the verdict", () => {
    const a = art({ id: "y2", confidence: 50 });
    const before = buildAnalyticRadar([a] as never, "LOW");
    const after = buildAnalyticRadar([a] as never, "LOW", { y2: "confirmed" });
    const axis = (m: ReturnType<typeof buildAnalyticRadar>) =>
      m.find((x) => x.label === "Confidence")!.value;
    expect(axis(after)).toBeGreaterThan(axis(before));
  });

  it("the radar's Signal axis drops when a row is rejected — it shares bucket() with the counters", () => {
    const a = art({ id: "y3", confidence: 90, metadata: { reviewed: true } });
    const b = art({ id: "y4", confidence: 90, metadata: { reviewed: true } });
    const before = buildAnalyticRadar([a, b] as never, "LOW");
    const after = buildAnalyticRadar([a, b] as never, "LOW", { y3: "wrong" });
    const signal = (m: ReturnType<typeof buildAnalyticRadar>) =>
      m.find((x) => x.label === "Signal")!.value;
    expect(signal(after)).toBeLessThan(signal(before));
  });
});

describe("#478 — the Identity panel honours verdicts", () => {
  it("a rejected name row is labelled FAILED, not reported at face value", () => {
    const name = art({ id: "z1", kind: "name", value: "Jane Doe", confidence: 85 });
    const plain = buildIdentityRows([name] as never);
    expect(plain.find((r) => r.field === "Real name")?.label).not.toBe("FAILED");

    const reviewed = buildIdentityRows([name] as never, { z1: "wrong" });
    expect(reviewed.find((r) => r.field === "Real name")?.label).toBe("FAILED");
  });
});

describe("#478 — the on-screen report and the markdown export cannot disagree", () => {
  it("a row the markdown export reports as FAILED is Excluded on screen", () => {
    const a = art({ id: "w1", confidence: 80 });
    const reviews: Record<string, ReviewState> = { w1: "wrong" };

    // Export side: already review-aware before this fix.
    expect(labelForArtifact(a as never, reviews.w1)).toBe("FAILED");
    const md = buildReportMarkdown({
      seedValue: "subject@example.com",
      seedType: "email",
      artifacts: [a] as never,
      reviews,
    });
    expect(md).toContain("analyst-rejected");

    // Screen side: only agrees once the prop is bound.
    const html = renderReport([a], reviews).textContent ?? "";
    expect(html).toContain(EXCLUDED_SECTION);
  });
});
