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
// The exemption lives in `paidBudgetTier`, NOT in `costTierForTool`. That split
// is the point: #563 originally added a toolName argument to costTierForTool
// itself, which bought the budget exemption but leaked "free" into every other
// reader of the tier — the EV scorer's costPenalty and the `cost_tier` written
// to rejected-call metadata and tool_usage_log — so a tool that really does bill
// $0.0002 would have been REPORTED as free. Cost classification answers "what
// does this cost"; budget admission answers "does this consume one of the 12
// slots". These tests pin both answers, and the boundary between them.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { costTierForTool, paidBudgetTier, PAID_BUDGET_EXEMPT_TOOLS } from "./cache.ts";
import { costForTool } from "./costs.ts";

Deno.test("memory_recall and memory_save are exempted from the paid-call budget", () => {
  assertEquals(paidBudgetTier(costForTool("memory_recall"), "memory_recall"), "free");
  assertEquals(paidBudgetTier(costForTool("memory_save"), "memory_save"), "free");
});

Deno.test("the exemption does NOT reach the honest cost classification", () => {
  // The defect this split closes. costTierForTool is what the EV scorer and the
  // `cost_tier` telemetry field read; it must keep reporting these tools as the
  // paying tier they actually are, or the logs assert a tool is free while it
  // bills $0.0002.
  assertEquals(costTierForTool(costForTool("memory_recall")), "low");
  assertEquals(costTierForTool(costForTool("memory_save")), "low");
});

Deno.test("cost alone maps to a paying tier — this needed code, not a price edit", () => {
  const cost = costForTool("memory_recall");
  assertEquals(cost, 200);
  assertEquals(costTierForTool(cost), "low", "the raw cost alone still reads as a paying tier");
  assertEquals(paidBudgetTier(cost, "some_other_tool"), "low", "the exemption is per-NAME, not per-cost");
});

Deno.test("the exemption is scoped to EXACTLY these two tools — no silent widening", () => {
  assertEquals([...PAID_BUDGET_EXEMPT_TOOLS].sort(), ["memory_recall", "memory_save"]);
});

Deno.test("a genuine paid tool at the SAME cost is NOT exempted", () => {
  // dns_records costs 50 (a "low" tier by cost alone, like memory_recall) but is
  // a real provider lookup and must still compete for the paid budget normally.
  assertEquals(paidBudgetTier(costForTool("dns_records"), "dns_records"), "low");
});

Deno.test("real intel-gathering tools are completely unaffected by this change", () => {
  for (const tool of ["breach_check", "minimax_correlate", "oathnet_lookup", "exa_search"]) {
    assertEquals(paidBudgetTier(costForTool(tool), tool), "expensive", tool);
    assertEquals(costTierForTool(costForTool(tool)), "expensive", tool);
  }
});

Deno.test("free tools stay free regardless of name", () => {
  assertEquals(paidBudgetTier(costForTool("google_dorks"), "google_dorks"), "free");
  assertEquals(paidBudgetTier(costForTool("record_artifacts"), "record_artifacts"), "free");
});

Deno.test("wiring: admission and refund agree, EV and telemetry read the honest tier", async () => {
  // A reservation taken under one tier and refunded under another either leaks a
  // slot or hands back one never taken, so these two call sites must use the
  // SAME function — and the scoring/telemetry sites must NOT.
  const src = await Deno.readTextFile(new URL("./cache.ts", import.meta.url));
  assert(
    /costTier: paidBudgetTier\(baseCost, name\)/.test(src),
    "startCall's paid-call admission must use paidBudgetTier",
  );
  assert(
    /refundPaidCall\(ctx\.investigationId, paidBudgetTier\(baseCost, name\)\)/.test(src),
    "the refund must use the same tier the reservation used",
  );
  assert(
    !/cost_tier: paidBudgetTier\(/.test(src),
    "cost_tier telemetry must report the honest cost tier, never the admission tier",
  );
  assert(
    !/costPenalty: [^\n]*paidBudgetTier\(/.test(src),
    "the EV scorer's costPenalty must read the honest cost tier",
  );
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
