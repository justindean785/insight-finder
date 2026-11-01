// finding_prompt_test.ts — the prompt no longer tells the model that an ARTIFACT is a FINDING.
//
// Audit 2026-11-01 (docs/AUDIT_2026-11-01_record-finding-gap-and-hitsticktaxfree-scan.md §3, §6 item 3):
// record_finding ran in 3 of 168 runs in 14 days because the wording the model reads conflated the two
// writers — "a finding only exists once it is in record_artifacts", a closing table that "renders what is
// already persisted" via record_artifacts, an OPTIONAL record_finding ("may run"), and a finalize_no_findings
// that described itself as "every tool-supported finding is already persisted".
//
// What this pins, in BOTH switch states (FINDING_PROMPT_V2_DISABLED):
//   1. the REAL assembled prompt (lib/base-prompt.ts) and the REAL workflow addendum carry the new wording,
//      and the exact pre-change text (copied from main d3aa3f59, NOT imported from the module under test)
//      comes back verbatim under the switch;
//   2. the finalize persist directive and the REAL finalize_no_findings tool (buildTools + stubbed client)
//      describe the ARTIFACT decision, with the wire contract (reason enum, return shape) unchanged;
//   3. only the named lines differ between the two variants — nothing else in the prompt moved;
//   4. the finalize CONTRACT is untouched: record_finding is in none of the three tool sets and
//      countFinalizeProgress does not count it (by value AND by behaviour, plus source-level);
//   5. /health wires checks.finding_prompt over the rendered surfaces (next_pivot_wiring_test.ts pattern).
// It does NOT claim the model now calls record_finding — that is a tool_usage_log measurement after deploy.
import { assert, assertEquals, assertFalse, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { assembleBaseSystemPrompt, staticSystemPrompt } from "../../functions/osint-agent/lib/base-prompt.ts";
import { responseLanguageBlock } from "../../functions/osint-agent/lib/response-language.ts";
import {
  buildSystemPromptFull,
  SYSTEM_PROMPT_FULL,
  SYSTEM_PROMPT_FULL_LEGACY_FINDING,
  SYSTEM_PROMPT_FULL_LEGACY_MEMORY,
  SYSTEM_PROMPT_FULL_LEGACY_MEMORY_AND_FINDING,
} from "../../functions/osint-agent/system-prompt.ts";
import { REVEAL_BREACH_DATA } from "../../functions/osint-agent/reveal-policy.ts";
import { buildWorkflowAddendum } from "../../functions/osint-agent/workflow_prompt.ts";
import {
  buildFinalizePersistDirective,
  countFinalizeProgress,
  FINALIZE_MEMORY_ACTIVE_TOOLS,
  FINALIZE_PERSIST_ACTIVE_TOOLS,
  FINALIZE_REPORT_ACTIVE_TOOLS,
} from "../../functions/osint-agent/orchestrator-finalize.ts";
import {
  CLOSING_TABLE_RULE,
  FINALIZE_NO_FINDINGS_DESCRIPTION,
  FINALIZE_PERSIST_DECISION_LINES,
  FINDING_PROMPT_V2_DISABLED_ENV,
  findingPromptSelfTest,
  findingPromptV2Disabled,
  RECORDING_FINDING_SENTENCE,
  WORKFLOW_FINDING_STEP,
} from "../../functions/osint-agent/lib/finding-prompt.ts";

const SWITCH = FINDING_PROMPT_V2_DISABLED_ENV;
const MEMORY_SWITCH = "MEMORY_AUTHORITY_WORDING_DISABLED";
const FN_DIR = new URL("../../functions/osint-agent/", import.meta.url);
const readFn = (rel: string) => Deno.readTextFile(new URL(rel, FN_DIR));

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    prev[k] = Deno.env.get(k);
    if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v);
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) Deno.env.delete(k); else Deno.env.set(k, v);
    }
  }
}
const bothOff = { [SWITCH]: undefined, [MEMORY_SWITCH]: undefined };

// ---- The EXACT pre-change text, copied from main d3aa3f59. Kept here, not imported, so a drift in the
// module's LEGACY_* constants fails this file instead of being blessed by it.
const LEGACY_RECORDING =
  "Your narration and the Findings prose are NOT a substitute for structured evidence: a finding only exists once it is in `record_artifacts`.";
