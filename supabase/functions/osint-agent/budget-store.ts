/**
 * budget-store.ts — durable persistence for the per-investigation tool-call budget.
 *
 * `runtime-policy.ts` owns the counters and the admission decision; this module is
 * the only thing that knows they live in Postgres. The split is deliberate:
 * runtime-policy.ts is imported by the FRONTEND test suite (src/test/runtime-policy.test.ts)
 * and must stay free of `npm:` specifiers and of any database dependency.
 *
 * Contract with runtime-policy.ts:
 *   - `loadThreadRunBudget` is awaited once, at request setup, and its result fed
 *     to `hydrateRuntimeBudget`.
 *   - `createBudgetWriter(...).queue` is registered as the `BudgetPersister`. It is
 *     called SYNCHRONOUSLY from `startCall` and must never throw or block.
 *   - `flush()` is awaited at run teardown so the last few calls of a run land even
 *     though the writer debounces.
 *
 * Everything here fails OPEN and loud: a read failure hydrates nothing (the run
 * proceeds with whatever the isolate already had, worst case zero) and a write
 * failure is logged and dropped. Under-counting spend during a database outage is
 * a cost problem; refusing an analyst's paid call because telemetry is down is a
 * product outage. See `docs/design/thread-run-budget.md`.
 */

import type { RuntimeBudgetSnapshot } from "./runtime-policy.ts";

type DbResult = { data?: unknown; error?: unknown };

/**
 * The two calls this module makes, and nothing else.
 *
 * Declared structurally rather than as `ReturnType<typeof createClient>` for two
 * reasons: the untyped supabase-js client types `rpc`'s params as `undefined`
 * without generated Database types (so the real client cannot be passed to a
 * strictly-typed signature at all), and a two-method interface means the tests
 * exercise the real read/write paths against a fake instead of mocking a module.
 * `index.ts` casts its admin client to this at the single call site.
 */
export interface BudgetDbClient {
  rpc(fn: string, params: Record<string, unknown>): PromiseLike<DbResult>;
  from(table: string): {
    select(columns: string): {
      eq(column: string, value: string): {
        maybeSingle(): PromiseLike<DbResult>;
      };
    };
  };
}

/** Minimum gap between two writes for the same thread. Writes coalesce to the most
 *  recent snapshot, so this bounds a ~90-call run to roughly a dozen round trips
 *  instead of ninety. The cost of the debounce is the ceiling on how much spend an
 *  abrupt isolate kill can lose — at MIN_START_GAP_MS=100 and 3-way concurrency
 *  that is a handful of calls, against the ~36 the old per-request reset lost every
 *  single time. `flush()` bypasses the wait. */
export const BUDGET_WRITE_DEBOUNCE_MS = 400;

/** Defensive ceiling on how many distinct tool keys are carried in/out of the DB.
 *  The catalog is ~90 tools; anything past this is corruption, not a bigger run. */
export const MAX_TRACKED_TOOLS = 500;

function toCount(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

/** Coerce a database row's `tool_counts` into a clean {tool: positiveInt} map. */
export function normalizeToolCounts(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  let kept = 0;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || kept >= MAX_TRACKED_TOOLS) continue;
    const n = toCount(value);
    if (n <= 0) continue;
    out[key] = n;
    kept++;
  }
  return out;
}

/**
 * Read a thread's persisted spend. Returns `null` when there is nothing to
 * hydrate — no row yet (a brand-new investigation), or a failed read.
 *
 * `null` is deliberately indistinguishable from "no spend" to the caller, because
 * `hydrateRuntimeBudget` is monotonic: a null hydrates nothing and therefore cannot
 * lower a counter the isolate already holds.
 */
export async function loadThreadRunBudget(
  client: BudgetDbClient,
  threadId: string,
): Promise<RuntimeBudgetSnapshot | null> {
  try {
    const { data, error } = await client
      .from("thread_run_budget")
      .select("total_calls,paid_calls,tool_counts")
      .eq("thread_id", threadId)
      .maybeSingle();
    if (error) {
      // Includes the case where the migration has not been applied yet (relation
      // does not exist). Loud, but not fatal: the run continues uncapped-as-before
      // rather than failing closed on a schema lag.
      console.warn(JSON.stringify({
        event: "run_budget_hydrate_failed",
        thread_id: threadId,
        error: String((error as { message?: string }).message ?? error),
      }));
      return null;
    }
    if (!data) return null;
    const row = data as { total_calls?: unknown; paid_calls?: unknown; tool_counts?: unknown };
    return {
      totalCalls: toCount(row.total_calls),
      paidCalls: toCount(row.paid_calls),
      toolCounts: normalizeToolCounts(row.tool_counts),
    };
  } catch (e) {
    console.warn(JSON.stringify({
      event: "run_budget_hydrate_threw",
      thread_id: threadId,
      error: String(e),
    }));
    return null;
  }
}

