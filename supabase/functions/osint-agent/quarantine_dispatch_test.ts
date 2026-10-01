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
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { Tool } from "npm:ai@6";
import type { createClient } from "npm:@supabase/supabase-js@2";
import { wrapToolsWithCache, isIntentionalSkip, deriveOk } from "./cache.ts";
import { clearRuntime } from "./runtime-policy.ts";
import * as circuit from "./circuit.ts";
import { dispatchKey, quarantineRefusal, isDispatchRefused, dispatchTypeCandidates, DISPATCH_REFUSAL_ERROR } from "./lib/dispatch-quarantine.ts";
import { UNPROVEN_LINKAGE_KEY } from "./lib/unproven-linkage.ts";

type SupabaseClient = ReturnType<typeof createClient>;

const QUARANTINED_USER = "jordan.vale";
const CLEAN_USER = "nightjar";

/**
 * A PostgREST-shaped chain. `range(from, to)` slices, and every ranged resolution
 * carries `count` — the TRUE unpaged total — because that is what the real API
 * returns under `{ count: "exact" }` and what lets a paged reader know when it is
 * done. A fake that ignored `.range()` could not express a truncated read at all,
 * which is precisely the defect the paging tests below exist to catch.
 */
function makeChain(resolveValue: { data: unknown; error: unknown }): Record<string, unknown> {
  const node: Record<string, unknown> = {};
  for (const m of ["select", "eq", "in", "order", "update", "limit"]) node[m] = () => node;
  const all = Array.isArray(resolveValue.data) ? resolveValue.data as unknown[] : null;
  const slice = (from: number, to: number) =>
    all === null
      ? resolveValue
      : { data: all.slice(from, to + 1), count: all.length, error: resolveValue.error };
  node.range = (from: number, to: number) => {
    const v = slice(from, to);
    return { then: (r: (x: unknown) => void) => r(v) };
  };
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
  // STRUCTURED fields, not the message. This assertion used to require the selector
  // to appear INSIDE `error`, which is the interpolation that let target-controlled
  // text steer `isIntentionalSkip` — the test encoded the defect. The payload is no
  // less auditable: tool, type and value are all still on it, in fields no
  // classifier reads.
  const r = quarantineRefusal("breach_check", "username", QUARANTINED_USER) as Record<string, unknown>;
  assertEquals(r.tool, "breach_check");
  assertEquals(r.selector_type, "username");
  assertEquals(r.selector, QUARANTINED_USER);
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

// ── the dispatch paths: RUN, and taint what comes back ────────────────────────
//
// These four used to assert `calls.n === 0`. Since the 2026-09-12 switch to
// PROMOTION quarantine the lookup is allowed — refusing it left person-seed
// runs structurally unable to test the link they were investigating — and the
// property that replaces "never runs" is "never promotes". Each case therefore
// asserts BOTH halves: the tool ran, AND the result carries the taint that
// stops anything it found from inheriting subject authority.

/** The unproven-linkage marker the wrapper must attach, or null. */
function taintOf(out: unknown): Record<string, unknown> | null {
  const runtime = (out as Record<string, unknown>)?._runtime as Record<string, unknown> | undefined;
  const raw = runtime?.[UNPROVEN_LINKAGE_KEY];
  return raw && typeof raw === "object" ? raw as Record<string, unknown> : null;
}

Deno.test("DIRECT call on a quarantined selector RUNS, and its result is tainted", async () => {
  const calls = { n: 0 };
  const tools = wrap(calls);
  const out = await (tools.breach_check as { execute: (i: unknown, o: unknown) => Promise<unknown> })
    .execute({ type: "username", value: QUARANTINED_USER }, {});
  assertEquals(calls.n, 1, "the lookup must happen — that is the point of the switch");
  assertEquals((out as Record<string, unknown>).ok, true);
  const taint = taintOf(out);
  assert(taint, "a permitted quarantined dispatch MUST carry the unproven-linkage marker");
  assertEquals(taint.parent_type, "username");
  assertEquals(taint.parent_value, QUARANTINED_USER);
  assertEquals(taint.parent_reason, "name-only echo", "the parent's own reason must travel with it");
});

Deno.test("REPEATED calls stay tainted — the marker is not a first-call-only flag", async () => {
  const calls = { n: 0 };
  const tools = wrap(calls);
  const ex = (tools.breach_check as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute;
  for (let i = 0; i < 3; i += 1) {
    const out = await ex({ type: "username", value: QUARANTINED_USER }, {});
    assert(taintOf(out), `call ${i + 1} lost the taint — a cached replay must not come back clean`);
  }
});

Deno.test("a PIVOTED selector (same value, different param) runs and is tainted", async () => {
  const calls = { n: 0 };
  const tools = wrap(calls);
  const out = await (tools.breach_check as { execute: (i: unknown, o: unknown) => Promise<unknown> })
    .execute({ username: QUARANTINED_USER }, {});
  assertEquals(calls.n, 1);
  assert(taintOf(out), "arriving under a different param must not shed the taint");
});

Deno.test("a PAID tool now DOES consume budget — the accepted cost of the switch", async () => {
  // Stated plainly rather than left implicit: allowing the lookup means paying
  // for it. The spend is bounded by the ordinary paid-call cap, not by this
  // boundary, and the run gets something testable for the money.
  const calls = { n: 0 };
  const budget = { genuine: 0, reserved: 0, capped: false };
  const tools = wrap(calls, undefined, { toolCallBudget: budget });
  const out = await (tools.breach_check as { execute: (i: unknown, o: unknown) => Promise<unknown> })
    .execute({ type: "username", value: QUARANTINED_USER }, {});
  assertEquals(calls.n, 1);
  assert(taintOf(out), "spending on it does not buy it authority");
});

// ── the KILL SWITCH restores the old boundary, with no deploy ─────────────────
Deno.test("PROMOTION_QUARANTINE_DISABLED=true restores the pre-2026-09-12 refusal", async () => {
  Deno.env.set("PROMOTION_QUARANTINE_DISABLED", "true");
  try {
    const calls = { n: 0 };
    const tools = wrap(calls);
    const out = await (tools.breach_check as { execute: (i: unknown, o: unknown) => Promise<unknown> })
      .execute({ type: "username", value: QUARANTINED_USER }, {});
    assertEquals(calls.n, 0, "with the switch off the tool must not run");
    assertEquals((out as Record<string, unknown>).ok, false);
    assertEquals(taintOf(out), null, "a refusal is not a tainted result");
  } finally {
    Deno.env.delete("PROMOTION_QUARANTINE_DISABLED");
  }
});

Deno.test("the switch is read at CALL time, so flipping it needs no redeploy", async () => {
  const calls = { n: 0 };
  const tools = wrap(calls);
  const ex = (tools.breach_check as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute;
  Deno.env.set("PROMOTION_QUARANTINE_DISABLED", "true");
  try {
    await ex({ type: "username", value: QUARANTINED_USER }, {});
    assertEquals(calls.n, 0);
  } finally {
    Deno.env.delete("PROMOTION_QUARANTINE_DISABLED");
  }
  const tools2 = wrap(calls);
  await (tools2.breach_check as { execute: (i: unknown, o: unknown) => Promise<unknown> })
    .execute({ type: "username", value: QUARANTINED_USER }, {});
  assertEquals(calls.n, 1, "clearing the secret must re-enable dispatch on the same running build");
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

Deno.test("`force` cannot buy AUTHORITY — it runs either way, and stays tainted", async () => {
  // `force` used to be the escape this boundary existed to close. Under
  // promotion quarantine the lookup happens regardless, so `force` no longer
  // decides anything about dispatch — and crucially it must not become a way
  // to shed the taint instead. Clearing quarantine is a linkage decision on
  // the artifact (`linkage_confirmed`), never a call-site flag.
  const calls = { n: 0 };
  const tools = wrap(calls);
  const out = await (tools.breach_check as { execute: (i: unknown, o: unknown) => Promise<unknown> })
    .execute({ type: "username", value: QUARANTINED_USER, force: true }, {});
  assertEquals(calls.n, 1);
  assert(taintOf(out), "force must not strip the unproven-linkage marker");
});

// ── the PostgREST row cap: the boundary must read the WHOLE thread ────────────
//
// `loadRefusedKeys` issued ONE unbounded `.select().eq()`. PostgREST answers such
// a request with at most `db-max-rows` rows and reports NO error — the response is
// a well-formed 200 that is simply short. So on a thread longer than that cap the
// refused-key set was silently built from a PREFIX of the thread, and every
// quarantined selector past it dispatched normally: the dispatch boundary
// reopened, quietly, exactly on the biggest threads (the ones a name-only harvest
// produces, which is the case this boundary exists for).
//
// The fake below models the cap the way the server actually applies it: it honours
// `.range()`, and it truncates ANY window — ranged or not — to SERVER_MAX_ROWS,
// returning `count` as the true unpaged total. That is the whole defect in one
// object; a fake that returned every row could not express it.

const SERVER_MAX_ROWS = 1000;

/** A quarantined username parked at `at`, padded to `size` rows of filler. */
function pagedArtifactRows(size: number, at: number): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let i = 0; i < size; i += 1) {
    rows.push(
      i === at
        ? {
          id: `q-${i}`, kind: "username", value: QUARANTINED_USER, confidence: 65,
          source: "minimax_web_search",
          metadata: { subject_unlinked: true, subject_unlinked_reason: "name-only echo" },
        }
        : { id: `f-${i}`, kind: "email", value: `filler${i}@example.test`, confidence: 90, source: "hibp", metadata: {} },
    );
  }
  return rows;
}

/**
 * A PostgREST-shaped `artifacts` table that enforces a server row cap.
 *
 * `calls` records only the RANGED windows. The quarantine loader is the one reader
 * that pages; the wrapper's other artifact reads (`loadSelectorEvidence`, the cache
 * write path) await the chain unranged, and counting those made a bounded-retry
 * assertion read 11 where 3 was correct — a test measuring the wrong thing. Those
 * reads are answered healthily and off the books so a test can isolate this loader.
 */
function pagingSupabase(
  allRows: Array<Record<string, unknown>>,
  calls: Array<{ from: number; to: number }>,
  opts?: { failFromPage?: number; serverMax?: number },
): SupabaseClient {
  const cap = opts?.serverMax ?? SERVER_MAX_ROWS;
  const makeTable = () => {
    const node: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "order", "update", "limit"]) node[m] = () => node;
    const window = (from: number, to: number) => ({
      data: allRows.slice(from, to + 1).slice(0, cap),
      count: allRows.length,
      error: null,
    });
    node.range = (from: number, to: number) => {
      calls.push({ from, to });
      const v = opts?.failFromPage !== undefined && calls.length > opts.failFromPage
        ? { data: null, count: null, error: { message: "simulated page failure" } }
        : window(from, to);
      return { then: (r: (x: unknown) => void) => r(v) };
    };
    node.maybeSingle = () => Promise.resolve(window(0, allRows.length - 1));
    // An UNRANGED await is the pre-fix shape. The server still applies the cap,
    // which is exactly why the single-shot read could not see past it.
    node.then = (r: (x: unknown) => void) => r(window(0, allRows.length - 1));
    node.insert = () => Promise.resolve({ error: null });
    node.upsert = () => Promise.resolve({ error: null });
    return node;
  };
  const artifacts = makeTable();
  const inert = makeChain({ data: [], error: null });
  inert.insert = () => Promise.resolve({ error: null });
  inert.upsert = () => Promise.resolve({ error: null });
  (inert as Record<string, unknown>).range = () => inert;
  return {
    from: (t: string) => (t === "artifacts" ? artifacts : inert),
    rpc: () => Promise.resolve({ data: null, error: null }),
  } as unknown as SupabaseClient;
}

Deno.test("a quarantined selector BEYOND the server row cap is still refused", async () => {
  // The row sits at index 1150 of 1200 — past PostgREST's cap, so the pre-fix
  // single-shot read never saw it.
  const calls = { n: 0 };
  const windows: Array<{ from: number; to: number }> = [];
  const db = pagingSupabase(pagedArtifactRows(1200, 1150), windows);
  const tools = wrap(calls, db);
  const out = await (tools.breach_check as { execute: (i: unknown, o: unknown) => Promise<unknown> })
    .execute({ type: "username", value: QUARANTINED_USER }, {}) as Record<string, unknown>;
  // Assert the TAINT specifically, not merely that the call ran. Under promotion
  // quarantine the paging failure mode INVERTED and got worse: an incomplete read
  // used to mean "failed to refuse", and now means "failed to taint" — the result
  // comes back clean and PROMOTES. So this is the assertion that matters.
  assert(taintOf(out), "a row past the cap must still be found, or its results silently promote");
  assertEquals(taintOf(out)!.parent_value, QUARANTINED_USER);
  assertEquals(calls.n, 1, "the lookup itself is allowed");
  assert(windows.length >= 2, `the read must page past the cap — windows requested: ${JSON.stringify(windows)}`);
});

Deno.test("the paging fake still dispatches a CLEAN selector — a refusal above is a refusal, not a stuck harness", async () => {
  // The control for the test above. Same thread size, same fake, same wrapper: if
  // this one runs, then `calls.n === 0` there is the boundary and not leaked
  // circuit/runtime state or an exhausted budget.
  const calls = { n: 0 };
  const db = pagingSupabase(pagedArtifactRows(1200, 1150), []);
  const tools = wrap(calls, db);
  const out = await (tools.breach_check as { execute: (i: unknown, o: unknown) => Promise<unknown> })
    .execute({ type: "username", value: CLEAN_USER }, {}) as Record<string, unknown>;
  assertEquals(calls.n, 1, "an unquarantined selector must still dispatch");
  assertEquals(out.ok, true);
});

Deno.test("the read advances by rows RETURNED, not by the window it asked for", async () => {
  // The cap PostgREST applies is container config, not a database setting — it is
  // not readable from the edge function, so no constant can be trusted to match it.
  // Here the server trims every window to 250 while the reader asks for 1000. A loop
  // that advanced by its REQUESTED size would jump 0-249 → 1000-1199 and never read
  // rows 250-999, where this quarantined row sits. Advancing by rows actually
  // returned makes the scan correct for any cap, including one changed later.
  const calls = { n: 0 };
  const windows: Array<{ from: number; to: number }> = [];
  const db = pagingSupabase(pagedArtifactRows(1200, 500), windows, { serverMax: 250 });
  const tools = wrap(calls, db);
  const out = await (tools.breach_check as { execute: (i: unknown, o: unknown) => Promise<unknown> })
    .execute({ type: "username", value: QUARANTINED_USER }, {}) as Record<string, unknown>;
  assert(taintOf(out), "a row in the trimmed region must still be found");
  assertEquals(calls.n, 1);
  assert(
    windows.some((w) => w.from > 0 && w.from < 1000),
    `the scan must resume inside the trimmed region — windows: ${JSON.stringify(windows)}`,
  );
});

Deno.test("a COMPLETE read is loaded once and reused for the whole run", async () => {
  // The boundary runs ahead of every tool call. Re-reading the thread each time
  // would put a query in front of ~89 tools; the memo is what keeps it at one read.
  const calls = { n: 0 };
  const windows: Array<{ from: number; to: number }> = [];
  const db = pagingSupabase(pagedArtifactRows(1200, 1150), windows);
  const tools = wrap(calls, db);
  const ex = (tools.breach_check as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute;
  for (let i = 0; i < 5; i += 1) {
    const o = await ex({ type: "username", value: QUARANTINED_USER }, {});
    assert(taintOf(o), "every one of the five must stay tainted");
  }
  const afterFirst = windows.length;
  assert(afterFirst <= 2, `1200 rows behind a 1000-row cap is two pages, got ${afterFirst}`);
  await ex({ type: "username", value: QUARANTINED_USER }, {});
  assertEquals(windows.length, afterFirst, "a completed read must not be re-issued");
});

Deno.test("a PARTIAL read still refuses everything it did see", async () => {
  // Page one succeeds and carries the quarantined row; page two fails. The keys in
  // hand are sound — a key present is a genuine quarantine — so the boundary must
  // still bind on them rather than discarding the whole read.
  const calls = { n: 0 };
  const windows: Array<{ from: number; to: number }> = [];
  const db = pagingSupabase(pagedArtifactRows(1200, 5), windows, { failFromPage: 1 });
  const tools = wrap(calls, db);
  const out = await (tools.breach_check as { execute: (i: unknown, o: unknown) => Promise<unknown> })
    .execute({ type: "username", value: QUARANTINED_USER }, {}) as Record<string, unknown>;
  assert(taintOf(out), "everything the partial read DID see must still be tainted");
});

Deno.test("an INCOMPLETE read is not cached, and the retry is bounded", async () => {
  // Two properties in one test because they trade off against each other. Caching a
  // partial answer freezes an open boundary for the rest of the run; retrying without
  // a bound puts a failing query in front of every one of ~89 tools. The memo is
  // therefore cleared only while attempts remain, and the last attempt sticks.
  const calls = { n: 0 };
  const windows: Array<{ from: number; to: number }> = [];
  const db = pagingSupabase(pagedArtifactRows(1200, 1150), windows, { failFromPage: 0 });
  const tools = wrap(calls, db);
  const ex = (tools.breach_check as { execute: (i: unknown, o: unknown) => Promise<unknown> }).execute;
  for (let i = 0; i < 8; i += 1) await ex({ type: "email", value: `probe${i}@example.test` }, {});
  assertEquals(
    windows.length,
    3,
    `every page failed, so the run must retry twice and then settle — got ${windows.length} reads`,
  );
  assertEquals(calls.n, 8, "a failed read must not refuse unrelated selectors — this boundary fails OPEN");
});

// ── the refusal message must be inert to the skip classifier ──────────────────
//
// `deriveOk` asks `isIntentionalSkip` BEFORE it reads `ok`, and `isIntentionalSkip`
// regex-matches the joined text of `error`, `note`, `reason` and `detail`. The first
// build interpolated the classifier-written `subject_unlinked_reason` AND the
// target-controlled selector into `error`. Either one carrying "gated", "not
// configured" or "unavailable: disabled" flipped the refusal to ok=true and deleted
// it from the failure metric — the `dork_harvest(completed)` failure, reproduced.

const SKIP_VOCABULARY = [
  "name-only echo — provider disabled in config",
  "gated behind a paywall",
  "unavailable: missing_key",
  "unavailable: disabled",
  "the source was not configured for this subject",
  "GATED",
  "unavailable:   gated",
];

Deno.test("no quarantine reason, however phrased, can make a refusal read as ok", () => {
  for (const reason of SKIP_VOCABULARY) {
    const r = quarantineRefusal("breach_check", "username", QUARANTINED_USER, reason) as Record<string, unknown>;
    assertEquals(deriveOk(r), false, `deriveOk must stay false for reason: ${reason}`);
    assertEquals(isIntentionalSkip(r), false, `must not read as a skip for reason: ${reason}`);
    assertEquals(r.skipped, undefined, "a refusal is never a skip");
    assertEquals(r.dropped, undefined, "a refusal is never the unknown-tool sink");
    assertEquals(r.ok, false);
  }
});

Deno.test("no SELECTOR value, however spelled, can make a refusal read as ok", () => {
  // The selector is target-controlled: a domain literally named `gated.com` matches
  // `\bgated\b`, and a normalized name can spell "not configured".
  for (const selector of ["gated.com", "not configured", "unavailable: disabled", "gated"]) {
    const r = quarantineRefusal("breach_check", "domain", selector, null) as Record<string, unknown>;
    assertEquals(deriveOk(r), false, `deriveOk must stay false for selector: ${selector}`);
    assertEquals(isIntentionalSkip(r), false, `must not read as a skip for selector: ${selector}`);
  }
});

Deno.test("the refusal message is a CONSTANT — the reason survives as structured metadata", () => {
  // Not "the message avoids the vocabulary" but "the message is not built from
  // caller input at all". A scrub would be a filter to keep in step with a regex in
  // another module; a constant cannot drift.
  const a = quarantineRefusal("breach_check", "username", QUARANTINED_USER, "name-only echo") as Record<string, unknown>;
  const b = quarantineRefusal("oathnet_lookup", "domain", "gated.com", "gated") as Record<string, unknown>;
  assertEquals(a.error, DISPATCH_REFUSAL_ERROR);
  assertEquals(b.error, DISPATCH_REFUSAL_ERROR);
  assertEquals(a.error, b.error, "the message must not vary with the selector or the reason");
  // The reason is preserved — just nowhere isIntentionalSkip reads.
  assertEquals(a.quarantine_reason, "name-only echo");
  assertEquals(b.quarantine_reason, "gated");
  assertEquals(a.reason, undefined, "`reason` is one of the four fields the classifier joins");
  assertEquals(a.note, undefined);
  assertEquals(a.detail, undefined);
});

Deno.test("KILL-SWITCH path: a refusal carrying a skip-shaped reason still logs as ok:false", async () => {
  // #519's hardening, preserved for the path where refusals still happen. Under
  // promotion quarantine this selector is dispatched, so the end-to-end refusal
  // now only exists behind the kill switch — and it must keep the property that
  // a caller-controlled reason cannot make a refusal vanish from the failure
  // metric. Deleting this with the boundary would have quietly retired #519.
  Deno.env.set("PROMOTION_QUARANTINE_DISABLED", "true");
  try {
    const rows = [{
      id: "a1", kind: "username", value: QUARANTINED_USER, confidence: 65, source: "minimax_web_search",
      metadata: { subject_unlinked: true, subject_unlinked_reason: "unavailable: gated — provider disabled in config" },
    }];
    const calls = { n: 0 };
    const tools = wrap(calls, fakeSupabase(rows));
    const out = await (tools.breach_check as { execute: (i: unknown, o: unknown) => Promise<unknown> })
      .execute({ type: "username", value: QUARANTINED_USER }, {});
    assertEquals(calls.n, 0);
    assertEquals(deriveOk(out), false, "the shipped payload must log as a failure, not a no-op");
    assertEquals((out as Record<string, unknown>).quarantine_reason, "unavailable: gated — provider disabled in config");
  } finally {
    Deno.env.delete("PROMOTION_QUARANTINE_DISABLED");
  }
});
