// cache_write_guard_test.ts — the #310 write-guard merge-blocker.
//
// #310 changed the cache-write predicate from `if (ok && hash && key)` to
// `if (isCacheableToolResult(result) && hash && key)`, dropping the authoritative
// operational-success gate (`ok = deriveOk(result)`). This restores BOTH gates:
//   if (ok && isCacheableToolResult(result) && hash && key)
// so a result is cached only when it is a genuine success (deriveOk) AND a usable,
// non-skip result (isCacheableToolResult). These tests exercise the real WRITE PATH
// through wrapToolsWithCache (not just the pure predicate), asserting what actually
// lands in the LRU + durable cache.
//
// Signals: `cacheUpserts` (durable write attempts) is AUTHORITATIVE for "was it
// cached" — the LRU write (TOOL_CACHE_LRU.set) and the durable upsert share ONE
// guarded block, so cacheUpserts===0 proves NEITHER cache was written. `executions`
// proves replay for CACHED results (2nd call served from LRU ⇒ executions stays 1),
// but is unreliable for failures: a genuine ok:false failure trips the circuit
// breaker, which suppresses the retry independently of caching (so a not-cached
// failure can still show executions===1). Skips do NOT trip the breaker, so
// executions===2 is meaningful there.
import { assertEquals } from "jsr:@std/assert@^1";
import type { Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { wrapToolsWithCache } from "./cache.ts";
import { clearRuntime } from "./runtime-policy.ts";

type SupabaseClient = ReturnType<typeof createClient>;

// Durable cache is empty on read (maybeSingle/select → null); upserts are counted.
function fakeSupabase(onUpsert: () => void): SupabaseClient {
  const q: Record<string, unknown> = {};
  const chain = () => q;
  q.select = chain;
  q.eq = chain;
  q.in = chain;
  q.order = chain;
  q.update = chain;
  q.limit = chain;
  q.maybeSingle = () => Promise.resolve({ data: null, error: null });
  q.insert = () => Promise.resolve({ error: null });
  q.upsert = () => {
    onUpsert();
    return Promise.resolve({ error: null });
  };
  return {
    from: () => q,
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as unknown as SupabaseClient;
}

function makeTool(execute: (input: unknown, opts: unknown) => Promise<unknown>): Tool {
  return { description: "test tool", execute } as unknown as Tool;
}

// Drive the same input through the wrapped tool twice and report how many times the
// underlying tool actually ran + how many durable upserts were attempted.
async function runTwice(
  toolName: string,
  threadId: string,
  impl: () => unknown,
): Promise<{ executions: number; cacheUpserts: number }> {
  clearRuntime(threadId);
  let executions = 0;
  let cacheUpserts = 0;
  const supabase = fakeSupabase(() => cacheUpserts++);
  const wrapped = wrapToolsWithCache({
    [toolName]: makeTool(async () => {
      executions++;
      return impl();
    }),
  }, {
    investigationId: threadId,
    userId: `u-${threadId}`,
    supabase,
    supabaseAdmin: supabase,
  });
  const execute = wrapped[toolName].execute as (input: unknown, opts: unknown) => Promise<unknown>;
  const input = { domain: `${threadId}.example`, purpose: "probe", force: true };
  await execute(input, { toolCallId: `${threadId}-1`, messages: [] });
  clearRuntime(threadId);
  await execute(input, { toolCallId: `${threadId}-2`, messages: [] });
  clearRuntime(threadId);
  return { executions, cacheUpserts };
}

// ---- ordinary success caches + replays -------------------------------------------

Deno.test("write-guard: an ordinary successful result caches and replays", async () => {
  const { executions, cacheUpserts } = await runTwice(
    "dns_records",
    "wg-success",
    () => ({ ok: true, records: ["1.2.3.4"] }),
  );
  assertEquals(executions, 1, "the 2nd call must be served from cache (not re-executed)");
  assertEquals(cacheUpserts, 1, "a successful result is persisted durably once");
});

// ---- intentional skip: live twice, no LRU/durable --------------------------------

Deno.test("write-guard: an intentional skip retries live and writes no cache entry", async () => {
  const { executions, cacheUpserts } = await runTwice(
    "dns_records",
    "wg-skip",
    () => ({ ok: false, skipped: true, provider_unavailable: true, records: [] }),
  );
  assertEquals(executions, 2, "a skip must retry the provider, never replay");
  assertEquals(cacheUpserts, 0, "a skip is never persisted");
});

// ---- provider_unavailable: not cached (isCacheable half of the gate) --------------

Deno.test("write-guard: provider_unavailable is not cached even though deriveOk treats it as ok", async () => {
  // {provider_unavailable:true} with no ok/error → deriveOk=true (telemetry non-failure)
  // but isCacheableToolResult=false. The gate's isCacheable half must exclude it.
  const { cacheUpserts } = await runTwice(
    "dns_records",
    "wg-punavail",
    () => ({ provider_unavailable: true, records: [] }),
  );
  assertEquals(cacheUpserts, 0, "provider_unavailable is never persisted (nor written to the LRU)");
});

// ---- deriveOk=false ambiguous failure: not cached (authoritative ok half) ----------

Deno.test("write-guard: an ambiguous ok:false failure is not cached", async () => {
  // deriveOk=false → the authoritative `ok` gate excludes it. (isCacheableToolResult
  // also returns false here; a shape where isCacheable=true AND deriveOk=false cannot
  // occur under the current predicates, so the `ok &&` gate is drift-insurance: it
  // keeps cache-eligibility tied to the success signal even if the two predicates
  // later diverge.) cacheUpserts is authoritative here — the breaker may or may not
  // suppress the retry, so executions is not asserted.
  const { cacheUpserts } = await runTwice(
    "dns_records",
    "wg-ambiguous",
    () => ({ ok: false, records: [] }),
  );
  assertEquals(cacheUpserts, 0, "an ok:false failure is never persisted (nor written to the LRU)");
});

// ---- null raw result after wrapper normalization ---------------------------------

Deno.test("write-guard: a null raw result is not cached after normalization", async () => {
  // A tool that returns null normalizes to {value:null, _tier, _model, _runtime}.
  // Both deriveOk and the OLD isCacheableToolResult classified that as cacheable, so
  // it was cached+replayed (verified: cacheUpserts=1 before the fix). It must not be:
  // replaying an empty result suppresses a live retry.
  const { cacheUpserts } = await runTwice(
    "dns_records",
    "wg-null",
    () => null,
  );
  assertEquals(cacheUpserts, 0, "a null/degenerate result must not be persisted (nor LRU-cached)");
});

// ---- status-only: preserve legit target HTTP observations, exclude real failures --

Deno.test("write-guard: a successful observation of a 4xx target (bare status) still caches", async () => {
  // A tool that SUCCESSFULLY observes a target returning HTTP 404 is a usable finding
  // — the tool set ok:true and records the target's status as data. Must still cache.
  const { executions, cacheUpserts } = await runTwice(
    "http_fingerprint",
    "wg-target404",
    () => ({ ok: true, status: 404, url: "https://x.example", note: "target 404" }),
  );
  assertEquals(executions, 1, "a legit ok:true observation of a 4xx target must cache+replay");
  assertEquals(cacheUpserts, 1, "and be persisted once");
});

Deno.test("write-guard: an upstream 5xx failure (ok:false + status) is not cached", async () => {
  // ok:false → not cached. (executions may be 1 here: the failure trips the circuit
  // breaker, which suppresses the 2nd live call — that is NOT a cache replay, which is
  // why cacheUpserts, not executions, is the authoritative not-cached signal.)
  const { cacheUpserts } = await runTwice(
    "http_fingerprint",
    "wg-upstream500",
    () => ({ ok: false, status: 500, error: "upstream 500" }),
  );
  assertEquals(cacheUpserts, 0, "an ok:false upstream failure is never persisted");
});
