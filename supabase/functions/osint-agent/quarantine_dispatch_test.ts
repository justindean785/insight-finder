// quarantine_dispatch_test.ts — the subject_unlinked DISPATCH boundary.
//
// Quarantine bound at WRITE (auto-persist-findings) and at READ-BACK (cluster,
// graph, report) but never at DISPATCH. So a name-only harvest left its
// quarantined selectors sitting in the model's context window, each one eligible
// to seed its own paid multi-tool stack. That is the real driver of run spam and
// paid-cap pressure — not a MAX_PAID_CALLS that is too low.
//
// These tests drive the REAL wrap path (wrapToolsWithCache), not the predicate in
// isolation, because the property that matters is "the tool never runs", and only
// the wrapper can demonstrate that.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { wrapToolsWithCache, isIntentionalSkip } from "./cache.ts";
import { clearRuntime } from "./runtime-policy.ts";
import * as circuit from "./circuit.ts";
import { dispatchKey, quarantineRefusal, isDispatchRefused, dispatchTypeCandidates } from "./lib/dispatch-quarantine.ts";

type SupabaseClient = ReturnType<typeof createClient>;

const QUARANTINED_USER = "jordan.vale";
const CLEAN_USER = "nightjar";

function makeChain(resolveValue: { data: unknown; error: unknown }): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "update", "limit"]) node[m] = () => node;
  node.maybeSingle = () => Promise.resolve(resolveValue);
  node.then = (r: (v: { data: unknown; error: unknown }) => void) => r(resolveValue);
  return node;
}

/**
 * `artifacts` returns one QUARANTINED username row and one CLEAN email row, which
 * is the production shape: quarantine is disclosure, so the rows are persisted and
 * readable — they simply must not carry authority.
 */
