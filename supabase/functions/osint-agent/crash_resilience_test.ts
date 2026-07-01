// crash_resilience_test.ts — Phase 1 (MissingToolResults crash) regression tests.
//
//  T1: a throwing tool returns a schema-safe, PAIRED error result (never throws),
//      so a sibling parallel-call batch is never orphaned — the exact condition
//      that produced "Tool results are missing for tool calls <id>". Covers BOTH
//      catch blocks in wrapToolsWithCache: the cached live path (socialfetch_lookup)
//      and the NO_CACHE path (triage_seed).
//  T4: the stream-error classifier matches the PLURAL stock MissingToolResults
//      message (the one MiniMax's truncated parallel calls actually emit), while
//      NOT misclassifying genuine provider/context errors.
//
// Resilience-only — touches no evidence-integrity logic.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { wrapToolsWithCache } from "./cache.ts";
import { isMessageSchemaError } from "./stream-error-classify.ts";
import { clearRuntime } from "./runtime-policy.ts";

type SupabaseClient = ReturnType<typeof createClient>;

// Minimal fake Supabase: every read chain resolves to a benign empty result and
// every write "succeeds", so the wrapper's cache/telemetry/evidence calls are inert
// no-ops and we isolate the tool-execution + catch paths.
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

Deno.test("Phase 1 (T1): a throwing tool returns a paired error result and does NOT orphan sibling calls", async () => {
  const threadId = "test-thread-crash-resilience-1";
  clearRuntime(threadId);
  const supabase = fakeSupabase();
  const tools: Record<string, Tool> = {
    // Cached live path (Block B): a live tool that throws mid-execution. The thrown
    // message embeds a fake secret so we also assert redaction.
    socialfetch_lookup: makeTool(() => {
      throw new Error("boom: upstream 500 leaked sk-secret123deadbeef");
    }),
    // Sibling successes fired in the SAME simulated parallel batch:
    dns_records: makeTool(() => Promise.resolve({ ok: true, records: ["1.2.3.4"] })),
    ip_intel: makeTool(() => Promise.resolve({ ok: true, asn: 15169 })),
    // NO_CACHE path (Block A): triage_seed ∈ NO_CACHE_TOOLS → the other catch block.
    triage_seed: makeTool(() => {
      throw new Error("triage boom");
    }),
  };
  const wrapped = wrapToolsWithCache(tools, {
    investigationId: threadId,
    userId: "u1",
    supabase,
    supabaseAdmin: supabase,
  });
  const opts = { toolCallId: "call", messages: [] };
  // Distinct selectors so nothing is deduped/suppressed; all fired concurrently to
  // mirror a single MiniMax step emitting parallel tool calls.
  const call = (name: string, input: unknown): Promise<unknown> => {
    const exec = wrapped[name].execute as (i: unknown, o: unknown) => Promise<unknown>;
    return exec(input, opts);
  };
  const results = await Promise.all([
    call("socialfetch_lookup", { username: "alice" }),
    call("dns_records", { domain: "example.com" }),
    call("ip_intel", { ip: "8.8.8.8" }),
    call("triage_seed", { seed: "alice@example.com" }),
  ]);

  // THE INVARIANT: Promise.all resolved — no member rejected, so no sibling call is
  // left without a result. That is precisely what prevents MissingToolResults.
  for (const r of results) assert(r && typeof r === "object", "every call must yield a result object");

  const [social, dns, ip, triage] = results as Array<Record<string, unknown>>;
  // Throwing live tool → schema-safe error result, not a throw.
  assertEquals(social.ok, false);
  assertEquals(social._tool_error, true);
  assert(typeof social.error === "string" && (social.error as string).length > 0);
  // Secret in the thrown message was redacted before it reached the result.
  assert(!(social.error as string).includes("sk-secret123deadbeef"), "secret must be redacted");
  // Siblings succeeded untouched.
  assertEquals(dns.ok, true);
  assertEquals(ip.ok, true);
  // NO_CACHE-path throw also returns a schema-safe error, not a throw.
  assertEquals(triage.ok, false);
  assertEquals(triage._tool_error, true);

  clearRuntime(threadId);
});

Deno.test("Phase 1 (T4): stream classifier matches the PLURAL MissingToolResults message, not genuine provider errors", () => {
  // The message MiniMax's truncated parallel tool calls actually produce (plural).
  assert(isMessageSchemaError("Tool results are missing for tool calls call_abc_1, call_abc_2"));
  // Singular form still matches (regression guard — it was the only prior match).
  assert(isMessageSchemaError("Tool result is missing for tool call call_abc"));
  // ModelMessage schema + error-name forms.
  assert(isMessageSchemaError("messages do not match the ModelMessage[] schema"));
  assert(isMessageSchemaError("anything", "AI_MissingToolResultsError"));
  assert(isMessageSchemaError("anything", "AI_InvalidPromptError"));

  // Genuine provider/context errors must NOT be misclassified (we must not mask them).
  assertEquals(isMessageSchemaError("Provider returned error: 429 rate limit"), false);
  assertEquals(isMessageSchemaError("context window exceeded (2013)"), false);
  assertEquals(isMessageSchemaError("fetch failed: ECONNRESET"), false);
});
