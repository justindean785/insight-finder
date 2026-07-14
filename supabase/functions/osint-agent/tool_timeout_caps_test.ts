// tool_timeout_caps_test.ts — Phase B3: the three chronic time-sink tools are
// capped, and a tool that blows its cap returns a schema-safe timeout result
// (never throws) while the abort signal fires so the in-flight fetch is cancelled.
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  toolTimeoutMs,
  DEFAULT_TOOL_TIMEOUT_MS,
  runWithToolTimeout,
} from "./cache.ts";

Deno.test("B3 caps: gemini_deep_dork=12s, deepfind_reverse_email=8s, jina_reader_scrape=8s", () => {
  assertEquals(toolTimeoutMs("gemini_deep_dork"), 12_000);
  assertEquals(toolTimeoutMs("deepfind_reverse_email"), 8_000);
  assertEquals(toolTimeoutMs("jina_reader_scrape"), 8_000);
});

Deno.test("B3 caps: gemini_deep_dork was cut from its old 30s tail", () => {
  assert(toolTimeoutMs("gemini_deep_dork") < 30_000, "gemini_deep_dork must no longer allow a 30s run");
});

Deno.test("B3 caps: an unlisted tool still uses the default cap", () => {
  assertEquals(toolTimeoutMs("some_free_tool"), DEFAULT_TOOL_TIMEOUT_MS);
});

Deno.test("B3: blowing the cap returns a schema-safe timeout and aborts the fetch signal", async () => {
  let captured: AbortSignal | null = null;
  // A factory that never resolves — like a stalled provider fetch.
  const result = await runWithToolTimeout(
    "jina_reader_scrape",
    (signal) => {
      captured = signal;
      return new Promise(() => {}); // never settles on its own
    },
    20, // tiny cap for the test
  );
  // Never throws; returns a schema-safe { ok:false, _tool_timeout } result.
  const r = result as { ok?: boolean; _tool_timeout?: boolean; error?: string };
  assertEquals(r.ok, false);
  assertEquals(r._tool_timeout, true);
  assert(typeof r.error === "string" && r.error.includes("timeout"));
  // The per-tool signal was aborted so a signal-forwarding fetch is cancelled.
  assert(captured !== null && (captured as AbortSignal).aborted, "timeout must abort the factory signal");
});

// Telemetry-backed overrides (2026-07-08 failing-tools panel): these tools
// chronically hit the 12s default and lost coverage. Regression-guard the fix.
Deno.test("timeout overrides: chronically-slow tools exceed the 12s default", () => {
  // Serus POLLS ~25s upstream by design — a 12s cap guaranteed a timeout.
  assert(toolTimeoutMs("serus_darkweb_scan") >= 25_000, "serus must clear its ~25s poll window");
  assertEquals(toolTimeoutMs("crtsh_lookup"), 25_000);
  assertEquals(toolTimeoutMs("crtsh_subdomains"), 25_000);
  assertEquals(toolTimeoutMs("whois_lookup"), 20_000);
  // wayback_snapshots must match its cdx peer (which is already 25s).
  assertEquals(toolTimeoutMs("wayback_snapshots"), toolTimeoutMs("wayback_cdx_search"));
});

// Audit F1 (2026-07-08): minimax_correlate timed out at 12,143ms on the 12s default,
// so the correlation engine produced zero output — raised to 20s. RECURRENCE
// 2026-07-09: a real correlation COMPLETED at 22,487ms but the 20s cap had already
// binned it as a timeout, so the cap was raised again to 30s (cache.ts). Keep this
// guard in lockstep with that value.
Deno.test("timeout overrides: minimax_correlate clears the 12s default that killed it", () => {
  assert(
    toolTimeoutMs("minimax_correlate") > DEFAULT_TOOL_TIMEOUT_MS,
    "minimax_correlate must exceed the default cap it was timing out on",
  );
  assertEquals(toolTimeoutMs("minimax_correlate"), 30_000);
});