function fakeSupabase(rows?: Array<Record<string, unknown>>): SupabaseClient {
  const artifactRows = rows ?? [
    {
      id: "a1", kind: "username", value: QUARANTINED_USER, confidence: 65, source: "minimax_web_search",
      metadata: { subject_unlinked: true, subject_unlinked_reason: "name-only echo" },
    },
    { id: "a2", kind: "email", value: "real@example.test", confidence: 90, source: "hibp", metadata: {} },
  ];
  const inert = makeChain({ data: [], error: null });
  inert.insert = () => Promise.resolve({ error: null });
  inert.upsert = () => Promise.resolve({ error: null });
  const artifacts = makeChain({ data: artifactRows, error: null });
  artifacts.insert = () => Promise.resolve({ error: null });
  return {
    from: (t: string) => (t === "artifacts" ? artifacts : inert),
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as unknown as SupabaseClient;
}

function countingTool(calls: { n: number }): Tool {
  return {
    description: "test",
    execute: (_i: unknown, _o: unknown) => { calls.n += 1; return Promise.resolve({ ok: true, hit: true }); },
  } as unknown as Tool;
}

// Each test gets its OWN thread id and clears both runtime and circuit state.
// Without this the circuit breaker's in-flight/dedup memory leaks between tests
// and blocks the second call for reasons that have nothing to do with this
// boundary — which made REPEATED / PIVOTED / PAID pass while the guard was still
// unwired. A test that passes for the wrong reason is worse than no test.
let threadSeq = 0;
function freshThread(): string {
  threadSeq += 1;
  return `11111111-2222-4333-8444-${String(threadSeq).padStart(12, "0")}`;
}

function wrap(
  calls: { n: number },
  db?: SupabaseClient,
  extra?: { toolCallBudget?: { genuine: number; reserved: number; capped: boolean } },
) {
  const investigationId = freshThread();
  clearRuntime(investigationId);
  circuit.clearThread(investigationId);
  return wrapToolsWithCache({ breach_check: countingTool(calls) }, {
    investigationId,
    userId: "u1",
    supabase: db ?? fakeSupabase(),
    ...(extra ?? {}),
  });
}

// ── the refusal payload itself ────────────────────────────────────────────────
Deno.test("a quarantine refusal is an explicit NON-success", () => {
  const r = quarantineRefusal("breach_check", "username", QUARANTINED_USER) as Record<string, unknown>;
  assertEquals(r.ok, false, "must be ok:false — the UNKNOWN_TOOL_SINK returns ok:true and that is the bug");
  assertEquals(r.dropped, undefined, "must not imitate the unknown-tool sink shape");
  assert(typeof r.error === "string" && (r.error as string).length > 0, "must carry a readable error");
});

Deno.test("a quarantine refusal is NOT classified as an intentional skip", () => {
  // deriveOk checks isIntentionalSkip BEFORE ok, so a refusal that matched the
  // skip regex would be logged ok=true and vanish from the failure metric.
  const r = quarantineRefusal("breach_check", "username", QUARANTINED_USER);
  assertEquals(isIntentionalSkip(r), false, "a refusal must not read as a skip");
  assertEquals((r as Record<string, unknown>).skipped, undefined);
});

Deno.test("the refusal names the tool and the selector, so it is auditable", () => {
  const r = quarantineRefusal("breach_check", "username", QUARANTINED_USER) as Record<string, unknown>;
  assertStringIncludes(String(r.error), QUARANTINED_USER);
  assertEquals(r.refused_by, "subject_unlinked_dispatch_boundary");
});

// ── keying: type:normalizedValue, never value alone ───────────────────────────
Deno.test("keys by type AND value — a quarantined username does not disable a same-valued name", () => {
  const q = new Set([dispatchKey("username", QUARANTINED_USER)]);
  assert(isDispatchRefused(q, "username", QUARANTINED_USER), "the quarantined username is refused");
  assert(!isDispatchRefused(q, "name", QUARANTINED_USER), "a NAME of the same text must NOT be refused");
  assert(!isDispatchRefused(q, "email", QUARANTINED_USER), "an EMAIL of the same text must NOT be refused");
});

Deno.test("keying by value alone would restore authority to a quarantined selector — it must not", () => {
  // The inverse hazard: a quarantined NAME must not silently free a username.
  const q = new Set([dispatchKey("name", "jordan vale")]);
  assert(!isDispatchRefused(q, "username", QUARANTINED_USER));
  assert(isDispatchRefused(q, "name", "jordan vale"));
});

// ── the dispatch paths ────────────────────────────────────────────────────────
Deno.test("DIRECT call on a quarantined selector never reaches the tool", async () => {
  const calls = { n: 0 };
  const tools = wrap(calls);
  const out = await (tools.breach_check as { execute: (i: unknown, o: unknown) => Promise<unknown> })
    .execute({ type: "username", value: QUARANTINED_USER }, {});
  assertEquals(calls.n, 0, "the tool body must not run");
  assertEquals((out as Record<string, unknown>).ok, false);
});

Deno.test("REPEATED calls stay refused — no first-one-through leak", async () => {
  const calls = { n: 0 };
  const tools = wrap(calls);
  const ex = (tools.breach_check as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute;
  for (let i = 0; i < 3; i += 1) await ex({ type: "username", value: QUARANTINED_USER }, {});
  assertEquals(calls.n, 0, "no repeat may slip through");
});

Deno.test("a PIVOTED selector (same value, arriving under a different param) is refused", async () => {
  const calls = { n: 0 };
  const tools = wrap(calls);
  const out = await (tools.breach_check as { execute: (i: unknown, o: unknown) => Promise<unknown> })
    .execute({ username: QUARANTINED_USER }, {});
  assertEquals(calls.n, 0);
  assertEquals((out as Record<string, unknown>).ok, false);
});

Deno.test("a PAID tool is refused before any budget is consumed", async () => {
  const calls = { n: 0 };
  const budget = { genuine: 0, reserved: 0, capped: false };
  const tools = wrap(calls, undefined, { toolCallBudget: budget });
  await (tools.breach_check as { execute: (i: unknown, o: unknown) => Promise<unknown> })
    .execute({ type: "username", value: QUARANTINED_USER }, {});
  assertEquals(calls.n, 0, "the tool body must not run");
  assertEquals(budget.reserved, 0, "a refused call must not reserve budget");
  assertEquals(budget.genuine, 0, "a refused call must not count as a genuine call");
});

// ── legitimate artifacts are unaffected ───────────────────────────────────────
Deno.test("a CLEAN selector still runs normally", async () => {
  const calls = { n: 0 };
  const tools = wrap(calls);
  const out = await (tools.breach_check as { execute: (i: unknown, o: unknown) => Promise<unknown> })
    .execute({ type: "username", value: CLEAN_USER }, {});
  assertEquals(calls.n, 1, "an unquarantined selector must still dispatch");
  assertEquals((out as Record<string, unknown>).ok, true);
});

Deno.test("an explicit human linkage decision clears the boundary", async () => {
  // linkage_confirmed is the ONLY thing that clears quarantine (operator ruling,
  // 2026-08-10). Ordinary attestation must not.
  const calls = { n: 0 };
  const db = fakeSupabase([{
    id: "a1", kind: "username", value: QUARANTINED_USER, confidence: 65, source: "x",
    metadata: { subject_unlinked: true, linkage_confirmed: true },
  }]);
  const tools = wrap(calls, db);
  await (tools.breach_check as { execute: (i: unknown, o: unknown) => Promise<unknown> })
    .execute({ type: "username", value: QUARANTINED_USER }, {});
  assertEquals(calls.n, 1, "a human-confirmed linkage must dispatch normally");
});

// ── the candidate widening must not become value-only keying ──────────────────
Deno.test("candidates include the caller-declared `type`, which the wrapper ignores", () => {
  // detectSelectorType reads kind / selector_type, never `type` — but the paid
  // breach tools' schemas are `{ type, value }`. Without this the boundary would
  // hold for cheap tools and leak on the expensive ones.
  const c = dispatchTypeCandidates("value", { type: "username", value: QUARANTINED_USER });
  assert(c.includes("username"), "the declared type must be a candidate");
  assert(c.includes("value"), "the computed type must remain a candidate");
});

Deno.test("candidates are ONLY types the caller declared — not every type", () => {
  // The whole hazard-1 guarantee rests on this. If candidates ever became
  // "any type", the boundary would degrade to value-only keying and a quarantined
  // username would start blocking unrelated names.
  const c = dispatchTypeCandidates("value", { type: "username", value: QUARANTINED_USER });
  assertEquals(c.includes("name"), false, "an undeclared type must never be a candidate");
  assertEquals(c.includes("email"), false);
});

Deno.test("a quarantined username still does NOT block the same text as a name", async () => {
  // The end-to-end form of hazard 1, through the real wrapper.
  const calls = { n: 0 };
  const tools = wrap(calls);
  await (tools.breach_check as { execute: (i: unknown, o: unknown) => Promise<unknown> })
    .execute({ type: "name", value: QUARANTINED_USER }, {});
  assertEquals(calls.n, 1, "a NAME dispatch of the same text must still run");
});

Deno.test("`force` does not override the boundary", async () => {
  // A manual re-run of a quarantined selector is the escape this exists to close.
  const calls = { n: 0 };
  const tools = wrap(calls);
  const out = await (tools.breach_check as { execute: (i: unknown, o: unknown) => Promise<unknown> })
    .execute({ type: "username", value: QUARANTINED_USER, force: true }, {});
  assertEquals(calls.n, 0, "force must not bypass quarantine");
  assertEquals((out as Record<string, unknown>).ok, false);
});
