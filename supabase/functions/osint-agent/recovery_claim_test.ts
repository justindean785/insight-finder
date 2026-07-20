// recovery_claim_test.ts — contract coverage for the atomic recovery claim
// beyond the two-caller case in recovery_race_test.ts: wider concurrency, retry
// idempotency, terminal threads, and the failed-insert rollback.
//
// Every fake `threads` table here is STATEFUL and applies its UPDATE patch in
// one indivisible step, mirroring Postgres's per-statement atomicity. A
// fixed-response fake would let every caller "win" and quietly defeat the point.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { recoverStaleThreadById, STALE_RUN_AFTER_MS } from "./recovery.ts";

type SupabaseClient = ReturnType<typeof createClient>;

type FakeOpts = {
  status?: string;
  stale?: boolean;
  /** Force the recovered-report insert to fail, exercising the rollback path. */
  failInsert?: boolean;
};

function buildDb(threadId: string, userId: string, now: Date, opts: FakeOpts = {}) {
  const stale = opts.stale ?? true;
  const stamp = stale
    ? new Date(now.getTime() - STALE_RUN_AFTER_MS - 5_000).toISOString()
    : now.toISOString();
  const threadRow: Record<string, unknown> = {
    id: threadId,
    user_id: userId,
    title: "claim-test",
    seed_value: "claim-test.example",
    status: opts.status ?? "active",
    run_started_at: stamp,
    last_heartbeat_at: stamp,
    updated_at: stamp,
  };
  const insertedMessages: Array<Record<string, unknown>> = [];
  let updateCount = 0;

  function threadsChain() {
    const filters: Array<[string, unknown]> = [];
    let pendingUpdate: Record<string, unknown> | null = null;
    const node: Record<string, unknown> = {
      select: () => node,
      eq: (col: string, val: unknown) => { filters.push([col, val]); return node; },
      is: (col: string, val: unknown) => { filters.push([col, val]); return node; },
      update: (patch: Record<string, unknown>) => { pendingUpdate = patch; return node; },
      maybeSingle: () => {
        const matches = filters.every(([c, v]) => threadRow[c] === v);
        return Promise.resolve({ data: matches ? { ...threadRow } : null, error: null });
      },
      then: (resolve: (v: { data: unknown; error: unknown }) => void) => {
        const matches = filters.every(([c, v]) => threadRow[c] === v);
        if (pendingUpdate) {
          if (matches) {
            updateCount++;
            Object.assign(threadRow, pendingUpdate);
            resolve({ data: [{ id: threadId }], error: null });
          } else {
            resolve({ data: [], error: null });
          }
          return;
        }
        resolve({ data: matches ? [{ ...threadRow }] : [], error: null });
      },
    };
    return node;
  }

  function inert(resolveValue: { data: unknown; error: unknown; count?: number }) {
    const node: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "limit"]) node[m] = () => node;
    node.maybeSingle = () => Promise.resolve(resolveValue);
    node.then = (resolve: (v: unknown) => void) => resolve(resolveValue);
    return node;
  }

  const db = {
    from: (table: string) => {
      if (table === "threads") return threadsChain();
      if (table === "messages") {
        const chain = inert({ data: null, error: null });
        chain.insert = (row: Record<string, unknown>) => {
          if (opts.failInsert) return Promise.resolve({ error: { message: "insert boom" } });
          insertedMessages.push(row);
          return Promise.resolve({ error: null });
        };
        return chain;
      }
      if (table === "artifacts") {
        return inert({
          data: [{ id: "a1", kind: "email", value: "hit@example.com", confidence: 0.9, source: "t", created_at: now.toISOString() }],
          error: null,
          count: 1,
        });
      }
      if (table === "artifact_reviews") return inert({ data: [], error: null });
      throw new Error(`unexpected table: ${table}`);
    },
  } as unknown as SupabaseClient;

  return { db, insertedMessages, threadRow, updateCount: () => updateCount };
}

