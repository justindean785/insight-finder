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

// UNQUARANTINED 2026-07-26 — the atomic recovery-claim front-gate this test was
// waiting on (issue #373) has re-landed in recovery.ts: recoverOneStaleThread now
// runs `UPDATE ... WHERE status='active'` with `.select("id")` BEFORE writing any
// stub, and writes nothing unless the claim matched a row.
Deno.test("recovery race: two concurrent sweeps on the same stale thread produce exactly ONE recovered report", async () => {
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

// ---------------------------------------------------------------------------
// BLOCKER 1 (2026-07-26): recovery racing a LIVE FINALIZATION, not another sweep.
//
// The claim-before-stub fix stopped the fabricated stub, but left a subtler bug:
// recovery could still WIN the status claim moments before the live run flipped
// status itself. The stub was then correctly suppressed (the post-claim re-read
// sees the real report) — but recovered_at / recovery_reason were already stamped,
// and the live run's own completion UPDATE is guarded on status='active', which
// recovery just consumed. Net effect: a normally-completed investigation with a
// durable report renders as Interrupted.
//
// The existing races above pit two SWEEPS against each other and cannot catch this,
// because neither of them inserts a real report mid-flight. This fake does.
// ---------------------------------------------------------------------------
function buildFakeDbLiveFinalize(threadId: string, userId: string, now: Date, reportInitiallyPresent = false) {
  const staleHeartbeat = new Date(now.getTime() - STALE_RUN_AFTER_MS - 5_000).toISOString();
  const threadRow: Record<string, unknown> = {
    id: threadId,
    user_id: userId,
    title: "live-finalize-race",
    seed_value: "fingerprint.to",
    status: "active",
    run_started_at: staleHeartbeat,
    last_heartbeat_at: staleHeartbeat,
    updated_at: staleHeartbeat,
  };
  // The live run's REAL report — report-shaped, so the post-claim re-read must veto.
  const liveReport = {
    created_at: new Date(now.getTime() - 500).toISOString(),
    parts: [{ type: "text", text: "## Fingerprint.to Investigation Report\n\n| # | Finding |\n|---|---|\n| 1 | domain |" }],
  };
  const messages: Array<Record<string, unknown>> = reportInitiallyPresent ? [liveReport] : [];
  const insertedMessages: Array<Record<string, unknown>> = [];
  let threadUpdates = 0;

  function threadsChain() {
    const filters: Array<[string, unknown]> = [];
    let pendingUpdate: Record<string, unknown> | null = null;
    const node: Record<string, unknown> = {
      select: () => node,
      eq: (col: string, val: unknown) => { filters.push([col, val]); return node; },
      update: (patch: Record<string, unknown>) => { pendingUpdate = patch; return node; },
      maybeSingle: () => {
        const matches = filters.every(([col, val]) => threadRow[col] === val);
        return Promise.resolve({ data: matches ? { ...threadRow } : null, error: null });
      },
      then: (resolve: (v: { data: unknown; error: unknown }) => void) => {
        if (pendingUpdate) {
          threadUpdates++;
          // THE INTERLEAVING: the live run inserts its real report just before our
          // claim commits — after recovery's first read saw an empty thread.
          if (threadUpdates === 1 && !reportInitiallyPresent) messages.push(liveReport);
          const matches = filters.every(([col, val]) => threadRow[col] === val);
          if (matches) {
            Object.assign(threadRow, pendingUpdate);
            resolve({ data: [{ id: threadId }], error: null });
          } else {
            resolve({ data: [], error: null });
          }
          return;
        }
        const matches = filters.every(([col, val]) => threadRow[col] === val);
        resolve({ data: matches ? [{ ...threadRow }] : [], error: null });
      },
    };
    return node;
  }

  const db = {
    from: (table: string) => {
      if (table === "threads") return threadsChain();
      if (table === "messages") {
        const node: Record<string, unknown> = {};
        for (const m of ["select", "eq", "in", "order", "limit"]) node[m] = () => node;
        node.maybeSingle = () => Promise.resolve({ data: messages.length ? messages[messages.length - 1] : null, error: null });
        node.then = (resolve: (v: unknown) => void) => resolve({ data: messages, error: null });
        node.insert = (row: Record<string, unknown>) => {
          insertedMessages.push(row);
          messages.push(row);
          return Promise.resolve({ error: null });
        };
        return node;
      }
      if (table === "artifacts") {
        const node: Record<string, unknown> = {};
        for (const m of ["select", "eq", "in", "order", "limit"]) node[m] = () => node;
        const value = { data: [{ kind: "domain", value: "fingerprint.to", confidence: 0.75, source: "whois_lookup", created_at: now.toISOString() }], error: null, count: 1 };
        node.maybeSingle = () => Promise.resolve(value);
        node.then = (resolve: (v: unknown) => void) => resolve(value);
        return node;
      }
      if (table === "artifact_reviews") {
        const node: Record<string, unknown> = {};
        for (const m of ["select", "eq"]) node[m] = () => node;
        node.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
        return node;
      }
      throw new Error(`unexpected table in fake db: ${table}`);
    },
  } as unknown as ReturnType<typeof createClient>;

  return { db, insertedMessages, messages, threadRow };
}

Deno.test("recovery vs live finalization: a report arriving during the claim must NOT leave the thread Interrupted", async () => {
  const now = new Date();
  const { db, insertedMessages, threadRow } = buildFakeDbLiveFinalize("t-live-final", "u1", now);

  const res = await recoverStaleThreadById(db, "t-live-final", { now, reason: "sweep A" });

  assertEquals(insertedMessages.length, 0, "the real report must suppress the recovery stub");
  assertEquals(res.recovered, false, "this is not a recovery — a durable report exists");
  // THE ACTUAL BLOCKER: the claim must be RELEASED, not merely un-stubbed.
  assertEquals(threadRow.recovered_at, null, "recovered_at must be cleared or the run renders Interrupted");
  assertEquals(threadRow.recovery_reason, null, "recovery_reason must be cleared");
  assertEquals(threadRow.status, "finished", "status stays terminal — the run really is over");
});

Deno.test("an already-durable report is atomically closed as a clean completion", async () => {
  const now = new Date("2026-07-28T16:00:00.000Z");
  const { db, insertedMessages, threadRow } = buildFakeDbLiveFinalize("t-report-present", "u1", now, true);

  const res = await recoverStaleThreadById(db, "t-report-present", {
    now,
    reason: "stale heartbeat recovered by health sweep",
  });

  assertEquals(insertedMessages.length, 0, "the existing durable report suppresses a recovery stub");
  assertEquals(res.recovered, false, "a durable report is a clean completion, not a recovery");
  assertEquals(threadRow.status, "finished", "the conditional active-status claim still closes the thread");
  assertEquals(threadRow.recovered_at, null, "clean completion must not carry recovery metadata");
  assertEquals(threadRow.recovery_reason, null, "clean completion must not render Interrupted");
});

Deno.test("a non-report early close preserves interruption metadata", async () => {
  const now = new Date("2026-07-28T16:00:00.000Z");
  const { db, insertedMessages, messages, threadRow } = buildFakeDbLiveFinalize("t-recent-assistant", "u1", now, true);
  messages[0].parts = [{ type: "text", text: "I am checking one more source now." }];

  const res = await recoverStaleThreadById(db, "t-recent-assistant", {
    now,
    reason: "stale heartbeat recovered by health sweep",
  });

  assertEquals(insertedMessages.length, 0, "a recent assistant suppresses the recovery stub");
  assertEquals(res.recovered, true, "a non-report early close remains an interrupted recovery");
  assertEquals(threadRow.status, "finished");
  assertEquals(threadRow.recovered_at, now.toISOString());
  assertEquals(threadRow.recovery_reason, "stale heartbeat recovered by health sweep");
});

Deno.test("recovery release only clears its OWN claim, never another worker's", async () => {
  const now = new Date();
  const { db, threadRow } = buildFakeDbLiveFinalize("t-live-final-2", "u1", now);
  // Simulate a DIFFERENT worker's claim already stamped on the row. The release
  // UPDATE is keyed on our exact recovered_at + recovery_reason, so it must not match.
  await recoverStaleThreadById(db, "t-live-final-2", { now, reason: "sweep A" });
  threadRow.recovered_at = "2020-01-01T00:00:00.000Z";
  threadRow.recovery_reason = "someone else's claim";

  const { db: db2, threadRow: row2 } = buildFakeDbLiveFinalize("t-live-final-3", "u1", now);
  row2.recovered_at = "2020-01-01T00:00:00.000Z";
  row2.recovery_reason = "someone else's claim";
  row2.status = "finished"; // already terminal → our claim cannot match
  const res = await recoverStaleThreadById(db2, "t-live-final-3", { now, reason: "sweep B" });
  assertEquals(res.recovered, false, "cannot claim an already-terminal thread");
  assertEquals(row2.recovered_at, "2020-01-01T00:00:00.000Z", "another worker's claim is untouched");
  assertEquals(row2.recovery_reason, "someone else's claim");
});
