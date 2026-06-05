/**
 * ratelimit_test.ts — Deno tests for the HTTP transport of
 * supabase/functions/osint-agent/ratelimit.ts.
 *
 * Coverage gap this file fills: the existing vitest test
 * (src/test/rate-limiter.test.ts) re-implements the pure decision logic but
 * explicitly leaves the Upstash HTTP transport untested. This file tests
 * the *real* checkRateLimit() against a stubbed globalThis.fetch so we
 * catch regressions in:
 *   - Pipeline body shape (4-cmd INCR+EXPIRE pair)
 *   - Pipeline response parsing (results in same order as commands)
 *   - Fail-open behavior on HTTP 4xx/5xx
 *   - Fail-open behavior on network/abort errors
 *   - Unconfigured (no env vars) → in-memory fallback
 *
 * Run: deno test --allow-net --allow-env ratelimit_test.ts
 */
import {
  assertEquals,
  assertExists,
} from "jsr:@std/assert@^1";
import { stub } from "jsr:@std/testing@^1/mock";

import {
  checkRateLimit,
  decide,
  inMemoryCheck,
  _resetInMemoryForTests,
  MAX_REQS_PER_MIN,
  MAX_REQS_PER_HOUR,
} from "./ratelimit.ts";

// ---- Pure decision (re-exported for parity with vitest suite) -------------
Deno.test("decide: allows when both counters are zero", () => {
  assertEquals(decide(0, 0), { ok: true });
});

Deno.test("decide: allows at exactly the cap (boundary)", () => {
  assertEquals(decide(MAX_REQS_PER_MIN, MAX_REQS_PER_HOUR), { ok: true });
});

Deno.test("decide: blocks at per_min cap+1 with reason=per_min", () => {
  assertEquals(decide(MAX_REQS_PER_MIN + 1, MAX_REQS_PER_HOUR), {
    ok: false,
    retryAfterSec: 60,
    reason: "per_min",
  });
});

Deno.test("decide: blocks at per_hour cap+1 with reason=per_hour", () => {
  assertEquals(decide(0, MAX_REQS_PER_HOUR + 1), {
    ok: false,
    retryAfterSec: 3600,
    reason: "per_hour",
  });
});

Deno.test("decide: per_min takes precedence when both exceeded", () => {
  // The implementation checks per_min first by design.
  assertEquals(decide(MAX_REQS_PER_MIN + 5, MAX_REQS_PER_HOUR + 5), {
    ok: false,
    retryAfterSec: 60,
    reason: "per_min",
  });
});

// ---- In-memory fallback (real export, not re-implementation) ------------
Deno.test("inMemoryCheck: allows the first request for a new user", () => {
  _resetInMemoryForTests();
  const r = inMemoryCheck("user-A", 1_000_000);
  assertEquals(r.ok, true);
});

Deno.test("inMemoryCheck: blocks after MAX_REQS_PER_MIN in one minute", () => {
  _resetInMemoryForTests();
  let now = 2_000_000;
  for (let i = 0; i < MAX_REQS_PER_MIN; i++) {
    const r = inMemoryCheck("user-B", now);
    assertEquals(r.ok, true);
    now += 1_000;
  }
  // 31st hit in same minute
  const r = inMemoryCheck("user-B", now);
  assertEquals(r, { ok: false, retryAfterSec: 60, reason: "per_min" });
});

Deno.test("inMemoryCheck: isolates per-user (one busy user, one fresh)", () => {
  _resetInMemoryForTests();
  const now = 3_000_000;
  for (let i = 0; i < MAX_REQS_PER_MIN; i++) {
    inMemoryCheck("user-busy", now);
  }
  const r = inMemoryCheck("user-fresh", now);
  assertEquals(r.ok, true);
});

Deno.test("inMemoryCheck: prunes timestamps older than 1 hour", () => {
  _resetInMemoryForTests();
  // 1 hit from 2 hours ago
  const old = 4_000_000;
  inMemoryCheck("user-C", old);
  // 2h+1ms later — old hit should be pruned, new one is the first in window
  const r = inMemoryCheck("user-C", old + 2 * 60 * 60 * 1000 + 1);
  assertEquals(r.ok, true);
});

