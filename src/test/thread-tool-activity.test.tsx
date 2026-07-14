import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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

  it("loads all 99 persisted calls even when failures are hidden from the feed", async () => {
    mock.rowsByThread.set("thread-a", rows(99, "failed"));

    const { result } = renderActivityHook("thread-a", "account-a");

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.persistedTotal).toBe(99);
    expect(result.current.total).toBe(0);
    expect(result.current.hiddenFailed).toBe(99);
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

  it("does not query or alter the evidence data source", async () => {
    mock.rowsByThread.set("thread-a", rows(1));
    const { result } = renderActivityHook("thread-a", "account-a");
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(mock.queriedTables).toEqual(["tool_usage_log"]);
  });
});
