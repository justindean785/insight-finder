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

Deno.test("wiring: the read starts behind BOTH switches, BEFORE the intake await, and after the registry is built", () => {
  assertStringIncludes(INDEX, 'from "./lib/memory-brief.ts"');
  const kickoff = INDEX.indexOf("const toolLessonReads = memoryBriefDisabled() || !memoryBriefLegacyRowsEnabled() ? null : loadToolLessons((signal) =>");
  const intake = INDEX.indexOf("const intake = await intakePromise;");
  const registry = INDEX.indexOf("} = buildTools({");
  assert(kickoff > 0 && kickoff < intake, "the read must overlap the intake and review loads");
  assert(registry > 0 && registry < kickoff, "the registry's tool names are a query predicate, so the registry must exist first");
});

Deno.test("wiring: index.ts delegates the query to toolLessonQuery with the registry's subjects, the freshness cutoff and the abort signal", () => {
  const start = INDEX.indexOf("const toolLessonReads");
  const slice = INDEX.slice(start, start + 700);
  assertStringIncludes(slice, "toolLessonQuery(supabase, {");
  assertStringIncludes(slice, "userId,");
  assertStringIncludes(slice, "subjects: registeredToolSubjects(Object.keys(tools), TOOL_NAME_ALIASES)");
  assertStringIncludes(slice, "cutoffIso: freshnessCutoffIso()");
  assertStringIncludes(slice, "signal,");
  assertFalse(/\.like\(/.test(slice), "the prefix LIKE is gone: only registered tool subjects are fetched, so retired tools cannot starve the window");
});

Deno.test("module: the query is the owner's fresh GLOBAL-scope LESSON rows for registered subjects, ordered deterministically, cancellable", () => {
  const start = MODULE.indexOf("export function toolLessonQuery(");
  const slice = MODULE.slice(start, start + 1400);
  assertStringIncludes(slice, '.from("agent_memory")');
  assertStringIncludes(slice, '.eq("user_id", args.userId)');
  assertStringIncludes(slice, '.eq("scope", "global")'); // a case-scoped row must never reach another case
  assertStringIncludes(slice, '.eq("kind", "lesson")');
  assertStringIncludes(slice, '.in("subject", args.subjects)');
  assertStringIncludes(slice, '.gte("created_at", args.cutoffIso)');
  assertStringIncludes(slice, '.order("created_at", { ascending: false })');
  assertStringIncludes(slice, '.order("id", { ascending: true })');
  assertStringIncludes(slice, ".limit(MEMORY_BRIEF_FETCH_LIMIT)");
  assertStringIncludes(slice, ".abortSignal(args.signal)");
  assertFalse(/order\("confidence"/.test(slice), "confidence is a ratchet, never an ordering key");
});

Deno.test("module: the builder never sorts by confidence, hit_count or updated_at", () => {
  const body = MODULE.slice(MODULE.indexOf("export function buildMemoryBrief("), MODULE.indexOf("// ---- loading"));
  assertFalse(/confidence\)|hit_count\)|updated_at/.test(body), "ranking must be created_at desc, id asc only");
});

Deno.test("wiring: the block is built from the registry's own tool names (plus aliases) and appended to intermediateSystem ONLY", () => {
  assertStringIncludes(INDEX, "availableTools: new Set(Object.keys(tools)), aliases: TOOL_NAME_ALIASES");
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
  // Attribution (lesson ids, hashes, invocation id) is a separate approval unit (plan §4.11 / Q8, Q13): the M1
  // build must not carry it. Pinned here so it cannot ride in quietly.
  const observability = MODULE.slice(MODULE.indexOf("// ---- observability"));
  assertFalse(/lesson_ids|sha256|invocation_id|digest/.test(observability), "count-only telemetry in the M1 hardening build");
});

Deno.test("health: the proof key is registered", () => {
  assertStringIncludes(HEALTH, "r.checks.memory_brief = memoryBriefSelfTest();");
});

Deno.test("prompt budget: the block sits after the cached base, which is unchanged by it", () => {
  const base = "BASE PROMPT ".repeat(50);
  const block = buildMemoryBrief({
    rows: [{ id: "x", kind: "lesson", scope: "global", subject: "tool:fofa_search", content: "failed 7 of 7", created_at: new Date().toISOString() }],
    disabled: false,
  }).text;
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
