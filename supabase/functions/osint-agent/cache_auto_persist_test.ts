// cache_auto_persist_test.ts — per-tool-call auto-persist hook in wrapToolsWithCache.
//
// WHY THIS HOOK EXISTS: onStepFinish (index.ts) only fires once an entire step
// completes. If the isolate is CPU-killed mid-step — e.g. partway through a batch
// of parallel tool calls the model requested — onStepFinish never runs for that
// step, so even calls that already completed successfully are lost (confirmed in
// production: thread 9d2e0e6b, 42 tool calls including several with real,
// extractable output, 0 artifacts, 0 assistant messages, CPU-killed before any
// step boundary completed). persistLiveFindings (wired into BOTH execute paths in
// wrapToolsWithCache) persists the instant each call lands, independent of step
// boundaries. These tests exercise the real wrap path (not the pure extractor
// directly), asserting what actually lands in the `artifacts` table.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { wrapToolsWithCache } from "./cache.ts";
import { clearRuntime } from "./runtime-policy.ts";

type SupabaseClient = ReturnType<typeof createClient>;

// A query-builder double that is BOTH chainable (every filter/modifier method
// returns itself, so arbitrarily long chains like .select().eq().eq() work) AND
// thenable (awaiting it at any point in the chain resolves to `resolveValue`,
// matching how supabase-js query builders are themselves awaitable promises).
function makeChain(resolveValue: { data: unknown; error: unknown }): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "update", "limit"]) node[m] = () => node;
  node.maybeSingle = () => Promise.resolve(resolveValue);
  node.then = (resolve: (v: { data: unknown; error: unknown }) => void) => resolve(resolveValue);
  return node;
}

// Per-table fake: `artifacts` selects return no existing rows (empty dedup set);
// `artifacts` inserts are counted and captured. Every other table (tool_usage_log,
// tool_call_cache, threads, reviews, ...) resolves to an empty/no-op success so the
// wrapper's unrelated bookkeeping (circuit breaker, selector-reuse, reviews) never
// throws or logs spurious warnings.
function fakeSupabase(onArtifactsInsert: (rows: Array<Record<string, unknown>>) => void): SupabaseClient {
  const inertChain = makeChain({ data: [], error: null });
  inertChain.insert = () => Promise.resolve({ error: null });
  inertChain.upsert = () => Promise.resolve({ error: null });

  const artifactsTable = makeChain({ data: [], error: null }); // no prior artifacts → empty seen set
  artifactsTable.insert = (rows: Array<Record<string, unknown>>) => {
    onArtifactsInsert(rows);
    return Promise.resolve({ error: null });
  };

  return {
    from: (table: string) => (table === "artifacts" ? artifactsTable : inertChain),
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as unknown as SupabaseClient;
}

function makeTool(execute: (input: unknown, opts: unknown) => Promise<unknown>): Tool {
  return { description: "test tool", execute } as unknown as Tool;
}

async function runOnce(
  toolName: string,
  threadId: string,
  impl: () => unknown,
): Promise<{ inserted: Array<Record<string, unknown>> }> {
  clearRuntime(threadId);
  const inserted: Array<Record<string, unknown>> = [];
  const supabase = fakeSupabase((rows) => inserted.push(...rows));
  const wrapped = wrapToolsWithCache({
    [toolName]: makeTool(async () => impl()),
  }, {
    investigationId: threadId,
    userId: `u-${threadId}`,
    supabase,
    supabaseAdmin: supabase,
  });
  const execute = wrapped[toolName].execute as (input: unknown, opts: unknown) => Promise<unknown>;
  // Mirrors cache_write_guard_test.ts's proven-working input shape: `force: true`
  // bypasses runtime/circuit-breaker gating so the call reaches the real execute
  // (and this hook) instead of being skipped before it ever runs.
  const input = { value: `${threadId}-probe`, purpose: "probe", force: true };
  await execute(input, { toolCallId: `${threadId}-1`, messages: [] });
  clearRuntime(threadId);
  return { inserted };
}

Deno.test("auto-persist: a github_user success persists an artifact via the LIVE (non-cache) execute path", async () => {
  const { inserted } = await runOnce(
    "github_user",
    "live-github",
    () => ({ ok: true, user: { login: "octocat", html_url: "https://github.com/octocat" } }),
  );
  assertEquals(inserted.length >= 1, true, "extractFindings(github_user) should surface at least the github_account");
  const kinds = inserted.map((r) => r.kind).sort();
  assertEquals(kinds.includes("github_account"), true);
});

Deno.test("auto-persist: a denylisted tool (jina_reader_scrape) never persists, even with URL-shaped output", async () => {
  const { inserted } = await runOnce(
    "jina_reader_scrape",
    "live-jina",
    () => ({ ok: true, url: "https://example.com/profile", citations: [{ url: "https://example.com/profile" }] }),
  );
  assertEquals(inserted.length, 0, "denylisted tools must never auto-persist regardless of shape");
});

Deno.test("auto-persist: a non-matching successful shape persists nothing (no false positives)", async () => {
  const { inserted } = await runOnce(
    "oathnet_lookup",
    "live-oathnet",
    () => ({ ok: true, clean: true, checked: "xoxo_tvera" }),
  );
  assertEquals(inserted.length, 0);
});

Deno.test("auto-persist: a failed call (ok:false) never persists", async () => {
  const { inserted } = await runOnce(
    "github_user",
    "live-github-fail",
    () => ({ ok: false, error: "not found" }),
  );
  assertEquals(inserted.length, 0, "a failure must never be treated as a finding even if shaped like one");
});
