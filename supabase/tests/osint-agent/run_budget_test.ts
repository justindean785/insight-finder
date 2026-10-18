// run_budget_test.ts — the classification behind the per-investigation budget.
//
// These assert the rules that decide whether a logged call consumed one of
// MAX_PAID_CALLS' slots, because a wrong answer here would later set a cap that
// either starves real investigations or fails to bound the $2.04 ones.
import { assert, assertEquals } from "jsr:@std/assert@^1";
import {
  EMPTY_PRIOR_SPEND,
  priorSpendEvent,
  summarizePriorSpend,
  type PriorCallRow,
} from "../../functions/osint-agent/lib/run-budget.ts";

// Stand-in for paidBudgetTier(costForTool(name), name) !== "free".
const PAID = new Set(["oathnet_lookup", "serus_darkweb_scan", "minimax_correlate"]);
const isPaid = (n: string) => PAID.has(n);

Deno.test("a cached replay never consumed a paid slot", () => {
  // The cache lookup sits BEFORE startCall in the guard chain, so a replay
  // cannot have reserved anything. Counting one would inflate the cap upward.
  const rows: PriorCallRow[] = [
    { tool_name: "oathnet_lookup", cached: true, outcome: "ok", cost_micro_usd: 0 },
    { tool_name: "oathnet_lookup", cached: false, outcome: "ok", cost_micro_usd: 8800 },
  ];
  const s = summarizePriorSpend(rows, isPaid);
  assertEquals(s.cached_calls, 1);
  assertEquals(s.paid_calls, 1);
  assertEquals(s.total_calls, 1);
});

Deno.test("a governance skip never consumed a paid slot", () => {
  // Budget/burst/dedup/suppression refusals are decided at or before the gate.
  // The `outcome` column exists precisely because `ok` conflates these with
  // real failures — measuring on `ok` is what made gravatar_profile read 35%.
  const rows: PriorCallRow[] = [
    { tool_name: "serus_darkweb_scan", cached: false, outcome: "skipped", cost_micro_usd: 0 },
    { tool_name: "serus_darkweb_scan", cached: false, outcome: "failed", cost_micro_usd: 2500 },
  ];
  const s = summarizePriorSpend(rows, isPaid);
  assertEquals(s.skipped_calls, 1);
  // A FAILED paid call still spent the slot and usually the upstream request.
  assertEquals(s.paid_calls, 1);
  assertEquals(s.total_calls, 1);
});

Deno.test("an empty negative is a real result and counts as spent", () => {
  // "The target has no record" is a finding, not a non-call. It reached the
  // provider and consumed the slot.
  const s = summarizePriorSpend(
    [{ tool_name: "oathnet_lookup", cached: false, outcome: "empty", cost_micro_usd: 8800 }],
    isPaid,
  );
  assertEquals(s.paid_calls, 1);
  assertEquals(s.total_calls, 1);
});

Deno.test("free-tier tools count as calls but not against the paid budget", () => {
  const rows: PriorCallRow[] = [
    { tool_name: "username_sweep", cached: false, outcome: "ok", cost_micro_usd: 0 },
    { tool_name: "google_dorks", cached: false, outcome: "ok", cost_micro_usd: 0 },
    { tool_name: "minimax_correlate", cached: false, outcome: "ok", cost_micro_usd: 220000 },
  ];
  const s = summarizePriorSpend(rows, isPaid);
  assertEquals(s.total_calls, 3);
  assertEquals(s.paid_calls, 1);
});

Deno.test("cost sums across every row, including cached and skipped ones", () => {
  // cost_micro_usd is already 0 for cached/free rows, so summing everything is
  // both simpler and truthful; it must not be gated on the paid predicate.
  const s = summarizePriorSpend(
    [
      { tool_name: "oathnet_lookup", cached: true, outcome: "ok", cost_micro_usd: 0 },
      { tool_name: "oathnet_lookup", cached: false, outcome: "ok", cost_micro_usd: 8800 },
      { tool_name: "minimax_correlate", cached: false, outcome: "ok", cost_micro_usd: 220000 },
    ],
    isPaid,
  );
  assertEquals(s.cost_micro_usd, 228800);
});

Deno.test("the twelve-per-isolate bug is visible in the aggregate", () => {
  // Six invocations that each spent their own 12 paid slots. Per case that is 72,
  // which is the number the cap is documented to prevent and does not.
  const rows: PriorCallRow[] = [];
  for (let i = 0; i < 72; i++) {
    rows.push({ tool_name: "oathnet_lookup", cached: false, outcome: "ok", cost_micro_usd: 8800 });
  }
  const s = summarizePriorSpend(rows, isPaid);
  assertEquals(s.paid_calls, 72);
  assert(s.paid_calls > 12, "a per-investigation view must be able to exceed the per-isolate cap");
});

Deno.test("malformed rows degrade, never throw", () => {
  const s = summarizePriorSpend(
    [
      { tool_name: 42, cached: "yes", outcome: null, cost_micro_usd: "abc" },
      {},
      null,
    ] as unknown as PriorCallRow[],
    isPaid,
  );
  assert(Number.isFinite(s.cost_micro_usd));
  assertEquals(s.cost_micro_usd, 0);
  // An unnamed row still reached a provider, so it counts as a call but cannot
  // be attributed to the paid budget without a tool name.
  assertEquals(s.total_calls, 3);
  assertEquals(s.paid_calls, 0);
});

Deno.test("no rows yields a zeroed summary, and the constant is not aliased", () => {
  const a = summarizePriorSpend([], isPaid);
  const b = summarizePriorSpend(null, isPaid);
  assertEquals(a, EMPTY_PRIOR_SPEND);
  assertEquals(b, EMPTY_PRIOR_SPEND);
  a.paid_calls = 99;
  assertEquals(EMPTY_PRIOR_SPEND.paid_calls, 0);
});

Deno.test("the log line names the event and carries the whole breakdown", () => {
  const s = summarizePriorSpend(
    [{ tool_name: "oathnet_lookup", cached: false, outcome: "ok", cost_micro_usd: 8800 }],
    isPaid,
  );
  const parsed = JSON.parse(priorSpendEvent("thread-1", s, { invocation_cap: 12 }));
  assertEquals(parsed.event, "run_budget_prior");
  assertEquals(parsed.thread_id, "thread-1");
  assertEquals(parsed.paid_calls, 1);
  assertEquals(parsed.rows_read, 1);
  assertEquals(parsed.invocation_cap, 12);
});
