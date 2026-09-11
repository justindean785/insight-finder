/**
 * Finalize-window correlate exemption -- closes the second blocker after #530/#531.
 * Production audit 2026-09-01: 5/5 minimax_correlate calls skipped at 90s+ with
 * "finalize window open; live lookup skipped" despite a due correlate pass.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  FINALIZE_WINDOW_LIVE_EXEMPT,
  isFinalizeWindowLiveLookupExempt,
  shouldDeferFinalizeForCorrelate,
  shouldSkipForFinalizeWindow,
  FINALIZE_RESERVE_MS,
  requiredCompletionMs,
} from "./orchestrator-finalize.ts";
import { ORCHESTRATOR_WALL_CLOCK_MS } from "./orchestrator-budget.ts";

const openAt = ORCHESTRATOR_WALL_CLOCK_MS - FINALIZE_RESERVE_MS;
const lateMs = openAt + 5_000;

Deno.test("FINALIZE_WINDOW_LIVE_EXEMPT contains only minimax_correlate", () => {
  assertEquals([...FINALIZE_WINDOW_LIVE_EXEMPT], ["minimax_correlate"]);
  assertEquals(isFinalizeWindowLiveLookupExempt("minimax_correlate"), true);
  assertEquals(isFinalizeWindowLiveLookupExempt("jina_reader_scrape"), false);
});

Deno.test("minimax_correlate is not skipped after the reserve window opens", () => {
  assertEquals(shouldSkipForFinalizeWindow(lateMs, false, { toolName: "jina_reader_scrape" }), true);
  assertEquals(shouldSkipForFinalizeWindow(lateMs, false, { toolName: "minimax_correlate" }), false);
});

// The deferral is bounded by a per-run counter AND a required-completion budget
// (orchestrator-finalize.ts, correcting the Codex P1 on the PR that first bounded
// it -- review thread PRRT_kwDOSxbowM6hW_4I). This test keeps the eligibility
// AXES (outcome / correlateDue / counter); the budget axis itself is driven
// end-to-end in correlate_finalize_deferral_bound_test.ts.
Deno.test("shouldDeferFinalizeForCorrelate: due and never attempted, WITH enough remaining budget, is eligible", () => {
  // openAt alone is not enough under real runtime constants (see the window test
  // below) -- use a budget large enough that remaining time clears
  // requiredCompletionMs(), isolating the correlateDue/outcome/counter axes from
  // the completion-budget axis.
  const roomyOpts = { budgetMs: openAt + requiredCompletionMs() + 1_000 };
  assertEquals(shouldDeferFinalizeForCorrelate(true, null, 0, openAt, false, roomyOpts), true);
  assertEquals(shouldDeferFinalizeForCorrelate(true, "ok", 0, openAt, false, roomyOpts), false);
  assertEquals(shouldDeferFinalizeForCorrelate(true, "failed", 0, openAt, false, roomyOpts), false);
  assertEquals(shouldDeferFinalizeForCorrelate(false, null, 0, openAt, false, roomyOpts), false);
});

Deno.test("shouldDeferFinalizeForCorrelate: a spent counter blocks it even with room to spare", () => {
  const roomyOpts = { budgetMs: openAt + requiredCompletionMs() + 1_000 };
  assertEquals(shouldDeferFinalizeForCorrelate(true, null, 1, openAt, false, roomyOpts), false);
});

// THE P1 THIS FILE NOW PINS: at the real reserve-window opening, under real
// runtime constants, there is NOT enough remaining budget to safely defer.
// correlateDeferralFloorMs()'s old 30s-grace answer to "is openAt eligible?" was
// YES; the corrected required-completion-budget answer is NO.
Deno.test("shouldDeferFinalizeForCorrelate: at the real reserve opening, production budgets refuse the deferral", () => {
  assertEquals(shouldDeferFinalizeForCorrelate(true, null, 0, openAt, false), false);
});