const LEGACY_TABLE =
  "- Every Findings-table row MUST correspond to an artifact you already persisted via `record_artifacts` this run — the table is a VIEW of recorded artifacts, never a substitute for recording them. Record findings as you go (see Recording); the closing table just renders what is already persisted.";
const LEGACY_WORKFLOW_LINE =
  "- `record_finding` may run whenever source-backed evidence exists. Each finding still needs named sources, drivers, reducers, contradictions, unresolved questions, and next pivots.";
const AVF_LAST_LINE = "  (DOB, phone, address, full name) to findings without corroboration.";
const LEGACY_ADVISORY_TO_SCORING = [
  "## ADVISORY WORKFLOW",
  "- Classify the seed and use the playbook as a ranked checklist, not a prerequisite list.",
  "- Use `minimax_plan_pivots`, `coverage_audit`, `detect_contradictions`, and `tool_audit` when they improve the investigation. None is required for progress.",
  "- Missing tools or incomplete coverage should be disclosed as limitations, not converted into retry loops.",
  LEGACY_WORKFLOW_LINE,
  "- Manual override never bypasses hard call, concurrency, pacing, timeout, circuit-breaker, or paid-call limits.",
  "",
  "## ARTIFACT vs FINDING (do not conflate)",
  "- An artifact is a collected data point. Everything from a tool starts as an artifact.",
  "- A finding is an analyst conclusion supported by ≥1 artifact, with named drivers/reducers and a confidence axis.",
  "- Do NOT auto-promote raw scraped results, single-source username hits, or breach-only identity attributes",
  AVF_LAST_LINE,
  "",
  "## RELATIONSHIP SCORING (mandatory whenever you link two artifacts)",
].join("\n");
const LEGACY_PERSIST_LINES = [
  "- Call record_artifacts with every tool-supported finding not yet persisted; OR",
  "- Call finalize_no_findings with a short reason if there is genuinely no additional",
  "  supported finding to persist.",
];
const LEGACY_PERSIST_DIRECTIVE = [
  "",
  "",
  "=== BUDGET NEARLY EXHAUSTED — FINALIZE NOW ===",
  "Your time and step budget for this investigation is almost spent.",
  "Do NOT start any new lookups, pivots, or web searches.",
  "This is the PERSISTENCE phase. Do not write narration or the report yet.",
  "You MUST make exactly one tool call:",
  ...LEGACY_PERSIST_LINES,
  "Never invent an artifact merely to satisfy this phase.",
].join("\n");
const LEGACY_DESCRIPTION =
  "Finalize-only decision: declare that every tool-supported finding is already persisted. Never call during normal investigation work.";

// ---- chainable stub client (memory_authority_test.ts pattern): builders chain; awaiting resolves the table's rows.
function stubClient(tables: Record<string, unknown[]>) {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "or", "order", "limit", "in", "gt"]) b[m] = () => b;
    b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: tables[table] ?? [], error: null }).then(res);
    return b;
  };
  return { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) };
}
type FinalizeTool = {
  description: string;
  inputSchema: { safeParse: (v: unknown) => { success: boolean } };
  execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>>;
};
async function finalizeNoFindingsTool(): Promise<FinalizeTool> {
  const { buildTools } = await import("../../functions/osint-agent/tool-registry.ts");
  const sb = stubClient({ agent_memory: [], artifact_reviews: [], artifacts: [] });
  const { tools } = buildTools({
    supabase: sb, supabaseAdmin: sb, userId: "u-test", threadId: "t-test", archiveEnabled: false,
    detectedSeedType: "username", messages: [], manualOverrideSelector: null,
  } as unknown as Parameters<typeof buildTools>[0]);
  return (tools as unknown as Record<string, FinalizeTool>).finalize_no_findings;
}

// ---------------------------------------------------------------------------------------------------
// 0. The switch
// ---------------------------------------------------------------------------------------------------

Deno.test("finding prompt: only the literal 'true' (trimmed, case-insensitive) disables the new wording", () => {
  const env = (v: string | undefined) => () => v;
  assertFalse(findingPromptV2Disabled(env(undefined)));
  assertFalse(findingPromptV2Disabled(env("")));
  assertFalse(findingPromptV2Disabled(env("1")));
  assertFalse(findingPromptV2Disabled(env("false")));
  assert(findingPromptV2Disabled(env("true")));
  assert(findingPromptV2Disabled(env(" TRUE ")));
});

// ---------------------------------------------------------------------------------------------------
// 1. Default: the assembled prompt distinguishes the two writers
// ---------------------------------------------------------------------------------------------------

