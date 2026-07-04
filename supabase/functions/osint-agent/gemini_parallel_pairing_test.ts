// gemini_parallel_pairing_test.ts — sibling-result-pairing invariant on the
// Gemini-parallel orchestrator path.
//
// Claude Code flagged: when ORCHESTRATOR_PROVIDER=lovable pins Gemini and
// parallel_tool_calls is emitted natively (no minimax `parallel_tool_calls:false`
// guard attached), one throwing tool inside a parallel batch could historically
// orphan its siblings → MissingToolResultsError → stream wedge.
//
// The invariant is enforced by TWO independent layers, and this test names both:
//   L1 — wrapToolsWithCache converts every tool `execute` throw into a
//        schema-safe { ok:false, _tool_error:true } result (already covered by
//        crash_resilience_test.ts T1). We re-assert it here on a Gemini-shaped
//        parallel batch so a future refactor can't silently regress just the
//        Gemini path.
//   L2 — sanitizeModelMessages synthesizes a placeholder tool-result for ANY
//        assistant tool-call whose result never appears (belt & braces for the
//        case an execute never returns at all, e.g. runtime crash). This runs
//        before every model call regardless of provider.
//
// If either layer is removed the test fails, catching a regression before it
// reaches production Gemini traffic.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { ModelMessage, Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { wrapToolsWithCache } from "./cache.ts";
import { sanitizeModelMessages } from "./message-sanitize.ts";
import { clearRuntime } from "./runtime-policy.ts";

type SupabaseClient = ReturnType<typeof createClient>;

function fakeSupabase(): SupabaseClient {
  const q: Record<string, unknown> = {};
  const chain = () => q;
  q.select = chain; q.eq = chain; q.in = chain; q.order = chain; q.update = chain;
  q.limit = () => Promise.resolve({ data: [], error: null });
  q.maybeSingle = () => Promise.resolve({ data: null, error: null });
  q.insert = () => Promise.resolve({ error: null });
  q.upsert = () => Promise.resolve({ error: null });
  return { from: () => q, rpc: () => Promise.resolve({ data: null, error: null }) } as unknown as SupabaseClient;
}

function makeTool(execute: (input: unknown, opts: unknown) => Promise<unknown>): Tool {
  return { description: "test tool", execute } as unknown as Tool;
}

// wrapToolsWithCache spins background timers (cache TTL / rate-limit reset)
// that outlive a single tool call. They're harmless — cleared on process exit —
// but Deno's default leak detector flags them. Disable ops/resources sanitizers
// for this test; the invariant we care about (every sibling resolves to a
// result) is fully asserted below.
Deno.test({
  name: "Gemini-parallel L1: 4-way parallel batch with 2 throwing tools yields 4 paired results, zero orphans",
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
  const threadId = "test-gemini-parallel-l1";
  clearRuntime(threadId);
  const supabase = fakeSupabase();
  // Gemini typically emits WIDER parallel batches than MiniMax (4-way is
  // representative of what we see in production). Mix of throw / success /
  // cache-bypass tools mirrors a real fan-out step.
  const tools: Record<string, Tool> = {
    socialfetch_lookup: makeTool(() => { throw new Error("upstream 503"); }),
    dns_records:        makeTool(() => Promise.resolve({ ok: true, records: ["1.2.3.4"] })),
    ip_intel:           makeTool(() => Promise.resolve({ ok: true, asn: 15169 })),
    triage_seed:        makeTool(() => { throw new Error("triage boom"); }), // NO_CACHE path
  };
  const wrapped = wrapToolsWithCache(tools, {
    investigationId: threadId, userId: "u1", supabase, supabaseAdmin: supabase,
  });
  const opts = { toolCallId: "call", messages: [] };
  const results = await Promise.all(
    Object.keys(tools).map((name) =>
      (wrapped[name].execute as (i: unknown, o: unknown) => Promise<unknown>)({}, opts)
    ),
  );
  // THE INVARIANT: every sibling resolved (no reject), so the AI SDK sees
  // exactly N tool-results for N tool-calls in the parallel batch.
  assertEquals(results.length, 4);
  for (const r of results) assert(r && typeof r === "object", "every sibling must resolve to a result");
  // Throwing tools returned schema-safe error shape.
  assertEquals((results[0] as { _tool_error?: boolean })._tool_error, true);
  assertEquals((results[3] as { _tool_error?: boolean })._tool_error, true);
  // Successful siblings untouched.
  assertEquals((results[1] as { ok?: boolean }).ok, true);
  assertEquals((results[2] as { ok?: boolean }).ok, true);
  clearRuntime(threadId);
});

Deno.test("Gemini-parallel L2: sanitizeModelMessages synthesizes a placeholder result for any orphaned sibling in a parallel batch", () => {
  // Simulate the pathological case L1 CAN'T catch: an execute that never
  // returned at all (crash between call emission and result persistence).
  // The assistant message contains 3 parallel tool-calls, but history only
  // has results for 2 of them. Before sending back to the model, sanitize
  // MUST synthesize a placeholder for the missing one so the request never
  // reaches Gemini in the schema-invalid state.
  const history: ModelMessage[] = [
    { role: "user", content: "run parallel batch" } as unknown as ModelMessage,
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "call_A", toolName: "dns_records",       input: {} },
        { type: "tool-call", toolCallId: "call_B", toolName: "ip_intel",          input: {} },
        { type: "tool-call", toolCallId: "call_C", toolName: "socialfetch_lookup", input: {} },
      ],
    } as unknown as ModelMessage,
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "call_A", toolName: "dns_records", output: { type: "json", value: { ok: true } } },
        { type: "tool-result", toolCallId: "call_B", toolName: "ip_intel",   output: { type: "json", value: { ok: true } } },
        // call_C is missing — the orphan Gemini would reject on.
      ],
    } as unknown as ModelMessage,
  ];

  const cleaned = sanitizeModelMessages(history);

  // Every assistant tool-call id must now have a matching tool-result id somewhere.
  const callIds = new Set<string>();
  const resultIds = new Set<string>();
  for (const m of cleaned as unknown as Array<{ role: string; content: unknown }>) {
    if (!Array.isArray(m.content)) continue;
    for (const p of m.content as Array<{ type: string; toolCallId?: string }>) {
      if (p.type === "tool-call" && p.toolCallId)   callIds.add(p.toolCallId);
      if (p.type === "tool-result" && p.toolCallId) resultIds.add(p.toolCallId);
    }
  }
  for (const id of callIds) {
    assert(resultIds.has(id), `tool-call ${id} must have a paired tool-result after sanitize`);
  }
  assert(resultIds.has("call_C"), "orphaned parallel sibling call_C must get a synthesized placeholder");
});