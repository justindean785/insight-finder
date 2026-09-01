/**
 * Finalize-window correlate exemption — closes the second blocker after #530/#531.
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

Deno.test("shouldDeferFinalizeForCorrelate: due and never attempted defers once", () => {
  assertEquals(shouldDeferFinalizeForCorrelate(true, null), true);
  assertEquals(shouldDeferFinalizeForCorrelate(true, "ok"), false);
  assertEquals(shouldDeferFinalizeForCorrelate(true, "failed"), false);
  assertEquals(shouldDeferFinalizeForCorrelate(false, null), false);
});