Deno.test("recovery claim: ten simultaneous callers still produce exactly ONE recovered report", async () => {
  const now = new Date();
  const { db, insertedMessages } = buildDb("thread-claim-10", "user-10", now);

  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      recoverStaleThreadById(db, "thread-claim-10", { now, reason: `sweep ${i}` })),
  );

  const winners = results.filter((r) => r.recovered && r.assistantInserted);
  assertEquals(winners.length, 1, "exactly one of ten callers may win the claim");
  assertEquals(results.filter((r) => !r.recovered).length, 9, "the other nine lose cleanly");
  assertEquals(insertedMessages.length, 1, "only one report row may ever be inserted");
  assertEquals(results.every((r) => r.error === undefined), true, "losing a race is not an error");
});

Deno.test("recovery claim: a retry AFTER a winning insert adds no duplicate report", async () => {
  const now = new Date();
  const { db, insertedMessages } = buildDb("thread-claim-retry", "user-retry", now);

  const first = await recoverStaleThreadById(db, "thread-claim-retry", { now, reason: "sweep 1" });
  assertEquals(first.recovered, true);
  assertEquals(insertedMessages.length, 1);

  // Same sweep runs again (scheduled tick, retried health probe, redeliver).
  const second = await recoverStaleThreadById(db, "thread-claim-retry", { now, reason: "sweep 1 retry" });
  assertEquals(second.recovered, false, "the thread is no longer active — nothing to claim");
  assertEquals(insertedMessages.length, 1, "a retry must be idempotent, not additive");

  const third = await recoverStaleThreadById(db, "thread-claim-retry", { now, reason: "sweep 1 retry 2" });
  assertEquals(third.recovered, false);
  assertEquals(insertedMessages.length, 1);
});

Deno.test("recovery claim: an already-terminal thread is never touched", async () => {
  const now = new Date();
  const { db, insertedMessages, threadRow } = buildDb("thread-terminal", "user-term", now, { status: "finished" });

  const res = await recoverStaleThreadById(db, "thread-terminal", { now, reason: "sweep" });

  assertEquals(res.recovered, false, "a finished thread is not recoverable");
  assertEquals(insertedMessages.length, 0, "no report may be inserted for a terminal thread");
  assertEquals(threadRow.status, "finished", "status must be left exactly as found");
  assertEquals(threadRow.recovered_at, undefined, "no recovery metadata may be written");
});

Deno.test("recovery claim: a FRESH active thread is never claimed, even by many callers", async () => {
  const now = new Date();
  const { db, insertedMessages, threadRow } = buildDb("thread-fresh", "user-fresh", now, { stale: false });

  const results = await Promise.all(
    Array.from({ length: 5 }, () => recoverStaleThreadById(db, "thread-fresh", { now, reason: "sweep" })),
  );

  assertEquals(results.every((r) => !r.recovered), true, "a live run must never be recovered");
  assertEquals(insertedMessages.length, 0);
  assertEquals(threadRow.status, "active", "a live run must stay active");
});

Deno.test("recovery claim: a failed report insert releases the claim, leaving a retryable state", async () => {
  const now = new Date();
  const { db, insertedMessages, threadRow } = buildDb("thread-insert-fail", "user-fail", now, { failInsert: true });

  const res = await recoverStaleThreadById(db, "thread-insert-fail", { now, reason: "sweep" });

  assertEquals(res.recovered, false, "a claim whose report never landed must NOT report success");
  assertEquals(res.assistantInserted, false);
  assertEquals(res.error, "insert boom", "the underlying failure must be surfaced, not swallowed");
  assertEquals(insertedMessages.length, 0);
  // The observable, retryable state: back to active/stale exactly as found, so
  // the next sweep re-claims it rather than the thread being stranded terminal.
  assertEquals(threadRow.status, "active", "the claim must be released on insert failure");
  assertEquals(threadRow.recovered_at, null, "recovery metadata must be rolled back too");
  assertEquals(threadRow.recovery_reason, null);
});

