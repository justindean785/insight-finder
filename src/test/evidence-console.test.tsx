import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildCaseSnapshot } from "@/lib/case-snapshot";
import { CaseSnapshotContext, type CaseSnapshot } from "@/hooks/useCaseSnapshot";
import { WorkspaceTabs } from "@/components/workspace/WorkspaceTabs";
import { ViewWorkspaceTabs } from "@/components/workspace/ViewWorkspaceTabs";
import { SubTabs } from "@/components/ui/compact-controls";

// OverviewTab reads analyst decisions through the review store, which talks to
// Supabase. No decisions is the case under test.
vi.mock("@/lib/review", async (orig) => ({
  ...(await orig<typeof import("@/lib/review")>()),
  useReviewStates: () => ({ get: () => undefined }),
}));

import { OverviewTab } from "@/components/workspace/OverviewTab";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function emptyCase(): CaseSnapshot {
  const core = buildCaseSnapshot({
    threadId: "t1",
    accountReady: true,
    thread: {
      id: "t1", seed_value: "analyst@example.com", seed_type: "email", status: "finished",
      credits_used: 0, cost_micro_usd: 0, recovered_at: null, recovery_reason: null,
      run_started_at: "2026-09-11T09:50:00Z", last_heartbeat_at: "2026-09-11T09:55:00Z",
      updated_at: "2026-09-11T09:55:00Z",
    },
    threadLoaded: true,
    artifacts: { items: [], loading: false, error: false },
    tools: { events: [], persistedTotal: 3, failed: 0, degraded: 0, skipped: 0, gated: 0, ok: 3, loading: false, error: false, loadedAt: 1 },
    authority: { verified: 0, infrastructure: 0, probable: 0, review: 0, weak: 0, quarantined: 0, conflict: 0, failed: 0 },
    integrity: null,
    readiness: null,
    chatRunning: false,
    nowMs: Date.parse("2026-09-11T10:00:00Z"),
  });
  return { ...core, version: 1, capturedAt: 1, syncing: false, syncedAt: 1, syncError: false, lastChange: null };
}

describe("Overview — an empty findings list is a line, not a panel", () => {
  it("states 'none corroborated' as a status line and drops the second column", () => {
    const snapshot = emptyCase();
    expect(snapshot.hydrated).toBe(true);
    const { container } = render(
      <CaseSnapshotContext.Provider value={{ snapshot, refresh: async () => {} }}>
        <OverviewTab threadId="t1" />
      </CaseSnapshotContext.Provider>,
    );
    const line = screen.getByText("Strongest supported findings").closest(".status-line");
    expect(line).toBeTruthy();
    expect(within(line as HTMLElement).getByText("0")).toBeTruthy();
    expect(line?.textContent).toMatch(/corroborated yet/);
    // The old empty panel is gone, and nothing reserves a column for it.
    expect(screen.queryByText("No corroborated findings yet.")).toBeNull();
    expect(container.querySelector('[class*="lg:grid-cols-[minmax(0,1.15fr)"]')).toBeNull();
  });
});

describe("One tab grammar — every tab strip is a .tab-rule", () => {
  it("workspace tabs: words only, the active tab carries aria-selected, counts in the data face", () => {
    render(
      <WorkspaceTabs active="evidence" onChange={() => {}} counts={{ evidence: { value: 27 } }} />,
    );
    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(6);
    for (const t of tabs) {
      expect(t.classList.contains("tab-rule-item")).toBe(true);
      expect(t.querySelector("svg")).toBeNull();
    }
    const evidence = screen.getByRole("tab", { name: /Evidence/ });
    expect(evidence.getAttribute("aria-selected")).toBe("true");
    expect(within(evidence).getByText("27").classList.contains("tab-rule-count")).toBe(true);
  });

  it("read-only case tabs share the same strip and hide a zero count instead of printing it", () => {
    render(
      <ViewWorkspaceTabs active="report" onChange={() => {}} counts={{ evidence: { value: 0 }, tools: { value: 12 } }} />,
    );
    for (const t of screen.getAllByRole("tab")) {
      expect(t.classList.contains("tab-rule-item")).toBe(true);
      expect(t.querySelector("svg")).toBeNull();
    }
    expect(screen.getByRole("tab", { name: "Evidence" }).querySelector(".tab-rule-count")).toBeNull();
    expect(screen.getByRole("tab", { name: /Tools/ }).textContent).toContain("12");
  });

  it("sub-view switches (Report, Tools, Graph) use the compact strip and report state via aria-pressed", () => {
    const onChange = vi.fn();
    render(
      <SubTabs<"graph" | "list">
        label="Graph view"
        options={[{ key: "graph", label: "Graph" }, { key: "list", label: "List", count: 4 }]}
        active="graph"
        onChange={onChange}
      />,
    );
    const group = screen.getByRole("group", { name: "Graph view" });
    expect(group.classList.contains("tab-rule")).toBe(true);
    expect(group.classList.contains("tab-rule--sub")).toBe(true);
    expect(screen.getByRole("button", { name: "Graph" }).getAttribute("aria-pressed")).toBe("true");
    const list = screen.getByRole("button", { name: /List/ });
    expect(list.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(list);
    expect(onChange).toHaveBeenCalledWith("list");
  });
});
