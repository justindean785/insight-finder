// rejected_dispatch_test.ts — the ANALYST-REJECTION dispatch boundary.
//
// A `dismissed` / `wrong` verdict bound at every model-facing READ (reviews.ts)
// and the prompt said DO NOT USE — but nothing enforced it at DISPATCH, so the
// model, a manual "Run this pivot", or a queued batch could still start a paid
// tool call on a selector the analyst had ruled out. A prompt rule is not
// enforcement. These tests drive the REAL wrap path (wrapToolsWithCache), not the
// predicate in isolation, because the property that matters is "the tool never
// runs", and only the wrapper can demonstrate that.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { wrapToolsWithCache, isIntentionalSkip } from "./cache.ts";
import { clearRuntime } from "./runtime-policy.ts";
import * as circuit from "./circuit.ts";
import {
  buildRejectedDispatchKeys, isRejectedDispatch, rejectionRefusal, rejectedTypeAliases,
  REJECTED_DISPATCH_REFUSAL_MARKER,
} from "./lib/dispatch-rejection.ts";
import { dispatchKey } from "./lib/dispatch-quarantine.ts";

type SupabaseClient = ReturnType<typeof createClient>;

const REJECTED_EMAIL = "Wrong.Person@Example.test";
const CLEAN_EMAIL = "real@example.test";
const REJECTED_HANDLE = "jordan.vale";

function makeChain(resolveValue: { data: unknown; error: unknown }): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "update", "limit"]) node[m] = () => node;
  node.maybeSingle = () => Promise.resolve(resolveValue);
  node.then = (r: (v: { data: unknown; error: unknown }) => void) => r(resolveValue);
  return node;
}

/**
 * `artifact_reviews` holds two rejections; `artifacts` serves the id → row
 * lookup the review loader makes, plus a clean row. Nothing here is quarantined,
 * so the ONLY thing that can refuse a call is the analyst's verdict.
 */
