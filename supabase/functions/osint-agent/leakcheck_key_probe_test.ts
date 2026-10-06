// leakcheck_key_probe_test.ts — /health can ask LeakCheck whether it still accepts our key. Ships DARK.
//
// The incident (2026-10-06): LEAKCHECK_API_KEY stopped being accepted on 2026-10-01 and nothing noticed for five days,
// because checks.credentials only learns from PAST paid lookups.
//
// What was captured from the LIVE LeakCheck API on 2026-10-06 (throwaway key, no real key involved):
//   no key    → HTTP 401 {"success": false, "error": "Missing X-API-Key header (read docs at …)"}
//   bogus key → HTTP 401 {"success": false, "error": "Invalid X-API-Key"}      (the docs say 400 — they are wrong)
// and the key check happens BEFORE query validation: a bogus key on a 2-character query is still a 401.
// What the DOCS say (https://docs.leakcheck.io/errors): 400 "Too short query (< 3 characters)"; 403 "Active plan
// required" / "Limit reached"; `quota` is returned on successful responses.
//
// NOT verified anywhere in this file, and the reason the probe is OFF BY DEFAULT: that a VALID key on the 2-character
// query answers 400 "Too short query" AND that it spends no quota. Only the rejected-key path was observed live.
// `?health=1` is public and the frontend's stuck-run sweeper GETs it every 30 s per running tab, so the probe must
// not run until that is verified with the real key.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  interpretLeakcheckProbe,
  LEAKCHECK_PROBE_RETRY_MS,
  LEAKCHECK_PROBE_TTL_MS,
  LEAKCHECK_PROBE_URL,
  leakcheckKeyProbeEnabled,
  probeLeakcheckKey,
  resetLeakcheckKeyProbeMemo,
} from "./lib/leakcheck-key-probe.ts";

const KEY = "0123456789abcdef0123456789abcdef01234567"; // synthetic, 40 chars like a real key
const ENABLE = "LEAKCHECK_KEY_PROBE_ENABLED";
const DISABLE = "LEAKCHECK_KEY_PROBE_DISABLED";
const TOO_SHORT = { success: false, error: "Too short query (< 3 characters)" };

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const prev = Object.fromEntries(Object.keys(vars).map((k) => [k, Deno.env.get(k)]));
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v); }
  }
}

function stub(status: number, body: unknown, delayMs = 0) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, fetchFn };
}

// ── verdicts: three positive assertions, everything else is UNVERIFIED ─────────────────────────────

Deno.test("a rejected key is reported by name — both live 401 payloads", () => {
  const missing = interpretLeakcheckProbe(401, { success: false, error: "Missing X-API-Key header (read docs at https://leakcheck.io/api_s)" });
  assertEquals(missing.ok, false);
  assertEquals(missing.state, "rejected");
  assertStringIncludes(missing.detail, "REJECTED the key");
  const bad = interpretLeakcheckProbe(401, { success: false, error: "Invalid X-API-Key" });
  assertEquals(bad.ok, false);
  assertStringIncludes(bad.detail, 'HTTP 401: "Invalid X-API-Key"');
  assertStringIncludes(bad.detail, "replace LEAKCHECK_API_KEY");
  assertEquals(bad.conclusive, true);
});

Deno.test("the documented 400 'Invalid X-API-Key' is also a rejection (docs and live API disagree)", () => {
  const v = interpretLeakcheckProbe(400, { success: false, error: "Invalid X-API-Key" });
  assertEquals(v.ok, false);
  assertEquals(v.state, "rejected");
});

Deno.test("ACCEPTED requires positive evidence: the documented 'Too short query' 400, and nothing weaker", () => {
  const v = interpretLeakcheckProbe(400, TOO_SHORT);
  assertEquals(v.ok, true);
  assertEquals(v.state, "accepted");
  assertEquals(v.conclusive, true);
  assertStringIncludes(v.detail, "key accepted");
});

