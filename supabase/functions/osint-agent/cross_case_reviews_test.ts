// cross_case_reviews_test.ts — E4: analyst marks carry across the user's cases.
//
// Measured 2026-10-15: 234 artifacts in OTHER threads of the same user carried a
// value the analyst had already dismissed / marked wrong, because every review
// read was `.eq("thread_id", threadId)`. These tests drive the SHIPPED control
// flow — the real `loadReviewsForThread`, the real read predicates every
// model-facing surface uses, the real prompt renderer and the real dispatch
// guard in `wrapToolsWithCache` — against an in-memory PostgREST stand-in that
// honours eq / neq / in / order / range, so pagination and keying are exercised
// for real rather than re-described.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { wrapToolsWithCache, isIntentionalSkip } from "./cache.ts";
import { clearRuntime } from "./runtime-policy.ts";
import * as circuit from "./circuit.ts";
import {
  applyReviewsToArtifacts, buildExclusionMap, dropRejectedAndDerived, dropRejectedArtifacts,
  enforcedRejectedRows, isRejectedByReview, loadReviewsForThread, normalizeArtifactKey,
  renderAnalystDecisionsBlock, type ReviewDb,
} from "./reviews.ts";
import {
  buildCrossCaseIndex, CROSS_CASE_IN_CHUNK, crossCaseKey, crossCaseLogEvent, crossCaseReviewsSelfTest,
  isCaseOnlyNote, resetCrossCaseMemo,
} from "./lib/cross-case-reviews.ts";
import { REJECTED_DISPATCH_REFUSAL_MARKER } from "./lib/dispatch-rejection.ts";

type SupabaseClient = ReturnType<typeof createClient>;
type Row = Record<string, unknown>;

const USER = "u-e4";
const OTHER_USER = "u-someone-else";

// ── an in-memory PostgREST stand-in ───────────────────────────────────────────
// Filters it understands are APPLIED (so a test can't pass by accident because a
// filter was ignored); anything else is a no-op. `maxRows` simulates PostgREST's
// server-side max-rows clip, which returns a SHORT page that is not the end.
interface FakeOpts { maxRows?: number; failCrossCase?: boolean; failThreadArtifacts?: boolean }
interface FakeDb {
  client: SupabaseClient;
  writes: Array<{ table: string; op: string }>;
  inSizes: number[];
  rangeCalls: number;
}
function fakeDb(tables: Record<string, Row[]>, opts: FakeOpts = {}): FakeDb {
  const writes: Array<{ table: string; op: string }> = [];
  const inSizes: number[] = [];
  const state = { rangeCalls: 0 };
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let order: string | null = null;
    let range: [number, number] | null = null;
    let usedNeqThread = false;
    let usedEqThread = false;
    const node: Record<string, unknown> = {};
    const chain = () => node;
    node.select = chain;
    node.eq = (c: string, v: unknown) => { if (c === "thread_id") usedEqThread = true; filters.push((r) => r[c] === v); return node; };
    node.neq = (c: string, v: unknown) => { if (c === "thread_id") usedNeqThread = true; filters.push((r) => r[c] !== v); return node; };
    node.in = (c: string, vs: readonly unknown[]) => { inSizes.push(vs.length); filters.push((r) => vs.includes(r[c])); return node; };
    node.order = (c: string) => { order = c; return node; };
    node.range = (a: number, b: number) => { state.rangeCalls++; range = [a, b]; return node; };
    for (const m of ["limit", "or", "gte", "lte", "gt", "lt", "is", "not", "filter", "match", "contains"]) node[m] = chain;
    for (const m of ["insert", "upsert", "update", "delete"]) {
      node[m] = () => { writes.push({ table, op: m }); return node; };
    }
    const resolve = () => {
      if (opts.failCrossCase && table === "artifact_reviews" && usedNeqThread) {
        return { data: null, error: { message: "cross-case read boom" } };
      }
      if (opts.failThreadArtifacts && table === "artifacts" && usedEqThread) {
        return { data: null, error: { message: "thread artifacts boom" } };
      }
      let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      if (order) rows = [...rows].sort((a, b) => String(a[order!]).localeCompare(String(b[order!])));
      if (range) {
        const [a, b] = range;
        rows = rows.slice(a, b + 1);
        if (opts.maxRows) rows = rows.slice(0, opts.maxRows);
      }
      return { data: rows, error: null };
    };
    node.maybeSingle = () => Promise.resolve({ data: resolve().data?.[0] ?? null, error: null });
    node.single = node.maybeSingle;
    node.then = (ok: (v: unknown) => unknown, err?: (e: unknown) => unknown) => Promise.resolve(resolve()).then(ok, err);
    return node;
  };
  const client = {
    from,
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as unknown as SupabaseClient;
  return { client, writes, inSizes, get rangeCalls() { return state.rangeCalls; } } as FakeDb;
}

