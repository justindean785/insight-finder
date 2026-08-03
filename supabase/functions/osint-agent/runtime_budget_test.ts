/**
 * runtime_budget_test.ts — the budget is scoped to the INVESTIGATION, not the request.
 *
 * The defect these tests pin, in one sentence: `index.ts` calls
 * `clearRuntime(threadId)` at the top of every request, `runtime-policy.ts` keeps the
 * budget counters in an isolate-local Map, and an investigation spans several
 * requests because the isolate is killed at the 180s ceiling and the analyst sends
 * "Continue" — so "36 paid calls per investigation" meant "36 per HTTP request",
 * i.e. no ceiling at all. The last production run measured 32 paid calls against a
 * nominal cap of 12.
 *
 * Test (A) reproduces that exact sequence and fails if the rehydrate is removed.
 */
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  type BudgetPersister,
  clearRuntime,
  hydrateRuntimeBudget,
  MAX_PAID_CALLS,
  MAX_SAME_TOOL_CALLS,
  MAX_TOTAL_CALLS,
  readRuntimeBudget,
  registerBudgetPersister,
  type RuntimeBudgetSnapshot,
  runtimeLimits,
  startCall,
  unregisterBudgetPersister,
} from "./runtime-policy.ts";
import { buildBudgetStatusBlock } from "./system-prompt.ts";

const DEFAULT_LIMITS = { ...runtimeLimits };
function restoreLimits() {
  Object.assign(runtimeLimits, DEFAULT_LIMITS);
}

const noWeakLead = { weak: false, reasons: [] as string[], autoPivotBlocked: false };

function paidCall(threadId: string, i: number, toolName = `paid_${i}`) {
  return startCall({
    threadId,
    toolName,
    selector: "alice@example.com",
    selectorType: "email",
    costTier: "expensive" as const,
    expectedValue: 80,
    familyKey: `${toolName}::email::alice@example.com`,
    weakLead: noWeakLead,
    staleCache: false,
    manualOverride: false,
    now: 1_000_000 + i * 1000,
  });
}

/** Burn paid calls until the runtime refuses one; return how many were admitted. */
function spendUntilRefused(threadId: string, attempts = 200): number {
  let allowed = 0;
  for (let i = 0; i < attempts; i++) {
    if (paidCall(threadId, i).allow) allowed++;
  }
  return allowed;
}

// ---------------------------------------------------------------------------
// (A) The bug itself
// ---------------------------------------------------------------------------

Deno.test("(A) a continuation does NOT get a fresh budget — the reset bug", () => {
  restoreLimits();
  const thread = "t-budget-continuation";
  clearRuntime(thread);

  // ---- Request 1: the run burns its whole paid budget, then the isolate is killed.
  const spentInRun1 = spendUntilRefused(thread);
  assertEquals(spentInRun1, MAX_PAID_CALLS, "run 1 must stop at the paid ceiling");
  const persisted = readRuntimeBudget(thread);
  assertEquals(persisted.paidCalls, MAX_PAID_CALLS);

  // ---- Request 2: the analyst sends "Continue". index.ts clears the isolate state…
  clearRuntime(thread);
  assertEquals(
    readRuntimeBudget(thread).paidCalls,
    0,
    "precondition: clearRuntime alone leaves NO memory of the spend — this is why the rehydrate exists",
  );
  // …and then puts the investigation-scoped spend straight back.
  hydrateRuntimeBudget(thread, persisted);

  const spentInRun2 = spendUntilRefused(thread);
  assertEquals(
    spentInRun2,
    0,
    "a continuation must inherit the exhausted budget, not receive a second one",
  );
});

Deno.test("(A2) without the rehydrate the same sequence yields an UNBOUNDED budget", () => {
  // The negative control for (A). If this ever starts failing, the mechanism under
  // test has changed and (A) may be passing for the wrong reason.
  restoreLimits();
  const thread = "t-budget-no-hydrate";
  clearRuntime(thread);

  let total = 0;
  for (let request = 0; request < 3; request++) {
    clearRuntime(thread); // what index.ts did, and ONLY that
    total += spendUntilRefused(thread);
  }
  assertEquals(
    total,
    MAX_PAID_CALLS * 3,
    "three requests without rehydration spend three full budgets — the documented cap is per-request",
  );
});

// ---------------------------------------------------------------------------
// (B) hydrateRuntimeBudget is monotonic
// ---------------------------------------------------------------------------

