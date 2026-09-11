import { act, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";

/**
 * The case snapshot, DRIVEN through the real components.
 *
 * The production defect was surfaces reading the case from different reads:
 * the header said "Interrupted · 46 tools · $0.120", the Tools panel said 48,
 * and after completion the header said "Complete · 48" while the Tools tab
 * badge stayed 46. These tests mount the real case bar, the real tab strip and
 * the real Tools tab inside ONE provider and assert what the analyst reads.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Row = Record<string, unknown>;
type Binding = { table: string; event: string; cb: (payload: unknown) => void; active: boolean };

const m = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  /** Per-table held read: while set, reads of that table wait on it. */
  gates: {} as Record<string, Promise<void> | undefined>,
  bindings: [] as { table: string; event: string; cb: (payload: unknown) => void; active: boolean }[],
}));

vi.mock("@/integrations/supabase/client", () => {
  function builder(table: string) {
    let rows = [...(m.tables[table] ?? [])];
    const q: Record<string, unknown> = {};
    const chain = () => q;
    for (const k of ["select", "order", "limit", "neq", "in", "is", "gt", "insert", "update", "upsert", "delete"]) q[k] = chain;
    q.eq = (col: string, v: unknown) => { rows = rows.filter((r) => !(col in r) || r[col] === v); return q; };
    const settle = async <T,>(v: () => T): Promise<T> => {
      if (m.gates[table]) await m.gates[table];
      return v();
    };
    q.maybeSingle = () => settle(() => ({ data: rows[0] ?? null, error: null }));
    q.single = q.maybeSingle;
    q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      settle(() => ({ data: rows, error: null, count: rows.length })).then(res, rej);
    return q;
  }
  return {
    SUPABASE_URL: "https://test.local",
    supabase: {
      from: (t: string) => builder(t),
      rpc: () => Promise.resolve({ data: [{ ok: true, total: 12, first_break: null }], error: null }),
      channel: () => {
        const mine: Binding[] = [];
        const ch: Record<string, unknown> = {};
        ch.on = (_t: string, cfg: { table: string; event?: string }, cb: (p: unknown) => void) => {
          const b = { table: cfg.table, event: cfg.event ?? "*", cb, active: true };
          mine.push(b);
          m.bindings.push(b);
          return ch;
        };
        ch.subscribe = (cb?: (s: string) => void) => { cb?.("SUBSCRIBED"); return ch; };
        ch.__mine = mine;
        return ch;
      },
      removeChannel: (ch: { __mine?: Binding[] }) => { for (const b of ch.__mine ?? []) b.active = false; return Promise.resolve("ok"); },
      auth: {
        getSession: () => Promise.resolve({ data: { session: { user: { id: "u1" } } }, error: null }),
        getUser: () => Promise.resolve({ data: { user: { id: "u1" } }, error: null }),
        onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      },
    },
  };
});

// Heavy sibling panels of the Tools tab are not under test here.
vi.mock("@/components/panel/AuditTab", () => ({ AuditTab: () => null }));
vi.mock("@/components/panel/CustodyTab", () => ({ CustodyTab: () => null }));
vi.mock("@/components/panel/ToolHealthPanel", () => ({ ToolHealthPanel: () => null }));

const { CaseSnapshotProvider } = await import("@/components/workspace/CaseSnapshotProvider");
const { WorkspaceHeader } = await import("@/components/workspace/WorkspaceHeader");
const { WorkspaceTabs } = await import("@/components/workspace/WorkspaceTabs");
const { ToolsTab } = await import("@/components/workspace/ToolsTab");
const { useCaseSnapshot } = await import("@/hooks/useCaseSnapshot");
const { buildWorkspaceTabCounts } = await import("@/lib/workspace-tab-counts");

const T = "11111111-2222-4333-8444-555555555555";

const toolRow = (i: number) => ({
  id: `t${i}`, thread_id: T, tool_name: "exa_search", outcome: i === 0 ? "failed" : "ok", ok: i !== 0,
  error_msg: i === 0 ? "provider error" : null, created_at: new Date(1_700_000_000_000 + i * 1000).toISOString(),
  duration_ms: 400, cached: false, charged_micro_usd: 1000, cost_micro_usd: 1000,
});

function threadRow(over: Row = {}): Row {
  return {
    id: T, seed_value: "analyst@example.com", seed_type: "email", status: "finished", credits_used: 0,
    cost_micro_usd: 120_000, recovered_at: null, recovery_reason: "stream_error: upstream closed",
    run_started_at: "2026-09-11T09:50:00Z", last_heartbeat_at: "2026-09-11T09:55:00Z", updated_at: "2026-09-11T09:55:00Z",
    ...over,
  };
}