function fakeSupabase(opts?: { reviewsError?: boolean; reviewRows?: Array<Record<string, unknown>> }): SupabaseClient {
  const artifactRows = [
    { id: "a1", kind: "email", value: REJECTED_EMAIL, confidence: 70, source: "hibp", metadata: {} },
    { id: "a2", kind: "email", value: CLEAN_EMAIL, confidence: 90, source: "hibp", metadata: {} },
    { id: "a3", kind: "handle", value: REJECTED_HANDLE, confidence: 60, source: "sherlock", metadata: {} },
  ];
  const reviewRows = opts?.reviewRows ?? [
    { artifact_id: "a1", state: "dismissed", note: null },
    { artifact_id: "a3", state: "wrong", note: null },
  ];
  const inert = makeChain({ data: [], error: null });
  inert.insert = () => Promise.resolve({ error: null });
  inert.upsert = () => Promise.resolve({ error: null });
  const artifacts = makeChain({ data: artifactRows, error: null });
  artifacts.insert = () => Promise.resolve({ error: null });
  const reviews = makeChain(opts?.reviewsError
    ? { data: null, error: { message: "boom" } }
    : { data: reviewRows, error: null });
  return {
    from: (t: string) => (t === "artifacts" ? artifacts : t === "artifact_reviews" ? reviews : inert),
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as unknown as SupabaseClient;
}

function countingTool(calls: { n: number }): Tool {
  return {
    description: "test",
    execute: (_i: unknown, _o: unknown) => { calls.n += 1; return Promise.resolve({ ok: true, hit: true }); },
  } as unknown as Tool;
}

let threadSeq = 0;
function freshThread(): string {
  threadSeq += 1;
  return `22222222-3333-4444-8555-${String(threadSeq).padStart(12, "0")}`;
}

function wrap(calls: { n: number }, db?: SupabaseClient) {
  const investigationId = freshThread();
  clearRuntime(investigationId);
  circuit.clearThread(investigationId);
  return wrapToolsWithCache({ breach_check: countingTool(calls) }, {
    investigationId,
    userId: "u1",
    supabase: db ?? fakeSupabase(),
  });
}
type Exec = { execute: (i: unknown, o: unknown) => Promise<unknown> };

// ── the refusal payload ───────────────────────────────────────────────────────
Deno.test("a rejection refusal is an explicit NON-success and NOT a skip", () => {
  const r = rejectionRefusal("breach_check", "email", "x@y.z") as Record<string, unknown>;
  assertEquals(r.ok, false);
  assertEquals(r.refused_by, REJECTED_DISPATCH_REFUSAL_MARKER);
  assertEquals(r.dropped, undefined, "must not imitate the unknown-tool sink shape");
  assertEquals(r.skipped, undefined);
  assertEquals(isIntentionalSkip(r), false, "a refusal must not read as an intentional skip");
  assertStringIncludes(String(r.error), "x@y.z");
});

// ── keying ────────────────────────────────────────────────────────────────────
Deno.test("keys by type AND value, folding artifact kinds onto selector types", () => {
  const keys = buildRejectedDispatchKeys(
    [{ id: "a3", kind: "handle", value: "@Jordan.Vale" }],
    circuit.normalizeSelector,
  );
  assert(keys.has(dispatchKey("username", "jordan.vale")), "handle → username alias");
  assert(keys.has(dispatchKey("handle", "jordan.vale")), "the raw kind still keys too");
  assertEquals(isRejectedDispatch(keys, ["username"], "jordan.vale"), "username");
  assertEquals(isRejectedDispatch(keys, ["name"], "jordan.vale"), null, "a NAME of the same text is not refused");
  assertEquals(isRejectedDispatch(keys, ["username"], ""), null, "an empty selector fails open");
  assertEquals(rejectedTypeAliases("email"), ["email"]);
});

// ── the dispatch paths ────────────────────────────────────────────────────────
Deno.test("⛔ MODEL-REQUESTED call on a rejected selector never reaches the tool", async () => {
  const calls = { n: 0 };
  const tools = wrap(calls);
  const out = await (tools.breach_check as Exec).execute({ type: "email", value: REJECTED_EMAIL.toLowerCase() }, {});
  assertEquals(calls.n, 0, "the tool body must not run");
  assertEquals((out as Record<string, unknown>).refused_by, REJECTED_DISPATCH_REFUSAL_MARKER);
});

Deno.test("refusal is by NORMALIZED value — casing and @ do not bypass it", async () => {
  const calls = { n: 0 };
  const tools = wrap(calls);
  await (tools.breach_check as Exec).execute({ email: "WRONG.PERSON@example.TEST" }, {});
  await (tools.breach_check as Exec).execute({ username: "@Jordan.Vale" }, {});
  assertEquals(calls.n, 0);
});

Deno.test("a clean selector in the same run still dispatches", async () => {
  const calls = { n: 0 };
  const tools = wrap(calls);
  const out = await (tools.breach_check as Exec).execute({ email: CLEAN_EMAIL }, {});
  assertEquals(calls.n, 1, "the rejection of a1 must not disable a2");
  assertEquals((out as Record<string, unknown>).ok, true);
});

Deno.test("`force` does not override an analyst rejection", async () => {
  const calls = { n: 0 };
  const tools = wrap(calls);
  await (tools.breach_check as Exec).execute({ email: REJECTED_EMAIL, force: true }, {});
  assertEquals(calls.n, 0);
});

Deno.test("a rejected username does not disable a NAME of the same text (type-keyed)", async () => {
  const calls = { n: 0 };
  const tools = wrap(calls);
  await (tools.breach_check as Exec).execute({ name: REJECTED_HANDLE }, {});
  assertEquals(calls.n, 1, "a name is a different identity from a username");
});

Deno.test("an unreadable review set leaves the boundary OPEN for this run, loudly", async () => {
  // Documented, deliberate: dispatch is a spend/steering control, not an
  // authorization control. The authoritative consumers fail closed on the same
  // load (synthesis, cache, clustering, recovery, prompt block).
  const calls = { n: 0 };
  const warned: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => { warned.push(a.map(String).join(" ")); };
  try {
    const tools = wrap(calls, fakeSupabase({ reviewsError: true }));
    await (tools.breach_check as Exec).execute({ email: REJECTED_EMAIL }, {});
  } finally { console.warn = orig; }
  assertEquals(calls.n, 1);
  assert(warned.some((w) => w.includes("[rejected-dispatch]")), "the open boundary must be observable");
});
