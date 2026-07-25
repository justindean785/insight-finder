// tool_timeout_caps_test.ts — Phase B3: the three chronic time-sink tools are
// capped, and a tool that blows its cap returns a schema-safe timeout result
// (never throws) while the abort signal fires so the in-flight fetch is cancelled.
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  toolTimeoutMs,
  DEFAULT_TOOL_TIMEOUT_MS,
  runWithToolTimeout,
} from "./cache.ts";

Deno.test("B3 caps: gemini_deep_dork=20s, jina_reader_scrape=18s; deepfind_reverse_email on the 12s default (F2)", () => {
  // 2026-07-25 audit: gemini_deep_dork hit its 12s cap mid-response too often
  // (2 timeout failures / 2 in-flight skips of 8 attempts in the audited run).
  // Raised 12s -> 20s, matching the prior recalibration ceiling.
  assertEquals(toolTimeoutMs("gemini_deep_dork"), 20_000);
  // 18s (was 8s): one slow-but-recoverable render must not burn the provider —
  // paired with the multi-origin circuit policy (jina dead-lists only the slow URL
  // and suppresses only after 3 consecutive timeouts; see circuit_timeout_test.ts).
  assertEquals(toolTimeoutMs("jina_reader_scrape"), 18_000);
  // F2: the 8s deepfind_reverse_email override was removed — the provider
  // legitimately needs the 12s default (9/36 failures were timeouts at exactly 8s).
  assertEquals(toolTimeoutMs("deepfind_reverse_email"), DEFAULT_TOOL_TIMEOUT_MS);
  // F3 (2026-07-15): oathnet_lookup AND the whole oathnet family raised to 22s.
  // The family's own fetch budget is 20s; the wrapper cap must sit ABOVE it or it
  // guillotines the call before the fetch's timeout can return a clean result. A
  // live run proved the earlier 15s (oathnet_lookup only) still killed a 20s fetch
  // at 12,127ms — the sibling endpoints had no override at all (12s default) — and
  // one timeout then suppressed the whole family for the run.
  assertEquals(toolTimeoutMs("oathnet_lookup"), 22_000);
  assertEquals(toolTimeoutMs("oathnet_stealer_search"), 22_000);
  assertEquals(toolTimeoutMs("oathnet_victims_search"), 22_000);
  assert(toolTimeoutMs("oathnet_lookup") > 20_000, "oathnet wrapper cap must exceed its 20s fetch budget");
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
// so the correlation engine produced zero output. Raised 12s -> 20s.
// Recurrence (2026-07-09, live trybutez/fullyteamjody run): correlate COMPLETED at
// 22,487ms but the 20s cap had already discarded it as a timeout — the finished
// correlation was thrown away. Its input is BOUNDED (16k chars / 1500 out tokens),
// so latency is bounded; the cap simply sat below the workload's real p99. Raised to
// 30s (matching the serus precedent) so a completed correlation is USED, not binned.
Deno.test("timeout overrides: minimax_correlate clears its real bounded-batch latency (~22.5s)", () => {
  assert(
    toolTimeoutMs("minimax_correlate") > DEFAULT_TOOL_TIMEOUT_MS,
    "minimax_correlate must exceed the default cap it was timing out on",
  );
  // Must clear the observed 22,487ms real-world completion, with headroom, or a
  // finished correlation gets discarded again.
  assert(
    toolTimeoutMs("minimax_correlate") >= 25_000,
    "minimax_correlate cap must clear its ~22.5s observed completion latency",
  );
  // 2026-07-25 audit: still timed out (1 of 2 calls, at ~30s) even at the 30s cap —
  // it's identity consolidation, not raw search, so raised 30s -> 60s to stop
  // discarding completed correlations and stop the model compensating with more
  // raw searches when correlate fails.
  assertEquals(toolTimeoutMs("minimax_correlate"), 60_000);
});