/** The tab strip as ChatPage wires it: badges from the SAME snapshot. */
function Tabs() {
  const { snapshot } = useCaseSnapshot();
  const counts = buildWorkspaceTabCounts(snapshot?.items ?? [], snapshot?.tools.total ?? 0);
  return <WorkspaceTabs active="tools" onChange={() => {}} counts={counts} loading={!snapshot?.hydrated} />;
}

function mount() {
  return render(
    <MemoryRouter>
      <TooltipProvider>
        <CaseSnapshotProvider threadId={T}>
          <WorkspaceHeader threadId={T} />
          <Tabs />
          <ToolsTab threadId={T} />
        </CaseSnapshotProvider>
      </TooltipProvider>
    </MemoryRouter>,
  );
}

async function flush(times = 6) {
  for (let i = 0; i < times; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  }
}

const headerTools = () => {
  const header = screen.getByRole("region", { name: "Case summary" });
  return within(header).getByText(/^tools?$/).previousElementSibling?.textContent;
};
const badgeTools = () => screen.getByRole("tab", { name: /Tools/ }).textContent?.replace(/\D/g, "");
const panelTools = () => within(screen.getByText("Tool calls").closest("div")!.parentElement!).getByText(/^\d+$/).textContent;

beforeEach(() => {
  m.tables = {
    threads: [threadRow()],
    artifacts: Array.from({ length: 10 }, (_, i) => ({
      id: `a${i}`, thread_id: T, kind: "email", value: `v${i}@example.com`, confidence: 60, source: "exa_search",
      created_at: "2026-09-11T09:51:00Z", metadata: {},
    })),
    tool_usage_log: Array.from({ length: 46 }, (_, i) => toolRow(i)),
    evidence_log: [],
    artifact_reviews: [],
  };
  m.gates = {};
  m.bindings = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("CaseSnapshotProvider — one version on every surface", () => {
  it("shows 'Syncing case…', never a false 0, until every source has answered", async () => {
    let release!: () => void;
    m.gates.tool_usage_log = new Promise<void>((r) => { release = r; });
    mount();
    await flush();

    expect(screen.getAllByText("Syncing case…").length).toBeGreaterThan(0);
    // No authoritative-looking zero anywhere while the ledger is unread.
    expect(screen.queryByText(/^0$/)).toBeNull();
    expect(document.body.textContent ?? "").not.toMatch(/\b0 tools?\b|Tool calls\s*0/);

    await act(async () => { release(); });
    await flush();
    expect(screen.queryByText("Syncing case…")).toBeNull();
  });

  it("header tool count = Tools tab badge = Tools panel count", async () => {
    mount();
    await flush();
    expect(headerTools()).toBe("46");
    expect(badgeTools()).toBe("46");
    expect(panelTools()).toBe("46");
  });

  it("publishes a reconciliation atomically — status, tools and spend move in the same frame", async () => {
    mount();
    await flush();
    expect(screen.getByText("Interrupted")).toBeTruthy();
    expect(headerTools()).toBe("46");

    // The run finalizes server-side: two more calls, the recovery stamp cleared,
    // the final cost delta written. The tool read is HELD mid-reconcile.
    let release!: () => void;
    m.gates.tool_usage_log = new Promise<void>((r) => { release = r; });
    m.tables.tool_usage_log = Array.from({ length: 48 }, (_, i) => toolRow(i));
    m.tables.threads = [threadRow({ recovery_reason: null, cost_micro_usd: 393_000 })];
    await act(async () => {
      for (const b of m.bindings) {
        if (b.active && b.table === "threads") b.cb({ eventType: "UPDATE", new: m.tables.threads[0] });
      }
    });
    await flush();

    // While the reconcile is in flight nothing half-updates: still the old
    // version everywhere — never "Complete" beside a stale 46.
    expect(screen.getByText("Interrupted")).toBeTruthy();
    expect(screen.queryByText("Complete")).toBeNull();
    expect(headerTools()).toBe("46");
    expect(badgeTools()).toBe("46");

    await act(async () => { release(); });
    await flush(10);

    expect(screen.getByText("Complete")).toBeTruthy();
    expect(headerTools()).toBe("48");
    expect(badgeTools()).toBe("48");
    expect(panelTools()).toBe("48");
    expect(screen.getAllByText("$0.393").length).toBeGreaterThan(0);
    // …and the change is announced once, in words.
    const live = screen.getAllByRole("status").find((el) => /Case updated/.test(el.textContent ?? ""));
    expect(live?.textContent).toMatch(/Status Interrupted → Complete · Tools 46 → 48 · Spend \$0\.120 → \$0\.393/);
  });

  it("renders an analyst Stop as Stopped — not Complete", async () => {
    m.tables.threads = [threadRow({ status: "stopped", recovery_reason: null })];
    mount();
    await flush();
    expect(screen.getByText("Stopped")).toBeTruthy();
    expect(screen.queryByText("Complete")).toBeNull();
  });
});