// ---- Upstash HTTP transport (the gap vitest can't fill) -----------------

/** Helper: shape a fake Upstash pipeline response. */
function fakeUpstashOk(minCount: number, hourCount: number) {
  return {
    ok: true,
    status: 200,
    json: async () => [
      { result: minCount },
      { result: 1 },
      { result: hourCount },
      { result: 1 },
    ],
  } as Response;
}

function fakeUpstashHttpError(status: number) {
  return {
    ok: false,
    status,
    json: async () => ({}),
  } as Response;
}

/** Set required Upstash env vars; returns a restore fn. */
function withUpstashEnv(url = "https://test.upstash.io", token = "test-token") {
  const envGet = Deno.env.get;
  Deno.env.get = (k: string) => {
    if (k === "UPSTASH_REDIS_REST_URL") return url;
    if (k === "UPSTASH_REDIS_REST_TOKEN") return token;
    return envGet.call(Deno.env, k);
  };
  return () => {
    Deno.env.get = envGet;
  };
}

/** Unset Upstash env vars. */
function withoutUpstashEnv() {
  const envGet = Deno.env.get;
  Deno.env.get = (k: string) => {
    if (k === "UPSTASH_REDIS_REST_URL" || k === "UPSTASH_REDIS_REST_TOKEN") return undefined;
    return envGet.call(Deno.env, k);
  };
  return () => {
    Deno.env.get = envGet;
  };
}

Deno.test("checkRateLimit: without env vars, falls back to in-memory", async () => {
  _resetInMemoryForTests();
  const restore = withoutUpstashEnv();
  try {
    // First call → should hit the in-memory path, never call Upstash.
    const r = await checkRateLimit("user-unconfigured", 5_000_000);
    assertEquals(r.ok, true);
  } finally {
    restore();
  }
});

Deno.test("checkRateLimit: configured + 200 OK, parses pipeline response", async () => {
  _resetInMemoryForTests();
  const restoreEnv = withUpstashEnv();
  let capturedUrl = "";
  let capturedBody: unknown = null;
  const fetchStub = stub(
    globalThis,
    "fetch",
    (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = String(input);
      capturedBody = init?.body ? JSON.parse(String(init.body)) : null;
      return Promise.resolve(fakeUpstashOk(5, 42));
    },
  );
  try {
    const r = await checkRateLimit("user-pipeline-200", 6_000_000);
    assertEquals(r.ok, true);
    // Pipeline body should be 4 commands, in the documented order
    assertEquals(capturedUrl, "https://test.upstash.io/pipeline");
    const body = capturedBody as string[][];
    assertEquals(body.length, 4, "pipeline should send 4 commands");
    assertEquals(body[0][0], "INCR");
    assertEquals(body[1][0], "EXPIRE");
    assertEquals(body[2][0], "INCR");
    assertEquals(body[3][0], "EXPIRE");
    // Pipeline keys should be the documented format
    assertEquals(body[0][1], `rl:m:user-pipeline-200:${Math.floor(6_000_000 / 60_000)}`);
    assertEquals(body[2][1], `rl:h:user-pipeline-200:${Math.floor(6_000_000 / 3_600_000)}`);
  } finally {
    fetchStub.restore();
    restoreEnv();
  }
});

Deno.test("checkRateLimit: configured + 200 + over per_min, blocks", async () => {
  _resetInMemoryForTests();
  const restoreEnv = withUpstashEnv();
  const fetchStub = stub(
    globalThis,
    "fetch",
    () => Promise.resolve(fakeUpstashOk(MAX_REQS_PER_MIN + 1, 10)),
  );
  try {
    const r = await checkRateLimit("user-blocked-min", 7_000_000);
    assertEquals(r, { ok: false, retryAfterSec: 60, reason: "per_min" });
  } finally {
    fetchStub.restore();
    restoreEnv();
  }
});

Deno.test("checkRateLimit: configured + 200 + over per_hour, blocks", async () => {
  _resetInMemoryForTests();
  const restoreEnv = withUpstashEnv();
  const fetchStub = stub(
    globalThis,
    "fetch",
    () => Promise.resolve(fakeUpstashOk(1, MAX_REQS_PER_HOUR + 1)),
  );
  try {
    const r = await checkRateLimit("user-blocked-hour", 8_000_000);
    assertEquals(r, { ok: false, retryAfterSec: 3600, reason: "per_hour" });
  } finally {
    fetchStub.restore();
    restoreEnv();
  }
});