Deno.test("default: the ASSEMBLED prompt names record_finding as the finding writer and never says a finding exists in record_artifacts", async () => {
  await withEnv(bothOff, () => {
    for (const seed of ["username", "domain", "email"]) {
      const p = assembleBaseSystemPrompt({ detectedSeedType: seed, visionIntakeSummary: "", analystDecisionsBlock: "" });
      // Surface 1 — system prompt, both sentences.
      assertStringIncludes(p, RECORDING_FINDING_SENTENCE);
      assertStringIncludes(p, CLOSING_TABLE_RULE);
      assertStringIncludes(p, "a finding exists ONLY once it is in `record_finding`");
      assertStringIncludes(p, "renders `record_finding` rows and nothing else");
      assertStringIncludes(p, "the confidence and label you pass are advisory");
      // Surface 2 — workflow addendum, the required step.
      assertStringIncludes(p, WORKFLOW_FINDING_STEP);
      assertStringIncludes(p, "REQUIRED STEP of the main investigation loop, not a finalize task");
      assertStringIncludes(p, "TWO OR MORE independent source classes");
      assertStringIncludes(p, "BEFORE you move to the next pivot and before any finalize phase");
      assertStringIncludes(p, "Never call `record_finding` to make the Evidence Record non-empty");
      assertStringIncludes(p, "Synthetic example: `record_finding({");
      // The conflation is gone from every surface.
      assertFalse(p.includes(LEGACY_RECORDING), `${seed}: legacy Recording sentence survived`);
      assertFalse(p.includes(LEGACY_TABLE), `${seed}: legacy closing-table rule survived`);
      assertFalse(p.includes(LEGACY_WORKFLOW_LINE), `${seed}: legacy 'may run' line survived`);
      assertFalse(/a finding only exists once it is in `record_artifacts`/.test(p));
      // The neighbours are untouched.
      assertStringIncludes(p, "RECORDING IS A PRECONDITION OF FINISHING, NOT AN OPTIONAL HABIT.");
      assertStringIncludes(p, "record first, correlate after.");
      assertStringIncludes(p, "## ADVISORY WORKFLOW");
      assertStringIncludes(p, "None is required for progress");
      assertStringIncludes(p, "## ARTIFACT vs FINDING (do not conflate)");
    }
  });
});

Deno.test("default: the required step is appended to ARTIFACT vs FINDING, the ADVISORY WORKFLOW list no longer mentions record_finding", async () => {
  await withEnv(bothOff, () => {
    const w = buildWorkflowAddendum("username");
    const advisoryStart = w.indexOf("## ADVISORY WORKFLOW");
    const avfStart = w.indexOf("## ARTIFACT vs FINDING");
    const scoringStart = w.indexOf("## RELATIONSHIP SCORING");
    assert(advisoryStart > 0 && avfStart > advisoryStart && scoringStart > avfStart, "section order preserved");
    const advisory = w.slice(advisoryStart, avfStart);
    const avf = w.slice(avfStart, scoringStart);
    assertFalse(advisory.includes("record_finding"), "ADVISORY WORKFLOW must not carry the optional record_finding line");
    assertStringIncludes(avf, AVF_LAST_LINE + "\n" + WORKFLOW_FINDING_STEP);
    // The frontend contract test (src/test/fail-open-policy-contract.test.ts) reads the SOURCE for these; the
    // rendered text must honour the same promises.
    assertStringIncludes(advisory, "None is required for progress");
    assertFalse(/WORKFLOW GATE|run every REQUIRED tool/.test(w));
  });
});

// ---------------------------------------------------------------------------------------------------
// 2. Default: the finalize persist surfaces describe an ARTIFACT decision; the wire contract is unchanged
// ---------------------------------------------------------------------------------------------------

Deno.test("default: the persist directive asks for artifacts, says persisted artifacts are not findings, keeps its pinned promises", async () => {
  await withEnv(bothOff, () => {
    const d = buildFinalizePersistDirective();
    assertStringIncludes(d, FINALIZE_PERSIST_DECISION_LINES.join("\n"));
    assertStringIncludes(d, "every tool-supported ARTIFACT not yet persisted");
    assertStringIncludes(d, "This is an ARTIFACT decision: persisted artifacts");
    assertStringIncludes(d, "record_finding is not offered in this phase");
    assertFalse(d.includes("supported finding to persist"));
    assertFalse(d.includes("tool-supported finding not yet persisted"));
    // orchestrator_finalize_test.ts pins these three; they must survive the rewording.
    const lower = d.toLowerCase();
    assert(lower.includes("exactly one tool call"));
    assert(lower.includes("finalize_no_findings"));
    assert(lower.includes("never invent"));
  });
});

