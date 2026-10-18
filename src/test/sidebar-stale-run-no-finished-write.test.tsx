import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The sidebar used to "reconcile" a silent run by writing `{status:'finished'}`
 * with no `recovery_reason`. That breaks invariant I-2 twice over:
 *
 *  - `deriveRunState` (case-snapshot.ts) reads finished + no recovery marker as
 *    COMPLETE, so a run that died mid-investigation, with no report, showed green.
 *  - server recovery (`recoverStaleActiveThreads`) only selects `status='active'`
 *    rows, so once the browser had written `finished` the server could no longer
 *    claim the thread, stamp `recovery_reason` and post the recovered report.
 *
 * The sidebar must leave the row for the server. A dead run is still shown as
 * not-running locally (dimmed), which is display only.
 *
 * Drives the real ThreadSidebar against a recording Supabase stub.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const m = vi.hoisted(() => ({
  threadRows: [] as Array<Record<string, unknown>>,
  updates: [] as Array<{ table: string; patch: unknown }>,
  // One stable object, like the real hook: a fresh user per render would re-run the load effect.
  auth: { user: { id: "user-1", email: "analyst@test.local" }, session: { access_token: "t" }, loading: false, error: null },
}));

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => m.auth }));

vi.mock("@/integrations/supabase/client", () => {
  const makeChain = (table: string) => {
    const result = () =>
      table === "threads"
        ? { data: m.threadRows, error: null, count: null }
        : { data: [], error: null, count: 0 };
    const chain: Record<string, unknown> = {};
    for (const k of ["select", "eq", "neq", "in", "gt", "lt", "order", "limit", "insert", "delete"]) {
      chain[k] = () => chain;
    }
    chain.update = (patch: unknown) => {
      m.updates.push({ table, patch });
      return chain;
    };
    chain.maybeSingle = () => Promise.resolve({ data: null, error: null });
    chain.single = () => Promise.resolve({ data: null, error: null });
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(resolve, reject);
    return chain;
  };
  const ch = { on: () => ch, subscribe: () => ch };
  return {
    supabase: {
      from: (table: string) => makeChain(table),
      rpc: () => Promise.resolve({ data: null, error: null }),
      channel: () => ch,
      removeChannel: () => Promise.resolve(),
    },
  };
});

import { ThreadSidebar } from "@/components/ThreadSidebar";

const NOW = Date.now();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

afterEach(() => {
  cleanup();
  m.threadRows = [];
  m.updates = [];
});

function renderSidebar() {
  return render(
    <MemoryRouter initialEntries={["/chat/live-thread"]}>
      <Routes>
        <Route path="/chat/:threadId" element={<ThreadSidebar collapsed={false} onToggleCollapse={() => {}} />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("ThreadSidebar leaves dead runs for server recovery", () => {
  it("does not write status 'finished' over a run whose heartbeat died", async () => {
    m.threadRows = [
      {
        id: "dead-run",
        title: "Dead run case",
        updated_at: ago(20 * 60_000),
        credits_used: 0,
        cost_micro_usd: 1000,
        status: "active",
        seed_type: "email",
        run_started_at: ago(25 * 60_000),
        last_heartbeat_at: ago(20 * 60_000),
      },
    ];
    renderSidebar();
    await screen.findByText("Dead run case");
    // Give the load effect's fire-and-forget write a chance to land if it exists.
    await new Promise((r) => setTimeout(r, 50));
    const threadWrites = m.updates.filter((u) => u.table === "threads");
    expect(threadWrites).toEqual([]);
  });

  it("still shows the dead run as not running (dimmed), display only", async () => {
    m.threadRows = [
      {
        id: "dead-run",
        title: "Dead run case",
        updated_at: ago(20 * 60_000),
        credits_used: 0,
        cost_micro_usd: 1000,
        status: "active",
        seed_type: "email",
        run_started_at: ago(25 * 60_000),
        last_heartbeat_at: ago(20 * 60_000),
      },
    ];
    renderSidebar();
    const title = await screen.findByText("Dead run case");
    await waitFor(() => expect(title.closest("[class*='opacity-55']")).not.toBeNull());
  });
});