let seq = 0;
const tid = () => `33333333-4444-4555-8666-${String(++seq).padStart(12, "0")}`;
const rid = () => `r-${String(++seq).padStart(8, "0")}`;

function art(id: string, thread: string, kind: string, value: string, extra: Row = {}): Row {
  return { id, thread_id: thread, user_id: USER, kind, value, confidence: 60, source: "test", metadata: {}, ...extra };
}
function review(artifactId: string, thread: string, state: string, at: string, note: string | null = null, user = USER): Row {
  return { id: rid(), artifact_id: artifactId, thread_id: thread, user_id: user, state, note, created_at: at, updated_at: at };
}

async function load(db: FakeDb, thread: string) {
  resetCrossCaseMemo();
  return await loadReviewsForThread(db.client as unknown as ReviewDb, thread, USER);
}

function countingTool(calls: { n: number }): Tool {
  return {
    description: "test",
    execute: () => { calls.n += 1; return Promise.resolve({ ok: true, hit: true }); },
  } as unknown as Tool;
}
type Exec = { execute: (i: unknown, o: unknown) => Promise<unknown> };
function wrapFor(db: FakeDb, thread: string, calls: { n: number }) {
  resetCrossCaseMemo();
  clearRuntime(thread);
  circuit.clearThread(thread);
  return wrapToolsWithCache({ breach_check: countingTool(calls) }, {
    investigationId: thread, userId: USER, supabase: db.client,
  });
}

// ── keying ────────────────────────────────────────────────────────────────────
Deno.test("index key == normalizeArtifactKey for non-phones (the two cannot drift)", () => {
  for (const [k, v] of [
    ["email", " Wrong.Person@Example.TEST "], ["username", "Jordan.Vale"], ["handle", "jordan.vale"],
    ["name", "Jordan   Vale"], ["ip_address", "10.0.0.1"], ["social_profile", "https://x.com/a"], ["domain", "EXAMPLE.test"],
  ]) {
    assertEquals(crossCaseKey(k, v), normalizeArtifactKey(k, v), `${k}:${v}`);
  }
});

Deno.test("normalization: case and whitespace collide; phone formats collide; username vs name do NOT", () => {
  assertEquals(crossCaseKey("email", "A@B.test"), crossCaseKey("email", "  a@b.TEST "));
  assertEquals(crossCaseKey("name", "Jordan  Vale"), crossCaseKey("name", "jordan vale"));
  const p = crossCaseKey("phone", "+16174427629");
  assertEquals(crossCaseKey("phone", "6174427629"), p);
  assertEquals(crossCaseKey("phone", "(617) 442-7629"), p);
  assertEquals(crossCaseKey("phone", "1-617-442-7629"), p);
  assertEquals(crossCaseKey("phone_number", "617.442.7629"), p);
  assert(crossCaseKey("phone", "6174427620") !== p, "a different number stays different");
  assert(crossCaseKey("username", "jordan.vale") !== crossCaseKey("name", "Jordan Vale"), "jordan.vale hazard");
  assert(crossCaseKey("username", "jordanvale") !== crossCaseKey("name", "jordanvale"), "same letters, different type");
  // the persisted dedup/read key for phones is untouched
  assert(normalizeArtifactKey("phone", "6174427629") !== normalizeArtifactKey("phone", "+16174427629"));
});