Deno.test("default: finalize_no_findings describes the ARTIFACT decision; name, reason enum and return shape are unchanged", async () => {
  await withEnv(bothOff, async () => {
    const t = await finalizeNoFindingsTool();
    assertEquals(t.description, FINALIZE_NO_FINDINGS_DESCRIPTION);
    assertStringIncludes(t.description, "Persisted artifacts are NOT findings");
    assertStringIncludes(t.description, "record_finding is not available in this phase");
    assertStringIncludes(t.description, "two-independent-source bar");
    assertStringIncludes(t.description, "Never call during normal investigation work.");
    assertFalse(t.description.includes("every tool-supported finding is already persisted"));
    // Wire contract: the same two reasons validate, anything else is rejected, the result shape is the old one.
    assert(t.inputSchema.safeParse({ reason: "all_supported_findings_already_persisted" }).success);
    assert(t.inputSchema.safeParse({ reason: "no_tool_supported_findings" }).success);
    assertFalse(t.inputSchema.safeParse({ reason: "no_cluster_clears_the_bar" }).success);
    assertFalse(t.inputSchema.safeParse({}).success);
    assertEquals(
      await t.execute({ reason: "no_tool_supported_findings" }, { toolCallId: "c1", messages: [] }),
      { ok: true, decision: "no_additional_supported_findings", reason: "no_tool_supported_findings" },
    );
  });
});

// ---------------------------------------------------------------------------------------------------
// 3. Kill switch: the exact pre-change wording, on every surface, with no deploy
// ---------------------------------------------------------------------------------------------------

Deno.test("kill switch: FINDING_PROMPT_V2_DISABLED=true restores the pre-change wording VERBATIM on every surface", async () => {
  await withEnv({ [SWITCH]: "true", [MEMORY_SWITCH]: undefined }, async () => {
    // Surface 1
    // staticSystemPrompt() = the selected wording variant + the output-language rule (lib/response-language.ts).
    const s = staticSystemPrompt();
    assertEquals(s, SYSTEM_PROMPT_FULL_LEGACY_FINDING + responseLanguageBlock());
    assertEquals(s, buildSystemPromptFull(REVEAL_BREACH_DATA, false, true) + responseLanguageBlock());
    assertStringIncludes(s, LEGACY_RECORDING);
    assertStringIncludes(s, LEGACY_TABLE);
    assertFalse(s.includes(RECORDING_FINDING_SENTENCE));
    assertFalse(s.includes(CLOSING_TABLE_RULE));
    // Surface 2 — the whole ADVISORY WORKFLOW → RELATIONSHIP SCORING stretch is the old bytes.
    const w = buildWorkflowAddendum("username");
    assertStringIncludes(w, LEGACY_ADVISORY_TO_SCORING);
    assertFalse(w.includes(WORKFLOW_FINDING_STEP));
    // Surface 3
    assertEquals(buildFinalizePersistDirective(), LEGACY_PERSIST_DIRECTIVE);
    assertEquals((await finalizeNoFindingsTool()).description, LEGACY_DESCRIPTION);
    // The assembled prompt follows the switch too (both index.ts sites go through assembleBaseSystemPrompt).
    const p = assembleBaseSystemPrompt({ detectedSeedType: "username", visionIntakeSummary: "" });
    assert(p.startsWith(SYSTEM_PROMPT_FULL_LEGACY_FINDING));
    assertStringIncludes(p, LEGACY_WORKFLOW_LINE);
  });
});

