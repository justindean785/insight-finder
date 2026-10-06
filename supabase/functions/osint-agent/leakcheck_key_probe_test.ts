// leakcheck_key_probe_test.ts — /health can now say whether LeakCheck accepts our key, for free.
//
// The incident (2026-10-06): LEAKCHECK_API_KEY stopped being accepted on 2026-10-01 and nothing noticed for
// five days, because checks.credentials only learns from PAST paid lookups; after the key was replaced the
// fix could not be confirmed without spending a lookup on a real case.
//
// The two payloads below were captured from the LIVE LeakCheck API on 2026-10-06 (no real key involved):
//   no key         → HTTP 401 {"success": false, "error": "Missing X-API-Key header (read docs at …)"}
//   bogus key      → HTTP 401 {"success": false, "error": "Invalid X-API-Key"}      (the docs say 400 — they are wrong)
// and the key check happens BEFORE query validation: a bogus key on a 2-character query is still a 401.
//
// NOT verified here, and said so in the PR: a VALID key on the 2-character query answering HTTP 400 and costing
// no quota. That is the one assumption this probe rests on; the first deployed /health shows whether it holds.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  interpretLeakcheckProbe,
  LEAKCHECK_PROBE_RETRY_MS,
  LEAKCHECK_PROBE_TTL_MS,
  LEAKCHECK_PROBE_URL,
  probeLeakcheckKey,
  resetLeakcheckKeyProbeMemo,
} from "./lib/leakcheck-key-probe.ts";

const KEY = "0123456789abcdef0123456789abcdef01234567"; // synthetic, 40 chars like a real key
const SWITCH = "LEAKCHECK_KEY_PROBE_DISABLED";

async function withEnv<T>(key: string, value: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const prev = Deno.env.get(key);
  if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value);
  try { return await fn(); } finally {
    if (prev === undefined) Deno.env.delete(key); else Deno.env.set(key, prev);
  }
}

function stub(status: number, body: unknown) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    return Promise.resolve(new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
  }) as typeof fetch;
  return { calls, fetchFn };
}

// ── verdicts ───────────────────────────────────────────────────────────────────

Deno.test("a rejected key is reported by name — both live 401 payloads", () => {
  const missing = interpretLeakcheckProbe(401, { success: false, error: "Missing X-API-Key header (read docs at https://leakcheck.io/api_s)" });
  assertEquals(missing.ok, false);
  assertStringIncludes(missing.detail, "REJECTED the key");
  assertStringIncludes(missing.detail, "Missing X-API-Key header");
  const bad = interpretLeakcheckProbe(401, { success: false, error: "Invalid X-API-Key" });
  assertEquals(bad.ok, false);
  assertStringIncludes(bad.detail, 'HTTP 401: "Invalid X-API-Key"');
  assertStringIncludes(bad.detail, "replace LEAKCHECK_API_KEY");
  assertEquals(bad.conclusive, true);
});

Deno.test("the documented 400 'Invalid X-API-Key' is also a rejection (docs and live API disagree)", () => {
  assertEquals(interpretLeakcheckProbe(400, { success: false, error: "Invalid X-API-Key" }).ok, false);
});

Deno.test("a 400 that does NOT name the key means validation failed on the too-short query — the key was accepted", () => {
  const v = interpretLeakcheckProbe(400, { success: false, error: "Too short query (< 3 characters)" });
  assertEquals(v.ok, true);
  assertStringIncludes(v.detail, "key accepted");
  assertStringIncludes(v.detail, "no lookup was run");
  assertEquals(v.conclusive, true);
});

Deno.test("403 is plan/quota, reported as such — not as a bad key", () => {
  const v = interpretLeakcheckProbe(403, { success: false, error: "Active plan required" });
  assertEquals(v.ok, false);
  assertStringIncludes(v.detail, "accepted the key but refused");
  assertStringIncludes(v.detail, "Active plan required");
  assert(!v.detail.includes("REJECTED"), v.detail);
});

Deno.test("429 / 5xx are INCONCLUSIVE: ok:true (a blip says nothing about the key), retried sooner", () => {
  for (const s of [429, 500, 502, 503]) {
    const v = interpretLeakcheckProbe(s, { success: false, error: "Too many requests" });
    assertEquals(v.ok, true, String(s));
    assertEquals(v.conclusive, false, String(s));
    assertStringIncludes(v.detail, "the key was not tested");
  }
});

Deno.test("provider text is made log-safe and bounded", () => {
  const v = interpretLeakcheckProbe(401, { error: "Invalid X-API-Key\u0000\n" + "x".repeat(500) });
  assert(v.detail.length < 400, String(v.detail.length));
  assert(![...v.detail].some((ch) => ch.charCodeAt(0) < 0x20), "control characters must be stripped");
});

// ── the probe itself ───────────────────────────────────────────────────────────