Deno.test("escape hatch: 'this case only' / '#caseonly' notes, case-insensitive", () => {
  assert(isCaseOnlyNote("Not him — THIS CASE ONLY"));
  assert(isCaseOnlyNote("#CaseOnly wrong here"));
  assert(!isCaseOnlyNote("wrong person"));
  assert(!isCaseOnlyNote(null));
});

Deno.test("most-recent-wins across cases, both directions; ties go to the rejection", () => {
  const arts = new Map([["a", { id: "a", kind: "email", value: "x@e.test" }], ["c", { id: "c", kind: "email", value: "X@E.test" }]]);
  const dismissedThenConfirmed = buildCrossCaseIndex([
    { artifact_id: "a", thread_id: "A", state: "dismissed", updated_at: "2026-01-01T00:00:00Z" },
    { artifact_id: "c", thread_id: "C", state: "confirmed", updated_at: "2026-02-01T00:00:00Z" },
  ], arts, "B").index;
  assertEquals(dismissedThenConfirmed.get(crossCaseKey("email", "x@e.test"))?.state, "confirmed");
  const confirmedThenWrong = buildCrossCaseIndex([
    { artifact_id: "c", thread_id: "C", state: "confirmed", updated_at: "2026-01-01T00:00:00Z" },
    { artifact_id: "a", thread_id: "A", state: "wrong", updated_at: "2026-02-01T00:00:00Z" },
  ], arts, "B").index;
  assertEquals(confirmedThenWrong.get(crossCaseKey("email", "x@e.test"))?.state, "wrong");
  const tie = buildCrossCaseIndex([
    { artifact_id: "a", thread_id: "A", state: "dismissed", updated_at: "2026-01-01T00:00:00Z" },
    { artifact_id: "c", thread_id: "C", state: "confirmed", updated_at: "2026-01-01T00:00:00Z" },
  ], arts, "B").index;
  assertEquals(tie.get(crossCaseKey("email", "x@e.test"))?.state, "dismissed");
});

// ── dismissed in A never reaches B ────────────────────────────────────────────
function caseAB() {
  const A = tid(), B = tid();
  const db = fakeDb({
    artifacts: [
      art("a-email", A, "email", "Wrong.Person@Example.test"),
      art("a-phone", A, "phone", "+16174427629"),
      art("a-user", A, "username", "jordan.vale"),
      art("b-email", B, "email", "wrong.person@example.TEST"),
      art("b-phone", B, "phone", "6174427629"),
      art("b-name", B, "name", "Jordan Vale"),
      art("b-clean", B, "email", "real@example.test"),
      art("b-child", B, "password", "hunter2", { metadata: { parent_selector: "wrong.person@example.test" } }),
    ],
    artifact_reviews: [
      review("a-email", A, "dismissed", "2026-10-01T00:00:00Z"),
      review("a-phone", A, "wrong", "2026-10-01T00:00:00Z"),
      review("a-user", A, "wrong", "2026-10-01T00:00:00Z"),
    ],
  });
  return { A, B, db };
}

