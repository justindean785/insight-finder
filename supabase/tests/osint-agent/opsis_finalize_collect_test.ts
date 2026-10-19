// opsis_finalize_collect_test.ts — a paid opsis_search still pending at finalize
// gets ONE bounded opsis_results step before persist → memory → report.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  pendingOpsisRuns, shouldCollectOpsisBeforeFinalize, resolveFinalizePhase, buildFinalizeStepPlan,
  countFinalizeProgress, opsisFinalizeCollectEnabled, opsisFinalizeCollectSelfTest, isFinalizeCollectExempt,
  MAX_OPSIS_COLLECT_STEPS, OPSIS_COLLECT_BUDGET_MS, OPSIS_FINALIZE_COLLECT_DISABLED_ENV, requiredCompletionMs,
} from "../../functions/osint-agent/orchestrator-finalize.ts";
import { ORCHESTRATOR_WALL_CLOCK_MS } from "../../functions/osint-agent/orchestrator-budget.ts";
import { classifyToolOutcome } from "../../functions/osint-agent/tool-outcome.ts";

const res = (toolName: string, id: string, value: Record<string, unknown>) =>
  ({ type: "tool-result", toolName, toolCallId: id, output: { type: "json", value } });

Deno.test("pendingOpsisRuns: partial searches are pending until a results read (or a complete/failed search) names the run", () => {
  const hist = [{ content: [
    res("opsis_search", "a", { ok: true, partial: true, run_id: "r1", kind: "username", value: "x" }),
    res("opsis_search", "b", { ok: true, partial: true, run_id: "r2", kind: "email", value: "y@z" }),
    res("opsis_search", "c", { ok: true, complete: true, run_id: "r3", kind: "domain", value: "z" }),
    res("opsis_search", "d", { ok: false, error: "opsis search failed upstream", run_id: "r4" }),
  ] }, { content: [
    res("opsis_results", "e", { ok: false, error: "opsis run status unavailable", run_id: "r2" }), // any read counts
  ] }];
  assertEquals(pendingOpsisRuns(hist), [{ run_id: "r1", kind: "username", value: "x" }]);
  // an unwrapped output and a duplicate toolCallId are handled
  const dup = [{ content: [
    { type: "tool-result", toolName: "opsis_search", toolCallId: "a", output: { ok: true, partial: true, run_id: "r1", kind: "username", value: "x" } },
    { type: "tool-result", toolName: "opsis_search", toolCallId: "a", output: { ok: true, partial: true, run_id: "r1", kind: "username", value: "x" } },
  ] }];
  assertEquals(pendingOpsisRuns(dup).length, 1);
  assertEquals(pendingOpsisRuns([]), []);
  assertEquals(pendingOpsisRuns([{ content: "text" }]), []);
});

Deno.test("shouldCollectOpsisBeforeFinalize: bounded by step count, time, the step cap and the budget; the tool cap is its trigger", () => {
  const base = { pending: 2, collectStepsRun: 0, elapsedMs: 10_000, stepCapDue: false, capReached: false, budgetExhausted: false };
  assert(shouldCollectOpsisBeforeFinalize(base));
  assert(shouldCollectOpsisBeforeFinalize({ ...base, capReached: true }), "tool cap must not block a free read");
  assert(!shouldCollectOpsisBeforeFinalize({ ...base, pending: 0 }));
  assert(!shouldCollectOpsisBeforeFinalize({ ...base, collectStepsRun: MAX_OPSIS_COLLECT_STEPS }));
  assert(!shouldCollectOpsisBeforeFinalize({ ...base, stepCapDue: true }));
  assert(!shouldCollectOpsisBeforeFinalize({ ...base, budgetExhausted: true }));
  assert(!shouldCollectOpsisBeforeFinalize({ ...base, enabled: false }));
  assert(!shouldCollectOpsisBeforeFinalize({ ...base, elapsedMs: NaN }));
  assert(!shouldCollectOpsisBeforeFinalize({ ...base, collectStepsRun: NaN }));
  // The exact time floor: the read plus a correlate-free completion.
  const need = OPSIS_COLLECT_BUDGET_MS + requiredCompletionMs({ correlateBudgetMs: 0 });
  assert(shouldCollectOpsisBeforeFinalize({ ...base, elapsedMs: ORCHESTRATOR_WALL_CLOCK_MS - need }));
  assert(!shouldCollectOpsisBeforeFinalize({ ...base, elapsedMs: ORCHESTRATOR_WALL_CLOCK_MS - need + 1 }));
  // Under the current budget the wall-clock trigger (≤ reserve remaining) can never afford it — stated, not hidden.
  assert(!shouldCollectOpsisBeforeFinalize({ ...base, elapsedMs: ORCHESTRATOR_WALL_CLOCK_MS - 90_000 }));
});