Deno.test("AMBIGUOUS answers are UNVERIFIED, never 'key accepted' (the reviewer's point)", () => {
  const ambiguous: Array<[number, unknown]> = [
    [400, { success: false, error: "Invalid query" }],                  // a 400 that is not the short-query message
    [400, { success: false, error: "Invalid characters in query" }],
    [400, { success: false }],                                           // a 400 with no text at all
    [400, null],
    [422, { success: false, error: "Could not determine search type automatically" }], // previously counted as accepted
    [429, { success: false, error: "Too many requests" }],
    [500, null], [502, null], [503, { error: "unavailable" }],
    [418, { error: "teapot" }],
  ];
  for (const [status, body] of ambiguous) {
    const v = interpretLeakcheckProbe(status, body);
    assertEquals(v.state, "unverified", `${status} ${JSON.stringify(body)}`);
    assertEquals(v.ok, true, "a blip must not turn /health red");
    assertEquals(v.conclusive, false, "and is retried on the SHORT window");
    assertStringIncludes(v.detail, "UNVERIFIED");
    assert(!/key accepted/i.test(v.detail), v.detail);
  }
});

Deno.test("403 is plan/quota — and names WHICH only when LeakCheck did", () => {
  const plan = interpretLeakcheckProbe(403, { success: false, error: "Active plan required" });
  assertEquals(plan.ok, false);
  assertEquals(plan.state, "plan_or_quota");
  assertStringIncludes(plan.detail, "the plan is not active");
  assert(!plan.detail.includes("REJECTED"), plan.detail);
  const quota = interpretLeakcheckProbe(403, { success: false, error: "Limit reached" });
  assertStringIncludes(quota.detail, "the usage quota is reached");
  const silent = interpretLeakcheckProbe(403, null);
  assertStringIncludes(silent.detail, "LeakCheck did not say which");
  // It must not pick one of the two: the specific phrases appear only when LeakCheck's own words chose them.
  assert(!silent.detail.includes("the plan is not active") && !silent.detail.includes("the usage quota is reached"), silent.detail);
});

Deno.test("a probe that LeakCheck answers like a real LOOKUP means the no-quota assumption is false", () => {
  for (const [status, body] of [[200, { success: true, found: 0, quota: 197, result: [] }], [200, null], [400, { quota: 150 }]] as Array<[number, unknown]>) {
    const v = interpretLeakcheckProbe(status, body);
    assertEquals(v.state, "assumption_violated", `${status}`);
    assertEquals(v.ok, false);
    assertStringIncludes(v.detail, "may have consumed quota");
    assertStringIncludes(v.detail, "latched OFF");
  }
});

Deno.test("provider text is made log-safe and bounded", () => {
  const v = interpretLeakcheckProbe(401, { error: "Invalid X-API-Key\u0000\n" + "x".repeat(500) });
  assert(v.detail.length < 400, String(v.detail.length));
  assert(![...v.detail].some((ch) => ch.charCodeAt(0) < 0x20), "control characters must be stripped");
});

// ── OFF BY DEFAULT ─────────────────────────────────────────────────────────────

Deno.test("DEFAULT OFF: with no switch set nothing is fetched and /health says it did not run", async () => {
  resetLeakcheckKeyProbeMemo();
  const s = stub(400, TOO_SHORT);
  const r = await withEnv({ [ENABLE]: undefined, [DISABLE]: undefined, LEAKCHECK_API_KEY: KEY }, () => probeLeakcheckKey({ fetchFn: s.fetchFn }));
  assertEquals(r.state, "not_run");
  assertEquals(r.ok, true);
  assertStringIncludes(r.detail, "opt-in (LEAKCHECK_KEY_PROBE_ENABLED=true)");
  assertEquals(s.calls.length, 0, "no request may leave the isolate unless an operator opted in");
});

Deno.test("the opt-in switch is exactly 'true', and DISABLED beats ENABLED", async () => {
  await withEnv({ [ENABLE]: "true", [DISABLE]: undefined }, () => assertEquals(leakcheckKeyProbeEnabled(), true));
  await withEnv({ [ENABLE]: "TRUE", [DISABLE]: undefined }, () => assertEquals(leakcheckKeyProbeEnabled(), true));
  for (const v of ["1", "yes", "on", "", " false "]) {
    await withEnv({ [ENABLE]: v, [DISABLE]: undefined }, () => assertEquals(leakcheckKeyProbeEnabled(), false, `"${v}"`));
  }
  await withEnv({ [ENABLE]: "true", [DISABLE]: "true" }, () => assertEquals(leakcheckKeyProbeEnabled(), false));
  resetLeakcheckKeyProbeMemo();
  const s = stub(400, TOO_SHORT);
  const r = await withEnv({ [ENABLE]: "true", [DISABLE]: "true", LEAKCHECK_API_KEY: KEY }, () => probeLeakcheckKey({ fetchFn: s.fetchFn }));
  assertEquals(r.state, "not_run");
  assertEquals(s.calls.length, 0);
});

