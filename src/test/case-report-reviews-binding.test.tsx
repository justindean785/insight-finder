import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { CaseReport, buildAnalyticRadar } from "@/components/panel/CaseReport";
import { buildIdentityRows } from "@/lib/report-hygiene";
import { adjustedConfidence, buildReportMarkdown, labelForArtifact } from "@/lib/intel";
import { effectiveConfidence } from "@/lib/display-confidence";
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

/**
 * #478 SUPERSEDED IN PART, 2026-08-31 — and only in part, so read which part.
 *
 * #478 bound the report to the REVIEW rather than to the raw column, because the
 * report's number and label disagreed with the radar on the same tab. That was
 * right about the disagreement and it fixed it by making the number follow
 * `adjustedConfidence(a, review)`.
 *
 * The display-confidence decision replaces that binding for the NUMBER only. A
 * displayed figure is now `min(stored, confidence_cap_applied)` on every surface,
 * so an analyst clicking Confirm no longer moves it — a decision is not new
 * evidence, and folding +20 into the figure is what made review verdicts useless
 * as calibration ground truth. #478's actual complaint is still satisfied, and
 * more strongly than before: the report and the radar cannot disagree, because
 * neither of them re-derives anything.
 *
 * What #478 established that STILL HOLDS, and is still asserted below:
 *   - the LABEL follows the verdict (`labelForArtifact(a, review)`),
 *   - the STATUS follows the verdict (`evidenceStatus(a, review)`),
 *   - the Signal axis and the counters follow the verdict through `bucket()`,
 *   - a rejected row may not strengthen a positive aggregate.
 *
 * Only "the figure follows the verdict" is retired.
 */
