// provider_exec_test.ts — the SHARED provider-execution primitive (PR #305 #1/#4).
// Proves the controls the anchor path previously bypassed: success charges credits +
// writes one tool_usage_log row; failure charges nothing; a fresh cache hit replays
// free without calling the provider; a tripped circuit skips (and charges nothing).
// Run: deno test --no-check --allow-env provider_exec_test.ts
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { executeProvider } from "./provider-exec.ts";
import * as circuit from "./circuit.ts";

interface Cap { usage: Array<{ t: string; r: Record<string, unknown> }>; cache: unknown[] }
function fakeAdmin(cap: Cap, cacheHit?: unknown) {
  const filter = { eq: () => filter, limit: () => Promise.resolve({ data: cacheHit ? [{ output_json: cacheHit, expires_at: null }] : [], error: null }) };
  return {
    from: (t: string) => ({
      insert: (r: unknown) => { cap.usage.push({ t, r: r as Record<string, unknown> }); return Promise.resolve({ error: null }); },
      upsert: (r: unknown) => { cap.cache.push(r); return Promise.resolve({ error: null }); },
      select: () => filter,
    }),
  };
}
const OPTS = { operation: "anchor_profile_read", provider: "socialfetch", selectorType: "username", selectorValue: "u", cacheInput: { op: "profile", handle: "u" } };

Deno.test("success: charges credits (once) and writes one truthful tool_usage_log row", async () => {
  const thread = "pe-ok"; circuit.clearThread(thread);
  const cap: Cap = { usage: [], cache: [] };
  const costs: number[] = [];
  const res = await executeProvider(
    (_s) => Promise.resolve({ ok: true, data: 1 }),
    { userId: "u1", threadId: thread, onCost: (m) => costs.push(m), adminDb: fakeAdmin(cap) },
    OPTS,
  );
  assert(res.ok && !res.cached && !res.skipped);
  assertEquals(res.charged, 3000, "anchor_profile_read priced at the SocialFetch cost");
  assertEquals(costs, [3000], "debited exactly once");
  const row = cap.usage.find((u) => u.r.tool_name === "anchor_profile_read")!.r;
  assertEquals(row.charged_micro_usd, 3000);
  assertEquals(row.ok, true);
  assert(cap.cache.length === 1, "success writes cache-back");
  circuit.clearThread(thread);
});

Deno.test("failure: NO charge, still logs a failed row", async () => {
  const thread = "pe-fail"; circuit.clearThread(thread);
  const cap: Cap = { usage: [], cache: [] };
  const costs: number[] = [];
  const res = await executeProvider(
    (_s) => Promise.resolve({ ok: false, error: "socialfetch 500", status: 500 }),
    { userId: "u1", threadId: thread, onCost: (m) => costs.push(m), adminDb: fakeAdmin(cap) },
    OPTS,
  );
  assertEquals(res.ok, false);
  assertEquals(res.charged, 0, "no charge on failure");
  assertEquals(costs.length, 0);
  const row = cap.usage.find((u) => u.r.tool_name === "anchor_profile_read")!.r;
  assertEquals(row.charged_micro_usd, 0);
  assertEquals(cap.cache.length, 0, "no cache-back on failure");
  circuit.clearThread(thread);
});

Deno.test("cache hit: replays free, does NOT call the provider", async () => {
  const thread = "pe-cache"; circuit.clearThread(thread);
  const cap: Cap = { usage: [], cache: [] };
  const costs: number[] = [];
  let called = false;
  const res = await executeProvider(
    (_s) => { called = true; return Promise.resolve({ ok: true, data: "fresh" }); },
    { userId: "u1", threadId: thread, onCost: (m) => costs.push(m), adminDb: fakeAdmin(cap, { ok: true, data: "cached" }) },
    OPTS,
  );
  assertEquals(res.cached, true);
  assertEquals(res.charged, 0, "cache hit is free");
  assertEquals(called, false, "provider not called on a cache hit");
  assertEquals(costs.length, 0);
  circuit.clearThread(thread);
});

Deno.test("circuit tripped: skips, charges nothing, does NOT call the provider", async () => {
  const thread = "pe-circuit"; circuit.clearThread(thread);
  circuit.disableTool(thread, "anchor_profile_read", "test-disable");
  const cap: Cap = { usage: [], cache: [] };
  const costs: number[] = [];
  let called = false;
  const res = await executeProvider(
    (_s) => { called = true; return Promise.resolve({ ok: true }); },
    { userId: "u1", threadId: thread, onCost: (m) => costs.push(m), adminDb: fakeAdmin(cap) },
    OPTS,
  );
  assertEquals(res.skipped, true);
  assertEquals(res.charged, 0);
  assertEquals(called, false, "provider not called when the circuit is open");
  assertEquals(costs.length, 0);
  circuit.clearThread(thread);
});
