import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { CaseReport } from "@/components/panel/CaseReport";

/**
 * The report's "Breach Exposure" table presents each row as a breach the SUBJECT
 * appears in, with its captured values. Every sibling subject surface in
 * CaseReport (profile, aliases, analyst confidence, the breach-corpora note) is
 * gated by `isSubjectAuthorityEligible`; this table was not, so a quarantined
 * namesake's breach, an analyst-dismissed breach, and a breach derived from an
 * analyst-rejected email all rendered as the subject's.
 *
 * Fixtures are fictional. The control test proves the fixture trips the table
 * when the gates are absent, so a passing gated test is not an empty fixture.
 */

type Over = Partial<{ id: string; kind: string; value: string; confidence: number; metadata: Record<string, unknown> | null }>;
const art = (over: Over) => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  thread_id: "t1",
  kind: over.kind ?? "breach_exposure",
  value: over.value ?? "x",
  source: "oathnet_lookup",
  confidence: over.confidence ?? 60,
  created_at: "2026-10-18T09:00:00Z",
  updated_at: "2026-10-18T09:00:00Z",
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
  const g = (m: Record<string, unknown>) => (gated ? m : {});
  return [
    art({ id: "seed", kind: "email", value: "quietfalcon77@example.com", confidence: 70 }),
    art({ id: "rej-email", kind: "email", value: "other.person@example.com", confidence: 55 }),
    art({
      id: "subject-breach",
      value: "quietfalcon77@example.com - Canva",
      metadata: { breach_name: "Canva", breach_date: "2019-05-24", exposed_fields: ["email", "password"] },
    }),
    art({
      id: "quarantined-breach",
      value: "Jordan Vale - StrangerCorp",
      metadata: { breach_name: "StrangerCorp", breach_date: "2020-01-01", exposed_fields: ["email"], ...g(UNLINKED) },
    }),
    art({
      id: "dismissed-breach",
      value: "quietfalcon77@example.com - DismissedCorp",
      metadata: { breach_name: "DismissedCorp", breach_date: "2021-02-02", exposed_fields: ["email"] },
    }),
    art({
      id: "derived-breach",
      value: "other.person@example.com - DerivedCorp",
      metadata: {
        breach_name: "DerivedCorp",
        breach_date: "2022-03-03",
        exposed_fields: ["email", "password"],
        parent_selector: "other.person@example.com",
      },
    }),
  ];
}

const REVIEWS = { "dismissed-breach": "dismissed", "rej-email": "wrong" } as const;

afterEach(cleanup);

/** Text of the Breach Exposure table (the one whose header has "Exposed fields"). */
function breachTableText(gated: boolean): string {
  const { container } = render(
    <CaseReport
      seedValue="quietfalcon77@example.com"
      seedType="email"
      artifacts={fixture(gated) as never}
      reviews={gated ? (REVIEWS as never) : undefined}
      messages={[]}
      reportType="full"
    />,
  );
  const table = Array.from(container.querySelectorAll("table")).find((t) =>
    (t.querySelector("thead")?.textContent ?? "").includes("Exposed fields"),
  );
  return table?.textContent ?? "";
}

describe("CaseReport Breach Exposure table honours subject authority", () => {
  it("control: without quarantine or reviews, every breach row renders", () => {
    const text = breachTableText(false);
    for (const site of ["Canva", "StrangerCorp", "DismissedCorp", "DerivedCorp"]) {
      expect(text).toContain(site);
    }
  });

  it("a quarantined (subject_unlinked) breach row is not presented as the subject's", () => {
    expect(breachTableText(true)).not.toContain("StrangerCorp");
  });

  it("an analyst-dismissed breach row is not presented as the subject's", () => {
    expect(breachTableText(true)).not.toContain("DismissedCorp");
  });

  it("a breach row derived from an analyst-rejected selector leaves with it", () => {
    expect(breachTableText(true)).not.toContain("DerivedCorp");
  });

  it("the subject's own breach row stays", () => {
    expect(breachTableText(true)).toContain("Canva");
  });
});
