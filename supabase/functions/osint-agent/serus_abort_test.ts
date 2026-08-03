// serus_abort_test.ts — the wrapper's cancellation must actually stop Serus.
//
// Review finding on #398. serus.ts's execute() did not accept the AI SDK's
// options argument, so the wrapper AbortSignal never reached runSerusScan.
// runSerusScan took no signal, its poll sleep was a bare setTimeout, and none of
// its fetchRetry calls carried a signal. A 30s wrapper cap therefore returned
// while Serus kept sleeping and issuing requests for another ~25s+ — credits
// spent, provider still hit, result discarded. Orphaned work.
//
// These are behavioural, not source-scraping: they drive real aborts through the
// real function with fetch stubbed.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

// env.ts snapshots SERUS_API_KEY at module-evaluation time, so a static import
// would capture an unset key and every call would short-circuit on
// `serus_key_missing` before reaching a single fetch. Set it first, then load
// the module dynamically.
const PRIOR_SERUS_KEY = Deno.env.get("SERUS_API_KEY");
Deno.env.set("SERUS_API_KEY", "test-key");
const { runSerusScan, SERUS_OPERATION_DEADLINE_MS } = await import("./tools/serus_core.ts");
// Restore IMMEDIATELY after the import. env.ts snapshots the key at
// module-evaluation time, so serus_core.ts has already captured it — but leaving
// it set would leak into later test modules in the same process and quietly
// invalidate their missing-key cases (e.g. serus_test.ts).
if (PRIOR_SERUS_KEY === undefined) Deno.env.delete("SERUS_API_KEY");
else Deno.env.set("SERUS_API_KEY", PRIOR_SERUS_KEY);

const realFetch = globalThis.fetch;
function restore() { globalThis.fetch = realFetch; }

Deno.test("cancellation during the poll sleep prevents any further request", async () => {
  let calls = 0;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    calls++;
    const u = String(url);
    if (u.endsWith("/darkweb/scans") && init?.method === "POST") {
      return Promise.resolve(new Response(JSON.stringify({ id: "scan-1" }), { status: 200 }));
    }
    // Any poll would keep the scan pending forever.
    return Promise.resolve(new Response(JSON.stringify({ status: "pending" }), { status: 200 }));
  }) as typeof fetch;

  const ctrl = new AbortController();
  // Abort while the first poll interval is still sleeping.
  const t = setTimeout(() => ctrl.abort(), 40);
  const started = Date.now();
  const res = await runSerusScan("email", "a@b.c", { signal: ctrl.signal, intervalMs: 5_000, maxRetries: 10 });
  clearTimeout(t);
  const elapsed = Date.now() - started;
  restore();

  assertEquals(res.ok, false);
  assertEquals(res.status, "timeout");
  assertEquals(calls, 1, `expected only the initiate call, got ${calls} — a poll was issued after abort`);
  assert(elapsed < 4_000, `returned in ${elapsed}ms — it sat out the full sleep instead of aborting`);
});

Deno.test("cancellation reaches an in-flight request", async () => {
  let sawSignalAbort = false;
  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
    // Never resolve; settle only when the caller's signal aborts.
    return new Promise<Response>((_resolve, reject) => {
      const sig = init?.signal;
      if (sig?.aborted) { sawSignalAbort = true; reject(new DOMException("Aborted", "AbortError")); return; }
      sig?.addEventListener("abort", () => {
        sawSignalAbort = true;
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  }) as typeof fetch;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 50);
  const started = Date.now();
  const res = await runSerusScan("email", "a@b.c", { signal: ctrl.signal });
  const elapsed = Date.now() - started;
  clearTimeout(t);
  restore();

  assert(sawSignalAbort, "the abort never reached the in-flight fetch — the signal is not being forwarded");
  assert(
    elapsed < 2_000,
    `initiate abort took ${elapsed}ms — ended by fetchRetry's own timeout, not by the forwarded signal`,
  );
  assertEquals(res.ok, false);
});

Deno.test("the internal deadline bounds the operation with no external signal at all", async () => {
  let calls = 0;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    calls++;
    const u = String(url);
    if (u.endsWith("/darkweb/scans") && init?.method === "POST") {
      return Promise.resolve(new Response(JSON.stringify({ id: "scan-1" }), { status: 200 }));
    }
    return Promise.resolve(new Response(JSON.stringify({ status: "pending" }), { status: 200 }));
  }) as typeof fetch;

  const started = Date.now();
  // Short deadline so the test is fast; the production value is asserted separately.
  const res = await runSerusScan("email", "a@b.c", { deadlineMs: 120, intervalMs: 30, maxRetries: 50 });
  const elapsed = Date.now() - started;
  restore();

  assertEquals(res.status, "timeout");
  assert(elapsed < 1_500, `deadline did not bound the run (${elapsed}ms)`);
  assert(calls < 50, `polling continued past the deadline (${calls} calls)`);
});