Deno.test("it sends the key only in the X-API-Key header, to the too-short probe URL, and never echoes it", async () => {
  resetLeakcheckKeyProbeMemo();
  const s = stub(400, { success: false, error: "Too short query (< 3 characters)" });
  const r = await probeLeakcheckKey({ key: KEY, fetchFn: s.fetchFn, now: () => 1 });
  assertEquals(r.ok, true);
  assertEquals(s.calls.length, 1);
  assertEquals(s.calls[0].url, LEAKCHECK_PROBE_URL);
  assertEquals(new URL(s.calls[0].url).pathname.split("/").at(-1)!.length < 3, true, "the probe query must be shorter than LeakCheck's 3-char minimum — it must never run a real lookup");
  assert(!s.calls[0].url.includes(KEY), "the key must not be in the URL");
  assertEquals(s.calls[0].headers["X-API-Key"], KEY);
  assert(!r.detail.includes(KEY), "the key must not be in the detail");
});

Deno.test("a dead key is reported; the verdict never contains the key", async () => {
  resetLeakcheckKeyProbeMemo();
  const s = stub(401, { success: false, error: "Invalid X-API-Key" });
  const r = await probeLeakcheckKey({ key: KEY, fetchFn: s.fetchFn, now: () => 1 });
  assertEquals(r.ok, false);
  assert(!r.detail.includes(KEY));
});

Deno.test("no key configured: nothing is fetched and the detail says the tool is removed", async () => {
  resetLeakcheckKeyProbeMemo();
  const s = stub(200, {});
  const r = await withEnv("LEAKCHECK_API_KEY", undefined, () => probeLeakcheckKey({ fetchFn: s.fetchFn }));
  assertEquals(r.ok, true);
  assertStringIncludes(r.detail, "not configured");
  assertEquals(s.calls.length, 0);
});

Deno.test("a conclusive answer is memoised for the TTL, then re-asked — a health poll cannot hammer LeakCheck", async () => {
  resetLeakcheckKeyProbeMemo();
  const s = stub(400, { error: "Too short query" });
  let t = 1_000;
  await probeLeakcheckKey({ key: KEY, fetchFn: s.fetchFn, now: () => t });
  t += LEAKCHECK_PROBE_TTL_MS - 1;
  await probeLeakcheckKey({ key: KEY, fetchFn: s.fetchFn, now: () => t });
  assertEquals(s.calls.length, 1, "still inside the TTL");
  t += 2;
  await probeLeakcheckKey({ key: KEY, fetchFn: s.fetchFn, now: () => t });
  assertEquals(s.calls.length, 2, "TTL elapsed");
});

Deno.test("an inconclusive answer is retried after the SHORT window, not the full TTL", async () => {
  resetLeakcheckKeyProbeMemo();
  const s = stub(503, { error: "unavailable" });
  let t = 5_000;
  await probeLeakcheckKey({ key: KEY, fetchFn: s.fetchFn, now: () => t });
  t += LEAKCHECK_PROBE_RETRY_MS + 1;
  await probeLeakcheckKey({ key: KEY, fetchFn: s.fetchFn, now: () => t });
  assertEquals(s.calls.length, 2);
});

Deno.test("a network failure never throws and never turns /health red", async () => {
  resetLeakcheckKeyProbeMemo();
  const boom = (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
  const r = await probeLeakcheckKey({ key: KEY, fetchFn: boom, now: () => 1 });
  assertEquals(r.ok, true);
  assertStringIncludes(r.detail, "could not reach LeakCheck");
});

Deno.test("an unparsable body is still judged by its status", async () => {
  resetLeakcheckKeyProbeMemo();
  const s = stub(401, "<html>nope</html>");
  const r = await probeLeakcheckKey({ key: KEY, fetchFn: s.fetchFn, now: () => 1 });
  assertEquals(r.ok, false);
});

Deno.test("NEGATIVE CONTROL — the kill switch fetches nothing and reports LEGACY", async () => {
  resetLeakcheckKeyProbeMemo();
  const s = stub(401, { error: "Invalid X-API-Key" });
  const r = await withEnv(SWITCH, "true", () => probeLeakcheckKey({ key: KEY, fetchFn: s.fetchFn }));
  assertEquals(r, { ok: true, detail: "LEGACY via LEAKCHECK_KEY_PROBE_DISABLED" });
  assertEquals(s.calls.length, 0);
});

// ── wiring ─────────────────────────────────────────────────────────────────────

Deno.test("wiring: /health runs the probe in parallel with the orchestrator probes and reports checks.leakcheck_key", async () => {
  const src = await Deno.readTextFile(new URL("./health-handler.ts", import.meta.url));
  const all = src.indexOf("await Promise.all([");
  assert(all > 0);
  const block = src.slice(all, src.indexOf("]);", all));
  assert(block.includes("probeLeakcheckKey()"), "the probe must ride the same Promise.all so /health stays bounded");
  assert(src.includes("r.checks.leakcheck_key = leakcheckKeyCheck;"), "its PRESENCE is the proof-of-deploy key");
});
