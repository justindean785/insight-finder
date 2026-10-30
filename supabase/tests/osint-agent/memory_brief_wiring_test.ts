// memory_brief_wiring_test.ts — the tool-lesson brief is only safe if it reaches the model by the one channel
// that leaves the cached base prompt, the finalize prompt and the salvage prompt byte-identical. Source-level
// pins (as next_pivot_wiring_test.ts does) plus the real prompt-budget path.
//
// Source-level reads need --allow-read; without it the file aborts with NotCapable before any assertion runs.
import { assert, assertEquals, assertFalse, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildPerCycleCompactDirective } from "../../functions/osint-agent/orchestrator-finalize.ts";
import { splitCachedSystem } from "../../functions/osint-agent/anthropic-orchestrator.ts";
import { buildMemoryBrief, MEMORY_BRIEF_MAX_CHARS } from "../../functions/osint-agent/lib/memory-brief.ts";

const INDEX = await Deno.readTextFile(new URL("../../functions/osint-agent/index.ts", import.meta.url));
const HEALTH = await Deno.readTextFile(new URL("../../functions/osint-agent/health-handler.ts", import.meta.url));
const MODULE = await Deno.readTextFile(new URL("../../functions/osint-agent/lib/memory-brief.ts", import.meta.url));

Deno.test("wiring: the read starts behind the kill switch, BEFORE the intake await", () => {
  assertStringIncludes(INDEX, 'from "./lib/memory-brief.ts"');
  const kickoff = INDEX.indexOf("const toolLessonReads = memoryBriefDisabled() ? null : loadToolLessons(");
  const intake = INDEX.indexOf("const intake = await intakePromise;");
  assert(kickoff > 0 && kickoff < intake, "the read must overlap the intake and review loads");
});

Deno.test("wiring: the read is the user's own tool: rows only", () => {
  const start = INDEX.indexOf("const toolLessonReads");
  const slice = INDEX.slice(start, start + 700);
  assertStringIncludes(slice, '.from("agent_memory")');
  assertStringIncludes(slice, '.eq("user_id", userId)');
  assertStringIncludes(slice, '.like("subject", `${TOOL_LESSON_PREFIX}%`)');
});

Deno.test("wiring: the block is built from the registry's own tool names and appended to intermediateSystem ONLY", () => {
  assertStringIncludes(INDEX, "availableTools: new Set(Object.keys(tools))");
  assertStringIncludes(INDEX, "baseSystemPrompt + buildPerCycleCompactDirective() + resumeBriefBlock + memoryBriefBlock;");
  const occurrences = INDEX.split("memoryBriefBlock").length - 1;
  // declaration, assignment, and the single append: nothing else may carry it (no finalize/salvage/base path).
  assertEquals(occurrences, 3, "memoryBriefBlock must appear in exactly the declaration, the assignment and the intermediate append");
  const base = INDEX.indexOf("const baseSystemPrompt = assembleBaseSystemPrompt(");
  const decl = INDEX.indexOf("let memoryBriefBlock");
  assert(base > 0 && decl > base, "the block is built AFTER the base prompt, so it cannot leak into it");
});

Deno.test("wiring: the event is a structured count-only log and a failed read never throws into the run", () => {
  assertStringIncludes(INDEX, "memoryBriefEvent(threadId, memOutcome");
  assertFalse(/throw\b/.test(MODULE.slice(MODULE.indexOf("export async function loadToolLessons"), MODULE.indexOf("// ---- observability"))));
});

Deno.test("health: the proof key is registered", () => {
  assertStringIncludes(HEALTH, "r.checks.memory_brief = memoryBriefSelfTest();");
});

Deno.test("prompt budget: the block sits after the cached base, which is unchanged by it", () => {
  const base = "BASE PROMPT ".repeat(50);
  const block = buildMemoryBrief({ rows: [{ subject: "tool:fofa_search", content: "failed 7 of 7", confidence: 80 }] }).text;
  assert(block.length > 0 && block.length <= MEMORY_BRIEF_MAX_CHARS);
  const without = base + buildPerCycleCompactDirective();
  const withBlock = without + `\n\n${block}`;
  assert(withBlock.startsWith(without), "the brief is a pure suffix of the intermediate system");
  const a = splitCachedSystem(without, base);
  const b = splitCachedSystem(withBlock, base);
  assertEquals(JSON.stringify(a[0]), JSON.stringify(b[0]), "the cached prefix block is byte-identical with and without the brief");
  assertEquals(b[0].content, base);
  assert(b[0].providerOptions !== undefined, "the base block keeps its cache breakpoint");
  assertStringIncludes(String(b[1]?.content), "TOOL LESSONS FROM PRIOR RUNS");
});
