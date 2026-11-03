import { assert, assertEquals, assertFalse, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  boundedOutcomeRead,
  deriveOutcomeLessonRows,
  OUTCOME_LESSON_WINDOW_DAYS,
  OUTCOME_READ_DEADLINE_MS,
  outcomeLessonCutoffIso,
  outcomeLessonsSelfTest,
  type OutcomeLessonRead,
  type OutcomeUsageRow,
} from "../../../functions/osint-agent/lib/outcome-lessons.ts";
import { buildMemoryBrief, loadToolLessons } from "../../../functions/osint-agent/lib/memory-brief.ts";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const recent = (over: Partial<OutcomeUsageRow> = {}): OutcomeUsageRow => ({
  tool_name: "source_a",
  outcome: "failed",
  cached: false,
  status_code: 503,
  error_msg: "private upstream detail must not enter the prompt",
  thread_id: "case-1",
  created_at: new Date(NOW - 86_400_000).toISOString(),
  ...over,
});
const failingRows = (): OutcomeUsageRow[] => [
  recent({ thread_id: "case-1" }),
  recent({ thread_id: "case-2" }),
  recent({ thread_id: "case-1" }),
  recent({ thread_id: "case-2" }),
  recent({ thread_id: "case-1" }),
  recent({ thread_id: "case-2", outcome: "ok", status_code: null, error_msg: null }),
];

Deno.test("outcome lessons: repeated cross-case failures become fresh global tool lessons", () => {
  const rows = deriveOutcomeLessonRows(failingRows(), NOW);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].subject, "tool:source_a");
  assertEquals(rows[0].kind, "lesson");
  assertEquals(rows[0].scope, "global");
  assertStringIncludes(rows[0].content, "5 of 6 live attempts");
  assertStringIncludes(rows[0].content, "across 2 cases");
  assertStringIncludes(rows[0].content, "one later retry");
  assertStringIncludes(rows[0].content, "independent source");
  assertFalse(rows[0].content.includes("private upstream"));
  assertFalse(rows[0].content.includes("case-1"));
});

Deno.test("outcome lessons: derived rows enter the existing run-start planner brief as context only", () => {
  const derived = deriveOutcomeLessonRows(failingRows(), NOW);
  const brief = buildMemoryBrief({
    rows: derived,
    availableTools: new Set(["source_a"]),
    now: () => NOW,
    disabled: false,
  });
  assertEquals(brief.reason, "injected");
  assertStringIncludes(brief.text, "TOOL LESSONS FROM PRIOR RUNS (context, not evidence)");
  assertStringIncludes(brief.text, "tool:source_a");
  assertStringIncludes(brief.text, "Next run:");
  assertStringIncludes(brief.text, "never what a finding means");
});

Deno.test("outcome lessons: recovery retires the adaptation instead of leaving a stale global rule", () => {
  const before = deriveOutcomeLessonRows(failingRows(), NOW);
  const recovered = [
    ...failingRows(),
    ...Array.from({ length: 8 }, (_, i) => recent({
      outcome: "ok",
      status_code: null,
      error_msg: null,
      thread_id: `recovery-${i % 2}`,
    })),
  ];
  const after = deriveOutcomeLessonRows(recovered, NOW);
  assertEquals(before.length, 1);
  assertEquals(after, []);
});

Deno.test("outcome lessons: one case, cached calls, skips, empties and old rows teach nothing", () => {
  const oneCase = Array.from({ length: 8 }, () => recent({ thread_id: "only" }));
  assertEquals(deriveOutcomeLessonRows(oneCase, NOW), []);
  assertEquals(deriveOutcomeLessonRows(failingRows().map((r) => ({ ...r, cached: true })), NOW), []);
  assertEquals(deriveOutcomeLessonRows(failingRows().map((r) => ({ ...r, outcome: "skipped" })), NOW), []);
  assertEquals(deriveOutcomeLessonRows(failingRows().map((r) => ({ ...r, outcome: "empty" })), NOW), []);
  const old = new Date(NOW - (OUTCOME_LESSON_WINDOW_DAYS + 1) * 86_400_000).toISOString();
  assertEquals(deriveOutcomeLessonRows(failingRows().map((r) => ({ ...r, created_at: old })), NOW), []);
});

Deno.test("outcome lessons: the cross-case threshold counts cases that FAILED, not cases that merely ran", () => {
  // Five failures in one case plus one success in another: 5/6 fail and two cases appear in the window,
  // but the failures are one case's problem. Teaching every other investigation to avoid the tool from
  // that would be a case-specific fault leaking into global planning.
  const confined = [
    ...Array.from({ length: 5 }, () => recent({ thread_id: "case-1" })),
    recent({ thread_id: "case-2", outcome: "ok", status_code: null, error_msg: null }),
  ];
  assertEquals(deriveOutcomeLessonRows(confined, NOW), []);
});

Deno.test("outcome lessons: the case count in the lesson text is the failing-case count", () => {
  const rows = [
    recent({ thread_id: "case-1" }),
    recent({ thread_id: "case-1" }),
    recent({ thread_id: "case-1" }),
    recent({ thread_id: "case-2" }),
    recent({ thread_id: "case-2" }),
    ...["case-3", "case-4", "case-5"].map((thread_id) => recent({ thread_id, outcome: "ok", status_code: null, error_msg: null })),
  ];
  const [lesson] = deriveOutcomeLessonRows(rows, NOW);
  assertStringIncludes(lesson.content, "5 of 8 live attempts");
  assertStringIncludes(lesson.content, "across 2 cases");
  assertFalse(lesson.content.includes("across 5 cases"));
});

