import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { CaseReport } from "@/components/panel/CaseReport";
import { isNullResultValue } from "@/lib/report-hygiene";

/**
 * A username-seed production case (2026-09-23), SANITIZED: every handle, name and
 * organisation below is fictional; only the shape of the failure is real. The
 * Identity panel is gated by
 * `pickBestIdentity` (quarantine + rejection). Its sibling subject surfaces in the
 * same report were not, so the PDF said:
 *
 *   Subject Profile  Name: Jordan Vale          <- quarantined name-only breach echo
 *   Aliases          quietfalcon77, ace, jordanvael <- jordanvael analyst-REJECTED
 *   Analyst confidence 85% · HIGH                 <- from "Jordan Vale - Midvale Chamber CEO", REJECTED
 *   Hunter's Note    "Subject appears in 6 distinct breach corpora"
 *                    <- two were "no breach hits", the rest quarantined or a stranger's
 *
 * Each test drives the rendered component. The control test proves the fixture
 * trips every surface when the gates are absent, so a passing gated test is not
 * just an empty fixture passing.
 */

type Over = Partial<{ id: string; kind: string; value: string; confidence: number; metadata: Record<string, unknown> | null }>;
const art = (over: Over) => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  thread_id: "t1",
  kind: over.kind ?? "username",
  value: over.value ?? "x",
  source: "oathnet_lookup",
  confidence: over.confidence ?? 50,
  created_at: "2026-09-23T12:56:50Z",
  updated_at: "2026-09-23T12:56:50Z",
  metadata: over.metadata ?? null,
  label: "VERIFY" as const,
  is_key: false,
  is_dismissed: false,
  notes: null,
  review_state: null,
  group: "identity" as const,
});

const UNLINKED = { subject_unlinked: true, subject_unlinked_reason: "harvested from a name-only query" };

function fixture(gated: boolean) {
  const meta = (m: Record<string, unknown>) => (gated ? m : null);
  return [
    art({ id: "seed", kind: "username", value: "quietfalcon77", confidence: 50 }),
    art({ id: "rejected-handle", kind: "username", value: "jordanvael", confidence: 45 }),
    art({ id: "echo-name", kind: "name", value: "Jordan Vale", confidence: 50, metadata: meta(UNLINKED) }),
    art({ id: "ceo", kind: "name", value: "Jordan Vale - Midvale Chamber CEO", confidence: 85 }),
    art({ id: "nohit-1", kind: "breach_exposure", value: "quietfalcon77 - no breach hits", confidence: 65 }),
    art({ id: "nohit-2", kind: "breach_exposure", value: "jordan vael - no breach hits", confidence: 60 }),
    art({ id: "echo-breach", kind: "breach_exposure", value: "Breach exposure: jordan vale (oathnet_db)", confidence: 55, metadata: meta(UNLINKED) }),
  ];
}

const REVIEWS = { "rejected-handle": "dismissed", ceo: "wrong" } as const;

afterEach(cleanup);

function renderCase(gated: boolean) {
  const { container } = render(
    <CaseReport
      seedValue="quietfalcon77"
      seedType="username"
      artifacts={fixture(gated) as never}
      reviews={gated ? (REVIEWS as never) : undefined}
      messages={[]}
      reportType="full"
    />,
  );
  return container;
}

/** Text of the Subject Profile cell whose label is exactly `label`. */
function profileCell(container: HTMLElement, label: string): string | null {
  const spans = Array.from(container.querySelectorAll("span"));
  const lab = spans.find((s) => s.textContent === label);
  return lab?.parentElement?.textContent?.slice(label.length) ?? null;
}