Deno.test("⛔ a value dismissed in case A is excluded from case B's model-facing reads, report and clusters", async () => {
  const { B, db } = caseAB();
  const rl = await load(db, B);
  assert(rl.ok, "in-thread load still ok");
  assertEquals(rl.byId.size, 0, "cross-case verdicts never enter byId (no review_state tagging)");
  const rows = [
    art("b-email", B, "email", "wrong.person@example.TEST"),
    art("b-phone", B, "phone", "6174427629"),
    art("b-name", B, "name", "Jordan Vale"),
    art("b-clean", B, "email", "real@example.test"),
    art("b-child", B, "password", "hunter2", { metadata: { parent_selector: "wrong.person@example.test" } }),
  ];
  // dropRejectedArtifacts: cache write, clustering, synthesis, record_finding contradiction rows
  const kept = dropRejectedArtifacts(rows, rl).map((r) => r.id);
  assertEquals(kept.includes("b-email"), false, "case/whitespace variant removed");
  assertEquals(kept.includes("b-phone"), false, "phone format variant removed");
  assert(kept.includes("b-name"), "a NAME 'Jordan Vale' is not the rejected USERNAME 'jordan.vale'");
  assert(kept.includes("b-clean"));
  // applyReviewsToArtifacts: salvage synthesis (the report), cache, recovery
  assertEquals(applyReviewsToArtifacts(rows, rl).map((r) => r.id).sort(), ["b-child", "b-clean", "b-name"].sort());
  // dropRejectedAndDerived: planner graph / pivot ranking — the provenance cascade follows
  assertEquals(dropRejectedAndDerived(rows, rl).map((r) => r.id).sort(), ["b-clean", "b-name"].sort());
  const ex = buildExclusionMap(rows, rl);
  assertEquals(ex.get("b-email"), "rejected_in_other_case");
  assertEquals(ex.get("b-phone"), "rejected_in_other_case");
  assertEquals(ex.get("b-child"), "derived_from_rejected");
  // planner input list supplied by the model
  assert(isRejectedByReview(rl, "email", "WRONG.PERSON@example.test"));
  assert(!isRejectedByReview(rl, "name", "jordan.vale"));
  // memory supersession / memory-write refusal see the cross-case rows
  assert(enforcedRejectedRows(rl).some((r) => r.value === "Wrong.Person@Example.test"));
});

Deno.test("⛔ the raw row in case B is NEVER deleted or rewritten (disclosure, not deletion)", async () => {
  const { B, db } = caseAB();
  const rl = await load(db, B);
  dropRejectedArtifacts([art("b-email", B, "email", "wrong.person@example.test")], rl);
  assertEquals(db.writes.filter((w) => w.table === "artifacts"), [], "no write of any kind to artifacts");
  assertEquals(db.writes.filter((w) => w.table === "artifact_reviews"), [], "no review is written into case B");
});

Deno.test("prompt: a COUNT of hidden values, never the values themselves", async () => {
  const { B, db } = caseAB();
  const rl = await load(db, B);
  const block = renderAnalystDecisionsBlock(rl);
  // b-email and b-phone occur in B; jordan.vale (username) does not.
  assertStringIncludes(block, "2 values hidden by your earlier reviews in other cases");
  assertEquals(block.toLowerCase().includes("wrong.person"), false, "no rejected value named");
  assertEquals(block.includes("7629"), false, "no rejected phone named");
  assertEquals(block.includes("jordan"), false);
  assertEquals(rl.crossCase?.hiddenInCase, 2);
  const ev = crossCaseLogEvent(B, rl.crossCase);
  assertEquals(ev.suppressed, 3);
  assertEquals(ev.suppressed_in_case, 2);
  assertEquals(JSON.stringify(ev).includes("wrong.person"), false, "log carries counts only");
});

// ── dispatch, through the real wrapper ────────────────────────────────────────
Deno.test("⛔ dispatch in case B is refused for a value rejected in case A — same path, other-case message", async () => {
  const { B, db } = caseAB();
  const calls = { n: 0 };
  const tools = wrapFor(db, B, calls);
  const out = await (tools.breach_check as Exec).execute({ email: "WRONG.person@example.test" }, {}) as Row;
  assertEquals(calls.n, 0, "the tool never ran");
  assertEquals(out.ok, false);
  assertEquals(out.refused_by, REJECTED_DISPATCH_REFUSAL_MARKER);
  assertEquals(out.rejected_in, "other_case");
  assertStringIncludes(String(out.error), "rejected by your review in another case");
  assertEquals(isIntentionalSkip(out), false, "a refusal is not a skip");
  // force does not override it
  await (tools.breach_check as Exec).execute({ email: "wrong.person@example.test", force: true }, {});
  assertEquals(calls.n, 0);
});

Deno.test("⛔ dispatch: a phone rejected as +16174427629 in A is refused as 617-442-7629 in B", async () => {
  const { B, db } = caseAB();
  const calls = { n: 0 };
  const tools = wrapFor(db, B, calls);
  for (const p of ["617-442-7629", "+1 617 442 7629", "16174427629"]) {
    const out = await (tools.breach_check as Exec).execute({ phone: p }, {}) as Row;
    assertEquals(out.refused_by, REJECTED_DISPATCH_REFUSAL_MARKER, p);
  }
  assertEquals(calls.n, 0);
});

