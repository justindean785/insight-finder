// dead_target_dispatch_test.ts — the dead-target memory drives the REAL wrap path.
//
// The property that matters is "the tool never runs again on a target that
// already failed twice in this case", so these tests go through
// wrapToolsWithCache with a fake tool_usage_log, not the predicate in isolation.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { wrapToolsWithCache, isIntentionalSkip } from "./cache.ts";
import { clearRuntime } from "./runtime-policy.ts";
import * as circuit from "./circuit.ts";
import { DEAD_TARGET_REFUSAL_ERROR, DEAD_TARGET_REFUSAL_MARKER, DEAD_TARGET_PAGE } from "./lib/dead-target.ts";

type SupabaseClient = ReturnType<typeof createClient>;

const DEAD_URL = "https://youtube.com/@lildee808_first";
const LIVE_URL = "https://example.com/about";

function makeChain(resolveValue: { data: unknown; error: unknown }): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "update", "limit", "range"]) node[m] = () => node;
  node.maybeSingle = () => Promise.resolve(resolveValue);
  node.then = (r: (v: { data: unknown; error: unknown }) => void) => r(resolveValue);
  return node;
}

type UsageRowFixture = {
  tool_name: string;
  outcome: string;
  input_json: Record<string, unknown>;
  created_at?: string;
};

/**
 * A `tool_usage_log` chain that HONOURS `.range(from, to)`. The loader pages, and
 * a fake that ignores the range would return page 1 forever — every paging bug
 * would pass. This slices, so a loader that does not advance reads only page 1.
 */
function pagingUsageChain(
  rows: readonly UsageRowFixture[],
  error: { message: string } | null,
): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  let from = 0;
  let to = rows.length - 1;
  for (const m of ["select", "eq", "in", "order", "limit", "update"]) node[m] = () => node;
  node.range = (a: number, b: number) => { from = a; to = b; return node; };
  node.insert = () => Promise.resolve({ error: null });
  node.maybeSingle = () => Promise.resolve({ data: null, error });
  node.then = (r: (v: { data: unknown; error: unknown }) => void) =>
    r(error ? { data: null, error } : { data: rows.slice(from, to + 1), error: null });
  return node;
}

/** N failed rows for socialfetch_web_read on DEAD_URL, oldest first. */
function failures(n: number): UsageRowFixture[] {
  return Array.from({ length: n }, (_v, i) => ({
    tool_name: "socialfetch_web_read",
    outcome: "failed",
    input_json: { url: DEAD_URL },
    created_at: new Date(Date.UTC(2026, 8, 20, 0, 0, i)).toISOString(),
  }));
}

