// paid_budget_bookkeeping_exemption_test.ts — 2026-09-08 performance audit.
//
// MAX_PAID_CALLS (runtime-policy.ts, 12/run) is "a MONEY control" over real
// intel-gathering spend (paid_call_accounting_test.ts's own framing). But
// costTierForTool mapped memory_recall/memory_save's $0.0002 floor cost to
// "low" — the SAME tier as a genuine paid lookup — so every run spent 2 of its
// 12 slots on pure run-bookkeeping (one recall near the start, one save near
// the end) before any intel-gathering tool competed for them. Production
// measured this cost real correlation passes: threads 4f3a3da7, e79ad0b5 and
// c599a5bc all hit "internal paid-call cap reached" on a queued
// minimax_correlate with evidence already in hand.
//
// These tests pin costTierForTool's exemption AND the two things it must NOT
// do: change billing (cost_micro_usd/charged_micro_usd key off baseCost
// directly, never off tier) or exempt any OTHER tool.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { costTierForTool, PAID_BUDGET_EXEMPT_TOOLS } from "./cache.ts";
import { costForTool } from "./costs.ts";

Deno.test("memory_recall and memory_save are exempted from the paid-call budget tier", () => {
  assertEquals(costTierForTool(costForTool("memory_recall"), "memory_recall"), "free");
  assertEquals(costTierForTool(costForTool("memory_save"), "memory_save"), "free");
});

Deno.test("without the tool name, the SAME cost still maps to a paying tier", () => {
  // Locks in WHY this needed a code change, not a costs.ts price edit: the
  // $0.0002 cost alone (200 micro-USD) maps to "low" absent the exemption.
  const cost = costForTool("memory_recall");
  assertEquals(cost, 200);
  assertEquals(costTierForTool(cost), "low", "the raw cost alone still reads as a paying tier");
  assertEquals(costTierForTool(cost, "some_other_tool"), "low", "the exemption is per-NAME, not per-cost");
});

Deno.test("the exemption is scoped to EXACTLY these two tools — no silent widening", () => {
  assertEquals([...PAID_BUDGET_EXEMPT_TOOLS].sort(), ["memory_recall", "memory_save"]);
});

Deno.test("a genuine paid tool at the SAME cost is NOT exempted", () => {
  // dns_records costs 50 (a "low" tier by cost alone, like memory_recall) but is
  // a real provider lookup and must still compete for the paid budget normally.
  assertEquals(costTierForTool(costForTool("dns_records"), "dns_records"), "low");
});

Deno.test("real intel-gathering tools are completely unaffected by this change", () => {
  assertEquals(costTierForTool(costForTool("breach_check"), "breach_check"), "expensive");
  assertEquals(costTierForTool(costForTool("minimax_correlate"), "minimax_correlate"), "expensive");
  assertEquals(costTierForTool(costForTool("oathnet_lookup"), "oathnet_lookup"), "expensive");
  assertEquals(costTierForTool(costForTool("exa_search"), "exa_search"), "expensive");
});

Deno.test("free tools stay free regardless of name", () => {
  assertEquals(costTierForTool(costForTool("google_dorks"), "google_dorks"), "free");
  assertEquals(costTierForTool(costForTool("record_artifacts"), "record_artifacts"), "free");
});

Deno.test("the exemption does not change billing — cost_micro_usd is still the TRUE cost, not zero", () => {
  // This is the property that matters most: exempting a tool from the PAID-CALL
  // ADMISSION gate must never be confused with making it free to the user. The
  // billed amount comes from costForTool()/baseCost directly, and this test
  // pins that the audit's fix does not touch it.
  assert(costForTool("memory_recall") > 0, "memory_recall must still bill its true $0.0002");
  assert(costForTool("memory_save") > 0, "memory_save must still bill its true $0.0002");
  assertEquals(costForTool("memory_recall"), 200);
  assertEquals(costForTool("memory_save"), 200);
});

Deno.test("an unnamed call (no toolName argument) behaves exactly as before this change", () => {
  // Backward-compatible default: every OTHER costTierForTool caller in this
  // codebase that never passes a name must see byte-identical behavior.
  assertEquals(costTierForTool(0), "free");
  assertEquals(costTierForTool(200), "low");
  assertEquals(costTierForTool(1_500), "low");
  assertEquals(costTierForTool(1_501), "expensive");
  assertEquals(costTierForTool(10_000), "expensive");
});