Deno.test("(B) hydration never LOWERS a counter", () => {
  restoreLimits();
  const thread = "t-budget-monotonic";
  clearRuntime(thread);
  for (let i = 0; i < 5; i++) paidCall(thread, i, "shared_tool");

  // A stale row, or a racing sibling run that has spent less, must not hand budget
  // back — that is the failure mode this whole change exists to close.
  hydrateRuntimeBudget(thread, { totalCalls: 1, paidCalls: 1, toolCounts: { shared_tool: 1 } });
  const after = readRuntimeBudget(thread);
  assertEquals(after.totalCalls, 5);
  assertEquals(after.paidCalls, 5);
  assertEquals(after.toolCounts.shared_tool, 5);

  // A larger snapshot DOES raise it.
  hydrateRuntimeBudget(thread, { totalCalls: 9, paidCalls: 8, toolCounts: { shared_tool: 7, other: 2 } });
  const raised = readRuntimeBudget(thread);
  assertEquals(raised.totalCalls, 9);
  assertEquals(raised.paidCalls, 8);
  assertEquals(raised.toolCounts, { shared_tool: 7, other: 2 });
});

Deno.test("(B2) a null/failed hydrate is a no-op, not a reset", () => {
  restoreLimits();
  const thread = "t-budget-null-hydrate";
  clearRuntime(thread);
  for (let i = 0; i < 3; i++) paidCall(thread, i);
  const before = readRuntimeBudget(thread);

  // budget-store.ts returns null for BOTH "new investigation" and "read failed".
  // Neither may clear a live run's counters.
  hydrateRuntimeBudget(thread, null);
  hydrateRuntimeBudget(thread, undefined);
  assertEquals(readRuntimeBudget(thread), before);
});

Deno.test("(B3) hydration coerces junk from the database", () => {
  restoreLimits();
  const thread = "t-budget-junk";
  clearRuntime(thread);
  hydrateRuntimeBudget(thread, {
    totalCalls: -4,
    paidCalls: Number.NaN,
    toolCounts: { good: 3, negative: -1, nan: Number.NaN, "": 9 } as Record<string, number>,
  });
  const got = readRuntimeBudget(thread);
  assertEquals(got.totalCalls, 0);
  assertEquals(got.paidCalls, 0);
  assertEquals(got.toolCounts, { good: 3, negative: 0, nan: 0 });
});

Deno.test("(B4) readRuntimeBudget does not CREATE state for an unknown thread", () => {
  const thread = "t-budget-never-seen";
  clearRuntime(thread);
  assertEquals(readRuntimeBudget(thread), { totalCalls: 0, paidCalls: 0, toolCounts: {} });
});

// ---------------------------------------------------------------------------
// (C) The persister
// ---------------------------------------------------------------------------

Deno.test("(C) startCall pushes the moved counters at the registered persister", () => {
  restoreLimits();
  const thread = "t-budget-persist";
  clearRuntime(thread);
  const seen: RuntimeBudgetSnapshot[] = [];
  const fn: BudgetPersister = (_id, s) => seen.push(s);
  registerBudgetPersister(thread, fn);
  try {
    paidCall(thread, 0, "oathnet_lookup");
    paidCall(thread, 1, "oathnet_lookup");
    startCall({
      threadId: thread,
      toolName: "record_artifacts",
      selector: "x",
      selectorType: "email",
      costTier: "free",
      expectedValue: 90,
      familyKey: "record_artifacts::email::x",
      weakLead: noWeakLead,
      staleCache: false,
      manualOverride: false,
      now: 1_010_000,
    });
  } finally {
    unregisterBudgetPersister(thread, fn);
  }

  assertEquals(seen.length, 3, "every admitted call must be accounted for");
  assertEquals(seen[2], {
    totalCalls: 3,
    paidCalls: 2,
    toolCounts: { oathnet_lookup: 2, record_artifacts: 1 },
  });
});

Deno.test("(C2) a REFUSED call is not billed", () => {
  restoreLimits();
  const thread = "t-budget-refused";
  clearRuntime(thread);
  runtimeLimits.maxPaidCallsPerRun = 1;
  const seen: RuntimeBudgetSnapshot[] = [];
  const fn: BudgetPersister = (_id, s) => seen.push(s);
  registerBudgetPersister(thread, fn);
  try {
    assertEquals(paidCall(thread, 0).allow, true);
    assertEquals(paidCall(thread, 1).allow, false);
  } finally {
    unregisterBudgetPersister(thread, fn);
    restoreLimits();
  }
  assertEquals(seen.length, 1, "startCall returns before the counters move on a refusal");
  assertEquals(seen[0].paidCalls, 1);
});

