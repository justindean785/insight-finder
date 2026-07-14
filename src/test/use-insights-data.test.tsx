import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { InsightsSummary } from "@/pages/InsightsDerived";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

type CountTable = "agent_memory" | "threads" | "artifacts";

type RequestBatch = {
  summary: Deferred<{ data: InsightsSummary | null; error: { message: string } | null }>;
  counts: Record<CountTable, Deferred<{ count: number | null; error: null }>>;
  signals: AbortSignal[];
  userIds: string[];
};

const mocks = vi.hoisted(() => {
  const state: {
    queue: RequestBatch[];
    active: RequestBatch | null;
  } = {
    queue: [],
    active: null,
  };
  const channel = {
    on: vi.fn(),
    subscribe: vi.fn(),
  };
  channel.on.mockImplementation(() => channel);
  channel.subscribe.mockImplementation(() => channel);

  const supabase = {
    rpc: vi.fn(() => {
      const batch = state.queue.shift();
      if (!batch) throw new Error("No queued Insights request");
      state.active = batch;
      return {
        abortSignal: (signal: AbortSignal) => {
          batch.signals.push(signal);
          return batch.summary.promise;
        },
      };
    }),
    from: vi.fn((table: CountTable) => ({
      select: () => ({
        eq: (_column: string, userId: string) => {
          const batch = state.active;
          if (!batch) throw new Error("Count query started without an active request");
          return {
            abortSignal: (signal: AbortSignal) => {
              batch.signals.push(signal);
              batch.userIds.push(userId);
              return batch.counts[table].promise;
            },
          };
        },
      }),
    })),
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(() => Promise.resolve()),
  };

  return {
    state,
    supabase,
    captureError: vi.fn(),
  };
});

vi.mock("@/integrations/supabase/client", () => ({ supabase: mocks.supabase }));
vi.mock("@/lib/telemetry", () => ({ captureError: mocks.captureError }));

import { useInsightsData } from "@/hooks/useInsightsData";

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function requestBatch(): RequestBatch {
  return {
    summary: deferred(),
    counts: {
      agent_memory: deferred(),
      threads: deferred(),
      artifacts: deferred(),
    },
    signals: [],
    userIds: [],
  };
}

const EMPTY_SUMMARY: InsightsSummary = {
  kind_counts: [],
  source_counts: [],
  day_counts: [],
  top_cases: [],
  conf_buckets: { ge80: 0, b50: 0, b20: 0, lt20: 0, unscored: 0 },
  avg_confidence: 0,
  tool_counts: [],
  tool_calls_total: 0,
};

function resolveBatch(batch: RequestBatch, marker: number) {
  batch.summary.resolve({
    data: { ...EMPTY_SUMMARY, tool_calls_total: marker },
    error: null,
  });
  batch.counts.agent_memory.resolve({ count: marker + 1, error: null });
  batch.counts.threads.resolve({ count: marker + 2, error: null });
  batch.counts.artifacts.resolve({ count: marker + 3, error: null });
}

beforeEach(() => {
  mocks.state.queue.length = 0;
  mocks.state.active = null;
  mocks.supabase.rpc.mockClear();
  mocks.supabase.from.mockClear();
  mocks.supabase.channel.mockClear();
  mocks.supabase.removeChannel.mockClear();
  mocks.captureError.mockClear();
});

describe("useInsightsData account isolation", () => {
  it("ignores user A's late response after switching to B, then loads B normally", async () => {
    const requestA = requestBatch();
    mocks.state.queue.push(requestA);
    const { result, rerender } = renderHook(
      ({ userId }) => useInsightsData(userId, true),
      { initialProps: { userId: "user-a" } },
    );

    expect(requestA.userIds).toEqual(["user-a", "user-a", "user-a"]);

    const requestB = requestBatch();
    mocks.state.queue.push(requestB);
    rerender({ userId: "user-b" });

    expect(result.current.data).toBeNull();
    expect(requestA.signals.every((signal) => signal.aborted)).toBe(true);

    await act(async () => {
      resolveBatch(requestA, 10);
      await Promise.resolve();
    });
    expect(result.current.data).toBeNull();

    await act(async () => {
      resolveBatch(requestB, 20);
    });
    await waitFor(() => expect(result.current.data?.toolCallsTotal).toBe(20));
    expect(result.current.data?.memoryCount).toBe(21);
    expect(requestB.userIds).toEqual(["user-b", "user-b", "user-b"]);
    expect(result.current.error).toBeNull();
  });

  it("clears loaded Insights state on logout", async () => {
    const request = requestBatch();
    mocks.state.queue.push(request);
    const { result, rerender } = renderHook(
      ({ userId, enabled }) => useInsightsData(userId, enabled),
      { initialProps: { userId: "user-a" as string | undefined, enabled: true } },
    );

    await act(async () => {
      resolveBatch(request, 30);
    });
    await waitFor(() => expect(result.current.data?.toolCallsTotal).toBe(30));

    rerender({ userId: undefined, enabled: false });

    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("does not surface an aborted stale request as a user-facing error", async () => {
    const requestA = requestBatch();
    mocks.state.queue.push(requestA);
    const { result, rerender } = renderHook(
      ({ userId }) => useInsightsData(userId, true),
      { initialProps: { userId: "user-a" } },
    );

    const requestB = requestBatch();
    mocks.state.queue.push(requestB);
    rerender({ userId: "user-b" });

    await act(async () => {
      requestA.summary.reject(new DOMException("The operation was aborted", "AbortError"));
      await Promise.resolve();
    });

    expect(result.current.error).toBeNull();
    expect(mocks.captureError).not.toHaveBeenCalled();

    await act(async () => {
      resolveBatch(requestB, 40);
    });
    await waitFor(() => expect(result.current.data?.toolCallsTotal).toBe(40));
    expect(result.current.error).toBeNull();
  });
});