Deno.test("recovery claim: a thread with a NULL heartbeat is claimed via IS NULL, not = NULL", async () => {
  // Real production shape: recoverStaleActiveThreads explicitly selects rows
  // where last_heartbeat_at IS NULL and updated_at is old. `.eq(col, null)`
  // renders as `col = NULL`, which is never true in SQL — such a thread could
  // never be claimed at all. This pins the IS NULL branch.
  const now = new Date();
  const stamp = new Date(now.getTime() - STALE_RUN_AFTER_MS - 5_000).toISOString();
  const threadRow: Record<string, unknown> = {
    id: "thread-null-hb", user_id: "u", title: "t", seed_value: "s",
    status: "active", run_started_at: stamp, last_heartbeat_at: null, updated_at: stamp,
  };
  const inserted: Array<Record<string, unknown>> = [];
  let sawIsNull = false;
  function threadsChain() {
    const filters: Array<[string, unknown]> = [];
    let pending: Record<string, unknown> | null = null;
    const node: Record<string, unknown> = {
      select: () => node,
      eq: (c: string, v: unknown) => { filters.push([c, v]); return node; },
      is: (c: string, v: unknown) => {
        if (c === "last_heartbeat_at" && v === null) sawIsNull = true;
        filters.push([c, v]);
        return node;
      },
      update: (p: Record<string, unknown>) => { pending = p; return node; },
      maybeSingle: () => {
        const m = filters.every(([c, v]) => threadRow[c] === v);
        return Promise.resolve({ data: m ? { ...threadRow } : null, error: null });
      },
      then: (resolve: (v: { data: unknown; error: unknown }) => void) => {
        const m = filters.every(([c, v]) => threadRow[c] === v);
        if (pending) {
          if (m) { Object.assign(threadRow, pending); resolve({ data: [{ id: "thread-null-hb" }], error: null }); }
          else resolve({ data: [], error: null });
          return;
        }
        resolve({ data: m ? [{ ...threadRow }] : [], error: null });
      },
    };
    return node;
  }
  const db = {
    from: (table: string) => {
      if (table === "threads") return threadsChain();
      const node: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "order", "limit"]) node[m] = () => node;
      node.maybeSingle = () => Promise.resolve({ data: null, error: null });
      node.then = (r: (v: unknown) => void) => r({ data: [], error: null, count: 0 });
      if (table === "messages") node.insert = (row: Record<string, unknown>) => { inserted.push(row); return Promise.resolve({ error: null }); };
      return node;
    },
  } as unknown as SupabaseClient;

  const res = await recoverStaleThreadById(db, "thread-null-hb", { now, reason: "sweep" });
  assertEquals(sawIsNull, true, "a null heartbeat must be matched with IS NULL");
  assertEquals(res.recovered, true, "a null-heartbeat stale thread is still recoverable");
  assertEquals(threadRow.status, "finished");
  assertEquals(inserted.length, 1);
});

Deno.test("recovery claim: a run that resumes between the read and the claim is NOT recovered", async () => {
  // The claim compare-and-swaps on the exact last_heartbeat_at the staleness
  // decision was based on. If the run pulses in that window the value moves, the
  // WHERE matches nothing, and we correctly decline to close a live run.
  const now = new Date();
  const stale = new Date(now.getTime() - STALE_RUN_AFTER_MS - 5_000).toISOString();
  const threadRow: Record<string, unknown> = {
    id: "thread-resumed", user_id: "u", title: "t", seed_value: "s",
    status: "active", run_started_at: stale, last_heartbeat_at: stale, updated_at: stale,
  };
  const inserted: Array<Record<string, unknown>> = [];
  let reads = 0;
  function threadsChain() {
    const filters: Array<[string, unknown]> = [];
    let pending: Record<string, unknown> | null = null;
    const node: Record<string, unknown> = {
      select: () => node,
      eq: (c: string, v: unknown) => { filters.push([c, v]); return node; },
      is: (c: string, v: unknown) => { filters.push([c, v]); return node; },
      update: (p: Record<string, unknown>) => { pending = p; return node; },
      maybeSingle: () => {
        const m = filters.every(([c, v]) => threadRow[c] === v);
        const snapshot = m ? { ...threadRow } : null;
        // Simulate the heartbeat landing immediately AFTER our read: the caller
        // holds a stale snapshot while the row has already moved on.
        if (++reads === 1) threadRow.last_heartbeat_at = now.toISOString();
        return Promise.resolve({ data: snapshot, error: null });
      },
      then: (resolve: (v: { data: unknown; error: unknown }) => void) => {
        const m = filters.every(([c, v]) => threadRow[c] === v);
        if (pending) {
          if (m) { Object.assign(threadRow, pending); resolve({ data: [{ id: "thread-resumed" }], error: null }); }
          else resolve({ data: [], error: null });
          return;
        }
        resolve({ data: m ? [{ ...threadRow }] : [], error: null });
      },
    };
    return node;
  }
  const db = {
    from: (table: string) => {
      if (table === "threads") return threadsChain();
      const node: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "order", "limit"]) node[m] = () => node;
      node.maybeSingle = () => Promise.resolve({ data: null, error: null });
      node.then = (r: (v: unknown) => void) => r({ data: [], error: null, count: 0 });
      if (table === "messages") node.insert = (row: Record<string, unknown>) => { inserted.push(row); return Promise.resolve({ error: null }); };
      return node;
    },
  } as unknown as SupabaseClient;

  const res = await recoverStaleThreadById(db, "thread-resumed", { now, reason: "sweep" });
  assertEquals(res.recovered, false, "a run that resumed must not be closed by a stale sweep");
  assertEquals(inserted.length, 0, "no recovered report for a live run");
  assertEquals(threadRow.status, "active", "the resumed run keeps running");
});