describe("#478 — the report's LABEL follows the verdict; its NUMBER follows the evidence", () => {
  it("Confirm raises the CLASSIFICATION score — which is what drives the label", () => {
    const a = art({ id: "y1", confidence: 50 });
    // Unchanged: `adjustedConfidence` is still the label ladder's input, and a
    // verdict still moves it. It is simply no longer rendered.
    expect(adjustedConfidence(a as never, "confirmed")).toBeGreaterThan(50);
  });

  it("…and does NOT raise the displayed figure", () => {
    const a = art({ id: "y1b", confidence: 50 });
    expect(effectiveConfidence(a as never)).toBe(50);
  });

  it("the radar's Confidence axis reports the EVIDENCE, so a verdict does not move it", () => {
    // The axis is an average of displayed figures, so it inherits the same rule:
    // clicking Confirm cannot raise a case's measured confidence. The verdict is
    // visible on the Signal axis and in the counters instead, which is where a
    // decision belongs.
    const a = art({ id: "y2", confidence: 50 });
    const before = buildAnalyticRadar([a] as never, "LOW");
    const after = buildAnalyticRadar([a] as never, "LOW", { y2: "confirmed" });
    const axis = (m: ReturnType<typeof buildAnalyticRadar>) =>
      m.find((x) => x.label === "Confidence")!.value;
    expect(axis(after)).toBe(axis(before));
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
    // The seed names her, so she is the subject's name until the analyst rejects
    // the row. (An unlinked name is not a Real name at all since audit A01.)
    const name = art({ id: "z1", kind: "name", value: "Jane Doe", confidence: 85 });
    const plain = buildIdentityRows([name] as never, undefined, "Jane Doe");
    expect(plain.find((r) => r.field === "Real name")?.value).toBe("Jane Doe");

    const reviewed = buildIdentityRows([name] as never, { z1: "wrong" }, "Jane Doe");
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

// Both names sit on a record that carries the seed email, so each is linked to
// the subject. `renderReport`'s seed is the same address.
const SEED_EMAIL = "subject@example.com";
const linkedNames = (badId: string, goodId: string) => [
  art({ id: `${badId}-seed`, kind: "email", value: SEED_EMAIL, confidence: 70, source: "whois_lookup", metadata: null }),
  art({ id: badId, kind: "name", value: "Rejected Name", confidence: 90, source: "whois_lookup", metadata: { email: SEED_EMAIL } }),
  art({ id: goodId, kind: "name", value: "Valid Name", confidence: 70, source: "whois_lookup", metadata: { email: SEED_EMAIL } }),
];

describe("#495 finding A — a rejected row may not WIN an identity field", () => {
  it("a rejected higher-confidence name loses to a valid lower-confidence one", () => {
    const [seedRow, bad, good] = linkedNames("n-bad", "n-good");

    // Two different names linked to the seed are not reconciled by score (audit
    // A01), so the higher one does not win while both stand.
    const unreviewed = buildIdentityRows([seedRow, bad, good] as never, undefined, SEED_EMAIL);
    expect(unreviewed.find((r) => r.field === "Real name")).toBeUndefined();

    // Rejecting one leaves a single linked name: the verdict reached the picker.
    const reviewed = buildIdentityRows([seedRow, bad, good] as never, { "n-bad": "wrong" }, SEED_EMAIL);
    expect(reviewed.find((r) => r.field === "Real name")?.value).toBe("Valid Name");
  });

  it("a dismissed email does not hold Primary email ahead of a valid one", () => {
    const bad = plain("e-bad", "email", "bad@example.com", 90);
    const good = plain("e-good", "email", "good@example.com", 60);

    const reviewed = buildIdentityRows([bad, good] as never, { "e-bad": "dismissed" });
    expect(reviewed.find((r) => r.field === "Primary email")?.value).toBe("good@example.com");
  });

  it("the Subject Profile picks a valid name over a rejected one", () => {
    const [seedRow, bad, good] = linkedNames("s-bad", "s-good");
    // "dismissed", NOT "wrong": `wrong` carries a -40 delta that demotes the row
    // by arithmetic alone, so this would pass without the selection fix. Only
    // `dismissed` (delta 0) isolates the picker defect.
    const container = renderReport([seedRow, bad, good], { "s-bad": "dismissed" });

    const labels = Array.from(container.querySelectorAll("span"));
    const nameLabel = labels.find((s) => s.textContent?.trim() === "Name");
    expect(nameLabel?.nextElementSibling?.textContent).toContain("Valid Name");
  });

  it("with no verdicts the pickers are unchanged — pre-#478 behaviour", () => {
    const bad = plain("u-bad", "name", "Higher", 90);
    const good = plain("u-good", "name", "Lower", 60);
    // The seed names "Lower", so there is a pick for an empty verdict map to leave alone.
    const withEmptyMap = buildIdentityRows([bad, good] as never, {}, "Lower").find((r) => r.field === "Real name")?.value;
    expect(withEmptyMap).toBe("Lower");
    expect(buildIdentityRows([bad, good] as never, undefined, "Lower").find((r) => r.field === "Real name")?.value).toBe(withEmptyMap);
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

  it("Confirm leaves the Confidence axis alone — the aggregate reports evidence", () => {
    // This was "Confirm still raises the axis", the control proving #495's
    // rejection-exclusion had not broken the positive path. The positive path is
    // still untouched by #495; what changed is the axis itself, which no longer
    // moves on a verdict at all (2026-08-31). The control that matters now is
    // that confirming does not move it in EITHER direction — asserted here — and
    // the rejection behaviour #495 cared about is asserted directly above.
    const a = plain("c1", "email", "c1@example.com", 50);
    const before = confAxis(buildAnalyticRadar([a] as never, "LOW"));
    const after = confAxis(buildAnalyticRadar([a] as never, "LOW", { c1: "confirmed" }));
    expect(after).toBe(before);
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

/**
 * #495 finding C — the radar's positive axes were still built from the raw
 * population.
 *
 * The repair above fixed the pickers and the average, but `buildAnalyticRadar`
 * kept deriving four axes straight from `artifacts`:
 *
 *   Identity coverage - `kinds` from every artifact
 *   Exposure          - every breach/credential/leak artifact, and when
 *                       `metadata.severity` is numeric `confOf` is bypassed
 *                       entirely, so rejection had ZERO effect
 *   Cross-source      - `artifactSourceClasses(a).size >= 2` over every artifact
 *   Coverage          - source categories gathered from every artifact
 *
 * Same root cause as A and B: reviews reached per-row scoring, but the
 * positive-metric POPULATION was never filtered. Same authority applies —
 * a dismissed/wrong row may not seed or strengthen a positive metric
 * (buildIdentityClusters, intel.ts:1865).
 *
 * DENOMINATORS ARE DELIBERATELY UNCHANGED. Cross-source and Signal still divide
 * by `artifacts.length`, so rejecting a row can only lower or hold an axis,
 * never raise it — and the rejected row stays counted as a finding that exists.
 * Signal already excluded rejected rows through `bucket()`; it is untouched here
 * and pinned below.
 */

const axisOf = (m: ReturnType<typeof buildAnalyticRadar>, label: string) =>
  m.find((x) => x.label === label)!.value;

const baseArt = () => plain("base", "email", "base@example.com", 50);

describe("#495 finding C — a rejected row may not strengthen a radar axis", () => {
  it("a rejected identity row does not raise Identity coverage", () => {
    const name = plain("c-name", "name", "Rejected Person", 80);
    const without = buildAnalyticRadar([baseArt()] as never, "LOW");
    const withRejected = buildAnalyticRadar([baseArt(), name] as never, "LOW", { "c-name": "wrong" });
    expect(axisOf(withRejected, "Identity coverage")).toBeLessThanOrEqual(
      axisOf(without, "Identity coverage"),
    );
  });

  it("a rejected breach_exposure with numeric severity does not raise Exposure", () => {
    // severity bypasses confOf entirely, so rejection had literally no effect.
    const exp = art({
      id: "c-exp",
      kind: "breach_exposure",
      value: "leak@example.com",
      confidence: 70,
      source: "breach_check",
      metadata: { severity: 90 },
    });
    const without = buildAnalyticRadar([baseArt()] as never, "LOW");
    const withRejected = buildAnalyticRadar([baseArt(), exp] as never, "LOW", { "c-exp": "dismissed" });
    expect(axisOf(withRejected, "Exposure")).toBeLessThanOrEqual(axisOf(without, "Exposure"));
  });

  it("a rejected multi-class row does not raise Cross-source", () => {
    const multi = art({
      id: "c-multi",
      kind: "email",
      value: "multi@example.com",
      confidence: 60,
      source: "breach_check",
      metadata: { source_category: ["breach", "news"] },
    });
    const without = buildAnalyticRadar([baseArt()] as never, "LOW");
    const withRejected = buildAnalyticRadar([baseArt(), multi] as never, "LOW", { "c-multi": "wrong" });
    expect(axisOf(withRejected, "Cross-source")).toBeLessThanOrEqual(axisOf(without, "Cross-source"));
  });

  it("a rejected row introducing a new source category does not raise Coverage", () => {
    const court = art({
      id: "c-court",
      kind: "legal_record",
      value: "Case 123",
      confidence: 60,
      source: "court_record_search",
      metadata: { source_category: ["court_record"] },
    });
    const without = buildAnalyticRadar([baseArt()] as never, "LOW");
    const withRejected = buildAnalyticRadar([baseArt(), court] as never, "LOW", { "c-court": "dismissed" });
    expect(axisOf(withRejected, "Coverage")).toBeLessThanOrEqual(axisOf(without, "Coverage"));
  });

  it("Confirm does NOT filter a row out of the positive axes", () => {
    const multi = art({
      id: "c-ok",
      kind: "email",
      value: "ok@example.com",
      confidence: 60,
      source: "breach_check",
      metadata: { source_category: ["breach", "news"] },
    });
    const plainRun = buildAnalyticRadar([baseArt(), multi] as never, "LOW");
    const confirmedRun = buildAnalyticRadar([baseArt(), multi] as never, "LOW", { "c-ok": "confirmed" });
    expect(axisOf(confirmedRun, "Cross-source")).toBe(axisOf(plainRun, "Cross-source"));
    expect(axisOf(confirmedRun, "Coverage")).toBe(axisOf(plainRun, "Coverage"));
  });

  it("the Signal denominator still counts a rejected row — disclosure preserved", () => {
    // bucket() already excludes rejected rows from the numerator. The row must
    // still count as a finding that exists, so Signal goes DOWN, not sideways.
    const good = art({ id: "c-g", kind: "email", value: "g@example.com", confidence: 90, metadata: { reviewed: true } });
    const bad = art({ id: "c-b", kind: "email", value: "b@example.com", confidence: 90, metadata: { reviewed: true } });
    const before = axisOf(buildAnalyticRadar([good, bad] as never, "LOW"), "Signal");
    const after = axisOf(buildAnalyticRadar([good, bad] as never, "LOW", { "c-b": "wrong" }), "Signal");
    expect(after).toBeLessThan(before);
  });

  it("no verdict map and an empty verdict map produce identical axes", () => {
    const arts = [
      baseArt(),
      art({ id: "c-x", kind: "breach_exposure", value: "x@example.com", confidence: 70, metadata: { severity: 40, source_category: ["breach", "news"] } }),
    ];
    expect(buildAnalyticRadar(arts as never, "LOW", {})).toEqual(buildAnalyticRadar(arts as never, "LOW"));
  });
});