Deno.test("(C3) persisters are per-thread — one isolate serves many investigations", () => {
  restoreLimits();
  clearRuntime("t-budget-a");
  clearRuntime("t-budget-b");
  const a: RuntimeBudgetSnapshot[] = [];
  const b: RuntimeBudgetSnapshot[] = [];
  const fnA: BudgetPersister = (_id, s) => a.push(s);
  const fnB: BudgetPersister = (_id, s) => b.push(s);
  registerBudgetPersister("t-budget-a", fnA);
  registerBudgetPersister("t-budget-b", fnB);
  try {
    paidCall("t-budget-a", 0);
    paidCall("t-budget-a", 1);
    paidCall("t-budget-b", 0);
  } finally {
    unregisterBudgetPersister("t-budget-a", fnA);
    unregisterBudgetPersister("t-budget-b", fnB);
  }
  assertEquals(a.length, 2);
  assertEquals(b.length, 1);
  assertEquals(b[0].paidCalls, 1, "thread B's spend must not include thread A's");
});

Deno.test("(C4) unregister is identity-checked, so a finishing run cannot tear down its sibling", () => {
  restoreLimits();
  const thread = "t-budget-overlap";
  clearRuntime(thread);
  const first: RuntimeBudgetSnapshot[] = [];
  const second: RuntimeBudgetSnapshot[] = [];
  const fn1: BudgetPersister = (_id, s) => first.push(s);
  const fn2: BudgetPersister = (_id, s) => second.push(s);

  registerBudgetPersister(thread, fn1); // run 1 starts
  registerBudgetPersister(thread, fn2); // run 2 (double-submit) starts, takes over
  unregisterBudgetPersister(thread, fn1); // run 1 finishes FIRST
  try {
    paidCall(thread, 0);
    assertEquals(second.length, 1, "run 2 must still be accounting after run 1 tears down");
    assertEquals(first.length, 0);
  } finally {
    unregisterBudgetPersister(thread, fn2);
  }
  paidCall(thread, 1);
  assertEquals(second.length, 1, "after its own unregister, run 2 stops being notified");
});

Deno.test("(C5) a throwing persister never fails the call it is reporting on", () => {
  restoreLimits();
  const thread = "t-budget-throwing";
  clearRuntime(thread);
  const fn: BudgetPersister = () => {
    throw new Error("db exploded");
  };
  registerBudgetPersister(thread, fn);
  try {
    // Under-counting spend during a database outage is a cost problem; refusing an
    // analyst's paid call because telemetry is down is a product outage.
    assertEquals(paidCall(thread, 0).allow, true);
    assertEquals(readRuntimeBudget(thread).paidCalls, 1);
  } finally {
    unregisterBudgetPersister(thread, fn);
  }
});

// ---------------------------------------------------------------------------
// (D) The re-baselined constants
// ---------------------------------------------------------------------------

Deno.test("(D) the per-run caps are the re-baselined values, not the old per-request ones", () => {
  // Making the counters durable without raising these would have been a silent ~3×
  // cut in investigation depth: 30/12 was what production spent PER INVOCATION, and
  // a full investigation was measured at three invocations (32 paid calls). These
  // exact numbers are asserted so neither the cut nor a quiet increase can land
  // without editing this test and saying why.
  assertEquals(MAX_TOTAL_CALLS, 90, "total per investigation (was 30 per request)");
  assertEquals(MAX_PAID_CALLS, 36, "paid per investigation (was 12 per request; 32 observed)");
  assertEquals(MAX_SAME_TOOL_CALLS, 24, "per tool per investigation (was 16 per request)");
  assert(MAX_PAID_CALLS < MAX_TOTAL_CALLS, "the paid cap must bind before the total cap");
  assert(MAX_SAME_TOOL_CALLS < MAX_TOTAL_CALLS, "no single tool may consume the whole run");
});

// ---------------------------------------------------------------------------
// (F) What the model is told about a continuation
// ---------------------------------------------------------------------------

Deno.test("(F) a fresh investigation gets no budget block at all", () => {
  assertEquals(buildBudgetStatusBlock({ totalCalls: 0, paidCalls: 0 }), "");
  assertEquals(buildBudgetStatusBlock({ totalCalls: -3, paidCalls: Number.NaN }), "");
});

Deno.test("(F2) a continuation is told what is left, in real numbers", () => {
  const block = buildBudgetStatusBlock({ totalCalls: 50, paidCalls: 30 });
  assertStringIncludes(block, `50 of ${MAX_TOTAL_CALLS}`);
  assertStringIncludes(block, `30 of ${MAX_PAID_CALLS}`);
  assertStringIncludes(block, `${MAX_TOTAL_CALLS - 50} total`);
  assertStringIncludes(block, `${MAX_PAID_CALLS - 30} paid`);
  assertStringIncludes(block, "does NOT refill");
});

