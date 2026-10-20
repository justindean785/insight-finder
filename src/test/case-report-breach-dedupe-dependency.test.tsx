import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * #794 x #593: does frontend dedupe lose authority BEFORE the Breach Exposure
 * filter sees it?
 *
 * The production path is: `useThreadArtifacts` (load ordered by created_at,
 * then `dedupeArtifacts`) -> CaseSnapshotProvider `items` -> ReportTab, which
 * looks each review up by the SURVIVING row id (`review.get(a.id)`) ->
 * CaseReport. This test drives the real hook (real load + real dedupe) and feeds
 * its items to the real CaseReport with reviews keyed by artifact id, exactly as
 * `artifact_reviews.artifact_id` keys them.
 *
 * Two observations of the same breach share kind + value, so dedupe collapses
 * them: the OLDEST row's id survives, the later row's metadata is spread over
 * it, and the later row's review is never looked up.
 *
 * Identical twins still collapse that way. Rows whose AUTHORITY differs (#593:
 * source, confidence or metadata, e.g. a quarantine flag or a linkage release)
 * stay separate items, each judged under its own authority, so a clean
 * observation is no longer hidden by a quarantined copy and a release on one row
 * is not spread over another. The "WITH #593" cases replaced the cases that
 * pinned the pre-#593 over-exclusion.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Row = {
  id: string;
  kind: string;
  value: string;
  confidence: number | null;
  source: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
};

const mock = vi.hoisted(() => ({ rows: new Map<string, Row[]>() }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from() {
      let threadId = "";
      const query = {
        select: () => query,
        eq: (_column: string, value: string) => {
          threadId = value;
          return query;
        },
        order: () => query,
        // Like PostgREST for the hook's `.order("created_at", { ascending: true })`.
        limit: () =>
          Promise.resolve({
            data: [...(mock.rows.get(threadId) ?? [])].sort((x, y) => x.created_at.localeCompare(y.created_at)),
            error: null,
          }),
      };
      return query;
    },
    channel() {
      const ch = { on: () => ch, subscribe: () => ch };
      return ch;
    },
    removeChannel() {},
  },
}));

import { useThreadArtifacts } from "@/hooks/useThreadArtifacts";
import { CaseReport } from "@/components/panel/CaseReport";

const UNLINKED = { subject_unlinked: true, subject_unlinked_reason: "harvested from a name-only query" };
const DUP_VALUE = "quietfalcon77@example.com - DupCorp";

const row = (id: string, at: number, metadata: Record<string, unknown> = {}, value = DUP_VALUE, name = "DupCorp"): Row => ({
  id,
  kind: "breach_exposure",
  value,
  confidence: 60,
  source: "oathnet_lookup",
  created_at: new Date(1_760_000_000_000 + at * 1000).toISOString(),
  metadata: { breach_name: name, breach_date: "2020-01-01", exposed_fields: ["email"], ...metadata },
});
/** A clean subject breach that is not a duplicate: keeps the table rendering. */
const anchor = row("anchor", 0, {}, "quietfalcon77@example.com - Canva", "Canva");

function Harness({ threadId, reviews }: { threadId: string; reviews: Record<string, string> }) {
  const { items: artifacts } = useThreadArtifacts(threadId);
  // ReportTab: a review is read for each SURVIVING item id only.
  const byId: Record<string, string> = {};
  for (const a of artifacts) if (reviews[a.id]) byId[a.id] = reviews[a.id];
  return (
    <>
      <span data-testid="dup-items">{artifacts.filter((a) => a.value === DUP_VALUE).length}</span>
      <span data-testid="dup-ids">{artifacts.filter((a) => a.value === DUP_VALUE).map((a) => a.id).join(",")}</span>
      <CaseReport
        seedValue="quietfalcon77@example.com"
        seedType="email"
        artifacts={artifacts as never}
        reviews={byId as never}
        messages={[]}
        reportType="full"
      />
    </>
  );
}

let seq = 0;
async function renderCase(rows: Row[], reviews: Record<string, string> = {}) {
  const threadId = `dedupe-${seq++}`;
  mock.rows.set(threadId, rows);
  const view = render(<Harness threadId={threadId} reviews={reviews} />);
  await waitFor(() => expect(view.container.textContent).toContain("Canva"));
  const table = Array.from(view.container.querySelectorAll("table")).find((t) =>
    (t.querySelector("thead")?.textContent ?? "").includes("Exposed fields"),
  );
  return {
    table: table?.textContent ?? "",
    dupItems: Number(view.getByTestId("dup-items").textContent),
    survivor: view.getByTestId("dup-ids").textContent,
  };
}

afterEach(() => cleanup());

describe("Breach Exposure filter after the real load + dedupe path", () => {
  it("precondition: two observations of one breach collapse to the OLDEST row id", async () => {
    const r = await renderCase([anchor, row("newer", 2), row("older", 1)]);
    expect(r.dupItems).toBe(1);
    expect(r.survivor).toBe("older");
  });

  it("correct: a review on the surviving (oldest) row hides the breach", async () => {
    const r = await renderCase([anchor, row("older", 1), row("newer", 2)], { older: "dismissed" });
    expect(r.table).not.toContain("DupCorp");
  });

  it("correct: when every observation is quarantined the breach is hidden", async () => {
    const r = await renderCase([anchor, row("older", 1, UNLINKED), row("newer", 2, UNLINKED)]);
    expect(r.table).not.toContain("DupCorp");
  });

  it("KNOWN GAP (pre-existing, also on main; #593 keeps it for identical twins): a review on the newer duplicate is never looked up, so the breach stays", async () => {
    const r = await renderCase([anchor, row("older", 1), row("newer", 2)], { newer: "dismissed" });
    expect(r.survivor).toBe("older");
    expect(r.table).toContain("DupCorp");
  });

  it("WITH #593: a linkage release stays on its own row; the released row is shown, the older quarantined row stays separate", async () => {
    const r = await renderCase([anchor, row("older", 1, UNLINKED), row("newer", 2, { ...UNLINKED, linkage_confirmed: true })]);
    expect(r.dupItems).toBe(2);
    expect(r.table).toContain("DupCorp");
  });

  it("WITH #593: older clean + newer quarantined stay separate, so the clean observation is shown", async () => {
    const r = await renderCase([anchor, row("older", 1), row("newer", 2, UNLINKED)]);
    expect(r.dupItems).toBe(2);
    expect(r.table).toContain("DupCorp");
  });

  it("WITH #593: older quarantined + newer clean stay separate, so the clean observation is shown", async () => {
    const r = await renderCase([anchor, row("older", 1, UNLINKED), row("newer", 2)]);
    expect(r.dupItems).toBe(2);
    expect(r.table).toContain("DupCorp");
  });
});
