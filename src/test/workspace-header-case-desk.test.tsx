import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { buildCaseSnapshot, type CaseSnapshotInput, type CaseThreadRow } from "@/lib/case-snapshot";
import type { CaseSnapshot } from "@/hooks/useCaseSnapshot";
import type { Artifact } from "@/hooks/useThreadArtifacts";

/**
 * R1b of the Case-desk revamp (JD's prototype, 2026-11-02): the header is a
 * crumb line, an assessment line, a 32px subject with "<Kind> seed · selector",
 * labelled stats on the right (Last assessment / Source records / Spend), and
 * a bottom status strip that carries custody. Everything the e2e suite reads
 * in the "Case summary" region must survive: the run word, the sync stamp,
 * Refresh and the case line's "N tool calls".
 */

const NOW = Date.parse("2026-10-20T10:00:00Z");

const thread: CaseThreadRow = {
  id: "t1",
  seed_value: "analyst@example.com",
  seed_type: "email",
  status: "finished",
  credits_used: 0,
  cost_micro_usd: 340_000,
  recovered_at: null,
  recovery_reason: null,
  run_started_at: "2026-10-20T09:50:00Z",
  last_heartbeat_at: "2026-10-20T09:55:00Z",
  updated_at: "2026-10-20T09:55:00Z",
};

const art = (i: number): Artifact => ({
  id: `a${i}`, kind: "email", value: `v${i}@example.com`, confidence: 60, source: "exa_search",
  created_at: "2026-10-20T09:51:00Z", metadata: {},
});

function input(over: Partial<CaseSnapshotInput> = {}): CaseSnapshotInput {
  return {
    threadId: "t1",
    accountReady: true,
    thread,
    threadLoaded: true,
    artifacts: { items: Array.from({ length: 23 }, (_, i) => art(i)), loading: false, error: false },
    tools: { events: [], persistedTotal: 18, failed: 0, degraded: 0, skipped: 0, gated: 0, ok: 18, loading: false, error: false, loadedAt: NOW },
    authority: { verified: 2, infrastructure: 0, probable: 0, review: 0, weak: 0, quarantined: 9, conflict: 2, failed: 0 },
    integrity: { ok: true, total: 55, firstBreak: null },
    readiness: null,
    chatRunning: false,
    nowMs: NOW,
    ...over,
  };
}

let current: CaseSnapshot | null = null;

function published(over: Partial<CaseSnapshotInput> = {}): CaseSnapshot {
  return { ...buildCaseSnapshot(input(over)), version: 1, capturedAt: NOW, syncing: false, syncedAt: NOW, syncError: false, lastChange: null };
}

vi.mock("@/hooks/useCaseSnapshot", () => ({
  useCaseSnapshot: () => ({ snapshot: current, refresh: vi.fn(), reconciling: false }),
  useOptionalCaseSnapshot: () => ({ snapshot: current, refresh: vi.fn(), reconciling: false }),
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "u1" } }) }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: () => ({ insert: () => ({ select: () => ({ single: async () => ({ data: null, error: null }) }) }) }) } }));

const { WorkspaceHeader } = await import("@/components/workspace/WorkspaceHeader");
const { WorkspaceStatusStrip } = await import("@/components/workspace/WorkspaceStatusStrip");

function mount(snapshot: CaseSnapshot | null) {
  current = snapshot;
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <WorkspaceHeader threadId="t1" />
        <WorkspaceStatusStrip />
      </TooltipProvider>
    </MemoryRouter>,
  );
}

const header = () => screen.getByRole("region", { name: "Case summary" });

describe("WorkspaceHeader — Case-desk layout (R1b)", () => {
  it("crumb, assessment line, subject, seed line and the three labelled stats", () => {
    mount(published({ thread: { ...thread, title: "Alex Morgan" } as CaseThreadRow }));
    const h = header();
    const crumb = within(h).getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumb).getByRole("link", { name: "Insight Finder" })).toHaveAttribute("href", "/");
    expect(within(crumb).getByText("Alex Morgan")).toBeTruthy();

    // The assessment line: the run word (what e2e reads) plus the date the case changed.
    const word = within(h).getByText("Complete", { exact: true });
    expect(word.getAttribute("data-run-state")).toBe("completed");
    expect(within(h).getByText(/October 20, 2026/)).toBeTruthy();

    expect(within(h).getByRole("heading", { level: 1 }).textContent).toBe("Alex Morgan");
    expect(within(h).getByText("Email seed")).toBeTruthy();

    // Stats, labelled. Source records is the deduped artifact population; the
    // case line still counts custody entries, so both numbers are present and named.
    const stats = within(h).getByLabelText("Case stats");
    expect(within(stats).getByText("Last assessment")).toBeTruthy();
    expect(within(stats).getByText("Source records").nextElementSibling?.textContent).toBe("23");
    expect(within(stats).getByText("Spend").nextElementSibling?.textContent).toBe("$0.340");
    // "N tool calls" stays on the case line, exactly once.
    expect(within(h).getByText(/^(tool )?calls?$/).previousElementSibling?.textContent).toBe("18");
    expect(within(h).getByText("evidence logged").previousElementSibling?.textContent).toBe("55");
  });

  it("before hydration: skeletons, no 0 and no fabricated date", () => {
    mount({ ...published(), hydrated: false } as CaseSnapshot);
    const h = header();
    expect(within(h).getByLabelText("Case stats loading")).toBeTruthy();
    expect(h.textContent ?? "").not.toMatch(/\b0\b|Source records|October/);
    // The assessment line and the sync stamp both say so.
    expect(within(h).getAllByText("Syncing case…").length).toBeGreaterThan(0);
  });

  it("an interrupted run keeps its word on the assessment line", () => {
    mount(published({ thread: { ...thread, recovery_reason: "stream_error: upstream closed" } }));
    expect(within(header()).getByText("Interrupted", { exact: true }).getAttribute("data-run-state")).toBe("interrupted");
  });
});

describe("WorkspaceStatusStrip — custody with its basis", () => {
  it("a valid chain says what it measured", () => {
    mount(published());
    const strip = screen.getByLabelText("Case status strip");
    expect(within(strip).getByLabelText("Hash chain valid, 55/55 evidence-log entries chained")).toBeTruthy();
    expect(strip.textContent).toContain("AI inference labelled");
  });

  it("a break names the entry and never reads as valid", () => {
    mount(published({ integrity: { ok: false, total: 55, firstBreak: 40 } }));
    const strip = screen.getByLabelText("Case status strip");
    expect(within(strip).getByLabelText("Hash chain broken at entry 40, 39/55 evidence-log entries chained")).toBeTruthy();
    expect(within(strip).queryByLabelText(/Hash chain valid/)).toBeNull();
  });

  it("a check that did not run is 'not checked', not a broken chain", () => {
    mount(published({ integrity: null }));
    const strip = screen.getByLabelText("Case status strip");
    expect(strip.textContent).toContain("Custody not checked");
    expect(within(strip).queryByLabelText(/Hash chain/)).toBeNull();
  });
});
