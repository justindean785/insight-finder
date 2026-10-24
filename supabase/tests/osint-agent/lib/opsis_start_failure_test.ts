// lib/opsis_start_failure_test.ts — a start POST that never answers is classified, flagged charge_unknown, and never
// retried. Synthetic selectors only; no provider body is asserted or logged.
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  opsisSearch,
  opsisStartClassificationSelfTest,
  type OpsisDeps,
} from "../../../functions/osint-agent/lib/opsis.ts";

function deps(over: Partial<OpsisDeps> & { fetch: OpsisDeps["fetch"] }): OpsisDeps {
  let clock = 1_000_000;
  return {
    apiKey: "opsis_test_key",
    disabled: false,
    now: () => clock,
    sleep: (ms) => { clock += ms; return Promise.resolve(); },
    ...over,
  };
}
const hangUntilAborted: OpsisDeps["fetch"] = (_u, init) =>
  new Promise((_res, rej) => {
    const fail = () => rej(new DOMException("aborted", "AbortError"));
    if (init.signal?.aborted) fail(); else init.signal?.addEventListener("abort", fail, { once: true });
  });
const input = { kind: "username", value: "example_user" };

async function withEnv<T>(key: string, value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = Deno.env.get(key);
  if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value);
  try { return await fn(); } finally { if (prev === undefined) Deno.env.delete(key); else Deno.env.set(key, prev); }
}

Deno.test("a start POST that times out is classified `timeout`, charge_unknown, and sent exactly once", async () => {
  let posts = 0;
  const out = await opsisSearch(input, deps({ startTimeoutMs: 20, fetch: (u, i) => { posts++; return hangUntilAborted(u, i); } }));
  assertEquals(out.ok, false);
  assertEquals(out.code, "start_failed");
  assertEquals(out.start_failure, "timeout");
  assertEquals(out.error, "opsis search start request timed out");
  assertEquals(out.charge_unknown, true);
  assertEquals(posts, 1);
});

Deno.test("a caller abort is classified `caller_abort`, not a timeout", async () => {
  const ctrl = new AbortController();
  const p = opsisSearch(input, deps({ signal: ctrl.signal, fetch: hangUntilAborted }));
  queueMicrotask(() => ctrl.abort());
  const out = await p;
  assertEquals(out.start_failure, "caller_abort");
  assertEquals(out.error, "opsis search start was cancelled");
});

Deno.test("an already-aborted caller signal is `caller_abort`", async () => {
  const ctrl = new AbortController();
  ctrl.abort();
  const out = await opsisSearch(input, deps({ signal: ctrl.signal, fetch: hangUntilAborted }));
  assertEquals(out.start_failure, "caller_abort");
});

Deno.test("a rejected fetch is `network`, and the message text never reaches the result", async () => {
  let posts = 0;
  const out = await opsisSearch(input, deps({ fetch: () => { posts++; return Promise.reject(new TypeError("dns failure for https://api.example.invalid/v1/searches?key=SECRET")); } }));
  assertEquals(out.start_failure, "network");
  assertEquals(out.error, "opsis search start request failed");
  assertEquals(posts, 1);
  assertFalse(JSON.stringify(out).includes("SECRET"));
  assertFalse(JSON.stringify(out).includes("example.invalid"));
});

Deno.test("the failure text says it was not retried and bounds its advice", async () => {
  const out = await opsisSearch(input, deps({ fetch: () => Promise.reject(new TypeError("x")) }));
  const note = String(out.note);
  assert(note.includes("not retried") && note.includes("opsis_balance"));
  assert(note.length < 400);
});

Deno.test("kill switch restores the generic result with no new fields", async () => {
  await withEnv("OPSIS_START_CLASSIFY_DISABLED", "true", async () => {
    const out = await opsisSearch(input, deps({ startTimeoutMs: 20, fetch: hangUntilAborted }));
    assertEquals(out, { ok: false, error: "opsis search start request failed", code: "start_failed" });
    assert(opsisStartClassificationSelfTest().detail.startsWith("LEGACY"));
  });
});

Deno.test("self-test passes and reports its switch", () => {
  const t = opsisStartClassificationSelfTest();
  assert(t.ok, t.detail);
  assertEquals(t.switch, "OPSIS_START_CLASSIFY_DISABLED=false");
});