// ── the probe itself (enabled) ─────────────────────────────────────────────────

Deno.test("enabled: it sends the key only in the X-API-Key header, to the too-short URL, and never echoes it", async () => {
  resetLeakcheckKeyProbeMemo();
  const s = stub(400, TOO_SHORT);
  const r = await probeLeakcheckKey({ enabled: true, key: KEY, fetchFn: s.fetchFn, now: () => 1 });
  assertEquals(r.state, "accepted");
  assertEquals(s.calls.length, 1);
  assertEquals(s.calls[0].url, LEAKCHECK_PROBE_URL);
  assertEquals(new URL(s.calls[0].url).pathname.split("/").at(-1)!.length < 3, true, "the probe query must be shorter than LeakCheck's 3-char minimum — it must never run a real lookup");
  assert(!s.calls[0].url.includes(KEY), "the key must not be in the URL");
  assertEquals(s.calls[0].headers["X-API-Key"], KEY);
  assert(!r.detail.includes(KEY), "the key must not be in the detail");
});

Deno.test("enabled: a dead key is reported; the verdict never contains the key", async () => {
  resetLeakcheckKeyProbeMemo();
  const s = stub(401, { success: false, error: "Invalid X-API-Key" });
  const r = await probeLeakcheckKey({ enabled: true, key: KEY, fetchFn: s.fetchFn, now: () => 1 });
  assertEquals(r.ok, false);
  assertEquals(r.state, "rejected");
  assert(!r.detail.includes(KEY));
});

Deno.test("enabled but no key configured: nothing is fetched and the detail says the tool is removed", async () => {
  resetLeakcheckKeyProbeMemo();
  const s = stub(200, {});
  const r = await withEnv({ LEAKCHECK_API_KEY: undefined }, () => probeLeakcheckKey({ enabled: true, fetchFn: s.fetchFn }));
  assertEquals(r.ok, true);
  assertStringIncludes(r.detail, "not configured");
  assertEquals(s.calls.length, 0);
});

Deno.test("a conclusive answer is memoised for the TTL, then re-asked", async () => {
  resetLeakcheckKeyProbeMemo();
  const s = stub(400, TOO_SHORT);
  let t = 1_000;
  await probeLeakcheckKey({ enabled: true, key: KEY, fetchFn: s.fetchFn, now: () => t });
  t += LEAKCHECK_PROBE_TTL_MS - 1;
  await probeLeakcheckKey({ enabled: true, key: KEY, fetchFn: s.fetchFn, now: () => t });
  assertEquals(s.calls.length, 1, "still inside the TTL");
  t += 2;
  await probeLeakcheckKey({ enabled: true, key: KEY, fetchFn: s.fetchFn, now: () => t });
  assertEquals(s.calls.length, 2, "TTL elapsed");
});

Deno.test("an UNVERIFIED answer is retried after the SHORT window, not the full TTL", async () => {
  resetLeakcheckKeyProbeMemo();
  const s = stub(503, { error: "unavailable" });
  let t = 5_000;
  await probeLeakcheckKey({ enabled: true, key: KEY, fetchFn: s.fetchFn, now: () => t });
  t += LEAKCHECK_PROBE_RETRY_MS + 1;
  await probeLeakcheckKey({ enabled: true, key: KEY, fetchFn: s.fetchFn, now: () => t });
  assertEquals(s.calls.length, 2);
});

