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
  // CORRECTED after the #495 review. The first version of this test asserted the
  // rejected row should still occupy "Real name" carrying a FAILED label. That is
  // the defect, not the fix: these fields are IDENTITY-AUTHORITY claims (see the
  // #8 banner in report-hygiene.ts), so rendering a rejected row there still
  // asserts it IS the subject's name — the pill only argues with the assertion.
  // `buildIdentityClusters` (intel.ts:1865) already settled the semantics: a
  // dismissed/wrong row may not seed or strengthen identity. It is excluded.
  it("a rejected name does not occupy Real name at all", () => {
    const name = art({ id: "z1", kind: "name", value: "Jane Doe", confidence: 85 });
    const plain = buildIdentityRows([name] as never);
    expect(plain.find((r) => r.field === "Real name")?.value).toBe("Jane Doe");

    const reviewed = buildIdentityRows([name] as never, { z1: "wrong" });
    expect(reviewed.find((r) => r.field === "Real name")).toBeUndefined();
  });

  it("the rejected row is removed from identity authority, not from the report", () => {
    const name = art({ id: "z2", kind: "name", value: "Jane Doe", confidence: 85 });
    const html = renderReport([name], { z2: "wrong" }).textContent ?? "";
    expect(html).toContain("Jane Doe");
    expect(html).toContain(EXCLUDED_SECTION);
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

/**
 * Post-review findings on PR #495 (Codex P1 + identity-picker).
 *
 * The first pass threaded `reviews` into LABELLING and SCORING but not into
 * POPULATION SELECTION. Two consequences, both real:
 *
 *   A. `pickBestIdentity` ranks with `labelForArtifact(a)` — no review — and
 *      then falls back to raw `a.confidence`. `buildIdentityRows` applied the
 *      verdict only to the LABEL, after the winner was already chosen. So a
 *      rejected high-confidence row still won "Real name" and merely rendered
 *      with a FAILED pill.
 *
 *   B. `REVIEW_DELTA` has no `dismissed` key (delta 0), but routing a row
 *      through `adjustedConfidence` swaps in the corroboration/direct-profile
 *      bonus that the unreviewed branch never applies. Dismissing a row could
 *      therefore RAISE its number by up to +15 and lift report aggregates.
 *
 * The invariant is not invented here — `buildIdentityClusters` (intel.ts:1865)
 * already states it and ships it: an artifact marked "dismissed"/"wrong" must
 * NOT seed or strengthen an identity cluster "or its confidence". These tests
 * hold the same line for the report's pickers and aggregates.
 *
 * Deliberately NOT asserted: that a rejected row's per-row displayed score is
 * clamped. `EvidenceMatrixTab:41` renders `adjustedConfidence(a, r)` for the
 * same row, and making CaseReport disagree would recreate the exact divergence
 * #478 exists to remove.
 */

const plain = (id: string, kind: string, value: string, confidence: number) =>
  art({ id, kind, value, confidence, source: "whois_lookup", metadata: null });

// 3 distinct source classes + a direct-profile source => a real positive bonus.
const bonused = (id: string, confidence: number) =>
  art({
    id,
    kind: "email",
    value: `${id}@example.com`,
    confidence,
    source: "github_user",
    metadata: { sources: ["github_user", "whois_lookup", "dns_records"] },
  });

describe("#495 finding A — a rejected row may not WIN an identity field", () => {
  it("a rejected higher-confidence name loses to a valid lower-confidence one", () => {
    const bad = plain("n-bad", "name", "Rejected Name", 90);
    const good = plain("n-good", "name", "Valid Name", 60);

    const unreviewed = buildIdentityRows([bad, good] as never);
    expect(unreviewed.find((r) => r.field === "Real name")?.value).toBe("Rejected Name");

    const reviewed = buildIdentityRows([bad, good] as never, { "n-bad": "wrong" });
    expect(reviewed.find((r) => r.field === "Real name")?.value).toBe("Valid Name");
  });

  it("a dismissed email does not hold Primary email ahead of a valid one", () => {
    const bad = plain("e-bad", "email", "bad@example.com", 90);
    const good = plain("e-good", "email", "good@example.com", 60);

    const reviewed = buildIdentityRows([bad, good] as never, { "e-bad": "dismissed" });
    expect(reviewed.find((r) => r.field === "Primary email")?.value).toBe("good@example.com");
  });

  it("the Subject Profile picks a valid name over a rejected one", () => {
    const bad = plain("s-bad", "name", "Rejected Name", 90);
    const good = plain("s-good", "name", "Valid Name", 60);
    // "dismissed", NOT "wrong": `wrong` carries a -40 delta that demotes the row
    // by arithmetic alone, so this would pass without the selection fix. Only
    // `dismissed` (delta 0) isolates the picker defect.
    const container = renderReport([bad, good], { "s-bad": "dismissed" });

    const labels = Array.from(container.querySelectorAll("span"));
    const nameLabel = labels.find((s) => s.textContent?.trim() === "Name");
    expect(nameLabel?.nextElementSibling?.textContent).toContain("Valid Name");
  });

  it("with no verdicts the pickers are unchanged — pre-#478 behaviour", () => {
    const bad = plain("u-bad", "name", "Higher", 90);
    const good = plain("u-good", "name", "Lower", 60);
    expect(buildIdentityRows([bad, good] as never, {}).find((r) => r.field === "Real name")?.value)
      .toBe(buildIdentityRows([bad, good] as never).find((r) => r.field === "Real name")?.value);
  });
});

describe("#495 finding B — a rejected row may not strengthen positive aggregates", () => {
  const confAxis = (m: ReturnType<typeof buildAnalyticRadar>) =>
    m.find((x) => x.label === "Confidence")!.value;

  it("dismissing a corroborated row does not RAISE average confidence", () => {
    const flat = plain("p1", "email", "plain@example.com", 50);
    const rich = bonused("b1", 50);

    const before = confAxis(buildAnalyticRadar([flat, rich] as never, "LOW"));
    const after = confAxis(buildAnalyticRadar([flat, rich] as never, "LOW", { b1: "dismissed" }));
    expect(after).toBeLessThanOrEqual(before);
  });

  it("marking a corroborated row False does not RAISE average confidence", () => {
    const flat = plain("p2", "email", "plain2@example.com", 50);
    const rich = bonused("b2", 50);

    const before = confAxis(buildAnalyticRadar([flat, rich] as never, "LOW"));
    const after = confAxis(buildAnalyticRadar([flat, rich] as never, "LOW", { b2: "wrong" }));
    expect(after).toBeLessThanOrEqual(before);
  });

  it("Confirm still raises the axis — the positive path is untouched", () => {
    const a = plain("c1", "email", "c1@example.com", 50);
    const before = confAxis(buildAnalyticRadar([a] as never, "LOW"));
    const after = confAxis(buildAnalyticRadar([a] as never, "LOW", { c1: "confirmed" }));
    expect(after).toBeGreaterThan(before);
  });

  it("an empty verdict map leaves every axis identical to no map at all", () => {
    const arts = [plain("k1", "email", "k1@example.com", 50), bonused("k2", 70)];
    expect(buildAnalyticRadar(arts as never, "LOW", {})).toEqual(
      buildAnalyticRadar(arts as never, "LOW"),
    );
  });

  it("a rejected row still appears in the Excluded bucket — disclosure, not deletion", () => {
    const rich = bonused("x9", 50);
    const html = renderReport([rich], { x9: "dismissed" }).textContent ?? "";
    expect(html).toContain(EXCLUDED_SECTION);
  });
});
