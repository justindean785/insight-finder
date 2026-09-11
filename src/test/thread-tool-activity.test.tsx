import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  toolActivityStoreCount,
  useThreadToolActivity,
  type ThreadToolActivity,
} from "@/hooks/useThreadToolActivity";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type TestRow = {
  id: string;
  tool_name: string;
  outcome: string | null;
  ok: boolean | null;
  error_msg: string | null;
  created_at: string;
};

type Binding = {
  table: string;
  callback: (payload: unknown) => void;
};

type TestChannel = {
  active: boolean;
  bindings: Binding[];
  statusCallback?: (status: string) => void;
  on: (event: string, config: { table: string }, callback: (payload: unknown) => void) => TestChannel;
  subscribe: (callback?: (status: string) => void) => TestChannel;
};

const mock = vi.hoisted(() => ({
  rowsByThread: new Map<string, TestRow[]>(),
  pendingByThread: new Map<string, Promise<{ data: TestRow[]; error: null }>>(),
  channels: [] as TestChannel[],
  queriedTables: [] as string[],
}));

const mountedRoots: Root[] = [];

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from(table: string) {
      mock.queriedTables.push(table);
      let threadId = "";
      const query = {
        select: () => query,
        eq: (_column: string, value: string) => {
          threadId = value;
          return query;
        },
        order: () => mock.pendingByThread.get(threadId)
          ?? Promise.resolve({ data: mock.rowsByThread.get(threadId) ?? [], error: null }),
      };
      return query;
    },
    channel() {
      const channel: TestChannel = {
        active: true,
        bindings: [],
        on: (_event, config, callback) => {
          channel.bindings.push({ table: config.table, callback });
          return channel;
        },
        subscribe: (callback) => {
          channel.statusCallback = callback;
          callback?.("SUBSCRIBED");
          return channel;
        },
      };
      mock.channels.push(channel);
      return channel;
    },
    removeChannel(channel: TestChannel) {
      channel.active = false;
    },
  },
}));

function rows(count: number, outcome = "ok"): TestRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `row-${index}`,
    tool_name: `tool_${index % 3}`,
    outcome,
    ok: outcome === "ok",
    error_msg: outcome === "failed" ? "provider error" : null,
    created_at: new Date(1_700_000_000_000 + index).toISOString(),
  }));
}

/**
 * Build an explicit mix of persisted outcomes. Mirrors a real thread where the
 * durable log holds several distinct outcome buckets at once, so we can assert
 * how the Activity feed collapses them (see the classification-parity test).
 */
function mixedRows(counts: { ok?: number; empty?: number; failed?: number; skipped?: number }): TestRow[] {
  const out: TestRow[] = [];
  let index = 0;
  const push = (outcome: string, n: number) => {
    for (let i = 0; i < n; i++, index++) {
      out.push({
        id: `row-${index}`,
        tool_name: `tool_${index % 3}`,
        outcome,
        ok: outcome === "ok",
        error_msg: outcome === "failed" ? "provider error" : outcome === "skipped" ? "missing_key" : null,
        created_at: new Date(1_700_000_000_000 + index).toISOString(),
      });
    }
  };
  push("ok", counts.ok ?? 0);
  push("empty", counts.empty ?? 0);
  push("failed", counts.failed ?? 0);
  push("skipped", counts.skipped ?? 0);
  return out;
}

