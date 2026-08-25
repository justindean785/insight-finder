// The in-flight markers must be released on EVERY exit path, including a throw
// in the window between marking and the live call.
//
// Root cause: markProviderInFlight / markCallInFlight are set before the pacing
// sleep, notePlanCall and ctx.onHeartbeat(), but the only clears live inside the
// live-call try/catch further down — and there is no `finally` on the path. So a
// throw in that window left the provider marked in-flight with nothing able to
// clear it: circuit.release() only drops the state at end of run. For the rest
// of the run, shouldRun() then reported that provider busy and every later call
// on it was skipped. Silently — no error surfaces, the run just stops using the
// provider.
//
// These tests DRIVE the shipped wrapper (wrapToolsWithCache), using onHeartbeat
// as the thrower because it sits inside the guarded window on the real path.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { wrapToolsWithCache } from "./cache.ts";
import { clearRuntime } from "./runtime-policy.ts";
import { shouldRun, clearThread } from "./circuit.ts";

type SupabaseClient = ReturnType<typeof createClient>;

function makeChain(resolveValue: { data: unknown; error: unknown }): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "update", "limit"]) node[m] = () => node;
  node.maybeSingle = () => Promise.resolve(resolveValue);
  node.then = (resolve: (v: { data: unknown; error: unknown }) => void) => resolve(resolveValue);
  return node;
}

function fakeSupabase(): SupabaseClient {
  const chain = makeChain({ data: [], error: null });
  chain.insert = () => Promise.resolve({ error: null });
  chain.upsert = () => Promise.resolve({ error: null });
  return { from: () => chain, rpc: () => Promise.resolve({ data: null, error: null }) } as unknown as SupabaseClient;
}

function makeTool(): Tool {
  return {
    description: "test tool",
    execute: async () => { await Promise.resolve(); return { ok: true }; },
  } as unknown as Tool;
}

Deno.test("in-flight leak: a throw before the live call must not strand the provider", async () => {
  const threadId = "inflight-leak-1";
  clearRuntime(threadId);
  clearThread(threadId);
  const supabase = fakeSupabase();

  const wrapped = wrapToolsWithCache({ dns_records: makeTool() }, {
    investigationId: threadId,
    userId: "u-leak",
    supabase,
    supabaseAdmin: supabase,
    // Throws inside the marked window, exactly where the real host callback runs.
    onHeartbeat: () => { throw new Error("heartbeat exploded"); },
  });
  const execute = wrapped.dns_records.execute as (i: unknown, o: unknown) => Promise<unknown>;

  // The executor must NOT throw. A throw here escapes into the live AI-SDK step
  // and orphans the sibling tool calls the model emitted alongside this one,
  // which surfaces as "Tool results are missing for tool calls <id>" and ends the
  // run with "Investigation ended early — partial results were saved". Both
  // sibling paths (the NO_CACHE wrapper and the live-call catch) already return
  // a schema-safe result for exactly this reason; this one must match them.
  let threw = false;
  let out: unknown;
  try {
    out = await execute({ domain: "leak-1.example", force: true }, { toolCallId: `${threadId}-1`, messages: [] });
  } catch {
    threw = true;
  }
  assert(!threw, "the executor must never throw — that orphans sibling tool calls and kills the run");

  const r = out as { ok?: boolean; _tool_error?: boolean; error?: string };
  assertEquals(r.ok, false, "the failure must still be reported, not swallowed into a fake success");
  assertEquals(r._tool_error, true, "it must be tagged as a tool error");
  assert(typeof r.error === "string" && r.error.length > 0, "the real cause must survive for telemetry");

  // The real assertion: the provider is usable again. Before the fix this
  // returned allow:false with a provider-busy reason for the rest of the run.
  const next = shouldRun(threadId, "dns_records", "leak-2.example");
  assertEquals(next.allow, true, `provider stranded in-flight after a throw: ${JSON.stringify(next)}`);
});

Deno.test("in-flight leak: a LATER call on the same provider still executes after the throw", async () => {
  const threadId = "inflight-leak-2";
  clearRuntime(threadId);
  clearThread(threadId);
  const supabase = fakeSupabase();

  let boom = true;
  let executions = 0;
  const tool = {
    description: "test tool",
    execute: async () => { executions++; await Promise.resolve(); return { ok: true }; },
  } as unknown as Tool;

  const wrapped = wrapToolsWithCache({ dns_records: tool }, {
    investigationId: threadId,
    userId: "u-leak-2",
    supabase,
    supabaseAdmin: supabase,
    onHeartbeat: () => { if (boom) throw new Error("heartbeat exploded"); },
  });
  const execute = wrapped.dns_records.execute as (i: unknown, o: unknown) => Promise<unknown>;

  try {
    await execute({ domain: "leak-a.example", force: true }, { toolCallId: `${threadId}-a`, messages: [] });
  } catch { /* expected */ }
  assertEquals(executions, 0, "the tool never ran — the throw happened before dispatch");

  // Same provider, fresh selector. This is the behaviour the leak destroyed.
  boom = false;
  await execute({ domain: "leak-b.example", force: true }, { toolCallId: `${threadId}-b`, messages: [] });
  assertEquals(executions, 1, "a later call on the same provider must still run after an earlier throw");
});

Deno.test("in-flight leak: the happy path is unchanged", async () => {
  const threadId = "inflight-leak-3";
  clearRuntime(threadId);
  clearThread(threadId);
  const supabase = fakeSupabase();
  let beats = 0;

  const wrapped = wrapToolsWithCache({ dns_records: makeTool() }, {
    investigationId: threadId,
    userId: "u-leak-3",
    supabase,
    supabaseAdmin: supabase,
    onHeartbeat: () => { beats++; },
  });
  const execute = wrapped.dns_records.execute as (i: unknown, o: unknown) => Promise<unknown>;

  const out = await execute({ domain: "ok.example", force: true }, { toolCallId: `${threadId}-1`, messages: [] });
  assert(out, "a normal call still returns a result");
  assertEquals(beats, 1, "the heartbeat still fires exactly once on the live path");
  assertEquals(shouldRun(threadId, "dns_records", "ok-2.example").allow, true, "provider released after success");
});