Deno.test("kill switch: the two wording switches compose — each combination picks its own pre-built variant", async () => {
  await withEnv(bothOff, () => assertEquals(staticSystemPrompt(), SYSTEM_PROMPT_FULL + responseLanguageBlock()));
  await withEnv({ [SWITCH]: undefined, [MEMORY_SWITCH]: "true" }, () => assertEquals(staticSystemPrompt(), SYSTEM_PROMPT_FULL_LEGACY_MEMORY + responseLanguageBlock()));
  await withEnv({ [SWITCH]: "true", [MEMORY_SWITCH]: undefined }, () => assertEquals(staticSystemPrompt(), SYSTEM_PROMPT_FULL_LEGACY_FINDING + responseLanguageBlock()));
  await withEnv({ [SWITCH]: "true", [MEMORY_SWITCH]: "true" }, () => {
    assertEquals(staticSystemPrompt(), SYSTEM_PROMPT_FULL_LEGACY_MEMORY_AND_FINDING + responseLanguageBlock());
    assertEquals(staticSystemPrompt(), buildSystemPromptFull(REVEAL_BREACH_DATA, true, true) + responseLanguageBlock());
    assertStringIncludes(staticSystemPrompt(), LEGACY_RECORDING);
  });
  // #831's own guarantee is intact: the memory variant with the new finding wording still carries that wording.
  assertStringIncludes(SYSTEM_PROMPT_FULL_LEGACY_MEMORY, RECORDING_FINDING_SENTENCE);
  assertFalse(SYSTEM_PROMPT_FULL_LEGACY_MEMORY.includes(LEGACY_RECORDING));
});

// ---------------------------------------------------------------------------------------------------
// 4. Only the named lines differ — nothing else in any surface moved
// ---------------------------------------------------------------------------------------------------

Deno.test("only the named lines differ between the two variants of each surface", async () => {
  // System prompt: two sentences.
  assertEquals(
    SYSTEM_PROMPT_FULL_LEGACY_FINDING.replace(LEGACY_RECORDING, RECORDING_FINDING_SENTENCE).replace(LEGACY_TABLE, CLOSING_TABLE_RULE),
    SYSTEM_PROMPT_FULL,
  );
  assertEquals(SYSTEM_PROMPT_FULL_LEGACY_FINDING.split(LEGACY_RECORDING).length, 2, "legacy Recording sentence occurs exactly once");
  assertEquals(SYSTEM_PROMPT_FULL_LEGACY_FINDING.split(LEGACY_TABLE).length, 2, "legacy table rule occurs exactly once");
  // Workflow addendum: one line removed from ADVISORY WORKFLOW, the step appended to ARTIFACT vs FINDING.
  for (const seed of ["username", "domain", null]) {
    const legacy = await withEnv({ [SWITCH]: "true" }, () => buildWorkflowAddendum(seed));
    const current = await withEnv({ [SWITCH]: undefined }, () => buildWorkflowAddendum(seed));
    assertEquals(
      current,
      legacy.replace("\n" + LEGACY_WORKFLOW_LINE, "").replace(AVF_LAST_LINE, AVF_LAST_LINE + "\n" + WORKFLOW_FINDING_STEP),
      `workflow addendum (${seed}) differs beyond the named lines`,
    );
  }
  // Persist directive: the decision lines only.
  const legacyD = await withEnv({ [SWITCH]: "true" }, () => buildFinalizePersistDirective());
  const currentD = await withEnv({ [SWITCH]: undefined }, () => buildFinalizePersistDirective());
  assertEquals(currentD, legacyD.replace(LEGACY_PERSIST_LINES.join("\n"), FINALIZE_PERSIST_DECISION_LINES.join("\n")));
});

// ---------------------------------------------------------------------------------------------------
// 5. The finalize CONTRACT is untouched (CLAUDE.md: nothing new runs inside the finalize window)
// ---------------------------------------------------------------------------------------------------

Deno.test("finalize contract: record_finding is in none of the three tool sets and is not counted as progress", async () => {
  assertEquals(FINALIZE_PERSIST_ACTIVE_TOOLS, ["record_artifacts", "finalize_no_findings"]);
  assertEquals(FINALIZE_MEMORY_ACTIVE_TOOLS, ["memory_save", "finalize_skip_memory"]);
  assertEquals(FINALIZE_REPORT_ACTIVE_TOOLS, []);
  // Behaviour: a successful record_finding result changes nothing in the finalize progress accounting.
  const history = [{
    role: "tool",
    content: [
      { type: "tool-result", toolName: "record_finding", toolCallId: "rf-1", output: { type: "json", value: { ok: true, id: "f1", applied_label: "CORROBORATED" } } },
    ],
  }];
  assertEquals(
    countFinalizeProgress(history as unknown as Parameters<typeof countFinalizeProgress>[0]),
    { recordSucceeded: 0, noFindingsSucceeded: 0, memorySucceeded: 0, memorySkipped: 0 },
  );
  // Source: the constants read exactly as before and countFinalizeProgress's body never mentions record_finding.
  const src = await readFn("orchestrator-finalize.ts");
  assertStringIncludes(src, 'export const FINALIZE_PERSIST_ACTIVE_TOOLS = ["record_artifacts", "finalize_no_findings"] as const;');
  assertStringIncludes(src, 'export const FINALIZE_MEMORY_ACTIVE_TOOLS = ["memory_save", "finalize_skip_memory"] as const;');
  assertStringIncludes(src, "export const FINALIZE_REPORT_ACTIVE_TOOLS: readonly string[] = [];");
  const start = src.indexOf("export function countFinalizeProgress(");
  assert(start > 0);
  const body = src.slice(start, src.indexOf("\n}\n", start));
  assertFalse(/\brecord_finding\b/.test(body), "countFinalizeProgress must not count record_finding");
});

