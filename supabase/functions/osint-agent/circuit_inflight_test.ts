// Regression tests for the in-flight provider gate (F4 batch-race fix).
//
// Root cause: when parallel_tool_calls:false is ignored by the fallback gateway,
// multiple minimax_web_search calls are dispatched in the same step before any
// quota-401 returns and records. They all pass shouldRun because the suppression
// isn't set yet. Fix: markProviderInFlight before the live request; subsequent
// same-step calls see the flag and are blocked.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  shouldRun,
  recordResult,
  markProviderInFlight,
  clearProviderInFlight,
  clearThread,
  providerForTool,
} from "./circuit.ts";

Deno.test("minimax_web_search is decoupled from the reasoning tools' provider group", () => {
  // The search worker (Perplexity upstream) stays on its own "minimax" key; the
  // correlate/extract reasoning tools share "minimax_reason" so a SEARCH failure
  // can't suppress the identity-merge step (minimax_correlate). minimax_plan_pivots
  // is deliberately ungrouped (its own provider) so its chronic timeouts can't
  // suppress minimax_correlate — see circuit.ts.
  assertEquals(providerForTool("minimax_web_search"), "minimax");
  assertEquals(providerForTool("minimax_correlate"), "minimax_reason");
  assertEquals(providerForTool("minimax_extract"), "minimax_reason");
  assertEquals(providerForTool("minimax_plan_pivots"), "minimax_plan_pivots");
});

Deno.test("same-step parallel burst: second minimax call blocked while first is in-flight", () => {
  const thread = "t-inflight-block";
  clearThread(thread);

  // First call passes shouldRun — provider is idle.
  const first = shouldRun(thread, "minimax_web_search", "alice@example.com");
  assertEquals(first.allow, true, "first call should be allowed");

  // Simulate dispatch: mark provider in-flight before awaiting the result.
  markProviderInFlight(thread, "minimax_web_search");

  // Same-step sibling call for a different selector should be blocked.
  const second = shouldRun(thread, "minimax_web_search", "bob@example.com");
  assertEquals(second.allow, false, "parallel sibling should be blocked while first is in-flight");
  assertEquals(second.allow === false && "reason" in second && typeof second.reason === "string" && second.reason.includes("in-flight"), true);

  // After the first call returns, the gate clears.
  clearProviderInFlight(thread, "minimax_web_search");
  const third = shouldRun(thread, "minimax_web_search", "bob@example.com");
  assertEquals(third.allow, true, "next step should be allowed after in-flight cleared");

  clearThread(thread);
});

Deno.test("in-flight on one reasoning tool gates its sibling but NOT the search worker", () => {
  const thread = "t-inflight-sibling";
  clearThread(thread);

  // minimax_correlate starts a call.
  assertEquals(shouldRun(thread, "minimax_correlate", "batch-1").allow, true);
  markProviderInFlight(thread, "minimax_correlate");

  // minimax_extract shares the "minimax_reason" provider — must also be blocked.
  const ex = shouldRun(thread, "minimax_extract", "batch-2");
  assertEquals(ex.allow, false, "extract should be blocked while correlate is in-flight (same reasoning provider)");

  // minimax_web_search is now a DIFFERENT provider — a reasoning tool in-flight
  // must NOT gate the search worker (decoupling regression guard).
  const ws = shouldRun(thread, "minimax_web_search", "query");
  assertEquals(ws.allow, true, "web_search must be decoupled from the reasoning in-flight gate");

  clearProviderInFlight(thread, "minimax_correlate");
  clearThread(thread);
});

Deno.test("multi-origin tools (jina) are exempt from the in-flight gate — parallel reads of different URLs both run", () => {
  const thread = "t-inflight-multiorigin";
  clearThread(thread);

  // A jina scrape of one URL goes in-flight.
  assertEquals(shouldRun(thread, "jina_reader_scrape", "https://a.example/1").allow, true);
  markProviderInFlight(thread, "jina_reader_scrape");

  // A same-step scrape of a DIFFERENT URL must still run — multi-origin fan-out
  // isn't a shared-quota provider, so the in-flight lock must not drop it.
  assertEquals(
    shouldRun(thread, "jina_reader_scrape", "https://b.example/2").allow,
    true,
    "a different-URL jina read must not be blocked by the in-flight gate",
  );

  clearProviderInFlight(thread, "jina_reader_scrape");
  clearThread(thread);
});

Deno.test("in-flight gate does not affect a different provider", () => {
  const thread = "t-inflight-isolation";
  clearThread(thread);

  // deepfind is in-flight.
  markProviderInFlight(thread, "deepfind_reverse_email");

  // oathnet is a different provider — must not be blocked.
  const oa = shouldRun(thread, "oathnet_lookup", "target@example.com");
  assertEquals(oa.allow, true, "oathnet should not be blocked by deepfind in-flight");

  clearProviderInFlight(thread, "deepfind_reverse_email");
  clearThread(thread);
});

Deno.test("TOCTOU: mark before waitMs — sibling blocked even if mark is set after shouldRun", async () => {
  // Regression test for the prior TOCTOU: if markProviderInFlight ran AFTER an
  // `await waitMs` pacing delay, a sibling dispatched during the wait would pass
  // shouldRun (provider not yet in-flight) and fire a second live call. Fix is to
  // call markProviderInFlight before the await. Simulate that ordering here:
  const thread = "t-toctou";
  clearThread(thread);

  // First call: shouldRun allows, then we immediately mark (correct ordering).
  const first = shouldRun(thread, "minimax_web_search", "q1");
  assertEquals(first.allow, true);
  // Mark happens BEFORE any await (correct order).
  markProviderInFlight(thread, "minimax_web_search");

  // Simulate the pacing wait with a real microtask gap.
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Sibling dispatched after the await must still be blocked — the mark was set before.
  const sibling = shouldRun(thread, "minimax_web_search", "q2");
  assertEquals(sibling.allow, false, "sibling must be blocked even after async gap");

  clearProviderInFlight(thread, "minimax_web_search");
  clearThread(thread);
});

Deno.test("quota-401 after in-flight clears still suppresses the provider for the rest of the run", () => {
  const thread = "t-inflight-then-401";
  clearThread(thread);

  // Call goes in-flight.
  markProviderInFlight(thread, "minimax_web_search");
  // Comes back with quota-401 — clear in-flight then record result (as cache.ts does).
  clearProviderInFlight(thread, "minimax_web_search");
  recordResult(thread, "minimax_web_search", "q1", "default", { status: "http_401" });

  // Subsequent step must be suppressed (existing 10-min window logic).
  const d = shouldRun(thread, "minimax_web_search", "q2");
  assertEquals(d.allow, false, "401 must suppress the minimax provider for the rest of the run");

  // minimax_correlate is now a DIFFERENT provider (minimax_reason) — a SEARCH 401
  // must NOT suppress the identity-merge step (decoupling regression guard).
  assertEquals(
    shouldRun(thread, "minimax_correlate", "batch").allow,
    true,
    "correlate must stay available after a minimax_web_search 401",
  );

  clearThread(thread);
});
