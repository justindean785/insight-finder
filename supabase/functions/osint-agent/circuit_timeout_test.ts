// Timeout-suppression policy tests.
//
// A single timeout must NOT take a general multi-origin tool (jina_reader_scrape,
// socialfetch_web_read) offline for the whole run — one slow page is a per-URL
// problem, so we dead-list only that URL and suppress the tool only after
// >= TIMEOUT_SUPPRESS_CONSECUTIVE consecutive timeouts. Single-upstream paid
// providers keep first-timeout provider suppression (oathnet gets a 2-strike
// tolerance because its own fetch budget sits near the wrapper cap). And
// minimax_web_search (Perplexity) is decoupled from the MiniMax reasoning tools so
// a search timeout can't suppress minimax_correlate.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  shouldRun,
  recordResult,
  isProviderSuppressed,
  clearThread,
  TIMEOUT_SUPPRESS_CONSECUTIVE,
} from "./circuit.ts";

Deno.test("jina: one timeout dead-lists ONLY that URL; other hosts still run", () => {
  const thread = "t-jina-one-timeout";
  clearThread(thread);
  const slow = "https://slow.example/a";
  const other = "https://fast.example/b";

  recordResult(thread, "jina_reader_scrape", slow, "default", { status: "timeout" });

  // The slow URL is dead-listed…
  assertEquals(shouldRun(thread, "jina_reader_scrape", slow).allow, false, "the slow URL is dead-listed");
  // …but the provider is NOT suppressed, and a different host still runs.
  assertEquals(isProviderSuppressed(thread, "jina_reader_scrape").suppressed, false, "one timeout must not suppress jina");
  assertEquals(shouldRun(thread, "jina_reader_scrape", other).allow, true, "a different host must still run after one timeout");

  clearThread(thread);
});

Deno.test("jina: TIMEOUT_SUPPRESS_CONSECUTIVE consecutive timeouts suppress the tool", () => {
  const thread = "t-jina-three-timeouts";
  clearThread(thread);

  for (let i = 0; i < TIMEOUT_SUPPRESS_CONSECUTIVE; i++) {
    recordResult(thread, "jina_reader_scrape", `https://x.example/${i}`, "default", { status: "timeout" });
  }

  const sup = isProviderSuppressed(thread, "jina_reader_scrape");
  assertEquals(sup.suppressed, true, `${TIMEOUT_SUPPRESS_CONSECUTIVE} consecutive timeouts must suppress jina`);
  assert(
    typeof sup.reason === "string" && sup.reason.includes("consecutive timeouts"),
    "suppression reason must distinguish the consecutive-timeout path",
  );
  assertEquals(shouldRun(thread, "jina_reader_scrape", "https://any.example/z").allow, false, "jina suppressed after 3 consecutive timeouts");

  clearThread(thread);
});

Deno.test("jina: a success between timeouts resets the consecutive counter (no premature suppression)", () => {
  const thread = "t-jina-reset";
  clearThread(thread);

  recordResult(thread, "jina_reader_scrape", "https://a.example", "default", { status: "timeout" });
  recordResult(thread, "jina_reader_scrape", "https://b.example", "default", { status: "ok", artifactCount: 1 });
  recordResult(thread, "jina_reader_scrape", "https://c.example", "default", { status: "timeout" });
  recordResult(thread, "jina_reader_scrape", "https://d.example", "default", { status: "timeout" });

  // Only 2 CONSECUTIVE timeouts since the success reset the counter → not suppressed.
  assertEquals(isProviderSuppressed(thread, "jina_reader_scrape").suppressed, false, "a success must reset the consecutive-timeout run");

  clearThread(thread);
});

Deno.test("socialfetch_web_read: same multi-origin policy as jina", () => {
  const thread = "t-sfweb-timeout";
  clearThread(thread);

  recordResult(thread, "socialfetch_web_read", "https://youtube.com/@a", "default", { status: "timeout" });
  assertEquals(isProviderSuppressed(thread, "socialfetch_web_read").suppressed, false, "one timeout must not suppress socialfetch_web_read");
  assertEquals(shouldRun(thread, "socialfetch_web_read", "https://youtube.com/@b").allow, true, "a different page must still run");

  clearThread(thread);
});

Deno.test("minimax_web_search timeout does NOT suppress minimax_correlate (decoupled)", () => {
  const thread = "t-mm-decouple";
  clearThread(thread);

  recordResult(thread, "minimax_web_search", "some query", "default", { status: "timeout" });

  // The search worker itself IS suppressed (single-upstream, first-timeout policy)…
  assertEquals(isProviderSuppressed(thread, "minimax_web_search").suppressed, true, "the search worker suppresses on its own timeout");
  // …but the identity-merge step must remain available.
  assertEquals(isProviderSuppressed(thread, "minimax_correlate").suppressed, false, "correlate must be decoupled from a search timeout");
  assertEquals(shouldRun(thread, "minimax_correlate", "batch-1").allow, true, "correlate must still run after a search timeout");

  clearThread(thread);
});

Deno.test("minimax_plan_pivots timeout does NOT suppress minimax_correlate (own provider)", () => {
  const thread = "t-mm-planpivots";
  clearThread(thread);

  // The chronically-timing-out planner is deliberately ungrouped so its timeout
  // suppresses ONLY itself, never the identity-merge step.
  recordResult(thread, "minimax_plan_pivots", "seed", "default", { status: "timeout" });

  assertEquals(isProviderSuppressed(thread, "minimax_plan_pivots").suppressed, true, "plan_pivots suppresses itself on timeout");
  assertEquals(isProviderSuppressed(thread, "minimax_correlate").suppressed, false, "correlate must survive a plan_pivots timeout");
  assertEquals(shouldRun(thread, "minimax_correlate", "batch-1").allow, true, "correlate must still run after a plan_pivots timeout");

  clearThread(thread);
});

