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
// Platform account ids. These exist because `steam_profile { steamid64 }` and
// `roblox_user { user_id }` name their selector with fields the central
// detector did not recognize, which produced an EMPTY selector — and an empty
// selector fails open at every one of these checks (pinned two tests below).
const REJECTED_STEAMID = "76561197960287930";
const REJECTED_ROBLOX_ID = "12345";

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
    { id: "a4", kind: "account_id", value: REJECTED_STEAMID, confidence: 55, source: "steam", metadata: {} },
    { id: "a5", kind: "account_id", value: REJECTED_ROBLOX_ID, confidence: 55, source: "roblox", metadata: {} },
  ];
  const reviewRows = opts?.reviewRows ?? [
    { artifact_id: "a1", state: "dismissed", note: null },
    { artifact_id: "a3", state: "wrong", note: null },
    { artifact_id: "a4", state: "dismissed", note: null },
    { artifact_id: "a5", state: "wrong", note: null },
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

// ── mid-run binding ───────────────────────────────────────────────────────────

/**
 * Like fakeSupabase, but `artifact_reviews` reads a LIVE array (so a verdict can
 * be added between dispatches) and counts every read.
 */
function mutableFake(reviewRows: Array<Record<string, unknown>>, reads: { n: number }): SupabaseClient {
  const artifactRows = [
    { id: "a1", kind: "email", value: REJECTED_EMAIL, confidence: 70, source: "hibp", metadata: {} },
    { id: "a2", kind: "email", value: CLEAN_EMAIL, confidence: 90, source: "hibp", metadata: {} },
  ];
  const inert = makeChain({ data: [], error: null });
  inert.insert = () => Promise.resolve({ error: null });
  inert.upsert = () => Promise.resolve({ error: null });
  const artifacts = makeChain({ data: artifactRows, error: null });
  artifacts.insert = () => Promise.resolve({ error: null });
  const reviews: Record<string, unknown> = {};
  for (const m of ["eq", "in", "order", "update", "limit"]) reviews[m] = () => reviews;
  // Counts reads of THIS thread's review set. The E4 cross-case index read
  // (`select` naming `thread_id`) is memoized once per run and is not what these
  // tests measure — see cross_case_reviews_test.ts for that read.
  reviews.select = (cols?: string) => {
    if (!String(cols ?? "").includes("thread_id")) reads.n += 1;
    return reviews;
  };
  reviews.maybeSingle = () => Promise.resolve({ data: reviewRows, error: null });
  reviews.then = (r: (v: { data: unknown; error: unknown }) => void) => r({ data: reviewRows, error: null });
  return {
    from: (t: string) => (t === "artifacts" ? artifacts : t === "artifact_reviews" ? reviews : inert),
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as unknown as SupabaseClient;
}

Deno.test("⛔ a Wrong entered MID-RUN binds before the very next sequential dispatch", async () => {
  // The memo used to be once-per-run: a verdict the analyst entered while the
  // agent was still working did not reach this guard until the NEXT invocation,
  // so the next paid call could still go out on the selector they had just
  // ruled out (live: thread b74049ad, 2026-09-08).
  const reviewRows: Array<Record<string, unknown>> = [];
  const reads = { n: 0 };
  const calls = { n: 0 };
  const investigationId = freshThread();
  clearRuntime(investigationId);
  circuit.clearThread(investigationId);
  const tools = wrapToolsWithCache(
    { breach_check: countingTool(calls), gravatar_profile: countingTool(calls) },
    { investigationId, userId: "u1", supabase: mutableFake(reviewRows, reads) },
  );
  const bc = tools.breach_check as Exec;
  const gp = tools.gravatar_profile as Exec;

  // 1. No verdict yet → the selector dispatches, and the review set is read once.
  await bc.execute({ type: "email", value: REJECTED_EMAIL }, {});
  assertEquals(calls.n, 1, "clean selector must dispatch");
  assertEquals(reads.n, 1, "first dispatch loads the review set");

  // 2. The analyst marks it Wrong while the run is live.
  reviewRows.push({ artifact_id: "a1", state: "wrong", note: null });

  // 3. The very next sequential dispatch re-reads and REFUSES — no stale
  //    TTL window is allowed to spend a call after the analyst's ruling.
  const before = calls.n;
  const out = await gp.execute({ email: REJECTED_EMAIL.toUpperCase() }, {});
  assertEquals(reads.n, 2, "the next sequential dispatch re-reads analyst decisions");
  assertEquals(calls.n, before, "the tool body must not run on a rejected selector");
  assertEquals((out as Record<string, unknown>).refused_by, REJECTED_DISPATCH_REFUSAL_MARKER);
});

Deno.test("`force` cannot override a mid-run rejection on the next dispatch", async () => {
  const reviewRows: Array<Record<string, unknown>> = [];
  const reads = { n: 0 };
  const calls = { n: 0 };
  const investigationId = freshThread();
  clearRuntime(investigationId);
  circuit.clearThread(investigationId);
  const tools = wrapToolsWithCache(
    { breach_check: countingTool(calls) },
    { investigationId, userId: "u1", supabase: mutableFake(reviewRows, reads) },
  );
  const bc = tools.breach_check as Exec;
  await bc.execute({ type: "email", value: REJECTED_EMAIL }, {});
  assertEquals(calls.n, 1);
  reviewRows.push({ artifact_id: "a1", state: "dismissed", note: null });
  const out = await bc.execute({ type: "email", value: REJECTED_EMAIL, force: true }, {});
  assertEquals(calls.n, 1, "force must not override the analyst");
  assertEquals((out as Record<string, unknown>).refused_by, REJECTED_DISPATCH_REFUSAL_MARKER);
});

// ── the selector-field gap (Codex review, 2026-10-01) ─────────────────────────
// A tool that invents a parameter name is not merely uncached, it is UNGOVERNED:
// `detectSelectorType`/`detectSelectorValue` recognized only a fixed set of
// field names, so `steam_profile { vanity | steamid64 }` and
// `roblox_user { user_id }` produced selector `""` — and the test above pins
// that an empty selector FAILS OPEN. The rejection check, the `subject_unlinked`
// quarantine check and the `unproven_linkage` taint all silently matched
// nothing. These drive the real wrapper, so they fail against the pre-fix
// detector.

Deno.test("⛔ a rejected handle is still refused when it arrives as `vanity`", async () => {
  // `vanity` is a username in everything but spelling — a Steam /id/<name>
  // segment. Without the alias an analyst could reject a handle and the planner
  // could still read that same handle's profile at full subject authority.
  const calls = { n: 0 };
  const tools = wrap(calls);
  const out = await (tools.breach_check as Exec).execute({ vanity: "@Jordan.Vale" }, {});
  assertEquals(calls.n, 0, "the tool body must not run");
  assertEquals((out as Record<string, unknown>).refused_by, REJECTED_DISPATCH_REFUSAL_MARKER);
});

Deno.test("⛔ a rejected platform account id is refused as `steamid64` and as `user_id`", async () => {
  const calls = { n: 0 };
  const tools = wrap(calls);
  await (tools.breach_check as Exec).execute({ steamid64: REJECTED_STEAMID }, {});
  // Numeric, as the roblox_user schema accepts (z.union([string, number])) —
  // the detector must stringify rather than drop it.
  await (tools.breach_check as Exec).execute({ user_id: Number(REJECTED_ROBLOX_ID) }, {});
  assertEquals(calls.n, 0, "neither id form may reach the tool");
});

Deno.test("an account id the analyst never rejected still dispatches", async () => {
  // The control: the fix must not refuse everything that carries one of the new
  // fields — only the selector the analyst actually ruled out.
  const calls = { n: 0 };
  const tools = wrap(calls);
  const out = await (tools.breach_check as Exec).execute({ steamid64: "76561197960000000" }, {}) as Record<string, unknown>;
  assertEquals(calls.n, 1);
  assertEquals(out.refused_by, undefined);
});

Deno.test("an account id is NOT folded into the username namespace", async () => {
  // `normalizeTarget` collapses non-alphanumerics, so distinct selector kinds
  // can normalize equal — which is why `lib/dispatch-quarantine.ts` keys by
  // type AND value. Mapping a numeric id to `username` would let an unrelated
  // handle of the same digits refuse it, or vice versa.
  const keys = buildRejectedDispatchKeys(
    [{ id: "a4", kind: "account_id", value: REJECTED_STEAMID }],
    circuit.normalizeSelector,
  );
  assertEquals(isRejectedDispatch(keys, ["account_id"], REJECTED_STEAMID), "account_id");
  assertEquals(
    isRejectedDispatch(keys, ["username"], REJECTED_STEAMID),
    null,
    "a USERNAME spelled with the same digits is a different selector",
  );
});
