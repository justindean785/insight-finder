import { assert, assertEquals, assertFalse, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  deriveOutcomeLessonRows,
  OUTCOME_LESSON_WINDOW_DAYS,
  outcomeLessonCutoffIso,
  outcomeLessonsSelfTest,
  type OutcomeUsageRow,
} from "../../../functions/osint-agent/lib/outcome-lessons.ts";
import { buildMemoryBrief } from "../../../functions/osint-agent/lib/memory-brief.ts";

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

Deno.test("outcome lessons: health handler registers the behavioral proof key", async () => {
  const source = await Deno.readTextFile(new URL("../../../functions/osint-agent/health-handler.ts", import.meta.url));
  assertStringIncludes(source, 'import { outcomeLessonsSelfTest } from "./lib/outcome-lessons.ts";');
  assertStringIncludes(source, "r.checks.outcome_lessons = outcomeLessonsSelfTest();");
});
