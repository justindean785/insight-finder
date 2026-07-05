// gemini_parallel_pairing_test.ts — names and pins the sibling-result-pairing
// guarantee for the LOVABLE/GEMINI orchestrator path, which is the one path that
// runs WITHOUT the MiniMax-only `parallel_tool_calls: false` provider option
// (index.ts only attaches that constraint when `minimaxIsPrimary && !useFallback`
// — see ORCHESTRATOR_PARALLEL_TOOL_CALLS). When Gemini is primary/fallback it is
// free to emit several tool-calls in a single step, so this is the one path where
// a throwing/never-resolving sibling could actually produce the
// "Tool results are missing for tool calls" crash in production.
//
// crash_resilience_test.ts' T1 already proves wrapToolsWithCache never lets a
// throw escape (provider-agnostic). This file adds the two angles that are
// specific to the newly-live Gemini-parallel path and were NOT separately named
// or pinned anywhere:
//
//  L1: a batch WIDER than the current concurrency cap (MAX_CONCURRENT_CALLS=10,
//      raised from 6 in the Gemini speed pass) with thrown members mixed in —
//      proves the queue-not-kill concurrency policy (runtime-policy.ts
//      startCall/finishCall) never turns into a dropped/orphaned sibling once
//      calls start queueing.
//  L2: sanitizeModelMessages' belt-and-braces layer for the case
//      wrapToolsWithCache CANNOT catch — a tool execute() that never settles at
//      all (no throw, no timeout race lost) — proving a SINGLE assistant message
//      that fires MULTIPLE parallel tool-calls (the exact shape Gemini emits,
//      vs. the single-call shape already covered in message_sanitize_test.ts)
//      gets a synthesized placeholder for every unresolved sibling, not just one.
//
// Resilience-only — touches no evidence-integrity logic.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { wrapToolsWithCache } from "./cache.ts";
import { sanitizeModelMessages } from "./message-sanitize.ts";
import { clearRuntime, MAX_CONCURRENT_CALLS } from "./runtime-policy.ts";

type SupabaseClient = ReturnType<typeof createClient>;

function fakeSupabase(): SupabaseClient {
  const q: Record<string, unknown> = {};
  const chain = () => q;
  q.select = chain;
  q.eq = chain;
  q.in = chain;
  q.order = chain;
  q.update = chain;
  q.limit = () => Promise.resolve({ data: [], error: null });
  q.maybeSingle = () => Promise.resolve({ data: null, error: null });
  q.insert = () => Promise.resolve({ error: null });
  q.upsert = () => Promise.resolve({ error: null });
  return {
    from: () => q,
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as unknown as SupabaseClient;
}

function makeTool(execute: (input: unknown, opts: unknown) => Promise<unknown>): Tool {
  return { description: "test tool", execute } as unknown as Tool;
}

Deno.test("Gemini-parallel L1: a batch wider than MAX_CONCURRENT_CALLS, with throwing members, still pairs every result (queue never drops a sibling)", async () => {
  const threadId = "test-thread-gemini-parallel-l1";
  clearRuntime(threadId);
  const supabase = fakeSupabase();
  // One batch bigger than the concurrency cap so several calls MUST queue
  // (runtime-policy's waitMs path) rather than run immediately — the exact
  // condition the Gemini speed pass introduced by raising MAX_CONCURRENT_CALLS.
  const batchSize = MAX_CONCURRENT_CALLS + 2;
  const tools: Record<string, Tool> = {};
  for (let i = 0; i < batchSize; i++) {
    const name = `pivot_tool_${i}`;
    // Every 3rd tool throws mid-execution; the rest resolve normally.
    tools[name] = i % 3 === 0
      ? makeTool(() => { throw new Error(`boom from ${name}`); })
      : makeTool(() => Promise.resolve({ ok: true, tool: name }));
  }
  const wrapped = wrapToolsWithCache(tools, {
    investigationId: threadId,
    userId: "u1",
    supabase,
    supabaseAdmin: supabase,
  });
  const opts = { toolCallId: "call", messages: [] };
  // Fire the whole batch concurrently, mirroring a single Gemini step that
  // emits `batchSize` parallel tool-calls in one assistant message.
  const calls = Object.keys(tools).map((name, i) => {
    const exec = wrapped[name].execute as (i: unknown, o: unknown) => Promise<unknown>;
    return exec({ selector: `seed-${i}` }, opts);
  });
  const results = await Promise.all(calls);

  // THE INVARIANT: Promise.all resolved for the FULL oversized batch — nothing
  // rejected and nothing hung, so no assistant tool-call in this step is left
  // without a matching tool-result.
  assertEquals(results.length, batchSize);
  for (const r of results) assert(r && typeof r === "object", "every queued/live call must yield a result object");

  const thrown = results.filter((r) => (r as Record<string, unknown>)._tool_error === true);
  const ok = results.filter((r) => (r as Record<string, unknown>).ok === true);
  assertEquals(thrown.length, Math.ceil(batchSize / 3));
  assertEquals(ok.length, batchSize - thrown.length);

  clearRuntime(threadId);
});

Deno.test("Gemini-parallel L2: one assistant message firing MULTIPLE parallel tool-calls gets a placeholder for every unresolved sibling, not just the first", () => {
  // The shape a single Gemini step actually produces: one assistant message,
  // three tool-call parts. History only carries a result for the middle one
  // (e.g. the run was cut off after 1 of 3 sibling results synthesized/persisted).
  const partiallyResolved: import("npm:ai@6").ModelMessage[] = [
    { role: "user", content: "seed" },
    {
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "c1", toolName: "dns_records", input: {} },
        { type: "tool-call", toolCallId: "c2", toolName: "ip_intel", input: {} },
        { type: "tool-call", toolCallId: "c3", toolName: "whois_lookup", input: {} },
      ],
    },
    {
      role: "tool",
      content: [
        { type: "tool-result", toolCallId: "c2", toolName: "ip_intel", output: { type: "json", value: { ok: true } } },
      ],
    },
  ] as unknown as import("npm:ai@6").ModelMessage[];

  const out = sanitizeModelMessages(partiallyResolved);

  // Every tool-call id must resolve to EXACTLY one tool-result across the
  // sanitized history — c1 and c3 via synthesized placeholders, c2 via its
  // real (untouched) result.
  const resultIds: string[] = [];
  for (const m of out) {
    if (m.role !== "tool" || !Array.isArray(m.content)) continue;
    for (const p of m.content as Array<{ type?: string; toolCallId?: string }>) {
      if (p.type === "tool-result" && typeof p.toolCallId === "string") resultIds.push(p.toolCallId);
    }
  }
  assertEquals(new Set(resultIds).size, 3, "all three sibling tool-calls must have exactly one tool-result each");
  assert(resultIds.includes("c1") && resultIds.includes("c2") && resultIds.includes("c3"));

  // c2's real result must survive untouched (not overwritten by a placeholder).
  const c2Part = out
    .flatMap((m) => (m.role === "tool" && Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : []))
    .find((p) => p.toolCallId === "c2") as { output?: { type?: string; value?: unknown } } | undefined;
  assertEquals(c2Part?.output, { type: "json", value: { ok: true } });

  // c1 and c3 got synthesized placeholders (proves ALL unresolved siblings are
  // covered in one pass, not just the first one found).
  const placeholderIds = out
    .flatMap((m) => (m.role === "tool" && Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : []))
    .filter((p) => (p.output as { value?: unknown } | undefined)?.value === "[result dropped to fit context]")
    .map((p) => p.toolCallId);
  assertEquals(new Set(placeholderIds), new Set(["c1", "c3"]));
});