// ---------------------------------------------------------------------------------------------------
// 6. /health proof key, over the RENDERED surfaces
// ---------------------------------------------------------------------------------------------------

Deno.test("wiring: /health reports checks.finding_prompt from the self-test over the three rendered surfaces", async () => {
  const health = await readFn("health-handler.ts");
  assertStringIncludes(health, "r.checks.finding_prompt = findingPromptSelfTest({");
  assertStringIncludes(health, "systemPrompt: staticSystemPrompt(),");
  assertStringIncludes(health, "workflowAddendum: buildWorkflowAddendum(null),");
  assertStringIncludes(health, "persistDirective: buildFinalizePersistDirective(),");
});

Deno.test("self-test: ok on the real surfaces in both switch states, and it names the switch", async () => {
  const surfaces = () => ({
    systemPrompt: staticSystemPrompt(),
    workflowAddendum: buildWorkflowAddendum(null),
    persistDirective: buildFinalizePersistDirective(),
  });
  await withEnv(bothOff, () => {
    const r = findingPromptSelfTest(surfaces());
    assert(r.ok, r.detail);
    assertEquals(r.switch, "FINDING_PROMPT_V2_DISABLED");
    assertStringIncludes(r.detail, "not that the model follows it");
  });
  await withEnv({ [SWITCH]: "true" }, () => {
    const r = findingPromptSelfTest(surfaces());
    assert(r.ok, r.detail);
    assert(r.detail.startsWith("LEGACY via FINDING_PROMPT_V2_DISABLED"));
  });
});

Deno.test("self-test: a surface that lost its wording, or still carries the legacy sentence, reads ok:false", async () => {
  await withEnv(bothOff, () => {
    const lost = findingPromptSelfTest({ systemPrompt: "x", workflowAddendum: "y", persistDirective: "z" });
    assertFalse(lost.ok);
    assertStringIncludes(lost.detail, "missing=system_prompt,workflow_addendum,persist_directive");
    const leaked = findingPromptSelfTest({
      systemPrompt: RECORDING_FINDING_SENTENCE + CLOSING_TABLE_RULE + LEGACY_RECORDING,
      workflowAddendum: WORKFLOW_FINDING_STEP,
      persistDirective: FINALIZE_PERSIST_DECISION_LINES.join("\n"),
    });
    assertFalse(leaked.ok);
    assertStringIncludes(leaked.detail, "legacy_leaks=1");
  });
});

// ---------------------------------------------------------------------------------------------------
// 7. Module shape: a leaf, imported by every surface
// ---------------------------------------------------------------------------------------------------

Deno.test("wiring: lib/finding-prompt.ts is a leaf and all four surfaces (plus base-prompt) read the switch from it", async () => {
  const leaf = await readFn("lib/finding-prompt.ts");
  assertFalse(/^\s*import\s/m.test(leaf), "the leaf must import nothing (no cycles, Vite-safe)");
  assertStringIncludes(leaf, "globalThis");
  for (const f of ["system-prompt.ts", "workflow_prompt.ts", "orchestrator-finalize.ts", "tool-registry.ts"]) {
    assertStringIncludes(await readFn(f), 'from "./lib/finding-prompt.ts"', `${f} must take its wording from the leaf`);
  }
  const base = await readFn("lib/base-prompt.ts");
  assertStringIncludes(base, 'from "./finding-prompt.ts"');
  assertStringIncludes(base, "SYSTEM_PROMPT_FULL_LEGACY_FINDING");
  assertStringIncludes(base, "SYSTEM_PROMPT_FULL_LEGACY_MEMORY_AND_FINDING");
});