export interface BudgetWriter {
  /** Synchronous, non-throwing, coalescing. Safe to call on every admitted call. */
  queue(snapshot: RuntimeBudgetSnapshot): void;
  /** Await every queued snapshot, skipping the debounce. Call once at teardown. */
  flush(): Promise<void>;
  /** Diagnostics for tests and the run-forensics log. */
  stats(): { writes: number; coalesced: number; failures: number; lastError: string | null };
}

export interface BudgetWriterOptions {
  debounceMs?: number;
  /** Injected in tests. Defaults to the `bump_thread_run_budget` RPC. */
  write?: (snapshot: RuntimeBudgetSnapshot) => Promise<void>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Build the coalescing, fire-and-forget writer for one thread.
 *
 * Coalescing rule: `queue` only ever REPLACES the pending snapshot. Snapshots are
 * cumulative totals, not deltas, so dropping an intermediate one loses nothing —
 * and `bump_thread_run_budget` merges with GREATEST, so an out-of-order or replayed
 * write cannot lower a counter either. Those two facts together are what make it
 * safe to drop writes on the floor under load.
 */
export function createBudgetWriter(
  client: BudgetDbClient,
  threadId: string,
  options: BudgetWriterOptions = {},
): BudgetWriter {
  const debounceMs = options.debounceMs ?? BUDGET_WRITE_DEBOUNCE_MS;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const write = options.write ?? (async (snapshot: RuntimeBudgetSnapshot) => {
    const { error } = await client.rpc("bump_thread_run_budget", {
      p_thread_id: threadId,
      p_total: snapshot.totalCalls,
      p_paid: snapshot.paidCalls,
      p_tool_counts: snapshot.toolCounts,
    });
    if (error) throw new Error(String((error as { message?: string }).message ?? error));
  });

  let pending: RuntimeBudgetSnapshot | null = null;
  let running = false;
  let flushing = false;
  let lastWriteAt = -Infinity;
  let loop: Promise<void> = Promise.resolve();
  const stats = { writes: 0, coalesced: 0, failures: 0, lastError: null as string | null };

  async function runLoop(): Promise<void> {
    // Yield BEFORE touching anything. An async function body runs synchronously up
    // to its first await, and the first debounce check evaluates to "no wait", so
    // without this the very first write would be *initiated* — request building and
    // all — inside the synchronous startCall that queued it. queue() must return to
    // the tool-admission path having done no work at all.
    await Promise.resolve();
    try {
      while (pending) {
        const wait = flushing ? 0 : debounceMs - (now() - lastWriteAt);
        if (wait > 0) await sleep(wait);
        const snapshot = pending;
        pending = null;
        lastWriteAt = now();
        try {
          await write(snapshot);
          stats.writes++;
        } catch (e) {
          stats.failures++;
          stats.lastError = String(e);
          console.warn(JSON.stringify({
            event: "run_budget_write_failed",
            thread_id: threadId,
            error: stats.lastError,
          }));
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    queue(snapshot: RuntimeBudgetSnapshot): void {
      try {
        if (pending) stats.coalesced++;
        pending = {
          totalCalls: toCount(snapshot.totalCalls),
          paidCalls: toCount(snapshot.paidCalls),
          toolCounts: normalizeToolCounts(snapshot.toolCounts),
        };
        if (!running) {
          running = true;
          loop = runLoop();
        }
      } catch {
        // queue() is called from startCall and is contractually non-throwing.
      }
    },
    async flush(): Promise<void> {
      flushing = true;
      try {
        // `running` is set synchronously by queue(), so a non-null `pending`
        // always implies a live loop — this cannot spin.
        while (running || pending) {
          if (!running && pending) {
            running = true;
            loop = runLoop();
          }
          await loop;
        }
      } finally {
        flushing = false;
      }
    },
    stats() {
      return { ...stats };
    },
  };
}