Deno.test("dispatch: a NAME with the rejected username's letters, and a clean selector, still run", async () => {
  const { B, db } = caseAB();
  const calls = { n: 0 };
  const tools = wrapFor(db, B, calls);
  await (tools.breach_check as Exec).execute({ name: "jordan.vale" }, {});
  await (tools.breach_check as Exec).execute({ email: "real@example.test" }, {});
  assertEquals(calls.n, 2);
});

// ── confirmed in A: priority only, never Verified ─────────────────────────────
Deno.test("confirmed in A lists as pivot PRIORITY in B; B's row label/confidence unchanged", async () => {
  const A = tid(), B = tid();
  const db = fakeDb({
    artifacts: [
      art("a1", A, "email", "Subject@Example.test"),
      art("a2", A, "username", "elsewhere_only"),
      art("a3", A, "domain", "recheck.example"),
      art("b1", B, "email", "subject@example.test", { confidence: 45 }),
      art("b3", B, "domain", "recheck.example"),
    ],
    artifact_reviews: [
      review("a1", A, "confirmed", "2026-10-01T00:00:00Z"),
      review("a2", A, "key", "2026-10-01T00:00:00Z"),
      review("a3", A, "recheck", "2026-10-01T00:00:00Z"),
    ],
  });
  const rl = await load(db, B);
  assertEquals(rl.crossCase?.confirmed.map((v) => v.value), ["Subject@Example.test"]);
  assertEquals(rl.crossCase?.key.length, 0, "a key value that does not occur in B is not handed to B");
  assertEquals(rl.crossCase?.recheck.map((v) => v.value), ["recheck.example"]);
  const block = renderAnalystDecisionsBlock(rl);
  assertStringIncludes(block, "Analyst-confirmed (or Key) in another case");
  assertStringIncludes(block, "Subject@Example.test");
  assertStringIncludes(block, `case ${A}`);
  assertStringIncludes(block, "NOT a");
  assertStringIncludes(block, "source");
  assertStringIncludes(block, "Recheck requested in another case");
  assertEquals(block.includes("elsewhere_only"), false, "another subject's selector is not offered to B");
  // B's own row: not tagged, not re-scored, not verified
  const [row] = applyReviewsToArtifacts([art("b1", B, "email", "subject@example.test", { confidence: 45 })], rl);
  assertEquals(row.review_state, undefined, "no review_state → no Verified/CONFIRMED tag");
  assertEquals(row.confidence, 45, "confidence exactly as persisted");
  assertEquals((row.metadata as Row).linkage_confirmed, undefined);
  assertEquals(rl.byId.size, 0);
  assertEquals(rl.reviewedRows.length, 0, "the in-thread ANALYST DECISIONS sections stay empty");
  assertEquals(db.writes, [], "nothing written");
});

// ── precedence ────────────────────────────────────────────────────────────────
Deno.test("most-recent-wins through the real loader: dismissed in A then confirmed in C → not suppressed in B", async () => {
  const A = tid(), B = tid(), C = tid();
  const mk = (aState: string, aAt: string, cState: string, cAt: string) => fakeDb({
    artifacts: [art("a", A, "email", "x@e.test"), art("c", C, "email", "x@e.test"), art("b", B, "email", "x@e.test")],
    artifact_reviews: [review("a", A, aState, aAt), review("c", C, cState, cAt)],
  });
  let rl = await load(mk("dismissed", "2026-09-01T00:00:00Z", "confirmed", "2026-10-01T00:00:00Z"), B);
  assertEquals(dropRejectedArtifacts([art("b", B, "email", "x@e.test")], rl).length, 1);
  assertEquals(rl.crossCase?.confirmed.length, 1);
  rl = await load(mk("dismissed", "2026-10-02T00:00:00Z", "confirmed", "2026-10-01T00:00:00Z"), B);
  assertEquals(dropRejectedArtifacts([art("b", B, "email", "x@e.test")], rl).length, 0);
});