describe("CaseReport subject surfaces honour quarantine + analyst rejection", () => {
  it("control: without quarantine flags or verdicts, every surface picks up the namesake rows", () => {
    const c = renderCase(false);
    const text = c.textContent ?? "";
    // The cell now also carries the review-state note: a single-source name is a
    // candidate, not a plain fact (trust-labels). The value itself is unchanged.
    const nameCell = profileCell(c, "Name") ?? "";
    expect(nameCell.startsWith("Jordan Vale - Midvale Chamber CEO")).toBe(true);
    expect(nameCell).toContain("needs review");
    expect(profileCell(c, "Aliases / handles")).toContain("jordanvael");
    expect(text).toMatch(/Analyst confidence85%/);
    // With the negatives excluded, only one breach row remains, so the note is
    // absent here too. That is intended: a "no breach hits" row never counts.
    expect(text).not.toContain("breach corpora");
  });

  it("a quarantined name-only echo does not headline the Subject Profile; a rejected namesake does not either", () => {
    const c = renderCase(true);
    // Only non-eligible names exist, so there is no Name field at all.
    expect(profileCell(c, "Name")).toBeNull();
  });

  it("an analyst-rejected handle is not listed as the subject's alias", () => {
    const c = renderCase(true);
    const aliases = profileCell(c, "Aliases / handles") ?? "";
    expect(aliases).toContain("quietfalcon77");
    expect(aliases).not.toContain("jordanvael");
  });

  it("'Analyst confidence' is not taken from a rejected or quarantined row", () => {
    const c = renderCase(true);
    const text = c.textContent ?? "";
    // The rejected row keeps its 85% in the evidence table (disclosure); only
    // the headline must not borrow it.
    expect(text).not.toMatch(/Analyst confidence85%/);
    expect(text).toMatch(/Analyst confidence0%/);
  });

  it("no-hit rows and quarantined rows are not counted as breach corpora the subject 'appears in'", () => {
    const extra = [
      art({ id: "real-1", kind: "breach_exposure", value: "quietfalcon77@example.com - Canva", confidence: 60 }),
      art({ id: "real-2", kind: "breach_exposure", value: "quietfalcon77@example.com - Wattpad", confidence: 60 }),
    ];
    const { container } = render(
      <CaseReport
        seedValue="quietfalcon77"
        seedType="username"
        artifacts={[...fixture(true), ...extra] as never}
        reviews={REVIEWS as never}
        messages={[]}
        reportType="full"
      />,
    );
    // 5 breach-kind rows, but only 2 put the subject in a corpus: below the
    // 3-corpus threshold, so the note must not fire.
    expect(container.textContent ?? "").not.toContain("breach corpora");
  });

  it("three real subject breach rows still produce the note (the gate narrows, it does not silence)", () => {
    const real = ["Canva", "Wattpad", "MyFitnessPal"].map((b, i) =>
      art({ id: `real-${i}`, kind: "breach_exposure", value: `quietfalcon77@example.com - ${b}`, confidence: 60 }),
    );
    const { container } = render(
      <CaseReport
        seedValue="quietfalcon77"
        seedType="username"
        artifacts={[...fixture(true), ...real] as never}
        reviews={REVIEWS as never}
        messages={[]}
        reportType="full"
      />,
    );
    expect(container.textContent ?? "").toContain("Subject appears in 3 distinct breach corpora");
  });

  it("clean twin: a rejected row does not suppress the SAME value observed cleanly by another source", () => {
    // Rejection binds to the row the analyst judged, never to the value. An
    // independent, unrejected observation of the same handle keeps its authority.
    const twin = art({ id: "clean-twin", kind: "username", value: "jordanvael", confidence: 45 });
    const { container } = render(
      <CaseReport
        seedValue="quietfalcon77"
        seedType="username"
        artifacts={[...fixture(true), twin] as never}
        reviews={REVIEWS as never}
        messages={[]}
        reportType="full"
      />,
    );
    expect(profileCell(container, "Aliases / handles")).toContain("jordanvael");
  });

  it("a legacy metadata.false_positive row (no review row) is excluded like a rejection", () => {
    const legacy = art({ id: "legacy-fp", kind: "username", value: "legacyfp", confidence: 45, metadata: { false_positive: true } });
    const { container } = render(
      <CaseReport seedValue="quietfalcon77" seedType="username" artifacts={[...fixture(true), legacy] as never}
        reviews={REVIEWS as never} messages={[]} reportType="full" />,
    );
    expect(profileCell(container, "Aliases / handles")).not.toContain("legacyfp");
  });

  it("a real hit that merely CONTAINS a zero phrase still counts toward breach corpora", () => {
    const real = [
      "quietfalcon77@example.com - Canva breach found; no records of password exposure",
      "quietfalcon77@example.com - Wattpad",
      "quietfalcon77@example.com - MyFitnessPal",
    ].map((v, i) => art({ id: `mixed-${i}`, kind: "breach_exposure", value: v, confidence: 60 }));
    const { container } = render(
      <CaseReport seedValue="quietfalcon77" seedType="username" artifacts={[...fixture(true), ...real] as never}
        reviews={REVIEWS as never} messages={[]} reportType="full" />,
    );
    expect(container.textContent ?? "").toContain("Subject appears in 3 distinct breach corpora");
  });

  it("a rejected namesake's name/phone/DOB does not assert the subject's PII triad or raise risk", () => {
    const namesake = [
      art({ id: "ns-name", kind: "name", value: "Jordan R Vale", confidence: 40 }),
      art({ id: "ns-phone", kind: "phone", value: "+15555550123", confidence: 40 }),
      art({ id: "ns-dob", kind: "dob", value: "1980-01-02", confidence: 40 }),
    ];
    const rejected = { ...REVIEWS, "ns-name": "wrong", "ns-phone": "wrong", "ns-dob": "wrong" };
    const { container } = render(
      <CaseReport seedValue="quietfalcon77" seedType="username" artifacts={[...fixture(true), ...namesake] as never}
        reviews={rejected as never} messages={[]} reportType="full" />,
    );
    const text = container.textContent ?? "";
    expect(text).not.toContain("Full PII triad");
    expect(text).toMatch(/Risk LevelLOW/);
  });
});

describe("isNullResultValue — pure null results only (mirrors edge nullResultResidue)", () => {
  it.each([
    ["quietfalcon77 - no breach hits", "breach_check", true],
    ["jordan vael - no breach hits", null, true],
    ["0 results", null, true],
    ["Canva breach found; no records of password exposure", null, false],
    ["quietfalcon77@example.com - Canva", null, false],
    ["LinkedIn exposed email and phone - 0 hits", null, false],
    ["Adobe - no hits", null, true],
    ["quietfalcon77 - no breaches found", null, true],
    ["quietfalcon77 - 0 matches (breach_check)", "breach_check", true],
  ])("%s → %s", (value, source, expected) => {
    expect(isNullResultValue(value, source)).toBe(expected);
  });
});
