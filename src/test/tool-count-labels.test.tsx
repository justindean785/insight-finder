import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CaseFigures } from "@/components/workspace/WorkspaceHeader";
import { WorkspaceTabs } from "@/components/workspace/WorkspaceTabs";
import { CaseReport } from "@/components/panel/CaseReport";
import { buildCaseSnapshot, type CaseSnapshotInput, type CaseThreadRow } from "@/lib/case-snapshot";
import { buildWorkspaceTabCounts } from "@/lib/workspace-tab-counts";
import type { CaseSnapshot } from "@/hooks/useCaseSnapshot";
import type { Artifact } from "@/hooks/useThreadArtifacts";

/**
 * T01 — two different tool numbers used to share one word. The case bar's
 * "18 tools" counts tool CALLS (every recorded invocation, failed and skipped
 * included); the Report's "9 tools" counts DISTINCT tools that produced at
 * least one artifact. A case reading "18 tools" beside "9 tools" looked like a
 * contradiction. Each figure now names its population. No count changed.
 */

afterEach(cleanup);

const NOW = Date.parse("2026-10-20T10:00:00Z");

const thread: CaseThreadRow = {
  id: "t1",
  seed_value: "analyst@example.com",
  seed_type: "email",
  status: "finished",
  credits_used: 0,
  cost_micro_usd: 120_000,
  recovered_at: null,
  recovery_reason: null,
  run_started_at: "2026-10-20T09:50:00Z",
  last_heartbeat_at: "2026-10-20T09:55:00Z",
  updated_at: "2026-10-20T09:55:00Z",
};

const snapArt = (i: number): Artifact => ({
  id: `a${i}`, kind: "email", value: `v${i}@example.com`, confidence: 60, source: "exa_search",
  created_at: "2026-10-20T09:51:00Z", metadata: {},
});

type Tools = CaseSnapshotInput["tools"];
const tools = (over: Partial<Tools> = {}): Tools => ({
  events: [], persistedTotal: 18, failed: 2, degraded: 0, skipped: 3, gated: 0, ok: 13,
  loading: false, error: false, loadedAt: NOW, ...over,
});

function published(over: Partial<CaseSnapshotInput> = {}): CaseSnapshot {
  const input: CaseSnapshotInput = {
    threadId: "t1",
    accountReady: true,
    thread,
    threadLoaded: true,
    artifacts: { items: Array.from({ length: 10 }, (_, i) => snapArt(i)), loading: false, error: false },
    tools: tools(),
    authority: { verified: 0, infrastructure: 0, probable: 0, review: 0, weak: 0, quarantined: 0, conflict: 0, failed: 0 },
    integrity: { ok: true, total: 12, firstBreak: null },
    readiness: null,
    chatRunning: false,
    nowMs: NOW,
    ...over,
  };
  return { ...buildCaseSnapshot(input), version: 1, capturedAt: NOW, syncing: false, syncedAt: NOW, syncError: false, lastChange: null };
}

function figures(dense: boolean, over: Partial<CaseSnapshotInput> = {}) {
  return render(
    <TooltipProvider>
      <CaseFigures snapshot={published(over)} dense={dense} />
    </TooltipProvider>,
  );
}