Deno.test("outcome lessons: refusal adaptation does not declare a key dead and input failures demand repair", () => {
  const refusals = failingRows().map((r, i) => i < 5 ? { ...r, status_code: 403, error_msg: "forbidden" } : r);
  const refusal = deriveOutcomeLessonRows(refusals, NOW)[0];
  assertStringIncludes(refusal.content, "plan, permissions and provider policy");
  assertFalse(/dead credential|key is dead/i.test(refusal.content));
  const rejected = failingRows().map((r, i) => i < 5 ? { ...r, status_code: 400, error_msg: "invalid input" } : r);
  assertStringIncludes(deriveOutcomeLessonRows(rejected, NOW)[0].content, "validate the selector and schema");
});

Deno.test("outcome lessons: cutoff is exact and deterministic ordering does not depend on input order", () => {
  assertEquals(outcomeLessonCutoffIso(NOW), new Date(NOW - OUTCOME_LESSON_WINDOW_DAYS * 86_400_000).toISOString());
  const other = failingRows().map((r) => ({ ...r, tool_name: "source_b" }));
  const a = deriveOutcomeLessonRows([...failingRows(), ...other], NOW);
  const b = deriveOutcomeLessonRows([...other, ...failingRows()].reverse(), NOW);
  assertEquals(a, b);
  assertEquals(a.map((r) => r.subject), ["tool:source_a", "tool:source_b"]);
});

Deno.test("outcome lessons: health self-test proves the threshold and context-only behavior", () => {
  const check = outcomeLessonsSelfTest();
  assert(check.ok);
  assertStringIncludes(check.detail, "14-day");
  assertStringIncludes(check.detail, "context only");
});

// A PostgREST-shaped chain whose terminal `abortSignal` hands the signal to `read`.
function stubDb(read: (signal: AbortSignal) => PromiseLike<OutcomeLessonRead>) {
  const chain: Record<string, (...args: unknown[]) => unknown> = {};
  for (const m of ["eq", "gte", "order", "limit"]) chain[m] = () => chain;
  chain.abortSignal = (s: unknown) => read(s as AbortSignal);
  return { from: () => ({ select: () => chain }) };
}
const queryArgs = (signal: AbortSignal) => ({ userId: "u", cutoffIso: outcomeLessonCutoffIso(NOW), signal });
const hangs = (signal: AbortSignal) => new Promise<OutcomeLessonRead>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));

Deno.test("outcome lessons: a hanging outcome read settles as 'no derived rows' inside its own deadline and aborts the query", async () => {
  let seen: AbortSignal | undefined;
  const res = await boundedOutcomeRead(stubDb((s) => { seen = s; return hangs(s); }), queryArgs(new AbortController().signal), 15);
  assertEquals(res.data, null);
  assertEquals(res.error?.message, "outcome_read_deadline");
  assert(seen?.aborted, "the deadline must abort the underlying query, not just stop waiting for it");
});

Deno.test("outcome lessons: a throwing outcome read and the shared abort both resolve instead of rejecting", async () => {
  const thrown = await boundedOutcomeRead(stubDb(() => Promise.reject(new Error("boom"))), queryArgs(new AbortController().signal), 50);
  assertEquals(thrown, { data: null, error: { message: "outcome_read_failed" } });
  const shared = new AbortController();
  let inner: AbortSignal | undefined;
  const pending = boundedOutcomeRead(stubDb((s) => { inner = s; return hangs(s); }), queryArgs(shared.signal), 5_000);
  shared.abort();
  assertEquals((await pending).data, null);
  assert(inner?.aborted);
});

Deno.test("outcome lessons: a slow outcome read cannot discard stored lessons that already loaded", async () => {
  // The same shape index.ts builds: stored + outcome reads under ONE shared deadline. Unbounded, the outcome
  // read outlives the shared deadline, the race resolves empty, and the stored lessons are lost with it.
  const stored = { id: "s1", kind: "lesson", scope: "global", subject: "tool:source_a", content: "stored lesson", confidence: null, hit_count: 0, created_at: new Date(NOW).toISOString() };
  const wiring = (outcome: (signal: AbortSignal) => PromiseLike<OutcomeLessonRead>) => (signal: AbortSignal) =>
    Promise.all([
      Promise.resolve({ data: [stored], error: null }),
      boundedOutcomeRead(stubDb(outcome), queryArgs(signal), 20),
    ]).then(([s, o]) => ({ data: [...(s.data ?? []), ...deriveOutcomeLessonRows(o.data ?? [], NOW)], error: s.error }));
  const load = await loadToolLessons(wiring(hangs), { deadlineMs: 200 });
  assertEquals(load.reason, "ok");
  assertEquals(load.rows.map((r) => r.id), ["s1"]);
});

Deno.test("outcome lessons: the outcome deadline is shorter than the shared memory-brief read deadline, and index.ts uses the bounded read", async () => {
  assert(OUTCOME_READ_DEADLINE_MS < 2500, "must settle before memory-brief's shared 2500 ms race resolves empty");
  const index = await Deno.readTextFile(new URL("../../../functions/osint-agent/index.ts", import.meta.url));
  assertStringIncludes(index, "boundedOutcomeRead(supabase,");
  assertFalse(index.includes("toolOutcomeQuery("), "index.ts must not call the unbounded outcome query directly");
});

Deno.test("outcome lessons: health handler registers the behavioral proof key", async () => {
  const source = await Deno.readTextFile(new URL("../../../functions/osint-agent/health-handler.ts", import.meta.url));
  assertStringIncludes(source, 'import { outcomeLessonsSelfTest } from "./lib/outcome-lessons.ts";');
  assertStringIncludes(source, "r.checks.outcome_lessons = outcomeLessonsSelfTest();");
});