Deno.test("(F3) an exhausted continuation is pointed at the report, not at a stop", () => {
  const block = buildBudgetStatusBlock({ totalCalls: MAX_TOTAL_CALLS, paidCalls: MAX_PAID_CALLS });
  assertStringIncludes(block, "0 total");
  assertStringIncludes(block, "0 paid");
  // Recording/finalize are exempt from every cap, so the honest instruction is
  // "write the report", never "stop" — a stop decision taken from prose is exactly
  // what the run-termination invariants forbid.
  assertStringIncludes(block, "write the report");
  assertStringIncludes(block, "which lines of enquiry were left open");
  for (const forbidden of [/\bstop the run\b/i, /\bend the investigation\b/i, /\bdo not call\b/i]) {
    assert(!forbidden.test(block), `budget block must not instruct a stop (matched ${forbidden})`);
  }
  // And it must not hand the model the "rate limited" vocabulary the prompt
  // elsewhere forbids for anything that is not a literal 429.
  assertStringIncludes(block, "not describe the remaining tools as rate-limited");
});

Deno.test("(F4) the block never claims a negative allowance", () => {
  const block = buildBudgetStatusBlock({ totalCalls: MAX_TOTAL_CALLS + 40, paidCalls: MAX_PAID_CALLS + 9 });
  assert(!/-\d/.test(block), `overspend must clamp to zero, got: ${block}`);
});

Deno.test("(F5) index.ts appends the block to BOTH prompt assembly sites", () => {
  const uses = indexSrc.match(/budgetStatusBlock/g) ?? [];
  // one declaration + the two `system:`/baseSystemPrompt concatenations
  assert(uses.length >= 3, `budget block reaches only ${uses.length} site(s) in index.ts`);
  assert(
    indexSrc.includes("buildBudgetStatusBlock(persistedBudget"),
    "the block must be built from the PERSISTED spend, not from a fresh counter",
  );
});

// ---------------------------------------------------------------------------
// (E) Source-level wiring — the pair in index.ts
// ---------------------------------------------------------------------------

/**
 * Comments are stripped before scanning. Mutation testing caught this: a plain
 * `indexOf` passes happily when the call has been COMMENTED OUT, which is exactly
 * how a wiring regression arrives in practice. Line comments on a code line survive
 * the strip — that is fine, because you cannot disable a call that way.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

const indexSrc = stripComments(await Deno.readTextFile(new URL("./index.ts", import.meta.url)));

Deno.test("(E) index.ts rehydrates the budget immediately after clearing the isolate", () => {
  const clearAt = indexSrc.indexOf("clearRuntime(threadId);");
  const loadAt = indexSrc.indexOf("loadThreadRunBudget(");
  const hydrateAt = indexSrc.indexOf("hydrateRuntimeBudget(threadId,");
  assert(clearAt > 0, "clearRuntime call site missing");
  assert(loadAt > 0, "loadThreadRunBudget call site missing — the budget is per-request again");
  assert(hydrateAt > 0, "hydrateRuntimeBudget call site missing — the budget is per-request again");
  assert(loadAt > clearAt, "the persisted budget must be loaded AFTER clearRuntime wipes the isolate");
  assert(hydrateAt > loadAt, "hydration must follow the load");
});

Deno.test("(E2) index.ts registers a persister and tears it down identity-checked", () => {
  // NB: matched with a lookbehind, not `includes`. `unregisterBudgetPersister(...)`
  // CONTAINS `registerBudgetPersister(...)` as a substring, so a plain includes()
  // check for the registration is satisfied by the teardown line alone — mutation
  // testing caught this passing with the registration commented out.
  assert(
    /(?<!un)registerBudgetPersister\(threadId, budgetPersister\)/.test(indexSrc),
    "no persister registered — counters would move in memory and never reach the database",
  );
  assert(
    indexSrc.includes("unregisterBudgetPersister(threadId, budgetPersister)"),
    "persister never unregistered, or unregistered without the identity argument",
  );
  assert(indexSrc.includes("budgetWriter.flush()"), "no flush at teardown — the last writes would be lost");
});

Deno.test("(E3) the budget is read and written through the ADMIN client", () => {
  // thread_run_budget has a SELECT-only RLS policy for `authenticated` and no write
  // policy at all: it is a spend control, and the tenant must not be able to move
  // it. The user-scoped client would therefore fail every write.
  const castAt = indexSrc.indexOf("supabaseAdmin as unknown as BudgetDbClient");
  assert(castAt > 0, "the budget client must be derived from supabaseAdmin, not the user-scoped client");
  assert(
    !/loadThreadRunBudget\(\s*supabase\s*,/.test(indexSrc),
    "loadThreadRunBudget must not be handed the user-scoped client",
  );
  assert(
    !/createBudgetWriter\(\s*supabase\s*,/.test(indexSrc),
    "createBudgetWriter must not be handed the user-scoped client",
  );
});
