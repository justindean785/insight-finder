// provider_exec_test.ts — the SHARED provider-execution primitive (PR #305 #1/#4).
// Proves the controls the anchor path previously bypassed: success charges credits +
// writes one tool_usage_log row; failure charges nothing; a fresh cache hit replays
// free without calling the provider; a tripped circuit skips (and charges nothing).
// Also covers findings #1 (cache TTL) and #2 (timeout classification reachability).
// Run: deno test --no-check --allow-env provider_exec_test.ts
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { executeProvider } from "./provider-exec.ts";
import * as circuit from "./circuit.ts";
import { DEFAULT_TOOL_TTL_MS } from "./validation.ts";

interface Cap { usage: Array<{ t: string; r: Record<string, unknown> }>; cache: Array<Record<string, unknown>> }
function fakeAdmin(cap: Cap, cacheHit?: unknown, cacheHitExpiresAt: string | null = null) {
  const filter = { eq: () => filter, limit: () => Promise.resolve({ data: cacheHit ? [{ output_json: cacheHit, expires_at: cacheHitExpiresAt }] : [], error: null }) };
  return {
    from: (t: string) => ({
      insert: (r: unknown) => { cap.usage.push({ t, r: r as Record<string, unknown> }); return Promise.resolve({ error: null }); },
      upsert: (r: unknown) => { cap.cache.push(r as Record<string, unknown>); return Promise.resolve({ error: null }); },
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

// ── Finding #1: successful cache write MUST carry an expiry ─────────────────
Deno.test("finding #1: a successful write sets expires_at ~24h out (the canonical DEFAULT_TOOL_TTL_MS)", async () => {
  const thread = "pe-ttl"; circuit.clearThread(thread);
  const cap: Cap = { usage: [], cache: [] };
  const before = Date.now();
  await executeProvider(
    (_s) => Promise.resolve({ ok: true, data: 1 }),
    { userId: "u1", threadId: thread, onCost: () => {}, adminDb: fakeAdmin(cap) },
    OPTS,
  );
  assertEquals(cap.cache.length, 1);
  const expiresAt = cap.cache[0].expires_at as string | null;
  assert(expiresAt !== null && expiresAt !== undefined, "expires_at must be set on a successful write — a null expiry is treated as fresh forever");
  const deltaMs = new Date(expiresAt).getTime() - before;
  // Within a generous window of the canonical 24h TTL (allows for test execution time).
  assert(Math.abs(deltaMs - DEFAULT_TOOL_TTL_MS) < 60_000, `expected ~${DEFAULT_TOOL_TTL_MS}ms TTL, got ${deltaMs}ms`);
  circuit.clearThread(thread);
});

Deno.test("finding #1: a FRESH cache entry (expires_at in the future) replays without calling the provider", async () => {
  const thread = "pe-fresh"; circuit.clearThread(thread);
  const cap: Cap = { usage: [], cache: [] };
  const futureIso = new Date(Date.now() + 60_000).toISOString();
  let called = false;
  const res = await executeProvider(
    (_s) => { called = true; return Promise.resolve({ ok: true, data: "fresh-fetch" }); },
    { userId: "u1", threadId: thread, onCost: () => {}, adminDb: fakeAdmin(cap, { ok: true, data: "cached" }, futureIso) },
    OPTS,
  );
  assertEquals(res.cached, true);
  assertEquals(called, false, "a genuinely fresh (future expiry) entry must not re-call the provider");
  circuit.clearThread(thread);
});

Deno.test("finding #1: an EXPIRED cache entry (expires_at in the past) is rejected as stale — re-fetches from the provider", async () => {
  const thread = "pe-expired"; circuit.clearThread(thread);
  const cap: Cap = { usage: [], cache: [] };
  const pastIso = new Date(Date.now() - 60_000).toISOString();
  let called = false;
  const res = await executeProvider(
    (_s) => { called = true; return Promise.resolve({ ok: true, data: "fresh-fetch" }); },
    { userId: "u1", threadId: thread, onCost: () => {}, adminDb: fakeAdmin(cap, { ok: true, data: "stale-cached" }, pastIso) },
    OPTS,
  );
  assertEquals(res.cached, false, "an expired entry must NOT be reported as a cache hit");
  assertEquals(called, true, "an expired entry must trigger a real provider call, not reuse stale data");
  assert(res.ok);
  circuit.clearThread(thread);
});

// ── Finding #2: timeout classification must be REACHABLE ────────────────────
Deno.test("finding #2: a genuine abort (factory rethrows on signal.aborted, matching the readProfile/readSerp fix) is classified as a timeout", async () => {
  const thread = "pe-timeout"; circuit.clearThread(thread);
  const cap: Cap = { usage: [], cache: [] };
  const costs: number[] = [];
  const res = await executeProvider(
    (signal) =>
      new Promise((_resolve, reject) => {
        // Never resolves on its own — only the timeout's abort ends it, exactly
        // like readProfile/readSerp's fetch call racing the executor's AbortSignal.
        signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      }),
    { userId: "u1", threadId: thread, onCost: (m) => costs.push(m), adminDb: fakeAdmin(cap) },
    { ...OPTS, timeoutMs: 20 },
  );
  assertEquals(res.ok, false, "a timed-out call is not ok");
  assertEquals(res.charged, 0, "timeout billing stays zero, same as any other failure");
  assertEquals(costs.length, 0);
  const result = res.result as { _tool_timeout?: boolean; error?: string } | null;
  assert(result?._tool_timeout === true, "the timeout wrapper must actually be reached and set _tool_timeout — this is the branch findings #2 proved was unreachable when the provider swallowed its own AbortError");
  assert(typeof result?.error === "string" && result.error.includes("timeout"), "the error message must say timeout, not a generic/opaque failure");
  circuit.clearThread(thread);
});

Deno.test("finding #2: an ordinary provider failure (no abort involved) is NOT misclassified as a timeout", async () => {
  const thread = "pe-ordinary-fail"; circuit.clearThread(thread);
  const cap: Cap = { usage: [], cache: [] };
  const res = await executeProvider(
    (_signal) => Promise.resolve({ ok: false, error: "socialfetch 503", status: 503 }),
    { userId: "u1", threadId: thread, onCost: () => {}, adminDb: fakeAdmin(cap) },
    { ...OPTS, timeoutMs: 5_000 },
  );
  assertEquals(res.ok, false);
  const result = res.result as { _tool_timeout?: boolean } | null;
  assert(!result?._tool_timeout, "an ordinary provider error must never be classified as a timeout");
  circuit.clearThread(thread);
});

Deno.test("finding #2: success under a generous timeout is unaffected", async () => {
  const thread = "pe-timeout-success"; circuit.clearThread(thread);
  const cap: Cap = { usage: [], cache: [] };
  const res = await executeProvider(
    (_signal) => Promise.resolve({ ok: true, data: "fine" }),
    { userId: "u1", threadId: thread, onCost: () => {}, adminDb: fakeAdmin(cap) },
    { ...OPTS, timeoutMs: 5_000 },
  );
  assertEquals(res.ok, true);
  const result = res.result as { _tool_timeout?: boolean } | null;
  assert(!result?._tool_timeout);
  circuit.clearThread(thread);
});