async function emit(table: string, payload: unknown) {
  await act(async () => {
    for (const channel of mock.channels) {
      if (!channel.active) continue;
      for (const binding of channel.bindings) {
        if (binding.table === table) binding.callback(payload);
      }
    }
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function renderActivityHook(threadId: string, accountId: string) {
  const container = document.createElement("div");
  const root = createRoot(container);
  const snapshot: { current: ThreadToolActivity | null } = { current: null };

  function HookHarness(props: { threadId: string; accountId: string }) {
    snapshot.current = useThreadToolActivity(props.threadId, props.accountId);
    return null;
  }

  const render = (props: { threadId: string; accountId: string }) => {
    act(() => root.render(<HookHarness {...props} />));
  };
  render({ threadId, accountId });
  mountedRoots.push(root);

  return {
    result: {
      get current() {
        if (!snapshot.current) throw new Error("Hook did not render");
        return snapshot.current;
      },
    },
    rerender: render,
  };
}

async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }
  throw lastError;
}

describe("useThreadToolActivity persisted count", () => {
  beforeEach(() => {
    mock.rowsByThread.clear();
    mock.pendingByThread.clear();
    mock.channels.length = 0;
    mock.queriedTables.length = 0;
  });

  afterEach(() => {
    for (const root of mountedRoots.splice(0)) {
      act(() => root.unmount());
    }
  });

  // Failures used to be stripped from the feed, so a thread of 99 failed calls
  // rendered an EMPTY Activity list under a badge reading 99. An analyst could
  // not see which tool failed or why — across this account that hid 2,142 of
  // 18,393 calls. The feed now shows every persisted call.
  it("shows all 99 persisted calls when every one of them failed", async () => {
    mock.rowsByThread.set("thread-a", rows(99, "failed"));

    const { result } = renderActivityHook("thread-a", "account-a");

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.persistedTotal).toBe(99);
    expect(result.current.total).toBe(99);
    expect(result.current.failed).toBe(99);
    expect(result.current.events).toHaveLength(99);
  });

  it("keeps the feed total equal to the persisted total, so badge and panel agree", async () => {
    mock.rowsByThread.set("thread-a", mixedRows({ ok: 7, failed: 2 }));

    const { result } = renderActivityHook("thread-a", "account-a");

    await waitFor(() => expect(result.current.loading).toBe(false));
    // The 9-vs-7 disagreement between the tab badge and the panel is gone.
    expect(result.current.total).toBe(result.current.persistedTotal);
  });

  // The Activity feed still collapses `empty` into `succeeded` (an empty result
  // IS a completed call), but failures are no longer dropped. A thread with
  // 10 ok + 1 empty + 2 failed persists 13 rows and now SHOWS all 13.
  it("counts an empty outcome as succeeded and still surfaces failures", async () => {
    mock.rowsByThread.set("thread-a", mixedRows({ ok: 10, empty: 1, failed: 2 }));

    const { result } = renderActivityHook("thread-a", "account-a");

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.persistedTotal).toBe(13);
    expect(result.current.total).toBe(13);
    // ok + empty are both "succeeded" rows.
    expect(result.current.ok).toBe(11);
    expect(result.current.failed).toBe(2);
    // Empty is grouped with ok, so no separate skipped/gated/degraded rows.
    expect(result.current.skipped).toBe(0);
    expect(result.current.gated).toBe(0);
    expect(result.current.degraded).toBe(0);
  });

  it("realtime insertion increments the active thread only", async () => {
    mock.rowsByThread.set("thread-a", rows(1));
    const { result } = renderActivityHook("thread-a", "account-a");
    await waitFor(() => expect(result.current.persistedTotal).toBe(1));

    mock.rowsByThread.set("thread-a", rows(2));
    await emit("tool_usage_log", { new: { thread_id: "thread-a" } });

    await waitFor(() => expect(result.current.persistedTotal).toBe(2));
  });

  it("ignores tool rows announced for another thread", async () => {
    mock.rowsByThread.set("thread-a", rows(1));
    const { result } = renderActivityHook("thread-a", "account-a");
    await waitFor(() => expect(result.current.persistedTotal).toBe(1));
    const queryCount = mock.queriedTables.length;

    mock.rowsByThread.set("thread-a", rows(2));
    await emit("tool_usage_log", { new: { thread_id: "thread-b" } });

    expect(result.current.persistedTotal).toBe(1);
    expect(mock.queriedTables).toHaveLength(queryCount);
  });

  it("clears the previous count immediately while switching threads", async () => {
    mock.rowsByThread.set("thread-a", rows(4));
    const next = deferred<{ data: TestRow[]; error: null }>();
    const { result, rerender } = renderActivityHook("thread-a", "account-a");
    await waitFor(() => expect(result.current.persistedTotal).toBe(4));

    mock.pendingByThread.set("thread-b", next.promise);
    rerender({ threadId: "thread-b", accountId: "account-a" });
    expect(result.current.persistedTotal).toBe(0);
    expect(result.current.loading).toBe(true);

    next.resolve({ data: rows(2), error: null });
    await waitFor(() => expect(result.current.persistedTotal).toBe(2));
  });

  it("refetches on run completion to recover missed realtime events", async () => {
    mock.rowsByThread.set("thread-a", rows(1));
    const { result } = renderActivityHook("thread-a", "account-a");
    await waitFor(() => expect(result.current.persistedTotal).toBe(1));

    mock.rowsByThread.set("thread-a", rows(6));
    act(() => {
      window.dispatchEvent(new CustomEvent("proximity:run-state", {
        detail: { threadId: "thread-a", running: true },
      }));
      window.dispatchEvent(new CustomEvent("proximity:run-state", {
        detail: { threadId: "thread-a", running: false },
      }));
    });

    await waitFor(() => expect(result.current.persistedTotal).toBe(6));
  });

  it("refetches after realtime reconnect", async () => {
    mock.rowsByThread.set("thread-a", rows(1));
    const { result } = renderActivityHook("thread-a", "account-a");
    await waitFor(() => expect(result.current.persistedTotal).toBe(1));

    mock.rowsByThread.set("thread-a", rows(3));
    act(() => mock.channels[0].statusCallback?.("SUBSCRIBED"));

    await waitFor(() => expect(result.current.persistedTotal).toBe(3));
  });

  it("never exposes the previous account count during an account switch", async () => {
    mock.rowsByThread.set("thread-a", rows(5));
    const { result, rerender } = renderActivityHook("thread-a", "account-a");
    await waitFor(() => expect(result.current.persistedTotal).toBe(5));

    const next = deferred<{ data: TestRow[]; error: null }>();
    mock.pendingByThread.set("thread-a", next.promise);
    rerender({ threadId: "thread-a", accountId: "account-b" });
    expect(result.current.persistedTotal).toBe(0);
    expect(result.current.loading).toBe(true);

    next.resolve({ data: rows(2), error: null });
    await waitFor(() => expect(result.current.persistedTotal).toBe(2));
  });

  // The 46-vs-48 defect: the header, the tab badge and the Tools panel each ran
  // their OWN instance — own read, own channel, own refresh triggers — so they
  // could only agree by luck. They now share one store per (account, thread).
  it("shares ONE store — one read and one channel pair — across every consumer of a thread", async () => {
    mock.rowsByThread.set("thread-a", rows(46));
    const header = renderActivityHook("thread-a", "account-a");
    const badge = renderActivityHook("thread-a", "account-a");
    const panel = renderActivityHook("thread-a", "account-a");

    await waitFor(() => expect(panel.result.current.loading).toBe(false));
    expect(toolActivityStoreCount()).toBe(1);
    expect(mock.queriedTables.filter((t) => t === "tool_usage_log")).toHaveLength(1);
    // tool_usage_log on one channel, the threads heartbeat on another — ONE pair.
    expect(mock.channels.filter((c) => c.active)).toHaveLength(2);

    // A refresh through any consumer moves every consumer, in the same update.
    mock.rowsByThread.set("thread-a", rows(48));
    await act(async () => { await header.result.current.reload(); });
    expect(header.result.current.persistedTotal).toBe(48);
    expect(badge.result.current.persistedTotal).toBe(48);
    expect(panel.result.current.persistedTotal).toBe(48);
  });

  // tool_usage_log is not in the realtime publication, so a tool-row event
  // never arrives in production. The threads heartbeat (published) does.
  it("reconciles on a threads UPDATE — the heartbeat is the signal that actually arrives", async () => {
    mock.rowsByThread.set("thread-a", rows(46));
    const { result } = renderActivityHook("thread-a", "account-a");
    await waitFor(() => expect(result.current.persistedTotal).toBe(46));

    mock.rowsByThread.set("thread-a", rows(48));
    await emit("threads", { new: { id: "thread-a", status: "active" } });

    await waitFor(() => expect(result.current.persistedTotal).toBe(48));
  });

  it("keeps the last good count through a failed refresh instead of repainting 0", async () => {
    mock.rowsByThread.set("thread-a", rows(5));
    const { result } = renderActivityHook("thread-a", "account-a");
    await waitFor(() => expect(result.current.persistedTotal).toBe(5));

    mock.pendingByThread.set("thread-a", Promise.resolve({ data: null as unknown as TestRow[], error: { message: "boom" } as unknown as null }));
    await act(async () => { await result.current.reload(); });
    expect(result.current.error).toBe(true);
    expect(result.current.persistedTotal).toBe(5);
  });

  it("does not query or alter the evidence data source", async () => {
    mock.rowsByThread.set("thread-a", rows(1));
    const { result } = renderActivityHook("thread-a", "account-a");
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mock.queriedTables).toEqual(["tool_usage_log"]);
  });
});