Deno.test("an IN-THREAD verdict overrides the cross-case one (row, prompt and dispatch)", async () => {
  const A = tid(), B = tid();
  const db = fakeDb({
    artifacts: [art("a", A, "email", "x@e.test"), art("b", B, "email", "X@E.test")],
    artifact_reviews: [
      review("a", A, "dismissed", "2026-10-02T00:00:00Z"),
      review("b", B, "confirmed", "2026-09-01T00:00:00Z"), // older, but in THIS case
    ],
  });
  const rl = await load(db, B);
  assertEquals(rl.crossCase?.rejectedKeys.size, 0);
  assertEquals(rl.crossCase?.overriddenInThread, 1);
  assertEquals(dropRejectedArtifacts([art("b", B, "email", "X@E.test")], rl).length, 1);
  const calls = { n: 0 };
  await (wrapFor(db, B, calls).breach_check as Exec).execute({ email: "x@e.test" }, {});
  assertEquals(calls.n, 1, "the analyst's own call in this case wins");
});

Deno.test("a 'this case only' / #caseonly review does not propagate", async () => {
  const A = tid(), B = tid();
  const db = fakeDb({
    artifacts: [art("a", A, "email", "x@e.test"), art("a2", A, "email", "y@e.test"), art("b", B, "email", "x@e.test")],
    artifact_reviews: [
      review("a", A, "wrong", "2026-10-01T00:00:00Z", "Not our guy — this case only"),
      review("a2", A, "dismissed", "2026-10-01T00:00:00Z", "#CASEONLY"),
    ],
  });
  const rl = await load(db, B);
  assertEquals(rl.crossCase?.rejectedKeys.size, 0);
  assertEquals(rl.crossCase?.caseOnlySkipped, 2);
  const calls = { n: 0 };
  await (wrapFor(db, B, calls).breach_check as Exec).execute({ email: "x@e.test" }, {});
  assertEquals(calls.n, 1);
});

Deno.test("another USER's verdicts never cross over", async () => {
  const A = tid(), B = tid();
  const db = fakeDb({
    artifacts: [art("a", A, "email", "x@e.test", { user_id: OTHER_USER }), art("b", B, "email", "x@e.test")],
    artifact_reviews: [review("a", A, "dismissed", "2026-10-01T00:00:00Z", null, OTHER_USER)],
  });
  const rl = await load(db, B);
  assertEquals(rl.crossCase?.rejectedKeys.size, 0);
});

// ── fail-safe and kill switch ─────────────────────────────────────────────────
Deno.test("cross-case load failure → in-thread behaviour only, the run continues", async () => {
  const A = tid(), B = tid();
  const tables = {
    artifacts: [art("a", A, "email", "x@e.test"), art("b", B, "email", "x@e.test"), art("b2", B, "email", "local@e.test")],
    artifact_reviews: [review("a", A, "dismissed", "2026-10-01T00:00:00Z"), review("b2", B, "wrong", "2026-10-01T00:00:00Z")],
  };
  const db = fakeDb(tables, { failCrossCase: true });
  const rl = await load(db, B);
  assert(rl.ok, "a cross-case failure never makes the IN-THREAD state unavailable");
  assertEquals(rl.crossCase, null);
  assert(rl.rejectedKeys.has(normalizeArtifactKey("email", "local@e.test")), "in-thread rejection intact");
  assertEquals(dropRejectedArtifacts([art("b", B, "email", "x@e.test")], rl).length, 1);
  assertEquals(crossCaseLogEvent(B, rl.crossCase, "unavailable").enabled, false);
  const calls = { n: 0 };
  const tools = wrapFor(db, B, calls);
  await (tools.breach_check as Exec).execute({ email: "x@e.test" }, {});
  assertEquals(calls.n, 1, "the run continues");
  const refused = await (tools.breach_check as Exec).execute({ email: "local@e.test" }, {}) as Row;
  assertEquals(refused.refused_by, REJECTED_DISPATCH_REFUSAL_MARKER, "in-thread refusal still binds");
  assertEquals(refused.rejected_in, undefined);
});

