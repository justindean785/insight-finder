// recovery_race_test.ts — proves the atomic-claim fix in recoverOneStaleThread
// actually prevents duplicate "Findings report — recovered run" inserts when
// two sweeps (e.g. an overlapping /health-triggered sweep and a scheduled
// pg_cron tick) race to recover the SAME stale thread.
//
// WHY THIS TEST EXISTS: the old code queried artifacts / built the report
// BEFORE flipping status, so both concurrent callers could pass the
// isStaleActiveThread check, both build a report, and both insert a message.
// The fix moves a conditional `UPDATE ... WHERE status = 'active'` to the
// very front; only the caller whose UPDATE actually matches a row (checked via
// `.select("id")`) proceeds. This test builds a STATEFUL fake `threads` table
// (not just a fixed-response stub) so the conditional UPDATE's WHERE clause is
// actually evaluated against mutating row state — a fixed-response fake would
// let both callers "win" and defeat the entire point of the test.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { recoverStaleThreadById, STALE_RUN_AFTER_MS } from "./recovery.ts";

type SupabaseClient = ReturnType<typeof createClient>;

function buildFakeDb(threadId: string, userId: string, now: Date) {
  const staleHeartbeat = new Date(now.getTime() - STALE_RUN_AFTER_MS - 5_000).toISOString();
  const threadRow: Record<string, unknown> = {
    id: threadId,
    user_id: userId,
    title: "race-test",
    seed_value: "race-test.example",
    status: "active",
    run_started_at: staleHeartbeat,
    last_heartbeat_at: staleHeartbeat,
    updated_at: staleHeartbeat,
  };
  const insertedMessages: Array<Record<string, unknown>> = [];

  function threadsChain() {
    const filters: Array<[string, unknown]> = [];
    let pendingUpdate: Record<string, unknown> | null = null;
    const node: Record<string, unknown> = {
      select: () => node,
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return node;
      },
      update: (patch: Record<string, unknown>) => {
        pendingUpdate = patch;
        return node;
      },
      maybeSingle: () => {
        const matches = filters.every(([col, val]) => threadRow[col] === val);
        return Promise.resolve({ data: matches ? { ...threadRow } : null, error: null });
      },
      then: (resolve: (v: { data: unknown; error: unknown }) => void) => {
        const matches = filters.every(([col, val]) => threadRow[col] === val);
        if (pendingUpdate) {
          if (matches) {
            // Simulate Postgres's atomicity: the WHERE clause is evaluated and
            // the row mutated in one indivisible step — no other caller's
            // "concurrent" update can interleave inside this single statement.
            Object.assign(threadRow, pendingUpdate);
            resolve({ data: [{ id: threadId }], error: null });
          } else {
            resolve({ data: [], error: null }); // lost the race — WHERE matched nothing
          }
          return;
        }
        resolve({ data: matches ? [{ ...threadRow }] : [], error: null });
      },
    };
    return node;
  }

  function emptyChain(resolveValue: { data: unknown; error: unknown; count?: number }) {
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
        const chain = emptyChain({ data: null, error: null });
        chain.insert = (row: Record<string, unknown>) => {
          insertedMessages.push(row);
          return Promise.resolve({ error: null });
        };
        return chain;
      }
      if (table === "artifacts") {
        // Two durable artifacts already persisted before the CPU-kill —
        // real reports must be produced, which is exactly what makes a
        // duplicate-insert bug observable.
        return emptyChain({
          data: [
            { id: "a1", kind: "email", value: "found@example.com", confidence: 0.9, source: "test", created_at: now.toISOString() },
            { id: "a2", kind: "domain", value: "race-test.example", confidence: 0.8, source: "test", created_at: now.toISOString() },
          ],
          error: null,
          count: 2,
        });
      }
      if (table === "artifact_reviews") return emptyChain({ data: [], error: null });
      throw new Error(`unexpected table in fake db: ${table}`);
    },
  } as unknown as SupabaseClient;

  return { db, insertedMessages };
}

// QUARANTINED 2026-07-21 — orphaned by #370 rollback of #369; unskip when the atomic
// recovery-claim front-gate (UPDATE ... WHERE status='active') re-lands in recovery.ts. See issue #373.
Deno.test.ignore("recovery race: two concurrent sweeps on the same stale thread produce exactly ONE recovered report", async () => {
  const threadId = "thread-race-1";
  const userId = "user-race-1";
  const now = new Date();
  const { db, insertedMessages } = buildFakeDb(threadId, userId, now);

  const [first, second] = await Promise.all([
    recoverStaleThreadById(db, threadId, { now, reason: "sweep A" }),
    recoverStaleThreadById(db, threadId, { now, reason: "sweep B" }),
  ]);

  const winners = [first, second].filter((r) => r.recovered && r.assistantInserted);
  const losers = [first, second].filter((r) => !r.recovered);

  assertEquals(winners.length, 1, "exactly one caller must win the claim and insert the report");
  assertEquals(losers.length, 1, "the other caller must lose the race cleanly, not error or duplicate");
  assertEquals(insertedMessages.length, 1, "only one message row may ever be inserted, regardless of concurrent callers");
  assertEquals(winners[0].artifactCount, 2, "the winning report must reflect the real durable artifact count");
});

Deno.test("recovery race: a thread that is NOT stale is left untouched by both callers", async () => {
  const threadId = "thread-race-2";
  const userId = "user-race-2";
  const liveNow = new Date();
  const { db: liveDb, insertedMessages: liveInserted } = buildFakeDbLive(threadId, userId, liveNow);

  const [first, second] = await Promise.all([
    recoverStaleThreadById(liveDb, threadId, { now: liveNow, reason: "sweep A" }),
    recoverStaleThreadById(liveDb, threadId, { now: liveNow, reason: "sweep B" }),
  ]);

  assertEquals(first.recovered, false);
  assertEquals(second.recovered, false);
  assertEquals(liveInserted.length, 0, "a non-stale thread must never get a recovered report inserted");
});

function buildFakeDbLive(threadId: string, userId: string, now: Date) {
  const insertedMessages: Array<Record<string, unknown>> = [];
  const threadRow: Record<string, unknown> = {
    id: threadId,
    user_id: userId,
    title: "race-test-live",
    seed_value: "race-test-live.example",
    status: "active",
    run_started_at: now.toISOString(),
    last_heartbeat_at: now.toISOString(), // fresh — not stale
    updated_at: now.toISOString(),
  };
  function threadsChain() {
    const filters: Array<[string, unknown]> = [];
    let pendingUpdate: Record<string, unknown> | null = null;
    const node: Record<string, unknown> = {
      select: () => node,
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return node;
      },
      update: (patch: Record<string, unknown>) => {
        pendingUpdate = patch;
        return node;
      },
      maybeSingle: () => {
        const matches = filters.every(([col, val]) => threadRow[col] === val);
        return Promise.resolve({ data: matches ? { ...threadRow } : null, error: null });
      },
      then: (resolve: (v: { data: unknown; error: unknown }) => void) => {
        const matches = filters.every(([col, val]) => threadRow[col] === val);
        if (pendingUpdate) {
          if (matches) {
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
  const db = {
    from: (table: string) => {
      if (table === "threads") return threadsChain();
      const node: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "order", "limit"]) node[m] = () => node;
      node.maybeSingle = () => Promise.resolve({ data: null, error: null });
      node.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null, count: 0 });
      if (table === "messages") node.insert = (row: Record<string, unknown>) => { insertedMessages.push(row); return Promise.resolve({ error: null }); };
      return node;
    },
  } as unknown as ReturnType<typeof createClient>;
  return { db, insertedMessages };
}
