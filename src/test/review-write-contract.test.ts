/**
 * review-write-contract.test.ts — a review write returns a REAL result, rolls
 * back on failure, and gates every dependent action on the commit.
 *
 * THE DEFECTS this pins (all observed on `442ecbc`):
 *   - `set` returned void: callers could not tell a persisted verdict from a
 *     failed one, so Recheck fired `void review.set(...)` and launched the chat
 *     run on the SAME tick — before the row existed, and even when the write
 *     failed.
 *   - the reset/delete path, `setNote` and `clear` discarded their errors and
 *     left optimistic state in place.
 *   - the memory-teaching RPC's `{ error }` was never read (an RPC failure
 *     resolves, it does not throw), so a lost lesson looked saved.
 *   - consumers memoising on the artifact list never saw a verdict change —
 *     the hook now exposes a `revision` that bumps on every change.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

type Deferred = { promise: Promise<{ error: unknown }>; resolve: (v: { error: unknown }) => void };
function deferred(): Deferred {
  let resolve!: (v: { error: unknown }) => void;
  const promise = new Promise<{ error: unknown }>((r) => { resolve = r; });
  return { promise, resolve };
}

const mock = vi.hoisted(() => ({
  upsertError: null as unknown,
  deleteError: null as unknown,
  rpcError: null as unknown,
  /** When set, the next upsert waits on it — lets a test observe "before commit". */
  upsertGate: null as null | Promise<{ error: unknown }>,
  upserts: [] as Array<Record<string, unknown>>,
  deletes: 0,
  rpcs: [] as Array<Record<string, unknown>>,
  toasts: { error: [] as string[], warning: [] as string[], success: [] as string[] },
}));

vi.mock("sonner", () => ({
  toast: {
    error: (m: string) => { mock.toasts.error.push(String(m)); },
    warning: (m: string) => { mock.toasts.warning.push(String(m)); },
    success: (m: string) => { mock.toasts.success.push(String(m)); },
  },
}));

vi.mock("@/lib/analyst-feedback", () => ({
  recordAnalystFeedback: async () => true,
  actionForReviewState: (s: string | null) => (s && s !== "new" ? s : null),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getUser: async () => ({ data: { user: { id: "user-1" } } }) },
    rpc: async (_fn: string, args: Record<string, unknown>) => {
      mock.rpcs.push(args);
      return { error: mock.rpcError };
    },
    from(table: string) {
      const builder: Record<string, unknown> = {};
      let op: "select" | "delete" | "other" = "other";
      builder.select = () => { op = "select"; return builder; };
      builder.eq = () => builder;
      builder.in = () => builder;
      builder.maybeSingle = async () => ({ data: null, error: null });
      builder.delete = () => { op = "delete"; return builder; };
      builder.upsert = async (row: Record<string, unknown>) => {
        if (mock.upsertGate) {
          const r = await mock.upsertGate;
          mock.upserts.push(row);
          return r;
        }
        mock.upserts.push(row);
        return { error: mock.upsertError };
      };
      builder.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        if (table === "artifact_reviews" && op === "delete") {
          mock.deletes += 1;
          return Promise.resolve({ error: mock.deleteError }).then(res, rej);
        }
        return Promise.resolve({ data: [], error: null }).then(res, rej);
      };
      return builder;
    },
  },
}));

import { useReviewStates, startRecheck } from "@/lib/review";

let threadSeq = 0;
const freshThread = () => `thread-${++threadSeq}`;

async function hook(threadId: string) {
  const h = renderHook(() => useReviewStates(threadId));
  await waitFor(() => expect(h.result.current.availability).toBe("ok"));
  return h;
}

beforeEach(() => {
  mock.upsertError = null;
  mock.deleteError = null;
  mock.rpcError = null;
  mock.upsertGate = null;
  mock.upserts = [];
  mock.deletes = 0;
  mock.rpcs = [];
  mock.toasts = { error: [], warning: [], success: [] };
});