Deno.test("checkRateLimit: 5xx from Upstash → fails open to in-memory", async () => {
  _resetInMemoryForTests();
  const restoreEnv = withUpstashEnv();
  const fetchStub = stub(
    globalThis,
    "fetch",
    () => Promise.resolve(fakeUpstashHttpError(503)),
  );
  try {
    // First call: 5xx, fail-open to in-memory. The in-memory store will
    // record the hit (its side effect), then return ok.
    const r = await checkRateLimit("user-5xx", 9_000_000);
    assertEquals(r.ok, true, "should fail open to in-memory, not block");
  } finally {
    fetchStub.restore();
    restoreEnv();
  }
});

Deno.test("checkRateLimit: 401 from Upstash → fails open to in-memory", async () => {
  _resetInMemoryForTests();
  const restoreEnv = withUpstashEnv();
  const fetchStub = stub(
    globalThis,
    "fetch",
    () => Promise.resolve(fakeUpstashHttpError(401)),
  );
  try {
    const r = await checkRateLimit("user-401", 10_000_000);
    assertEquals(r.ok, true, "auth failure should fail open, not 500");
  } finally {
    fetchStub.restore();
    restoreEnv();
  }
});

Deno.test("checkRateLimit: network error (fetch throws) → fails open to in-memory", async () => {
  _resetInMemoryForTests();
  const restoreEnv = withUpstashEnv();
  const fetchStub = stub(
    globalThis,
    "fetch",
    () => Promise.reject(new Error("ECONNREFUSED")),
  );
  try {
    const r = await checkRateLimit("user-net-err", 11_000_000);
    assertEquals(r.ok, true, "network error should fail open, not throw");
  } finally {
    fetchStub.restore();
    restoreEnv();
  }
});

Deno.test("checkRateLimit: non-numeric response from Upstash → fails open", async () => {
  _resetInMemoryForTests();
  const restoreEnv = withUpstashEnv();
  // Upstash returns an object instead of an array — should not throw
  const fetchStub = stub(
    globalThis,
    "fetch",
    () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => [{ result: "not-a-number" }, { result: 1 }, { result: "also-bad" }, { result: 1 }],
      } as Response),
  );
  try {
    const r = await checkRateLimit("user-bad-shape", 12_000_000);
    assertEquals(r.ok, true, "corrupt Redis data should fail open, not block");
  } finally {
    fetchStub.restore();
    restoreEnv();
  }
});

Deno.test("checkRateLimit: missing pipeline index → fails open", async () => {
  _resetInMemoryForTests();
  const restoreEnv = withUpstashEnv();
  // Response missing the 3rd element (hourCount) — Number(undefined) === NaN
  const fetchStub = stub(
    globalThis,
    "fetch",
    () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => [{ result: 1 }],
      } as Response),
  );
  try {
    const r = await checkRateLimit("user-missing-idx", 13_000_000);
    assertEquals(r.ok, true, "malformed pipeline response should fail open");
  } finally {
    fetchStub.restore();
    restoreEnv();
  }
});

// ---- Auth header contract ------------------------------------------------
Deno.test("checkRateLimit: Upstash request includes Bearer auth + JSON content-type", async () => {
  _resetInMemoryForTests();
  const restoreEnv = withUpstashEnv("https://x.upstash.io", "secret-token-xyz");
  let capturedHeaders: HeadersInit | undefined;
  const fetchStub = stub(
    globalThis,
    "fetch",
    (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      return Promise.resolve(fakeUpstashOk(1, 1));
    },
  );
  try {
    await checkRateLimit("user-auth-headers", 14_000_000);
    assertExists(capturedHeaders);
    const h = capturedHeaders as Record<string, string>;
    assertEquals(h.Authorization, "Bearer secret-token-xyz");
    assertEquals(h["Content-Type"], "application/json");
  } finally {
    fetchStub.restore();
    restoreEnv();
  }
});
