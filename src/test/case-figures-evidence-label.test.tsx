import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CaseFigures } from "@/components/workspace/WorkspaceHeader";
import { buildCaseSnapshot, type CaseSnapshotInput, type CaseThreadRow } from "@/lib/case-snapshot";
import type { CaseSnapshot } from "@/hooks/useCaseSnapshot";
import type { Artifact } from "@/hooks/useThreadArtifacts";

/**
 * The case bar's first figure counts chain-of-custody entries across every run
 * of the case, not the artifacts the Evidence tab lists. It used to render as a
 * bare "64 evidence" with that fact only in a tooltip (2026-10-19 handoff, trust
 * labels sub-item 4). The visible word now says what is counted, at both widths.
 */

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
    artifacts: { items: Array.from({ length: 53 }, (_, i) => art(i)), loading: false, error: false },
    tools: { events: [], persistedTotal: 3, failed: 0, degraded: 0, skipped: 0, gated: 0, ok: 3, loading: false, error: false, loadedAt: NOW },
    authority: { verified: 0, infrastructure: 0, probable: 0, review: 0, weak: 0, quarantined: 0, conflict: 0, failed: 0 },
    integrity: { ok: true, total: 64, firstBreak: null },
    readiness: null,
    chatRunning: false,
    nowMs: NOW,
    ...over,
  };
}

function published(over: Partial<CaseSnapshotInput> = {}): CaseSnapshot {
  return { ...buildCaseSnapshot(input(over)), version: 1, capturedAt: NOW, syncing: false, syncedAt: NOW, syncError: false, lastChange: null };
}

function mount(dense: boolean, over: Partial<CaseSnapshotInput> = {}) {
  return render(
    <TooltipProvider>
      <CaseFigures snapshot={published(over)} dense={dense} />
    </TooltipProvider>,
  );
}

describe("CaseFigures — the evidence figure says what it counts", () => {
  it("desktop: '64 evidence logged', never a bare 'evidence'", () => {
    mount(false);
    expect(screen.getByText("64")).toBeInTheDocument();
    expect(screen.getByText("evidence logged")).toBeInTheDocument();
    expect(screen.queryByText("evidence")).toBeNull();
  });

  it("phone strip: the short form '64 logged'", () => {
    mount(true);
    expect(screen.getByText("64")).toBeInTheDocument();
    expect(screen.getByText("logged")).toBeInTheDocument();
    expect(screen.queryByText("evidence logged")).toBeNull();
  });

  it("with no chain total it counts artifacts and says plain 'evidence'", () => {
    mount(false, { integrity: null });
    expect(screen.getByText("53")).toBeInTheDocument();
    expect(screen.getByText("evidence")).toBeInTheDocument();
  });

  it("missing-custody shape keeps its self-describing text and no extra label", () => {
    mount(false, { integrity: { ok: true, total: 2, firstBreak: null } });
    expect(screen.getByText("53 recorded · 2 chain-verified")).toBeInTheDocument();
    expect(screen.queryByText(/logged/)).toBeNull();
  });
});
