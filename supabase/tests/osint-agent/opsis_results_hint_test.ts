// opsis_results_hint_test.ts — a refused opsis_results run id gets a HINT from the thread's own un-read runs; the
// mismatch refusal itself stays fail-closed. Synthetic selectors and run ids only.
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { wrapToolsWithCache } from "../../functions/osint-agent/cache.ts";
import { clearRuntime } from "../../functions/osint-agent/runtime-policy.ts";
import * as circuit from "../../functions/osint-agent/circuit.ts";
import { opsisResults, type OpsisDeps } from "../../functions/osint-agent/lib/opsis.ts";
import {
  clearOpsisGuardThread,
  OPSIS_HINT_NOTE_SEARCH,
  opsisResultsHint,
  opsisResultsHintSelfTest,
  uncollectedOpsisRuns,
  type OpsisPendingRun,
} from "../../functions/osint-agent/lib/opsis-search-guard.ts";

type SupabaseClient = ReturnType<typeof createClient>;
type Exec = { execute: (i: unknown, o: unknown) => Promise<Record<string, unknown>> };
const KILL = "OPSIS_RESULTS_HINT_DISABLED";

const A: OpsisPendingRun = { run_id: "run-a", kind: "username", value: "Example_User" };
const B: OpsisPendingRun = { run_id: "run-b", kind: "username", value: "other_user" };
const C: OpsisPendingRun = { run_id: "run-c", kind: "username", value: "example_user" };

Deno.test("exactly one un-read run for the exact selector is named; the requested id is never its own replacement", () => {
  const h = opsisResultsHint([A, B], "username", "  EXAMPLE_USER ", "run-wrong");
  assert(h.run_hint === "use_run");
  assertEquals(h.replacement_run_id, "run-a");
  assertEquals(h.read_with, { tool: "opsis_results", run_id: "run-a", kind: "username", value: "Example_User" });
  assertEquals(opsisResultsHint([A], "username", "example_user", "run-a").run_hint, "search_needed");
});

Deno.test("zero, several, a different kind, or a blank selector → no run id, only the paid-search pointer", () => {
  for (const [pending, kind, value] of [
    [[B], "username", "example_user"],
    [[A, C], "username", "example_user"],
    [[A], "email", "example_user"],
    [[A], "username", ""],
    [[], "username", "example_user"],
  ] as Array<[OpsisPendingRun[], string, string]>) {
    const h = opsisResultsHint(pending, kind, value, "run-wrong");
    assertEquals(h.run_hint, "search_needed");
    assertEquals(h.note, OPSIS_HINT_NOTE_SEARCH);
    assertFalse(JSON.stringify(h).includes("run-"), "no run id is offered");
  }
});

Deno.test("a fully-duplicated run id counts once (history + registry union)", () => {
  const h = opsisResultsHint([A, { ...A }], "username", "example_user", "x");
  assertEquals(h.run_hint, "use_run");
});

Deno.test("the mismatch check itself is unchanged: another selector's run is still refused, fail-closed", async () => {
  const deps: OpsisDeps = {
    apiKey: "k", disabled: false, now: () => 1, sleep: () => Promise.resolve(),
    fetch: () => Promise.resolve(new Response(JSON.stringify({ run_id: "run-x", status: "completed", type: "username", query: "someone_else", results: [] }), { status: 200 })),
  };
  const out = await opsisResults({ kind: "username", value: "example_user", run_id: "run-x" }, deps);
  assertEquals(out.ok, false);
  assertEquals(out.code, "selector_mismatch");
  assertFalse("results" in out && Array.isArray(out.results) && out.results.length > 0);
});

// ── the real wrapper ─────────────────────────────────────────────────────

function chain(v: { data: unknown; error: unknown }): Record<string, unknown> {
  const n: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "update", "limit", "range"]) n[m] = () => n;
  n.maybeSingle = () => Promise.resolve(v);
  n.then = (r: (x: { data: unknown; error: unknown }) => void) => r(v);
  n.insert = () => Promise.resolve({ error: null });
  n.upsert = () => Promise.resolve({ error: null });
  return n;
}
const db = () => ({ from: () => chain({ data: [], error: null }), rpc: () => Promise.resolve({ data: null, error: null }) }) as unknown as SupabaseClient;

let seq = 0;
function harness(replayed: OpsisPendingRun[], mismatchCode = "selector_mismatch") {
  seq += 1;
  const investigationId = `55555555-6666-4777-8888-${String(seq).padStart(12, "0")}`;
  clearRuntime(investigationId);
  circuit.clearThread(investigationId);
  clearOpsisGuardThread(investigationId);
  const results = {
    description: "opsis_results stand-in",
    // refuses any run id that is not run-a for username/example_user
    execute: (i: { run_id: string }) => Promise.resolve(
      i.run_id === "run-a"
        ? { ok: true, source: "opsis", run_id: i.run_id, run_status: "completed", complete: true, results: [] }
        : { ok: false, error: "opsis run belongs to a different selector", code: mismatchCode, run_id: i.run_id },
    ),
  } as unknown as Tool;
  const wrapped = wrapToolsWithCache({ opsis_results: results }, {
    investigationId, userId: "hint-user", supabase: db(), pendingOpsisRuns: () => replayed, remainingRunMs: () => 600_000,
  });
  return { exec: (wrapped.opsis_results as unknown as Exec).execute, investigationId };
}
let callSeq = 0;
const o = () => ({ toolCallId: `h${++callSeq}`, messages: [] });
const ask = { kind: "username", value: "example_user", run_id: "run-wrong" };

Deno.test("wrapper: a refused id with exactly one matching un-read run carries the replacement, and the replacement stays un-read", async () => {
  const h = harness([A, B]);
  const out = await h.exec(ask, o());
  assertEquals(out.ok, false);
  assertEquals(out.code, "selector_mismatch");
  assertEquals(out.run_hint, "use_run");
  assertEquals(out.replacement_run_id, "run-a");
  assertEquals(out.run_id, "run-wrong", "top-level run_id is still the refused one, so only IT is retired");
  const still = uncollectedOpsisRuns(h.investigationId, [A, B]).map((r) => r.run_id);
  assert(still.includes("run-a"));
});

Deno.test("wrapper: no unique match → a search_needed pointer, no run id, and no search is started", async () => {
  const h = harness([B]);
  const out = await h.exec(ask, o());
  assertEquals(out.run_hint, "search_needed");
  assertFalse("replacement_run_id" in out);
});

Deno.test("wrapper: an unknown run (not_found) is hinted too; other failures and successes are untouched", async () => {
  assertEquals((await harness([A], "not_found").exec(ask, o())).run_hint, "use_run");
  assertEquals((await harness([A], "unavailable").exec(ask, o())).run_hint, undefined);
  const ok = await harness([A]).exec({ ...ask, run_id: "run-a" }, o());
  assertEquals(ok.ok, true);
  assertEquals(ok.run_hint, undefined);
});

Deno.test("kill switch removes the hint; the refusal is unchanged", async () => {
  Deno.env.set(KILL, "true");
  try {
    const out = await harness([A]).exec(ask, o());
    assertEquals(out.code, "selector_mismatch");
    assertEquals(out.run_hint, undefined);
    assert(opsisResultsHintSelfTest().detail.startsWith("LEGACY"));
  } finally {
    Deno.env.delete(KILL);
  }
});

Deno.test("self-test passes and reports its switch", () => {
  const t = opsisResultsHintSelfTest();
  assert(t.ok, t.detail);
  assertEquals(t.switch, "OPSIS_RESULTS_HINT_DISABLED=false");
});