Deno.test("recovery claim: after a released claim, a later sweep succeeds", async () => {
  const now = new Date();
  // Insert fails for the first pass, then the fake is flipped to succeed —
  // proving the released thread is genuinely re-claimable, not just cosmetically
  // reset.
  const state = { fail: true };
  const stamp = new Date(now.getTime() - STALE_RUN_AFTER_MS - 5_000).toISOString();
  const threadRow: Record<string, unknown> = {
    id: "thread-retryable", user_id: "u", title: "t", seed_value: "s",
    status: "active", run_started_at: stamp, last_heartbeat_at: stamp, updated_at: stamp,
  };
  const inserted: Array<Record<string, unknown>> = [];
  function threadsChain() {
    const filters: Array<[string, unknown]> = [];
    let pending: Record<string, unknown> | null = null;
    const node: Record<string, unknown> = {
      select: () => node,
      eq: (c: string, v: unknown) => { filters.push([c, v]); return node; },
      is: (c: string, v: unknown) => { filters.push([c, v]); return node; },
      update: (p: Record<string, unknown>) => { pending = p; return node; },
      maybeSingle: () => {
        const m = filters.every(([c, v]) => threadRow[c] === v);
        return Promise.resolve({ data: m ? { ...threadRow } : null, error: null });
      },
      then: (resolve: (v: { data: unknown; error: unknown }) => void) => {
        const m = filters.every(([c, v]) => threadRow[c] === v);
        if (pending) {
          if (m) { Object.assign(threadRow, pending); resolve({ data: [{ id: "thread-retryable" }], error: null }); }
          else resolve({ data: [], error: null });
          return;
        }
        resolve({ data: m ? [{ ...threadRow }] : [], error: null });
      },
    };
    return node;
  }
  const db = {
    from: (table: string) => {
      if (table === "threads") return threadsChain();
      const node: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "order", "limit"]) node[m] = () => node;
      node.maybeSingle = () => Promise.resolve({ data: null, error: null });
      node.then = (r: (v: unknown) => void) => r({
        data: [{ id: "a1", kind: "email", value: "x@y.com", confidence: 0.9, source: "t", created_at: now.toISOString() }],
        error: null, count: 1,
      });
      if (table === "messages") {
        node.insert = (row: Record<string, unknown>) => {
          if (state.fail) return Promise.resolve({ error: { message: "transient" } });
          inserted.push(row);
          return Promise.resolve({ error: null });
        };
      }
      return node;
    },
  } as unknown as SupabaseClient;

  const failed = await recoverStaleThreadById(db, "thread-retryable", { now, reason: "sweep 1" });
  assertEquals(failed.recovered, false);
  assertEquals(threadRow.status, "active", "released back to active");

  state.fail = false;
  const retried = await recoverStaleThreadById(db, "thread-retryable", { now, reason: "sweep 2" });
  assertEquals(retried.recovered, true, "the released thread must be re-claimable");
  assertEquals(retried.assistantInserted, true);
  assertEquals(inserted.length, 1, "exactly one report after the successful retry");
  assertEquals(threadRow.status, "finished");
});
