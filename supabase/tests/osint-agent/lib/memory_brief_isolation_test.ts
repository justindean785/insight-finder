// memory_brief_isolation_test.ts — BEHAVIOURAL retrieval isolation for the tool-lesson brief (M1 hardening).
//
// memory_brief_wiring_test.ts pins index.ts by reading it as text, which proves the call site exists but not what the
// query admits. This test drives the real query builder (`toolLessonQuery`) against a fake PostgREST chain that
// RECORDS the predicates and APPLIES them to a fixture of two users × {global,case} × {lesson,pattern,identity} ×
// {fresh,stale} × {registered,alias,retired}, then feeds the result to the real `buildMemoryBrief`. Exactly the
// eligible set may reach the model text — and a row that slips past the query (the builder's defence in depth) is
// still dropped.
import { assert, assertEquals, assertFalse, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildMemoryBrief, freshnessCutoffIso, loadToolLessons, registeredToolSubjects, toolLessonQuery,
  MEMORY_BRIEF_FETCH_LIMIT,
} from "../../../functions/osint-agent/lib/memory-brief.ts";

const NOW = Date.parse("2026-10-31T10:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const TOOLS = new Set(["fofa_search", "jina_reader_scrape"]);
const ALIASES = { scrape_url: "jina_reader_scrape" };

type Row = Record<string, unknown>;
let n = 0;
const mk = (user: string, over: Row): Row => ({
  id: `r${++n}`, user_id: user, kind: "lesson", scope: "global", subject: "tool:fofa_search",
  content: `lesson ${n}`, confidence: 50, hit_count: 0, created_at: daysAgo(5), ...over,
});

const FIXTURE: Row[] = [
  mk(A, { content: "A fresh global lesson about fofa" }),                                   // eligible
  mk(A, { subject: "tool:scrape_url", content: "A alias-keyed jina lesson" }),               // eligible via alias
  mk(A, { scope: "case", content: "A case-scoped fofa lesson" }),                            // scope
  mk(A, { kind: "pattern", content: "A pattern filed under the tool" }),                     // kind
  mk(A, { kind: "identity", content: "A identity row" }),                                    // kind
  mk(A, { created_at: daysAgo(120), content: "A stale lesson" }),                           // stale
  mk(A, { subject: "tool:retired_tool", content: "A lesson for a retired tool" }),           // unregistered
  mk(A, { subject: "someone@example.test", content: "A selector memory" }),                 // not this axis
  mk(B, { content: "B fresh global lesson" }),                                               // other user
  mk(B, { scope: "case", content: "B case lesson" }),                                        // other user
];

/** Fake PostgREST chain: records predicates, applies eq/in/gte/order/limit to the fixture on await. */
function fakeDb(rows: Row[]) {
  const calls: Array<[string, unknown[]]> = [];
  let out = rows.slice();
  const chain: Record<string, unknown> = {};
  const rec = (op: string, fn: (...a: unknown[]) => void) => {
    chain[op] = (...a: unknown[]) => { calls.push([op, a]); fn(...a); return chain; };
  };
  rec("select", () => {});
  rec("eq", (k, v) => { out = out.filter((r) => r[k as string] === v); });
  rec("in", (k, list) => { const s = new Set(list as unknown[]); out = out.filter((r) => s.has(r[k as string])); });
  rec("gte", (k, v) => { out = out.filter((r) => String(r[k as string] ?? "") >= String(v)); });
  rec("order", (k, o) => {
    const asc = (o as { ascending?: boolean })?.ascending !== false;
    out = out.slice().sort((x, y) => {
      const a = String(x[k as string] ?? ""), b = String(y[k as string] ?? "");
      return a < b ? (asc ? -1 : 1) : a > b ? (asc ? 1 : -1) : 0;
    });
  });
  rec("limit", (nn) => { out = out.slice(0, nn as number); });
  rec("abortSignal", () => {});
  chain.then = (resolve: (v: unknown) => void) => resolve({ data: out, error: null });
  return { from: (table: string) => { calls.push(["from", [table]]); return chain; }, calls };
}

Deno.test("isolation: the query admits exactly the owner's fresh global lessons for registered (or aliased) tools", async () => {
  const db = fakeDb(FIXTURE);
  const subjects = registeredToolSubjects(TOOLS, ALIASES);
  const load = await loadToolLessons((signal) =>
    toolLessonQuery(db as never, { userId: A, subjects, cutoffIso: freshnessCutoffIso(NOW), signal }));
  assertEquals(load.reason, "ok");
  const contents = load.rows.map((r) => r.content);
  assertEquals(contents.sort(), ["A alias-keyed jina lesson", "A fresh global lesson about fofa"]);

  // The predicates themselves, so a future edit that widens them fails here.
  const ops = db.calls.map(([op, a]) => `${op}:${JSON.stringify(a)}`);
  assert(ops.includes(`from:["agent_memory"]`));
  assert(ops.includes(`eq:["user_id","${A}"]`));
  assert(ops.includes(`eq:["scope","global"]`));
  assert(ops.includes(`eq:["kind","lesson"]`));
  assert(ops.some((o) => o.startsWith(`in:["subject",`)));
  assert(ops.some((o) => o.startsWith(`gte:["created_at",`)));
  assert(ops.includes(`order:["created_at",{"ascending":false}]`));
  assert(ops.includes(`order:["id",{"ascending":true}]`));
  assert(ops.includes(`limit:[${MEMORY_BRIEF_FETCH_LIMIT}]`));
  assert(ops.some((o) => o.startsWith("abortSignal:")));
  assertFalse(ops.some((o) => o.startsWith("order:[\"confidence\"")), "confidence must not order the fetch window");

  const brief = buildMemoryBrief({ rows: load.rows, availableTools: TOOLS, aliases: ALIASES, now: () => NOW, disabled: false });
  assertEquals(brief.stats.injected, 2);
  assertStringIncludes(brief.text, "tool:jina_reader_scrape");
  assertFalse(/B fresh|B case|case-scoped|pattern|identity|stale lesson|retired|selector/.test(bullets(brief.text)));
});

/** Only the rendered lesson lines: the fixed header legitimately says "They may be stale." */
const bullets = (text: string) => text.split("\n").filter((l) => l.startsWith("- ")).join("\n");

Deno.test("isolation: rows that bypass the query are still refused by the builder (defence in depth)", () => {
  // Hand the builder the WHOLE fixture, as if every predicate had been removed from the query.
  const brief = buildMemoryBrief({ rows: FIXTURE as never, availableTools: TOOLS, aliases: ALIASES, now: () => NOW, disabled: false });
  assertEquals(brief.stats.injected, 3, "owner filtering is the query's job (the builder has no user id), everything else is re-checked");
  assertStringIncludes(brief.text, "A fresh global lesson about fofa");
  assertStringIncludes(brief.text, "A alias-keyed jina lesson");
  assertStringIncludes(brief.text, "B fresh global lesson");
  assertFalse(/case|pattern|identity|stale|retired|selector/.test(bullets(brief.text)));
  assertEquals(brief.stats.reasons.scope, 2);
  assertEquals(brief.stats.reasons.kind, 2);
  assertEquals(brief.stats.reasons.stale, 1);
  assertEquals(brief.stats.reasons.unregistered, 1);
});

Deno.test("isolation: a user with no eligible rows gets no block and the event says why", async () => {
  const db = fakeDb(FIXTURE.filter((r) => r.user_id === B));
  const load = await loadToolLessons((signal) =>
    toolLessonQuery(db as never, { userId: A, subjects: registeredToolSubjects(TOOLS, ALIASES), cutoffIso: freshnessCutoffIso(NOW), signal }));
  assertEquals(load.rows.length, 0);
  const brief = buildMemoryBrief({ rows: load.rows, availableTools: TOOLS, now: () => NOW, disabled: false });
  assertEquals(brief.reason, "no_rows");
  assertEquals(brief.text, "");
});
