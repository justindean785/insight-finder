// Tests for the per-tool timeout AbortController wiring (runWithToolTimeout +
// withTimeoutSignal). A timeout must ABORT the in-flight tool call, not just
// abandon the promise while the paid fetch keeps running.
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { runWithToolTimeout, withTimeoutSignal } from "./cache.ts";

Deno.test("withTimeoutSignal: no existing signal → uses the timeout signal directly", () => {
  const ctrl = new AbortController();
  const merged = withTimeoutSignal({ toolCallId: "x" }, ctrl.signal) as {
    toolCallId: string;
    abortSignal: AbortSignal;
  };
  assertEquals(merged.toolCallId, "x"); // preserves other opts
  assertEquals(merged.abortSignal, ctrl.signal);
});

Deno.test("withTimeoutSignal: existing SDK signal → EITHER firing aborts the merged signal", () => {
  const sdk = new AbortController();
  const timeout = new AbortController();
  const merged = withTimeoutSignal({ abortSignal: sdk.signal }, timeout.signal) as {
    abortSignal: AbortSignal;
  };
  assert(!merged.abortSignal.aborted);
  sdk.abort(); // top-level request cancellation
  assert(merged.abortSignal.aborted, "SDK abort should propagate to merged signal");
});

Deno.test("withTimeoutSignal: existing signal → timeout firing also aborts merged", () => {
  const sdk = new AbortController();
  const timeout = new AbortController();
  const merged = withTimeoutSignal({ abortSignal: sdk.signal }, timeout.signal) as {
    abortSignal: AbortSignal;
  };
  assert(!merged.abortSignal.aborted);
  timeout.abort(); // per-tool timeout
  assert(merged.abortSignal.aborted, "timeout abort should propagate to merged signal");
});

Deno.test("runWithToolTimeout: on timeout ABORTS the factory signal + returns a schema-safe timeout result", async () => {
  let sawAbort = false;
  const out = await runWithToolTimeout(
    "slow_tool",
    (signal) =>
      // A tool that only settles when its signal aborts — proves the timeout
      // actually cancels it rather than leaving it running.
      new Promise<unknown>((resolve) => {
        signal.addEventListener("abort", () => {
          sawAbort = true;
          resolve({ ok: false, note: "aborted" });
        }, { once: true });
      }),
    20,
  );
  assert(sawAbort, "factory signal should be aborted on timeout");
  const r = out as { _tool_timeout?: boolean; _tool_error?: boolean; ok?: boolean };
  assertEquals(r._tool_timeout, true);
  assertEquals(r._tool_error, true);
  assertEquals(r.ok, false);
});

Deno.test("runWithToolTimeout: fast factory returns its value and does NOT abort", async () => {
  let aborted = false;
  const out = await runWithToolTimeout(
    "fast_tool",
    (signal) => {
      signal.addEventListener("abort", () => { aborted = true; }, { once: true });
      return Promise.resolve({ ok: true, data: 42 });
    },
    1000,
  );
  assertEquals((out as { data?: number }).data, 42);
  assert(!aborted, "a fast tool must not be aborted");
});
