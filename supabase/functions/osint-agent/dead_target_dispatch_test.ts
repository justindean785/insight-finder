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
import { DEAD_TARGET_REFUSAL_ERROR, DEAD_TARGET_REFUSAL_MARKER } from "./lib/dead-target.ts";

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

/** `tool_usage_log` holds N failed rows for socialfetch_web_read on DEAD_URL. */
function fakeSupabase(opts: { failures: number; logError?: boolean }): SupabaseClient {
  const usageRows = Array.from({ length: opts.failures }, () => ({
    tool_name: "socialfetch_web_read", outcome: "failed", input_json: { url: DEAD_URL },
  }));
  const inert = makeChain({ data: [], error: null });
  inert.insert = () => Promise.resolve({ error: null });
  inert.upsert = () => Promise.resolve({ error: null });
  const usage = makeChain(opts.logError ? { data: null, error: { message: "boom" } } : { data: usageRows, error: null });
  usage.insert = () => Promise.resolve({ error: null });
  return {
    from: (t: string) => (t === "tool_usage_log" ? usage : inert),
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
