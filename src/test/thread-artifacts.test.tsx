import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useThreadArtifacts } from "@/hooks/useThreadArtifacts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type TestRow = {
  id: string;
  kind: string;
  value: string;
  confidence: number | null;
  source: string | null;
  created_at: string;
  metadata: Record<string, unknown> | null;
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
        order: () => query,
        // Artifacts load ends in `.limit()`, which resolves the query.
        limit: () => Promise.resolve({ data: mock.rowsByThread.get(threadId) ?? [], error: null }),
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

// Distinct artifacts (unique kind|value) so none collapse under dedupe and
// items.length equals the raw row count — the number the header renders.
function artifacts(count: number): TestRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `art-${index}`,
    kind: "email",
    value: `user${index}@example.com`,
    confidence: 50,
    source: `tool_${index}`,
    created_at: new Date(1_700_000_000_000 + index).toISOString(),
    metadata: null,
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

function renderArtifactsHook(threadId: string) {
  const container = document.createElement("div");
  const root = createRoot(container);
  const snapshot: { current: ReturnType<typeof useThreadArtifacts> | null } = { current: null };

  function HookHarness(props: { threadId: string }) {
    snapshot.current = useThreadArtifacts(props.threadId);
    return null;
  }

  const render = (props: { threadId: string }) => {
    act(() => root.render(<HookHarness {...props} />));
  };
  render({ threadId });
  mountedRoots.push(root);

  return {
    result: {
      get current() {
        if (!snapshot.current) throw new Error("Hook did not render");
        return snapshot.current;
      },
    },
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

describe("useThreadArtifacts terminal-status reconciliation", () => {
  beforeEach(() => {
    mock.rowsByThread.clear();
    mock.channels.length = 0;
    mock.queriedTables.length = 0;
  });

  afterEach(() => {
    for (const root of mountedRoots.splice(0)) {
      act(() => root.unmount());
    }
  });

  it("loads persisted artifacts on mount", async () => {
    mock.rowsByThread.set("thread-a", artifacts(3));
    const { result } = renderArtifactsHook("thread-a");
    await waitFor(() => expect(result.current.items).toHaveLength(3));
  });

  // The bug this fixes: when the realtime socket drops during a CPU-kill, the
  // artifact INSERTs from server-side recovery are missed and the count freezes
  // (e.g. "0 evidence"). The terminal-status flip must trigger a full refetch —
  // the same self-heal the sibling tools count already has.
  it("refetches when the run reaches a terminal status (finished)", async () => {
    mock.rowsByThread.set("thread-b", artifacts(1));
    const { result } = renderArtifactsHook("thread-b");
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    // Realtime missed these INSERTs; DB now holds the true count.
    mock.rowsByThread.set("thread-b", artifacts(23));
    await emit("threads", { new: { id: "thread-b", status: "finished" } });

    await waitFor(() => expect(result.current.items).toHaveLength(23));
  });

  it("refetches when the run is stopped", async () => {
    mock.rowsByThread.set("thread-c", artifacts(2));
    const { result } = renderArtifactsHook("thread-c");
    await waitFor(() => expect(result.current.items).toHaveLength(2));

    mock.rowsByThread.set("thread-c", artifacts(9));
    await emit("threads", { new: { id: "thread-c", status: "stopped" } });

    await waitFor(() => expect(result.current.items).toHaveLength(9));
  });

  it("does NOT refetch on a non-terminal threads update (still active)", async () => {
    mock.rowsByThread.set("thread-d", artifacts(4));
    const { result } = renderArtifactsHook("thread-d");
    await waitFor(() => expect(result.current.items).toHaveLength(4));
    const queryCount = mock.queriedTables.length;

    mock.rowsByThread.set("thread-d", artifacts(99));
    await emit("threads", { new: { id: "thread-d", status: "active" } });

    // No extra query fired; count unchanged.
    expect(mock.queriedTables).toHaveLength(queryCount);
    expect(result.current.items).toHaveLength(4);
  });

  it("refetches after a realtime reconnect (second SUBSCRIBED)", async () => {
    mock.rowsByThread.set("thread-e", artifacts(1));
    const { result } = renderArtifactsHook("thread-e");
    await waitFor(() => expect(result.current.items).toHaveLength(1));

    mock.rowsByThread.set("thread-e", artifacts(7));
    // The artifacts store owns exactly one channel; re-fire SUBSCRIBED to
    // simulate the socket recovering after a disconnect.
    await act(async () => { mock.channels[0].statusCallback?.("SUBSCRIBED"); });

    await waitFor(() => expect(result.current.items).toHaveLength(7));
  });

  // The gap the tests above do NOT cover, observed on thread dd2514e3 (2026-08-06):
  // a second run in an already-terminal thread wrote five artifacts at 10:14, and
  // the Evidence badge stayed on the three rows from 09:02.
  //
  // Every existing self-heal is realtime-dependent: the INSERT event, the
  // terminal-status flip, and the re-SUBSCRIBED reconcile all require a live
  // socket. When the socket is dead none of them fire — and that run was
  // CPU-killed (recovery_reason "stale heartbeat recovered by health sweep"),
  // so it never flipped status cleanly either. The count then stays stale
  // indefinitely, because nothing re-reads persistence until the store is torn
  // down and rebuilt (a reload or a re-navigation).
  //
  // Returning to the tab is the one signal that does not depend on the socket.
  it("reconciles from persistence when the tab becomes visible again", async () => {
    mock.rowsByThread.set("thread-f", artifacts(3));
    const { result } = renderArtifactsHook("thread-f");
    await waitFor(() => expect(result.current.items).toHaveLength(3));

    // Rows landed while the socket was down: no INSERT event, no terminal flip.
    mock.rowsByThread.set("thread-f", artifacts(9));
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => expect(result.current.items).toHaveLength(9));
  });

  it("does NOT reconcile while the tab is still hidden", async () => {
    mock.rowsByThread.set("thread-g", artifacts(4));
    const { result } = renderArtifactsHook("thread-g");
    await waitFor(() => expect(result.current.items).toHaveLength(4));
    const queryCount = mock.queriedTables.length;

    const original = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    try {
      mock.rowsByThread.set("thread-g", artifacts(99));
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });
      expect(mock.queriedTables).toHaveLength(queryCount);
      expect(result.current.items).toHaveLength(4);
    } finally {
      delete (document as unknown as Record<string, unknown>).visibilityState;
      if (original) Object.defineProperty(Document.prototype, "visibilityState", original);
    }
  });

  it("stops reconciling once the last subscriber has unmounted", async () => {
    mock.rowsByThread.set("thread-h", artifacts(2));
    renderArtifactsHook("thread-h");
    await waitFor(() => expect(mock.queriedTables.length).toBeGreaterThan(0));

    for (const root of mountedRoots.splice(0)) act(() => root.unmount());
    const queryCount = mock.queriedTables.length;

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    // A leaked listener would keep querying for a thread nobody is watching.
    expect(mock.queriedTables).toHaveLength(queryCount);
  });
});