Deno.test("in-thread fail-closed is untouched: an in-thread read error is still ok:false", async () => {
  const B = tid();
  const db = {
    from: () => {
      const n: Record<string, unknown> = {};
      for (const m of ["select", "eq", "neq", "in", "order", "range"]) n[m] = () => n;
      n.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: "down" } }).then(r);
      return n;
    },
  };
  resetCrossCaseMemo();
  const rl = await loadReviewsForThread(db as unknown as ReviewDb, B, USER);
  assertEquals(rl.ok, false);
  assertEquals(dropRejectedArtifacts([art("x", B, "email", "x@e.test")], rl).length, 0);
});

Deno.test("thread-artifact read failure: rejections still apply, positives are withheld", async () => {
  const A = tid(), B = tid();
  const db = fakeDb({
    artifacts: [art("a", A, "email", "x@e.test"), art("a2", A, "email", "ok@e.test"), art("b", B, "email", "x@e.test")],
    artifact_reviews: [review("a", A, "dismissed", "2026-10-01T00:00:00Z"), review("a2", A, "confirmed", "2026-10-01T00:00:00Z")],
  }, { failThreadArtifacts: true });
  const rl = await load(db, B);
  assertEquals(rl.crossCase?.rejectedKeys.size, 1);
  assertEquals(rl.crossCase?.confirmed.length, 0);
});

Deno.test("kill switch CROSS_CASE_REVIEWS_DISABLED=true (read at call time) restores in-thread-only behaviour", async () => {
  const { B, db } = caseAB();
  Deno.env.set("CROSS_CASE_REVIEWS_DISABLED", "true");
  try {
    const rl = await load(db, B);
    assertEquals(rl.crossCase, null);
    assertEquals(dropRejectedArtifacts([art("b-email", B, "email", "wrong.person@example.test")], rl).length, 1);
    const calls = { n: 0 };
    await (wrapFor(db, B, calls).breach_check as Exec).execute({ email: "wrong.person@example.test" }, {});
    assertEquals(calls.n, 1);
    assertStringIncludes(crossCaseReviewsSelfTest().detail, "LEGACY");
  } finally {
    Deno.env.delete("CROSS_CASE_REVIEWS_DISABLED");
  }
  const rl = await load(db, B);
  assert(rl.crossCase, "back on without a deploy");
});

// ── pagination ────────────────────────────────────────────────────────────────
Deno.test("pagination advances by rows RETURNED (a clipped short page is not the end) and chunks .in()", async () => {
  const B = tid();
  const artifacts: Row[] = [];
  const reviews: Row[] = [];
  for (let i = 0; i < 400; i++) {
    const t = `t-other-${i % 9}`;
    const id = `pa-${String(i).padStart(4, "0")}`;
    artifacts.push(art(id, t, "email", `p${i}@e.test`));
    reviews.push(review(id, t, "dismissed", "2026-10-01T00:00:00Z"));
  }
  // The LAST review only exists beyond many short pages.
  artifacts.push(art("b-last", B, "email", "p399@e.test"));
  const db = fakeDb({ artifacts, artifact_reviews: reviews }, { maxRows: 37 });
  const rl = await load(db, B);
  assertEquals(rl.crossCase?.rejectedKeys.size, 400, "every review read despite 37-row server clips");
  assertEquals(rl.crossCase?.hiddenInCase, 1);
  assert(Math.max(...db.inSizes) <= CROSS_CASE_IN_CHUNK, "no giant .in() URL");
});

Deno.test("read once per run: repeated loads in one run reuse the index", async () => {
  const { B, db } = caseAB();
  resetCrossCaseMemo();
  await loadReviewsForThread(db.client as unknown as ReviewDb, B, USER);
  const after1 = db.rangeCalls;
  await loadReviewsForThread(db.client as unknown as ReviewDb, B, USER);
  await loadReviewsForThread(db.client as unknown as ReviewDb, B, USER);
  assertEquals(db.rangeCalls, after1, "no further paged reads within the run");
});

Deno.test("/health checks.cross_case_reviews self-test passes", () => {
  const r = crossCaseReviewsSelfTest();
  assertEquals(r.ok, true, r.detail);
});
