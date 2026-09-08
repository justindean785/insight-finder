// tool_timeout_caps_test.ts — Phase B3: the three chronic time-sink tools are
// capped, and a tool that blows its cap returns a schema-safe timeout result
// (never throws) while the abort signal fires so the in-flight fetch is cancelled.
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  toolTimeoutMs,
  DEFAULT_TOOL_TIMEOUT_MS,
  runWithToolTimeout,
} from "./cache.ts";
import {
  SOCIALFETCH_DEFAULT_TIMEOUT_MS,
  SOCIALFETCH_YOUTUBE_FAST_TIMEOUT_MS,
} from "./tool-registry.ts";

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

// Backport of the Lovable mirror's 8df15d2 (fofa_search + markdown_extract). Both
// tools arrived with NO entry in TOOL_TIMEOUT_OVERRIDE_MS, so both inherited the 12s
// default while carrying their own, larger fetch budgets — the precise shape of the
// oathnet_lookup regression the table's comments already document: the wrapper fires
// first, the tool's own timeout never gets to return a clean result, the completed
// work is discarded, and one such timeout trips the circuit breaker for the rest of
// the run. Read the fetch budgets off the live source so this test tracks the real
// call sites rather than a copy of them that can silently drift.
Deno.test("timeout overrides: fofa_search and markdown_extract clear their own fetch budgets", () => {
  const src = Deno.readTextFileSync(new URL("./tool-registry.ts", import.meta.url));

  const budgetFor = (toolName: string): number => {
    const block = src.slice(src.indexOf(`    ${toolName}: tool({`));
    assert(block.length > 0, `${toolName} not found in tool-registry.ts`);
    // First fetchT(...) trailing timeout argument inside the tool's own definition.
    const m = block.slice(0, 3000).match(/\}, (\d[\d_]*)\);/);
    assert(m, `${toolName} has no fetchT timeout argument — call shape changed`);
    return Number(m[1].replace(/_/g, ""));
  };

  for (const name of ["fofa_search", "markdown_extract"]) {
    const cap = toolTimeoutMs(name);
    const fetchBudget = budgetFor(name);
    assert(
      cap > DEFAULT_TOOL_TIMEOUT_MS,
      `${name} must not sit on the ${DEFAULT_TOOL_TIMEOUT_MS}ms default — its own fetch runs ${fetchBudget}ms`,
    );
    assert(
      cap > fetchBudget,
      `${name} wrapper cap (${cap}ms) must exceed its own fetch budget (${fetchBudget}ms), ` +
      `or the wrapper guillotines the call before the fetch can return cleanly`,
    );
  }
});

// ── socialfetch_web_read: sized to the MEASURED success distribution ────────
//
// ⚠️ THIS TEST WAS WRONG ONCE, AND THE WAY IT WAS WRONG IS THE LESSON.
//
// The first version pinned 15s/12s and cited "21 aborts, avg 22,194ms, ZERO
// successes ever observed" from a written brief. Queried against the source the
// brief summarised (`tool_usage_log`), that claim does not hold — it came from a
// 4-run sample of 3 calls and was generalised to "the provider never answers":
//
//     30 days: 127 calls, 76 OK (60%), successes avg 5,446ms, p95 11,161ms
//     14 days:  71 calls, 43 OK (61%), successes p95 13,349ms
//     max successful duration, either window: 15,908ms
//     failures average 12,395ms
//
// A 12s tool cap would have severed 3 of 76 observed successes and cut through
// the 14-day p95. The tool is ordinary and somewhat slow, not dead.
//
// 18s clears the observed maximum with headroom, so it costs no evidence, while
// still trimming a failure path that previously ran to a 22s ceiling. Change
// these numbers ONLY against a fresh query of the success distribution — a
// prose summary of that distribution has already misled this file once.
Deno.test("socialfetch_web_read clears its measured success ceiling", () => {
  assertEquals(
    toolTimeoutMs("socialfetch_web_read"),
    22_000,
    "wrapper must stay above the tool's own 18s budget",
  );
});

Deno.test("socialfetch_web_read keeps the wrapper-above-own-budget invariant", () => {
  // This tool passes its budget as `fetchRetry(..., { timeoutMs: N })`, which the
  // structural scanner in tool_timeout_contract_test.ts does NOT see (it reads
  // `fetchT(…, N)` positional args only). So the invariant that file exists to
  // enforce rests, for this tool, on this test alone.
  //
  // 2026-09-08 performance audit: the tool's per-attempt timeout is no longer a
  // single literal — socialfetchHostPolicy() (tool-registry.ts) picks between
  // SOCIALFETCH_DEFAULT_TIMEOUT_MS (ordinary hosts) and the much shorter
  // SOCIALFETCH_YOUTUBE_FAST_TIMEOUT_MS (youtube.com/youtu.be, which measured a
  // 100% abort rate in production — see socialfetch_host_policy_test.ts). Import
  // the named constants directly rather than scraping a number out of source
  // text, and check the invariant against BOTH.
  assertEquals(SOCIALFETCH_DEFAULT_TIMEOUT_MS, 18_000, "the tool's own default fetch budget");
  assert(
    SOCIALFETCH_DEFAULT_TIMEOUT_MS > 15_908,
    `the default budget must clear the maximum observed SUCCESSFUL duration (15,908ms), saw ${SOCIALFETCH_DEFAULT_TIMEOUT_MS}`,
  );
  for (const own of [SOCIALFETCH_DEFAULT_TIMEOUT_MS, SOCIALFETCH_YOUTUBE_FAST_TIMEOUT_MS]) {
    assert(
      toolTimeoutMs("socialfetch_web_read") > own,
      `wrapper cap (${toolTimeoutMs("socialfetch_web_read")}ms) must exceed the tool's own ` +
        `fetch budget (${own}ms), or the wrapper guillotines the call before it can fail cleanly`,
    );
  }
  assert(
    SOCIALFETCH_YOUTUBE_FAST_TIMEOUT_MS < SOCIALFETCH_DEFAULT_TIMEOUT_MS,
    "the youtube fast-fail path must actually be faster than the default, or the policy does nothing",
  );
});
