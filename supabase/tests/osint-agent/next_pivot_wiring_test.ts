// next_pivot_wiring_test.ts — the RESUME BRIEF is only worth shipping if it reaches the model by the one
// channel that is safe, and nowhere else. These tests pin the WIRING (source level, as reviews_wiring_test.ts
// does) and the PROMPT BUDGET (through the real capTotalToBudget and the real cache split).
//
// Source-level reads need --allow-read; without it the file aborts with NotCapable before any assertion runs.
import { assert, assertEquals, assertFalse, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { ModelMessage } from "npm:ai@6";
import {
  approxMsgChars, capTotalToBudget, RECENT_WINDOW, TOTAL_PROMPT_CHAR_BUDGET,
} from "../../functions/osint-agent/orchestrator-budget.ts";
import { buildPerCycleCompactDirective } from "../../functions/osint-agent/orchestrator-finalize.ts";
import { splitCachedSystem } from "../../functions/osint-agent/anthropic-orchestrator.ts";
import { measurePromptTerms } from "../../functions/osint-agent/prompt-size.ts";
import { emptyReviewLoad } from "../../functions/osint-agent/reviews.ts";
import {
  buildResumeBrief, NEXT_PIVOT_BRIEF_MAX_CHARS, type BriefArtifact,
} from "../../functions/osint-agent/lib/next-pivot.ts";

const INDEX = await Deno.readTextFile(new URL("../../functions/osint-agent/index.ts", import.meta.url));
const HEALTH = await Deno.readTextFile(new URL("../../functions/osint-agent/health-handler.ts", import.meta.url));
const MODULE = await Deno.readTextFile(new URL("../../functions/osint-agent/lib/next-pivot.ts", import.meta.url));

/** The text between two anchors in index.ts, failing loudly when an anchor has moved. */
function between(src: string, from: string, to: string): string {
  const a = src.indexOf(from);
  assert(a >= 0, `anchor not found: ${from}`);
  const b = src.indexOf(to, a + from.length);
  assert(b > a, `anchor not found after start: ${to}`);
  return src.slice(a, b);
}

// ---- wiring ------------------------------------------------------------------------------------

Deno.test("wiring: the reads start behind the kill switch, BEFORE the intake await, and the brief is built from the loaded verdicts", () => {
  assertStringIncludes(INDEX, 'from "./lib/next-pivot.ts"');
  const kickoff = INDEX.indexOf("const resumeBriefReads = nextPivotBriefDisabled() || !hasPriorAssistantMessage ? null : loadBriefInputs(");
  const intake = INDEX.indexOf("const intake = await intakePromise;");
  const reviews = INDEX.indexOf("const turnReviews = await loadReviewsForThread(");
  const build = INDEX.indexOf("const briefOutcome = buildResumeBrief({");
  assert(kickoff > 0 && kickoff < intake, "reads must overlap the intake and review loads");
  assert(intake < reviews && reviews < build, "the brief is built after the verdicts are loaded");
  assertStringIncludes(between(INDEX, "const briefOutcome = buildResumeBrief({", "console.log(JSON.stringify(nextPivotBriefEvent("), "reviews: turnReviews");
});

Deno.test("wiring: the block rides ONLY on intermediateSystem, after the cached base and the per-cycle directive", () => {
  const lines = INDEX.split("\n").filter((l) => l.includes("resumeBriefBlock"));
  const shapes = lines.map((l) => l.trim());
  assertEquals(shapes.length, 3, `declaration, assignment, composition — got: ${shapes.join(" | ")}`);
  assert(shapes.includes('let resumeBriefBlock = "";'));
  assert(shapes.some((l) => l.startsWith("if (briefOutcome.text) resumeBriefBlock =")));
  assert(shapes.includes("let intermediateSystem = baseSystemPrompt + buildPerCycleCompactDirective() + resumeBriefBlock;"));
});

Deno.test("wiring: baseSystemPrompt, the finalize prompt, the salvage prompt and the opening gate are untouched by the brief", () => {
  const base = between(INDEX, "const baseSystemPrompt =", "// ---- RESUME BRIEF (lib/next-pivot.ts)");
  assertFalse(/resumeBrief|nextPivot|next-pivot/i.test(base), "the cached base must not contain the brief");
  assertStringIncludes(INDEX, "system: stepSystem(baseSystemPrompt + finalizePlan.directive),");
  assertStringIncludes(INDEX, "system: baseSystemPrompt,");
  // Nothing in the brief's own block touches tool choice, stop conditions or the finalize machinery.
  const block = between(INDEX, "// ---- RESUME BRIEF (lib/next-pivot.ts)", "// ---- Prompt-size instrument (A1)");
  assertFalse(/toolChoice|stopWhen|finalize|activeTools|openingPhase/i.test(block.replace(/finalize prompt/g, "")), "no termination or tool-choice control");
  // The module itself never mentions them as code either.
  assertFalse(/toolChoice|stopWhen/.test(MODULE.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n")));
});

Deno.test("wiring: the module never touches the database client, the filesystem or a model (pure + injected readers)", () => {
  const code = MODULE.split("\n").filter((l) => !l.trimStart().startsWith("//")).join("\n");
  assertFalse(/supabase|fetch\(|Deno\.(readTextFile|writeTextFile|env\.set)|streamText|generateText/.test(code));
});

Deno.test("wiring: /health reports checks.next_pivot_brief from the module's self-test", () => {
  assertStringIncludes(HEALTH, 'from "./lib/next-pivot.ts"');
  assertStringIncludes(HEALTH, "r.checks.next_pivot_brief = nextPivotBriefSelfTest();");
});

// ---- prompt budget: tested through the REAL capTotalToBudget ------------------------------------------------

function bigToolMessage(i: number, valueChars: number): ModelMessage {
  return {
    role: "tool",
    content: [{ type: "tool-result", toolCallId: `call_${i}`, toolName: `tool_${i}`, output: { type: "json", value: { blob: "x".repeat(valueChars), i } } }],
  } as unknown as ModelMessage;
}
const assistantText = (text: string): ModelMessage => ({ role: "assistant", content: [{ type: "text", text }] }) as unknown as ModelMessage;

function realBrief(): string {
  const rows: BriefArtifact[] = [
    { id: "a1", kind: "email", value: "probe@example.test", source: "rapidapi_breach_search", confidence: 60, metadata: {}, created_at: "2026-01-01T00:00:01Z" },
    { id: "a2", kind: "username", value: "probe_user", source: "github_user", confidence: 70, metadata: {}, created_at: "2026-01-01T00:00:02Z" },
  ];
  const out = buildResumeBrief({
    messages: [{ role: "user", parts: [{ type: "text", text: "x" }] }, { role: "assistant", parts: [{ type: "text", text: "y" }] }, { role: "user", parts: [{ type: "text", text: "Continue the investigation." }] }],
    inputs: { artifacts: rows, usage: [], complete: true }, reviews: emptyReviewLoad(true), disabled: false,
  });
  assert(out.text, out.reason);
  return out.text;
}

Deno.test("budget: as an ASSISTANT message the brief would be destroyed by the real elision pass (why it is a system block)", () => {
  const brief = realBrief();
  const sentinel = "give the reason as a trailing clause";
  assertStringIncludes(brief, sentinel);
  // An over-budget resumed thread: the brief-as-message sits early, then ~26 fat tool results.
  const msgs: ModelMessage[] = [assistantText(brief)];
  for (let i = 0; i < 26; i++) msgs.push(bigToolMessage(i, 12_000));
  assert(approxMsgChars(msgs) > TOTAL_PROMPT_CHAR_BUDGET, "fixture must be over budget");
  const out = capTotalToBudget(msgs, TOTAL_PROMPT_CHAR_BUDGET, RECENT_WINDOW, true);
  const first = JSON.stringify(out[0]);
  assertFalse(first.includes(sentinel), "the rule the brief carries is gone after elision");
  assertStringIncludes(first, "[elided]");
});

Deno.test("budget: as a system block it is outside the message array, so the real cap neither sees nor counts it", () => {
  const brief = realBrief();
  const msgs: ModelMessage[] = [];
  for (let i = 0; i < 26; i++) msgs.push(bigToolMessage(i, 12_000));
  const out = capTotalToBudget(msgs, TOTAL_PROMPT_CHAR_BUDGET, RECENT_WINDOW, true);
  assertFalse(JSON.stringify(out).includes("RESUME BRIEF"));
  // The block is bounded on its own terms, and small next to the budget it does not share.
  assert(brief.length <= NEXT_PIVOT_BRIEF_MAX_CHARS);
  assert(NEXT_PIVOT_BRIEF_MAX_CHARS <= TOTAL_PROMPT_CHAR_BUDGET * 0.01, "<= 1% of the message budget, at its hard cap");
});

Deno.test("budget: the prompt-size instrument already counts it, as part of the per-step directive", () => {
  const brief = `\n\n${realBrief()}`;
  const base = "BASE-PROMPT";
  const directive = buildPerCycleCompactDirective();
  const without = measurePromptTerms({ stepDirective: (base + directive).length - base.length });
  const withBrief = measurePromptTerms({ stepDirective: (base + directive + brief).length - base.length });
  assertEquals(withBrief.terms.stepDirective - without.terms.stepDirective, brief.length);
  assertEquals(withBrief.system_total - without.system_total, brief.length);
});

Deno.test("cache: appending the brief leaves the Anthropic cached prefix byte-identical and puts the brief in the uncached tail", () => {
  const base = "BASE-PROMPT ".repeat(50);
  const directive = buildPerCycleCompactDirective();
  const brief = `\n\n${realBrief()}`;
  const a = splitCachedSystem(base + directive, base);
  const b = splitCachedSystem(base + directive + brief, base);
  assertEquals(a[0].content, b[0].content);
  assertEquals(b[0].content, base);
  assert(JSON.stringify(b[0]).includes("ephemeral"), "the base is still the cache breakpoint");
  assertEquals(b.length, 2);
  assertStringIncludes(b[1].content, "RESUME BRIEF");
  assertFalse(b[0].content.includes("RESUME BRIEF"));
});
