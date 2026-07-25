// tool_budget_reserve_test.ts — PR A: atomic tool-call budget reservation.
//
// Covers the two primitives that make admission and finalization share ONE
// authoritative counter (the #366/#370 rollback removed the first; the #377
// draft left admission on `reserved` but finalize on `genuine` — the decoupling
// this file pins shut):
//   - reserveToolCall: reserve-on-start so a parallel fan-out can't overshoot.
//   - isToolBudgetExhausted: the finalize trigger's cap signal — TRUE on
//     reservation exhaustion even when no call has completed.
import { assertEquals } from "jsr:@std/assert@^1";
import {
  reserveToolCall,
  isToolBudgetExhausted,
  MAX_TOOL_CALLS_PER_RUN,
} from "./orchestrator-budget.ts";

Deno.test("reserveToolCall: sequential reservations stop exactly at the cap", () => {
  const budget = { genuine: 0, reserved: 0, capped: false };
  const cap = 3;
  let admitted = 0;
  for (let i = 0; i < 10; i++) if (reserveToolCall(budget, false, cap)) admitted++;
  assertEquals(admitted, 3, "only `cap` non-recording calls may ever be admitted");
  assertEquals(budget.reserved, 3, "reserved lands exactly at cap, never past");
  assertEquals(budget.capped, true, "capped flips when reservation reaches the cap");
});

Deno.test("reserveToolCall: recording/finalize tools are exempt — admitted past the cap, consume no slot", () => {
  const budget = { genuine: 0, reserved: MAX_TOOL_CALLS_PER_RUN, capped: true };
  assertEquals(reserveToolCall(budget, true), true, "a recording tool is always admitted");
  assertEquals(budget.reserved, MAX_TOOL_CALLS_PER_RUN, "an exempt tool must not consume a reservation slot");
});

Deno.test("isToolBudgetExhausted: TRUE on reservation exhaustion even with zero completed calls (finalize must not wait on genuine)", () => {
  // The #377 decoupling case: reservations spent (some on rejected calls), genuine still low.
  assertEquals(isToolBudgetExhausted({ genuine: 0, reserved: MAX_TOOL_CALLS_PER_RUN, capped: true }), true);
  // capped flag alone forces finalize (set at admission, before any completion).
  assertEquals(isToolBudgetExhausted({ genuine: 2, reserved: MAX_TOOL_CALLS_PER_RUN, capped: true }), true);
  // completion-count backstop (the now-rare all-complete path) still trips it.
  assertEquals(isToolBudgetExhausted({ genuine: MAX_TOOL_CALLS_PER_RUN, reserved: MAX_TOOL_CALLS_PER_RUN, capped: false }), true);
  // genuinely under budget on every axis → not exhausted.
  assertEquals(isToolBudgetExhausted({ genuine: 5, reserved: 5, capped: false }), false);
});