Deno.test("CONCURRENT callers share ONE request (the frontend sweeps /health every 30 s per tab)", async () => {
  resetLeakcheckKeyProbeMemo();
  const s = stub(400, TOO_SHORT, 25);
  const results = await Promise.all(Array.from({ length: 12 }, () => probeLeakcheckKey({ enabled: true, key: KEY, fetchFn: s.fetchFn })));
  assertEquals(s.calls.length, 1, "twelve simultaneous health GETs must make exactly one LeakCheck request");
  for (const r of results) assertEquals(r.state, "accepted");
});

Deno.test("the in-flight slot is released on a thrown fetch, so one failure cannot wedge the probe", async () => {
  resetLeakcheckKeyProbeMemo();
  const boom = (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
  const first = await probeLeakcheckKey({ enabled: true, key: KEY, fetchFn: boom, now: () => 1 });
  assertEquals(first.state, "unverified");
  const s = stub(400, TOO_SHORT);
  const second = await probeLeakcheckKey({ enabled: true, key: KEY, fetchFn: s.fetchFn, now: () => 1 + LEAKCHECK_PROBE_RETRY_MS + 1 });
  assertEquals(second.state, "accepted");
});

Deno.test("LATCH: once LeakCheck answers like a lookup, the probe stops asking for the life of the isolate", async () => {
  resetLeakcheckKeyProbeMemo();
  const s = stub(200, { success: true, found: 0, quota: 190, result: [] });
  let t = 1;
  const first = await probeLeakcheckKey({ enabled: true, key: KEY, fetchFn: s.fetchFn, now: () => t });
  assertEquals(first.state, "assumption_violated");
  assertEquals(first.ok, false);
  t += LEAKCHECK_PROBE_TTL_MS * 10; // far beyond any TTL
  const again = await probeLeakcheckKey({ enabled: true, key: KEY, fetchFn: s.fetchFn, now: () => t });
  assertEquals(again.state, "assumption_violated");
  assertEquals(s.calls.length, 1, "a probe that costs quota must never run a second time");
});

Deno.test("a network failure never throws and never turns /health red", async () => {
  resetLeakcheckKeyProbeMemo();
  const boom = (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;
  const r = await probeLeakcheckKey({ enabled: true, key: KEY, fetchFn: boom, now: () => 1 });
  assertEquals(r.ok, true);
  assertEquals(r.state, "unverified");
  assertStringIncludes(r.detail, "could not reach LeakCheck");
});

Deno.test("an unparsable body is still judged by its status — and a 401 is still a rejection", async () => {
  resetLeakcheckKeyProbeMemo();
  const s = stub(401, "<html>nope</html>");
  const r = await probeLeakcheckKey({ enabled: true, key: KEY, fetchFn: s.fetchFn, now: () => 1 });
  assertEquals(r.ok, false);
});

Deno.test("an unparsable 400 is UNVERIFIED, not accepted", async () => {
  resetLeakcheckKeyProbeMemo();
  const s = stub(400, "<html>bad gateway page</html>");
  const r = await probeLeakcheckKey({ enabled: true, key: KEY, fetchFn: s.fetchFn, now: () => 1 });
  assertEquals(r.state, "unverified");
});

// ── wiring ─────────────────────────────────────────────────────────────────────

Deno.test("wiring: /health runs the probe in parallel with the orchestrator probes and reports checks.leakcheck_key", async () => {
  const src = await Deno.readTextFile(new URL("./health-handler.ts", import.meta.url));
  const all = src.indexOf("await Promise.all([");
  assert(all > 0);
  const block = src.slice(all, src.indexOf("]);", all));
  assert(block.includes("probeLeakcheckKey()"), "the probe must ride the same Promise.all so /health stays bounded");
  assert(src.includes("r.checks.leakcheck_key = leakcheckKeyCheck;"), "its PRESENCE (even as 'not run') is the proof-of-deploy key");
});

Deno.test("wiring: the probe module reads its switches at CALL time and defaults OFF", async () => {
  const src = await Deno.readTextFile(new URL("./lib/leakcheck-key-probe.ts", import.meta.url));
  assert(src.includes('envFlag("LEAKCHECK_KEY_PROBE_ENABLED") && !envFlag("LEAKCHECK_KEY_PROBE_DISABLED")'));
  assert(src.includes("if (!enabled) {"), "the enabled check must come before any fetch");
});
