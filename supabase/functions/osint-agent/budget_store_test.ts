/**
 * budget_store_test.ts — the durable per-investigation budget writer.
 *
 * These tests exist because the writer sits on the tool-admission hot path. Three
 * properties matter more than the happy path, and each has a test that FAILS if the
 * property is removed:
 *   - `queue` never throws and never blocks (startCall is synchronous)
 *   - a write failure is absorbed, not propagated
 *   - `flush` actually lands the LAST snapshot, not merely the ones that already
 *     escaped the debounce
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  type BudgetDbClient,
  BUDGET_WRITE_DEBOUNCE_MS,
  createBudgetWriter,
  loadThreadRunBudget,
  MAX_TRACKED_TOOLS,
  normalizeToolCounts,
} from "./budget-store.ts";
import type { RuntimeBudgetSnapshot } from "./runtime-policy.ts";

const THREAD = "11111111-1111-1111-1111-111111111111";

function snap(total: number, paid: number, tools: Record<string, number> = {}): RuntimeBudgetSnapshot {
  return { totalCalls: total, paidCalls: paid, toolCounts: tools };
}

/** Fake clock whose only way to advance is `sleep` — so a test that forgets to
 *  await the debounce cannot accidentally pass by wall-clock drift. */
function fakeTime() {
  let t = 1_000_000;
  return {
    now: () => t,
    sleep: (ms: number) => {
      t += ms;
      return Promise.resolve();
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function fakeDb(handlers: {
  row?: unknown;
  selectError?: unknown;
  selectThrows?: boolean;
  onRpc?: (params: Record<string, unknown>) => DbReply;
} = {}): BudgetDbClient {
  return {
    rpc(_fn: string, params: Record<string, unknown>) {
      return Promise.resolve(handlers.onRpc ? handlers.onRpc(params) : {});
    },
    from(_table: string) {
      return {
        select(_cols: string) {
          return {
            eq(_col: string, _val: string) {
              return {
                maybeSingle() {
                  if (handlers.selectThrows) throw new Error("boom");
                  return Promise.resolve({
                    data: handlers.row ?? null,
                    error: handlers.selectError ?? null,
                  });
                },
              };
            },
          };
        },
      };
    },
  };
}
type DbReply = { data?: unknown; error?: unknown };

// ---------------------------------------------------------------------------
// normalizeToolCounts — the DB-boundary coercion
// ---------------------------------------------------------------------------

Deno.test("normalizeToolCounts keeps only positive integer counts", () => {
  assertEquals(
    normalizeToolCounts({ a: 3, b: "4", c: 0, d: -2, e: null, f: 2.9, g: "x" }),
    { a: 3, b: 4, f: 2 },
  );
});

Deno.test("normalizeToolCounts rejects non-objects and arrays", () => {
  for (const bad of [null, undefined, 7, "s", [1, 2], true]) {
    assertEquals(normalizeToolCounts(bad), {}, `should reject ${JSON.stringify(bad)}`);
  }
});

Deno.test("normalizeToolCounts caps the key count", () => {
  const huge: Record<string, number> = {};
  for (let i = 0; i < MAX_TRACKED_TOOLS + 50; i++) huge[`tool_${i}`] = 1;
  assertEquals(Object.keys(normalizeToolCounts(huge)).length, MAX_TRACKED_TOOLS);
});

// ---------------------------------------------------------------------------
// loadThreadRunBudget — hydration must FAIL OPEN
// ---------------------------------------------------------------------------

Deno.test("loadThreadRunBudget maps a row", async () => {
  const got = await loadThreadRunBudget(
    fakeDb({ row: { total_calls: 40, paid_calls: 18, tool_counts: { serus_darkweb_scan: 3 } } }),
    THREAD,
  );
  assertEquals(got, { totalCalls: 40, paidCalls: 18, toolCounts: { serus_darkweb_scan: 3 } });
});

Deno.test("loadThreadRunBudget returns null when there is no row (new investigation)", async () => {
  assertEquals(await loadThreadRunBudget(fakeDb({ row: null }), THREAD), null);
});

/** Capture console.warn for the duration of `fn`. "Fails open" is only half the
 *  contract — the other half is "and loudly", so the operator can tell a silent
 *  zero-budget hydrate apart from a genuinely new investigation. */
async function captureWarnings(fn: () => Promise<void>): Promise<string[]> {
  const original = console.warn;
  const lines: string[] = [];
  console.warn = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  try {
    await fn();
  } finally {
    console.warn = original;
  }
  return lines;
}

Deno.test("loadThreadRunBudget FAILS OPEN, and LOUDLY, on a db error", async () => {
  // The migration lags the function deploy in this project's topology (mirror sync
  // ships code; the SQL is applied separately). A relation-does-not-exist read must
  // degrade to "hydrate nothing", never to a refused run.
  let got: unknown = "unset";
  const warnings = await captureWarnings(async () => {
    got = await loadThreadRunBudget(
      fakeDb({ selectError: { message: 'relation "public.thread_run_budget" does not exist' } }),
      THREAD,
    );
  });
  assertEquals(got, null);
  assertEquals(warnings.length, 1, "a swallowed read failure must still be reported");
  assert(warnings[0].includes("run_budget_hydrate_failed"), warnings[0]);
  assert(warnings[0].includes("does not exist"), "the underlying cause must survive into the log");
});

Deno.test("loadThreadRunBudget FAILS OPEN, and LOUDLY, when the client throws", async () => {
  let got: unknown = "unset";
  const warnings = await captureWarnings(async () => {
    got = await loadThreadRunBudget(fakeDb({ selectThrows: true }), THREAD);
  });
  assertEquals(got, null, "a throwing client must not reject out of hydration");
  assertEquals(warnings.length, 1);
  assert(warnings[0].includes("run_budget_hydrate_threw"), warnings[0]);
});

Deno.test("a clean read does NOT warn — the loud path must stay diagnostic", async () => {
  const warnings = await captureWarnings(async () => {
    await loadThreadRunBudget(fakeDb({ row: { total_calls: 1, paid_calls: 1 } }), THREAD);
    await loadThreadRunBudget(fakeDb({ row: null }), THREAD);
  });
  assertEquals(warnings, []);
});

// ---------------------------------------------------------------------------
// createBudgetWriter
// ---------------------------------------------------------------------------

Deno.test("queue is synchronous and non-blocking — it returns before any write runs", () => {
  let started = false;
  const w = createBudgetWriter(fakeDb(), THREAD, {
    write: () => {
      started = true;
      return Promise.resolve();
    },
  });
  w.queue(snap(1, 1));
  // If queue awaited anything, `started` would already be true here.
  assertEquals(started, false, "queue must not run the write synchronously");
});

Deno.test("flush lands the LAST snapshot and coalesces the ones in between", async () => {
  const seen: RuntimeBudgetSnapshot[] = [];
  const clock = fakeTime();
  const w = createBudgetWriter(fakeDb(), THREAD, {
    now: clock.now,
    sleep: clock.sleep,
    write: (s) => {
      seen.push(s);
      return Promise.resolve();
    },
  });
  for (let i = 1; i <= 10; i++) w.queue(snap(i, i, { alpha: i }));
  await w.flush();

  assert(seen.length >= 1, "at least one write must happen");
  assert(seen.length < 10, `writes must coalesce, got ${seen.length} for 10 queued snapshots`);
  assertEquals(seen[seen.length - 1], snap(10, 10, { alpha: 10 }), "the final state must be durable");
  assert(w.stats().coalesced > 0, "coalescing must be counted");
});

Deno.test("a write failure is absorbed — flush resolves and later writes still run", async () => {
  let n = 0;
  const clock = fakeTime();
  const w = createBudgetWriter(fakeDb(), THREAD, {
    now: clock.now,
    sleep: clock.sleep,
    write: () => {
      n++;
      return n === 1 ? Promise.reject(new Error("db down")) : Promise.resolve();
    },
  });
  w.queue(snap(1, 1));
  await w.flush(); // must NOT reject
  assertEquals(w.stats().failures, 1);
  assert((w.stats().lastError ?? "").includes("db down"));

  w.queue(snap(2, 2));
  await w.flush();
  assertEquals(w.stats().writes, 1, "the run keeps accounting after a transient failure");
});

Deno.test("the rpc payload matches bump_thread_run_budget's signature", async () => {
  let params: Record<string, unknown> | null = null;
  const clock = fakeTime();
  const w = createBudgetWriter(
    fakeDb({
      onRpc: (p) => {
        params = p;
        return {};
      },
    }),
    THREAD,
    { now: clock.now, sleep: clock.sleep },
  );
  w.queue(snap(7, 3, { oathnet_lookup: 2 }));
  await w.flush();
  assertEquals(params, {
    p_thread_id: THREAD,
    p_total: 7,
    p_paid: 3,
    p_tool_counts: { oathnet_lookup: 2 },
  });
});

Deno.test("an rpc error surfaces as a counted failure, not a thrown flush", async () => {
  const clock = fakeTime();
  const w = createBudgetWriter(
    fakeDb({ onRpc: () => ({ error: { message: "permission denied" } }) }),
    THREAD,
    { now: clock.now, sleep: clock.sleep },
  );
  w.queue(snap(1, 1));
  await w.flush();
  assertEquals(w.stats().writes, 0);
  assertEquals(w.stats().failures, 1);
  assert((w.stats().lastError ?? "").includes("permission denied"));
});

Deno.test("queue sanitizes what it is handed", async () => {
  const seen: RuntimeBudgetSnapshot[] = [];
  const clock = fakeTime();
  const w = createBudgetWriter(fakeDb(), THREAD, {
    now: clock.now,
    sleep: clock.sleep,
    write: (s) => {
      seen.push(s);
      return Promise.resolve();
    },
  });
  w.queue({ totalCalls: -5, paidCalls: NaN, toolCounts: { a: -1, b: 3 } } as RuntimeBudgetSnapshot);
  await w.flush();
  assertEquals(seen[0], { totalCalls: 0, paidCalls: 0, toolCounts: { b: 3 } });
});

/** Yield to the macrotask queue so the writer's background loop can run a turn
 *  WITHOUT flush() — the only way to observe the debounce, since flush skips it. */
const yieldToLoop = () => new Promise<void>((r) => setTimeout(r, 0));

Deno.test("the background loop pays the debounce; flush skips it", async () => {
  const clock = fakeTime();
  const sleepRequests: number[] = [];
  const mk = () =>
    createBudgetWriter(fakeDb(), THREAD, {
      now: clock.now,
      sleep: (ms) => {
        sleepRequests.push(ms);
        return clock.sleep(ms);
      },
      write: () => Promise.resolve(),
    });

  const w = mk();
  w.queue(snap(1, 1));
  await yieldToLoop();
  assertEquals(sleepRequests, [], "the first write of a run must not be delayed");

  // Second snapshot, driven by the background loop rather than flush().
  w.queue(snap(2, 2));
  await yieldToLoop();
  assertEquals(
    sleepRequests,
    [BUDGET_WRITE_DEBOUNCE_MS],
    "a follow-up write must wait out the debounce",
  );

  // Third snapshot, driven by flush() — no further sleep.
  w.queue(snap(3, 3));
  await w.flush();
  assertEquals(
    sleepRequests,
    [BUDGET_WRITE_DEBOUNCE_MS],
    "flush must bypass the debounce so end-of-run spend is not lost to a timer",
  );
  assertEquals(w.stats().writes, 3);
});
