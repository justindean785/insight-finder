import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { CaseReport } from "@/components/panel/CaseReport";

/**
 * The Report tab's `bucket()` (CaseReport.tsx) derived its CONFIRMED/PROBABLE/
 * LEAD bucketing straight from `evidenceStatus`, which — by its own module's
 * documentation — "consults none of the collision flags." So a `possible_collision`
 * row that also clears the ordinary corroboration bar (2+ source classes,
 * confidence >= 80) read "verified" here and landed in "Confirmed Findings",
 * while the Evidence board (`src/lib/authority.ts`'s `authorityFor`) already
 * demotes the IDENTICAL row to quarantined via `isClusterIneligible`.
 *
 * Same defect shape as #448 ("A cluster/report/graph surface must not grant
 * authority to a row the engine has flagged as unlinked"), one layer up, at a
 * call site #448 never reached — measured on the harness fixture
 * (`src/dev/supabase-mock.ts`'s `a12b`: a second, unrelated "James Harker"
 * sharing only a name, explicitly flagged `possible_collision`, which still
 * rendered in the Report tab's Confirmed Findings table with its own caveat
 * text sitting right there in the "confirmed" section).
 *
 * The mutation these must kill: delete the `isClusterIneligible(a)` check from
 * `bucket()`. Both assertions below go red, because the row then clears
 * `evidenceStatus` and returns to the confirmed bucket.
 */

const collisionArtifact = (over: Partial<{ metadata: Record<string, unknown> }> = {}) => ({
  id: "collision-1",
  thread_id: "t1",
  kind: "email",
  value: "j.harker@harker-legal.example",
  source: "hunter_verify",
  confidence: 88,
  created_at: "2026-08-01T00:00:00Z",
  updated_at: "2026-08-01T00:00:00Z",
  metadata: over.metadata ?? {
    sources: ["hunter_verify", "exa_search"],
    corroborations: 2,
    source_class: "provider",
    possible_collision: true,
    reason_not_confirmed:
      "a second James Harker — attorney, Sacramento — matches the queried name but nothing else in the case",
  },
  label: "VERIFY" as const,
  is_key: false,
  is_dismissed: false,
  notes: null,
  review_state: null,
  group: "identity" as const,
});

afterEach(cleanup);

const CONFIRMED_EMPTY = "No findings meet the confirmation threshold (official + independent corroboration).";

function renderReport(artifacts: ReturnType<typeof collisionArtifact>[]) {
  const { container } = render(
    <CaseReport
      seedValue="james harker"
      seedType="name"
      artifacts={artifacts as never}
      messages={[]}
      reportType="full"
    />,
  );
  return container;
}

describe("CaseReport bucket() honours isClusterIneligible (same-name-collision authority boundary)", () => {
  it("a possible_collision row that would otherwise clear the corroboration bar does NOT land in Confirmed Findings", () => {
    const html = renderReport([collisionArtifact()]).textContent ?? "";
    expect(html).toContain(CONFIRMED_EMPTY);
    // Disclosure, not deletion — the row and its caveat still appear somewhere
    // in the report (the exact section is not this test's concern; only that
    // it must not be counted as confirmed evidence).
    expect(html).toContain("j.harker@harker-legal.example");
  });

  it("control: the identical row WITHOUT the collision flag DOES clear the bar (proves the fixture is otherwise confirmable)", () => {
    const html = renderReport([
      collisionArtifact({
        metadata: { sources: ["hunter_verify", "exa_search"], corroborations: 2, source_class: "provider" },
      }),
    ]).textContent ?? "";
    expect(html).not.toContain(CONFIRMED_EMPTY);
    expect(html).toContain("j.harker@harker-legal.example");
  });

  it("the Confirmed KPI count excludes the collision row (renders the dedicated '0 confirmed' explanation)", () => {
    // CaseReport renders a specific "0 confirmed is by design, not an empty
    // case" explanation only when buckets.confirmed.length === 0 with
    // artifacts present — the most direct signal that the KPI itself is 0,
    // without re-deriving the count by hand.
    const html = renderReport([collisionArtifact()]).textContent ?? "";
    expect(html).toContain("0 confirmed");
  });
});