function fakeSupabase(opts: {
  failures?: number;
  rows?: readonly UsageRowFixture[];
  logError?: boolean;
  cacheRow?: { output_json: unknown; created_at: string } | null;
}): SupabaseClient {
  const usageRows = opts.rows ?? failures(opts.failures ?? 0);
  const inert = makeChain({ data: [], error: null });
  inert.insert = () => Promise.resolve({ error: null });
  inert.upsert = () => Promise.resolve({ error: null });
  const usage = pagingUsageChain(usageRows, opts.logError ? { message: "boom" } : null);
  const cache = makeChain({ data: opts.cacheRow ?? null, error: null });
  cache.insert = () => Promise.resolve({ error: null });
  cache.upsert = () => Promise.resolve({ error: null });
  return {
    from: (t: string) =>
      t === "tool_usage_log" ? usage : t === "tool_call_cache" ? cache : inert,
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as unknown as SupabaseClient;
}

function countingTool(calls: { n: number }): Tool {
  return {
    description: "test",
    execute: (_i: unknown, _o: unknown) => { calls.n += 1; return Promise.resolve({ ok: true, data: "page" }); },
  } as unknown as Tool;
}

let threadSeq = 0;
function wrap(calls: { n: number }, db: SupabaseClient) {
  threadSeq += 1;
  const investigationId = `33333333-4444-4555-8666-${String(threadSeq).padStart(12, "0")}`;
  clearRuntime(investigationId);
  circuit.clearThread(investigationId);
  return wrapToolsWithCache({ socialfetch_web_read: countingTool(calls) }, {
    investigationId, userId: "u1", supabase: db,
  });
}
type Exec = { execute: (i: unknown, o: unknown) => Promise<unknown> };

Deno.test("two prior failures on the same target ⇒ refused before the tool runs, as a governance skip", async () => {
  const calls = { n: 0 };
  const w = wrap(calls, fakeSupabase({ failures: 2 }));
  const r = await (w.socialfetch_web_read as unknown as Exec).execute({ url: DEAD_URL }, {}) as Record<string, unknown>;
  assertEquals(calls.n, 0, "the tool must not run");
  assertEquals(r.ok, false);
  assertEquals(r.refused_by, DEAD_TARGET_REFUSAL_MARKER);
  assertEquals(r.error, DEAD_TARGET_REFUSAL_ERROR);
  assert(isIntentionalSkip(r), "a dead-target refusal is an intentional skip, not a fault");
});

Deno.test("one prior failure is not enough, and a different target on the same tool still runs", async () => {
  const one = { n: 0 };
  const w1 = wrap(one, fakeSupabase({ failures: 1 }));
  await (w1.socialfetch_web_read as unknown as Exec).execute({ url: DEAD_URL }, {});
  assertEquals(one.n, 1);

  const other = { n: 0 };
  const w2 = wrap(other, fakeSupabase({ failures: 2 }));
  await (w2.socialfetch_web_read as unknown as Exec).execute({ url: LIVE_URL }, {});
  assertEquals(other.n, 1, "a live target is unaffected by a dead one");
});

Deno.test("force:true overrides — the analyst asking for a retry is the legitimate exception", async () => {
  const calls = { n: 0 };
  const w = wrap(calls, fakeSupabase({ failures: 5 }));
  await (w.socialfetch_web_read as unknown as Exec).execute({ url: DEAD_URL, force: true }, {});
  assertEquals(calls.n, 1);
});

Deno.test("kill switch DEAD_TARGET_MEMORY_DISABLED=true opens the gate at call time", async () => {
  Deno.env.set("DEAD_TARGET_MEMORY_DISABLED", "true");
  try {
    const calls = { n: 0 };
    const w = wrap(calls, fakeSupabase({ failures: 5 }));
    await (w.socialfetch_web_read as unknown as Exec).execute({ url: DEAD_URL }, {});
    assertEquals(calls.n, 1);
  } finally {
    Deno.env.delete("DEAD_TARGET_MEMORY_DISABLED");
  }
});

Deno.test("a failed log read FAILS OPEN — the tool runs", async () => {
  const calls = { n: 0 };
  const w = wrap(calls, fakeSupabase({ failures: 5, logError: true }));
  await (w.socialfetch_web_read as unknown as Exec).execute({ url: DEAD_URL }, {});
  assertEquals(calls.n, 1);
});

// ---- The three defects JD's review named, each driven through the real path ----

Deno.test("failure → failure → SUCCESS: the pair is live again and the tool runs", async () => {
  const calls = { n: 0 };
  const history = [
    ...failures(2),
    {
      tool_name: "socialfetch_web_read",
      outcome: "ok",
      input_json: { url: DEAD_URL },
      created_at: new Date(Date.UTC(2026, 8, 20, 1, 0, 0)).toISOString(),
    },
  ];
  const w = wrap(calls, fakeSupabase({ rows: history }));
  await (w.socialfetch_web_read as unknown as Exec).execute({ url: DEAD_URL }, {});
  assertEquals(calls.n, 1, "a later success clears the streak — this target is not dead");
});

Deno.test("failure → success → failure → failure: dead AGAIN, counted from the success", async () => {
  const calls = { n: 0 };
  const at = (h: number) => new Date(Date.UTC(2026, 8, 20, h, 0, 0)).toISOString();
  const row = (outcome: string, h: number) => ({
    tool_name: "socialfetch_web_read", outcome, input_json: { url: DEAD_URL }, created_at: at(h),
  });
  const w = wrap(calls, fakeSupabase({ rows: [row("failed", 0), row("ok", 1), row("failed", 2), row("failed", 3)] }));
  const r = await (w.socialfetch_web_read as unknown as Exec).execute({ url: DEAD_URL }, {}) as Record<string, unknown>;
  assertEquals(calls.n, 0);
  assertEquals(r.refused_by, DEAD_TARGET_REFUSAL_MARKER);
  assertEquals(r.prior_failures, 2, "the streak is counted from the success forward, not from the case start");
});

Deno.test("out-of-order rows are sorted before the streak is read", async () => {
  const calls = { n: 0 };
  const at = (h: number) => new Date(Date.UTC(2026, 8, 20, h, 0, 0)).toISOString();
  const row = (outcome: string, h: number) => ({
    tool_name: "socialfetch_web_read", outcome, input_json: { url: DEAD_URL }, created_at: at(h),
  });
  // Newest-first, as a mis-ordered read would deliver it: the success is LAST in
  // the array but FIRST in time, so a loader that trusted array order would reset
  // on it and wrongly let the two later failures pass.
  const w = wrap(calls, fakeSupabase({ rows: [row("failed", 3), row("failed", 2), row("ok", 1)] }));
  const r = await (w.socialfetch_web_read as unknown as Exec).execute({ url: DEAD_URL }, {}) as Record<string, unknown>;
  assertEquals(calls.n, 0);
  assertEquals(r.prior_failures, 2);
});

Deno.test("the history read PAGES: a success beyond page 1 still clears the streak", async () => {
  const calls = { n: 0 };
  // 500 failures fill page 1 exactly. The success is row 501, reachable only by a
  // loader that advances. A single unbounded/short read sees 500 failures and refuses.
  const history = [
    ...failures(DEAD_TARGET_PAGE),
    {
      tool_name: "socialfetch_web_read",
      outcome: "ok",
      input_json: { url: DEAD_URL },
      created_at: new Date(Date.UTC(2026, 8, 21, 0, 0, 0)).toISOString(),
    },
  ];
  assertEquals(history.length, DEAD_TARGET_PAGE + 1);
  const w = wrap(calls, fakeSupabase({ rows: history }));
  await (w.socialfetch_web_read as unknown as Exec).execute({ url: DEAD_URL }, {});
  assertEquals(calls.n, 1, "page 2 carried the success; a non-paging read would have refused");
});

Deno.test("a CACHE HIT on a dead target is still served — the gate sits below every cache layer", async () => {
  const calls = { n: 0 };
  const w = wrap(calls, fakeSupabase({
    failures: 5,
    cacheRow: { output_json: { ok: true, data: "cached page" }, created_at: new Date().toISOString() },
  }));
  const r = await (w.socialfetch_web_read as unknown as Exec).execute({ url: DEAD_URL }, {}) as Record<string, unknown>;
  assertEquals(calls.n, 0, "a replay never runs the tool");
  assertEquals(r.ok, true, "the cached result is returned, NOT a dead-target refusal");
  assertEquals(r.refused_by, undefined);
  assertEquals((r.data as unknown), "cached page");
});