Deno.test("oathnet_lookup: first timeout tolerated, second suppresses the family (2-strike preserved)", () => {
  const thread = "t-oath-timeout";
  clearThread(thread);

  recordResult(thread, "oathnet_lookup", "target@example.com", "default", { status: "timeout" });
  // First timeout is latency noise — oathnet's 2-strike tolerance keeps the family alive.
  assertEquals(isProviderSuppressed(thread, "oathnet_lookup").suppressed, false, "oathnet tolerates one timeout");
  assertEquals(shouldRun(thread, "oathnet_stealer_search", "target").allow, true, "sibling stays available after one oathnet timeout");

  recordResult(thread, "oathnet_lookup", "target2@example.com", "default", { status: "timeout" });
  // Second consecutive timeout suppresses the whole family.
  assertEquals(isProviderSuppressed(thread, "oathnet_lookup").suppressed, true, "oathnet suppresses on the second timeout");
  assertEquals(isProviderSuppressed(thread, "oathnet_victims_search").suppressed, true, "a sibling oathnet endpoint is also suppressed");

  clearThread(thread);
});

Deno.test("paid single-upstream providers (exa, indicia) keep first-timeout suppression", () => {
  const thread = "t-paid-timeout";
  clearThread(thread);

  recordResult(thread, "exa_search", "q", "default", { status: "timeout" });
  assertEquals(isProviderSuppressed(thread, "exa_search").suppressed, true, "exa suppresses on first timeout");
  // exa family sibling also suppressed.
  assertEquals(isProviderSuppressed(thread, "exa_get_contents").suppressed, true, "exa family suppressed together");

  recordResult(thread, "indicia_phone", "+15551234567", "default", { status: "timeout" });
  assertEquals(isProviderSuppressed(thread, "indicia_person").suppressed, true, "indicia family suppresses on first timeout");

  clearThread(thread);
});

// Mixed-outcome regression: timeout suppression must key off a DEDICATED timeout
// streak, not b.consecutive (which counts every non-ok outcome). Otherwise a run
// like 404 → 451 → timeout would falsely read as "3 consecutive timeouts".
// These assert isProviderSuppressed (the timeout-suppression path specifically);
// the generic 3-consecutive-failure guard is a SEPARATE mechanism.

Deno.test("mixed: 404 → timeout → timeout does NOT trip timeout suppression (non-timeout doesn't count)", () => {
  const thread = "t-mix-404tt";
  clearThread(thread);
  recordResult(thread, "jina_reader_scrape", "https://a.example", "default", { status: "http_404" });
  recordResult(thread, "jina_reader_scrape", "https://b.example", "default", { status: "timeout" });
  recordResult(thread, "jina_reader_scrape", "https://c.example", "default", { status: "timeout" });
  // Only 2 CONSECUTIVE TIMEOUTS — the 404 is not a timeout.
  assertEquals(isProviderSuppressed(thread, "jina_reader_scrape").suppressed, false, "a 404 must not count toward the timeout streak");
  clearThread(thread);
});

Deno.test("mixed: timeout → 400 → timeout does NOT trip timeout suppression (400 resets the streak)", () => {
  const thread = "t-mix-t400t";
  clearThread(thread);
  recordResult(thread, "jina_reader_scrape", "https://a.example", "default", { status: "timeout" });
  recordResult(thread, "jina_reader_scrape", "https://b.example", "default", { status: "http_400" });
  recordResult(thread, "jina_reader_scrape", "https://c.example", "default", { status: "timeout" });
  // Streak: 1 → reset by the 400 → 1. Never reaches 3.
  assertEquals(isProviderSuppressed(thread, "jina_reader_scrape").suppressed, false, "a 400 between timeouts must reset the timeout streak");
  clearThread(thread);
});

Deno.test("mixed: timeout → timeout → timeout DOES suppress, and the reason reports the true streak", () => {
  const thread = "t-mix-ttt";
  clearThread(thread);
  for (const u of ["a", "b", "c"]) {
    recordResult(thread, "jina_reader_scrape", `https://${u}.example`, "default", { status: "timeout" });
  }
  const sup = isProviderSuppressed(thread, "jina_reader_scrape");
  assertEquals(sup.suppressed, true, "3 uninterrupted timeouts suppress the tool");
  assert(typeof sup.reason === "string" && sup.reason.includes("3 consecutive timeouts"), "reason must report the true timeout streak");
  clearThread(thread);
});

Deno.test("mixed: timeout → success → timeout → timeout does NOT suppress (success resets the streak)", () => {
  const thread = "t-mix-tsuctt";
  clearThread(thread);
  recordResult(thread, "jina_reader_scrape", "https://a.example", "default", { status: "timeout" });
  recordResult(thread, "jina_reader_scrape", "https://b.example", "default", { status: "ok", artifactCount: 1 });
  recordResult(thread, "jina_reader_scrape", "https://c.example", "default", { status: "timeout" });
  recordResult(thread, "jina_reader_scrape", "https://d.example", "default", { status: "timeout" });
  // Streak after the success: 0 → 1 → 2. Never reaches 3.
  assertEquals(isProviderSuppressed(thread, "jina_reader_scrape").suppressed, false, "a success resets the timeout streak");
  clearThread(thread);
});