describe("set() returns a real result", () => {
  it("resolves ok:true only after the upsert landed", async () => {
    const h = await hook(freshThread());
    let r: unknown;
    await act(async () => { r = await h.result.current.set("a1", "confirmed"); });
    expect(r).toEqual({ ok: true, state: "confirmed" });
    expect(mock.upserts).toHaveLength(1);
    expect(h.result.current.get("a1")).toBe("confirmed");
  });

  it("⛔ FAILED write: resolves ok:false, rolls the optimistic state back, tells the analyst", async () => {
    const h = await hook(freshThread());
    await act(async () => { await h.result.current.set("a1", "key"); });
    mock.upsertError = { message: "check constraint violated" };
    let r: { ok: boolean; error?: string } | undefined;
    await act(async () => { r = await h.result.current.set("a1", "wrong", { value: "x@y.z", kind: "email" }); });
    expect(r?.ok).toBe(false);
    expect(r?.error).toMatch(/constraint/);
    expect(h.result.current.get("a1")).toBe("key");
    expect(mock.toasts.error.some((m) => /not recorded/.test(m))).toBe(true);
    // Nothing downstream of the commit ran: no memory lesson for a verdict that did not persist.
    expect(mock.rpcs).toHaveLength(0);
  });

  it("the memory-teaching RPC result is CHECKED: a failed lesson is reported, the verdict still stands", async () => {
    const h = await hook(freshThread());
    mock.rpcError = { message: "rpc down" };
    let r: { ok: boolean; memoryTaught?: boolean } | undefined;
    await act(async () => { r = await h.result.current.set("a1", "wrong", { value: "x@y.z", kind: "email" }); });
    expect(r?.ok).toBe(true);
    expect(r?.memoryTaught).toBe(false);
    expect(h.result.current.get("a1")).toBe("wrong");
    expect(mock.toasts.warning.some((m) => /lesson was not saved/.test(m))).toBe(true);
  });

  it("reset/delete failure restores the prior verdict and surfaces the error", async () => {
    const h = await hook(freshThread());
    await act(async () => { await h.result.current.set("a1", "confirmed"); });
    mock.deleteError = { message: "delete refused" };
    let r: { ok: boolean } | undefined;
    await act(async () => { r = await h.result.current.set("a1", null); });
    expect(r?.ok).toBe(false);
    expect(h.result.current.get("a1")).toBe("confirmed");
    expect(mock.toasts.error.some((m) => /Could not reset/.test(m))).toBe(true);
  });
});

describe("startRecheck awaits persistence", () => {
  const launches: CustomEvent[] = [];
  const onRun = (e: Event) => { launches.push(e as CustomEvent); };
  beforeEach(() => {
    launches.length = 0;
    window.removeEventListener("proximity:run-pivot", onRun);
    window.addEventListener("proximity:run-pivot", onRun);
  });

  it("⛔ the chat run does NOT start before the review write commits", async () => {
    const threadId = freshThread();
    const h = await hook(threadId);
    const gate = deferred();
    mock.upsertGate = gate.promise;
    let done = false;
    const p = startRecheck({
      set: h.result.current.set, threadId,
      artifact: { id: "a1", value: "x@y.z", kind: "email" },
    }).then((r) => { done = true; return r; });
    // Let the microtasks run: the write is in flight, nothing has committed.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(launches).toHaveLength(0);
    expect(done).toBe(false);
    gate.resolve({ error: null });
    let r: { ok: boolean } | undefined;
    await act(async () => { r = await p; });
    expect(r?.ok).toBe(true);
    expect(launches).toHaveLength(1);
    expect(launches[0].detail.threadId).toBe(threadId);
    expect(launches[0].detail.prompt).toMatch(/Re-verify this specific finding/);
  });

  it("⛔ a failed review write prevents the Recheck run from starting", async () => {
    const threadId = freshThread();
    const h = await hook(threadId);
    mock.upsertError = { message: "boom" };
    let r: { ok: boolean } | undefined;
    await act(async () => {
      r = await startRecheck({ set: h.result.current.set, threadId, artifact: { id: "a1", value: "x@y.z", kind: "email" } });
    });
    expect(r?.ok).toBe(false);
    expect(launches).toHaveLength(0);
    expect(h.result.current.get("a1")).toBe("new");
  });
});

describe("setNote / clear", () => {
  it("a failed note rolls back the note AND the implicit confirmation", async () => {
    const h = await hook(freshThread());
    mock.upsertError = { message: "note refused" };
    let r: { ok: boolean } | undefined;
    await act(async () => { r = await h.result.current.setNote("a1", "why it matters"); });
    expect(r?.ok).toBe(false);
    expect(h.result.current.get("a1")).toBe("new");
    expect(h.result.current.getNote("a1")).toBe("");
    expect(mock.toasts.error.some((m) => /Could not save the note/.test(m))).toBe(true);
  });

  it("a failed clear restores every verdict", async () => {
    const h = await hook(freshThread());
    await act(async () => { await h.result.current.set("a1", "confirmed"); await h.result.current.set("a2", "key"); });
    mock.deleteError = { message: "clear refused" };
    let r: { ok: boolean } | undefined;
    await act(async () => { r = await h.result.current.clear(); });
    expect(r?.ok).toBe(false);
    expect(h.result.current.get("a1")).toBe("confirmed");
    expect(h.result.current.get("a2")).toBe("key");
  });
});

describe("revision", () => {
  it("bumps on every change — including a rollback — so memoised consumers recompute", async () => {
    const h = await hook(freshThread());
    const r0 = h.result.current.revision;
    await act(async () => { await h.result.current.set("a1", "confirmed"); });
    const r1 = h.result.current.revision;
    expect(r1).toBeGreaterThan(r0);
    mock.upsertError = { message: "boom" };
    await act(async () => { await h.result.current.set("a1", "dismissed"); });
    expect(h.result.current.revision).toBeGreaterThan(r1);
    expect(h.result.current.get("a1")).toBe("confirmed");
  });
});