Deno.test("the production deadline is well below the wrapper cap", async () => {
  const { toolTimeoutMs } = await import("./cache.ts");
  assert(
    toolTimeoutMs("serus_darkweb_scan") > SERUS_OPERATION_DEADLINE_MS,
    "wrapper cap must exceed the internal deadline",
  );
});

Deno.test("cancellation reaches an in-flight POLL request, not just the initiate", async () => {
  // Gap found by mutation testing: removing `signal` from the poll fetches broke
  // nothing, because the only in-flight test aborted during INITIATE. The poll
  // loop is where Serus spends almost all of its time, so it is the request that
  // matters most.
  let abortedUrl: string | null = null;
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/darkweb/scans") && init?.method === "POST") {
      return Promise.resolve(new Response(JSON.stringify({ id: "scan-1" }), { status: 200 }));
    }
    // The POLL never resolves; it settles only if its signal aborts.
    return new Promise<Response>((_resolve, reject) => {
      const sig = init?.signal;
      const fail = () => { abortedUrl = u; reject(new DOMException("Aborted", "AbortError")); };
      if (sig?.aborted) { fail(); return; }
      sig?.addEventListener("abort", fail, { once: true });
    });
  }) as typeof fetch;

  const ctrl = new AbortController();
  // Long enough to clear the 20ms sleep and be inside the poll fetch.
  const t = setTimeout(() => ctrl.abort(), 120);
  const started = Date.now();
  const res = await runSerusScan("email", "a@b.c", { signal: ctrl.signal, intervalMs: 20, maxRetries: 5 });
  const elapsed = Date.now() - started;
  clearTimeout(t);
  restore();

  // The elapsed bound is load-bearing. Without it this test still passes when the
  // signal is NOT forwarded: fetchRetry's own 12s-per-attempt timer eventually
  // aborts the request, so `abortedUrl` gets set ~24s later and the assertion
  // below is satisfied by the wrong mechanism. Found by mutation testing.
  assert(
    elapsed < 2_000,
    `poll abort took ${elapsed}ms — the signal is not reaching the poll fetch; ` +
      `fetchRetry's own per-attempt timeout eventually ended it instead`,
  );

  assert(
    abortedUrl !== null && !String(abortedUrl).endsWith("/darkweb/scans"),
    `the abort never reached an in-flight POLL request (aborted url: ${abortedUrl}) — poll fetches are not carrying the signal`,
  );
  assertEquals(res.ok, false);
});

Deno.test("a signal that is ALREADY aborted stops the scan before any request", async () => {
  // Review finding: the outer signal was only subscribed via addEventListener, so
  // a signal that had already fired never reached the internal controller and the
  // scan initiated anyway.
  let calls = 0;
  globalThis.fetch = ((_u: string | URL | Request, _i?: RequestInit) => {
    calls++;
    return Promise.resolve(new Response(JSON.stringify({ id: "scan-1" }), { status: 200 }));
  }) as typeof fetch;

  const ctrl = new AbortController();
  ctrl.abort();                       // already cancelled before the call
  const res = await runSerusScan("email", "a@b.c", { signal: ctrl.signal });
  restore();

  assertEquals(calls, 0, `issued ${calls} request(s) for an already-cancelled caller`);
  assertEquals(res.ok, false);
  assertEquals(res.status, "timeout");
});

Deno.test("a cancelled scan reports as a deadline, never as a provider failure", async () => {
  // Review finding: the final-attempt poll catch returned `poll_failed`, blaming
  // Serus for our own cancellation. That misclassification can trip the circuit
  // breaker and suppress a healthy provider for the rest of the run.
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/darkweb/scans") && init?.method === "POST") {
      return Promise.resolve(new Response(JSON.stringify({ id: "scan-1" }), { status: 200 }));
    }
    return new Promise<Response>((_res, rej) => {
      const sig = init?.signal;
      const fail = () => rej(new DOMException("Aborted", "AbortError"));
      if (sig?.aborted) { fail(); return; }
      sig?.addEventListener("abort", fail, { once: true });
    });
  }) as typeof fetch;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 60);
  const res = await runSerusScan("email", "a@b.c", { signal: ctrl.signal, intervalMs: 10, maxRetries: 1 });
  clearTimeout(t);
  restore();

  const err = res.error as Record<string, unknown> | undefined;
  assertEquals(err?.code, "serus_deadline", `cancellation reported as ${JSON.stringify(err)}`);
  assertEquals(err?.error, "aborted");
  assert(
    String(err?.message ?? "").includes("no further polling"),
    "the abort payload lost its message — serusErrorPayload would have flattened it to http_0",
  );
});