describe("case bar — the tool figure counts calls and says so", () => {
  it("desktop: '18 tool calls', never a bare 'tools'", () => {
    figures(false);
    expect(screen.getByText("18")).toBeInTheDocument();
    expect(screen.getByText("tool calls")).toBeInTheDocument();
    expect(screen.queryByText(/^tools?$/)).toBeNull();
  });

  it("phone strip: the short form '18 calls'", () => {
    figures(true);
    expect(screen.getByText("calls")).toBeInTheDocument();
    expect(screen.queryByText("tool calls")).toBeNull();
  });

  it("failed and skipped calls stay in the total (existing contract, unchanged)", () => {
    figures(false, { tools: tools({ persistedTotal: 7, failed: 4, skipped: 2, ok: 1 }) });
    expect(screen.getByText("7")).toBeInTheDocument();
  });

  it("singular forms", () => {
    figures(false, { tools: tools({ persistedTotal: 1, failed: 0, skipped: 0, ok: 1 }) });
    expect(screen.getByText("tool call")).toBeInTheDocument();
    cleanup();
    figures(true, { tools: tools({ persistedTotal: 1, failed: 0, skipped: 0, ok: 1 }) });
    expect(screen.getByText("call")).toBeInTheDocument();
  });

  it("an unreadable call ledger shows '—', never a confident 0", () => {
    // Never read (an error before any successful load); the existing rule keeps
    // a previously loaded total visible through a later error.
    figures(false, { tools: tools({ persistedTotal: 0, ok: 0, failed: 0, skipped: 0, error: true, loadedAt: null }) });
    expect(screen.getByText("—")).toBeInTheDocument();
    expect(screen.queryByText(/^0$/)).toBeNull();
  });

  it("the call figure keeps its keyboard-reachable explanation", () => {
    figures(false);
    const trigger = screen.getByText("tool calls").closest("[tabindex='0']");
    expect(trigger).not.toBeNull();
  });
});

describe("Tools tab badge — screen readers hear what the number counts", () => {
  it("buildWorkspaceTabCounts names the unit", () => {
    expect(buildWorkspaceTabCounts(18, 0).tools.unit).toBe("tool calls");
    expect(buildWorkspaceTabCounts(1, 0).tools.unit).toBe("tool call");
  });

  it("the tab's accessible name carries 'tool calls'", () => {
    render(<WorkspaceTabs active="overview" onChange={() => {}} counts={buildWorkspaceTabCounts(18, 0)} />);
    const tab = screen.getByRole("tab", { name: /Tools/ });
    expect(tab).toHaveAccessibleName(/18\s*tool calls/);
  });
});

const reportArt = (id: string, source: string) => ({
  id, thread_id: "t1", kind: "email", value: `${id}@example.com`, source, confidence: 60,
  created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z", metadata: null,
  label: "VERIFY" as const, is_key: false, is_dismissed: false, notes: null, review_state: null, group: "identity" as const,
});

function report(toolCallTotal?: number) {
  // Three artifacts from two producing tools; one tool repeated.
  const artifacts = [reportArt("r1", "whois_lookup"), reportArt("r2", "whois_lookup"), reportArt("r3", "exa_search")];
  return render(
    <CaseReport seedValue="subject@example.com" seedType="email" artifacts={artifacts as never} messages={[]} reportType="full" toolCallTotal={toolCallTotal} />,
  ).container;
}

describe("Report — distinct producing tools are not tool calls", () => {
  it("labels the distinct count 'tools with artifacts' and the call count 'tool calls'", () => {
    const c = report(18);
    expect(within(c).getByText("2 tools with artifacts")).toBeInTheDocument();
    expect(within(c).getByText("18 tool calls")).toBeInTheDocument();
    expect(c.textContent).not.toMatch(/\b2 tools\b(?! with)/);
  });

  it("a tool that was called but recorded nothing is in calls, not in tools with artifacts", () => {
    // 18 calls can come from more tools than the 2 that left artifacts.
    const c = report(18);
    expect(within(c).getByText("2 tools with artifacts")).toBeInTheDocument();
  });

  it("omits the call chip when the call total is unknown, rather than printing 0", () => {
    const c = report(undefined);
    expect(c.textContent).not.toMatch(/tool calls?/);
    expect(c.textContent).not.toMatch(/\b0 tool/);
  });

  it("the coverage tile names its population", () => {
    const c = report(18);
    expect(within(c).getByText("Tools with artifacts")).toBeInTheDocument();
    expect(within(c).queryByText("Tool coverage")).toBeNull();
  });
});