Deno.test("resolveFinalizePhase: collect comes first only when the caller says so; otherwise unchanged", () => {
  const empty = countFinalizeProgress([]);
  assertEquals(resolveFinalizePhase(empty, empty, { collect: true }), "collect");
  assertEquals(resolveFinalizePhase(empty, empty, { collect: false }), "persist");
  assertEquals(resolveFinalizePhase(empty, empty), "persist");
  const persisted = { ...empty, recordSucceeded: 1 };
  assertEquals(resolveFinalizePhase(empty, persisted), "memory");
  assertEquals(resolveFinalizePhase(empty, { ...persisted, memorySkipped: 1 }), "report");
});

Deno.test("buildFinalizeStepPlan('collect'): only opsis_results, required, with every pending run id in the directive", () => {
  const plan = buildFinalizeStepPlan("collect", [
    { run_id: "r1", kind: "username", value: "x" },
    { run_id: "r9", kind: "email", value: "y@z" },
  ]);
  assertEquals([...plan.activeTools], ["opsis_results"]);
  assertEquals(plan.toolChoice, "required");
  assert(plan.directive.includes('run_id: "r1"') && plan.directive.includes('run_id: "r9"'));
  assert(plan.directive.includes("Do NOT start a new opsis_search"));
  // the other phases are untouched
  assertEquals(buildFinalizeStepPlan("persist").toolChoice, "required");
  assertEquals(buildFinalizeStepPlan("report").toolChoice, "none");
});

Deno.test("opsis_results is finalize-collect exempt; paid opsis_search is not", () => {
  assert(isFinalizeCollectExempt("opsis_results"));
  assert(!isFinalizeCollectExempt("opsis_search"));
  assert(!isFinalizeCollectExempt("minimax_correlate"));
});

Deno.test("kill switch + self-test", () => {
  assertEquals(opsisFinalizeCollectEnabled(() => undefined), true);
  assertEquals(opsisFinalizeCollectEnabled((k) => (k === OPSIS_FINALIZE_COLLECT_DISABLED_ENV ? "true" : undefined)), false);
  const st = opsisFinalizeCollectSelfTest();
  assert(st.ok, st.detail);
});

Deno.test("wiring: index.ts resolves the collect phase from pending runs, counts it separately, and cache.ts exempts the read", () => {
  const index = Deno.readTextFileSync(new URL("../../functions/osint-agent/index.ts", import.meta.url));
  assert(index.includes("pendingOpsisRuns(stepMessages"), "pending runs read from the step history");
  assert(index.includes("shouldCollectOpsisBeforeFinalize({"), "the bounded decision gates the phase");
  assert(index.includes("finalizeCollectStepsRun++"), "collect steps are counted on entry");
  assert(index.includes('finalizePhase === "collect"'), "a collect step's decision is judged by an opsis_results call");
  const cache = Deno.readTextFileSync(new URL("../../functions/osint-agent/cache.ts", import.meta.url));
  assert(cache.includes("isFinalizeCollectExempt(name)"), "the read must pass the finalize-window and tool-cap guards");
  const health = Deno.readTextFileSync(new URL("../../functions/osint-agent/health-handler.ts", import.meta.url));
  assert(health.includes("r.checks.opsis_finalize_collect = opsisFinalizeCollectSelfTest()"));
  // a refusal on the read still reads as a skip for outcome classification (never a provider failure)
  assertEquals(classifyToolOutcome("finalize window open; live lookup skipped", null), "skipped");
});
