// memory_authority_test.ts — MITIGATION of authority escalation (not a report-integrity fix).
//
// Pins: recalled memory is prior-run CONTEXT, never "corroborated"; recall output tags rows
// with the provenance the data can actually support; analyst decisions, supersession and
// the analyst-decisions prompt block are PRESERVED. Synthetic values only.
//
// Drives the REAL assembled prompt (lib/base-prompt.ts), the REAL memory_recall tool
// (buildTools + a stubbed Supabase client), and the real hint renderers. The one place a
// source-wiring assertion stands in for execution is the record_artifacts auto-recall
// (needs a full artifact pipeline); it is marked below.
import { assert, assertEquals, assertFalse, assertMatch, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { assembleBaseSystemPrompt, staticSystemPrompt } from "./lib/base-prompt.ts";
import { routingGuard } from "./guard.ts";
import { SYSTEM_PROMPT_FULL, SYSTEM_PROMPT_FULL_LEGACY_MEMORY } from "./system-prompt.ts";
import { FINDING_LABELS } from "./catalog.ts";
import { buildWorkflowAddendum } from "./workflow_prompt.ts";
import { loadReviewsForThread, renderAnalystDecisionsBlock, type ReviewDb } from "./reviews.ts";
import {
  autoRecallHint,
  MEMORY_CITATION_LABEL,
  memoryAuthoritySelfTest,
  memoryProvenance,
  memoryRecallPromptRules,
  renderPlannerMemoryHint,
  tagMemoryProvenance,
} from "./lib/memory-provenance.ts";

const SWITCH = "MEMORY_AUTHORITY_WORDING_DISABLED";

async function withSwitch<T>(value: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const prev = Deno.env.get(SWITCH);
  if (value === undefined) Deno.env.delete(SWITCH); else Deno.env.set(SWITCH, value);
  try { return await fn(); } finally {
    if (prev === undefined) Deno.env.delete(SWITCH); else Deno.env.set(SWITCH, prev);
  }
}

// The exact pre-change wording of the two prompt lines (kill-switch fidelity).
const LEGACY_LINES =
  `- FIRST TURN, IN PARALLEL with triage_seed (or as the very first call for non-email/username seeds), call \`memory_recall\` with the raw seed value. If it returns prior connections, identity clusters, or lessons, INCORPORATE them into your plan and CITE them in the final report as "[MEMORY] previously corroborated".
- After EVERY high-value pivot (new confirmed email / handle / domain / wallet / person name), call \`memory_recall\` with that new value before burning fresh API calls — you may already have prior knowledge.`;

const FORBIDDEN = [
  /previously corroborated/i,
  /Do NOT re-investigate values already covered/i,
  /weight these/i,
  /confirmed links/i,
  /before burning fresh API calls/i,
  /you may already have prior knowledge/i,
];

// A synthetic analyst false-positive lesson, in the exact wording the analyst writer produces.
const analystLesson = (value: string) => ({
  id: "l-" + value, kind: "lesson", subject: value, subject_kind: "email", related_values: [] as string[],
  content: `Analyst marked "${value}" (email) as FALSE / incorrect data. Do NOT re-propose this artifact in future investigations for the same user. Treat as a confirmed false positive even if a tool surfaces it again.`,
  confidence: 95,
});
const modelRow = (id: string, kind: string, subject: string, related: string[] = [], confidence = 74) => ({
  id, kind, subject, subject_kind: null, related_values: related,
  content: `Synthetic model-written ${kind} about ${subject}.`, confidence,
});

// ---- chainable stub: every builder method returns the builder; awaiting it resolves the table's rows.
function stubClient(tables: Record<string, unknown[]>) {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "or", "order", "limit", "in", "gt"]) b[m] = () => b;
    b.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: tables[table] ?? [], error: null }).then(res);
    return b;
  };
  return { from: (t: string) => builder(t), rpc: () => Promise.resolve({ data: null, error: null }) };
}

async function recallTool(agentRows: unknown[]) {
  // index.ts resets this per request (index.ts:158); a test is its own request.
  routingGuard.memoryRecallTimestamps = [];
  routingGuard.memoryRecallSubjectsThisStep.clear();
  const { buildTools } = await import("./tool-registry.ts");
  const sb = stubClient({ agent_memory: agentRows, artifact_reviews: [] });
  const { tools } = buildTools({
    supabase: sb, supabaseAdmin: sb, userId: "u-test", threadId: "t-test", archiveEnabled: false,
    detectedSeedType: "domain", messages: [], manualOverrideSelector: null,
  } as unknown as Parameters<typeof buildTools>[0]);
  return (tools as unknown as Record<string, { execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>> }>).memory_recall;
}

// ---------------------------------------------------------------------------------------------
// 1. The ASSEMBLED runtime prompt
// ---------------------------------------------------------------------------------------------

Deno.test("assembled prompt: recalled memory is context, never 'corroborated'; analyst block carried byte-identical", async () => {
  await withSwitch(undefined, async () => {
    // A REAL ReviewLoad through the real loader: one confirmed, one wrong.
    const db = stubClient({
      artifact_reviews: [
        { artifact_id: "a1", state: "confirmed", note: "checked" },
        { artifact_id: "a2", state: "wrong", note: null },
      ],
      artifacts: [
        { id: "a1", kind: "domain", value: "kept.example", metadata: {} },
        { id: "a2", kind: "email", value: "rejected@example.com", metadata: {} },
      ],
    });
    const load = await loadReviewsForThread(db as unknown as ReviewDb, "t1", "u1");
    assert(load.ok);
    const block = renderAnalystDecisionsBlock(load);
    assert(block.length > 0, "fixture must produce a real analyst-decisions block");
    const prompt = assembleBaseSystemPrompt({ detectedSeedType: "domain", visionIntakeSummary: "", analystDecisionsBlock: block });

    for (const re of FORBIDDEN) assertFalse(re.test(prompt), `assembled prompt still contains ${re}`);
    assertStringIncludes(prompt, MEMORY_CITATION_LABEL);
    assertStringIncludes(prompt, "never counts as a source or as corroboration");
    assertStringIncludes(prompt, "analyst_marker_pattern");
    // The analyst's decisions are appended last and are untouched by this change.
    assert(prompt.endsWith(block), "analyst decisions block must remain the unmodified tail of the prompt");
    assertStringIncludes(prompt, "kept.example");
    assertStringIncludes(prompt, "rejected@example.com");
  });
});

Deno.test("assembled prompt: the extraction is behaviour-preserving (same bytes as the old inline concatenation)", async () => {
  await withSwitch(undefined, () => {
    const vision = "\n## VISION\nsynthetic\n";
    const block = "\n## ANALYST DECISIONS\nsynthetic\n";
    const old = SYSTEM_PROMPT_FULL + FINDING_LABELS + buildWorkflowAddendum("domain") + vision + block;
    assertEquals(assembleBaseSystemPrompt({ detectedSeedType: "domain", visionIntakeSummary: vision, analystDecisionsBlock: block }), old);
    // The streamText default site never carried the analyst block.
    assertEquals(
      assembleBaseSystemPrompt({ detectedSeedType: "domain", visionIntakeSummary: vision }),
      SYSTEM_PROMPT_FULL + FINDING_LABELS + buildWorkflowAddendum("domain") + vision,
    );
  });
});

Deno.test("kill switch restores the exact legacy wording, and ONLY those two lines differ", async () => {
  await withSwitch("true", () => {
    assertEquals(staticSystemPrompt(), SYSTEM_PROMPT_FULL_LEGACY_MEMORY);
    assertStringIncludes(staticSystemPrompt(), LEGACY_LINES);
    assertEquals(memoryRecallPromptRules(true), LEGACY_LINES);
    assertMatch(staticSystemPrompt(), /previously corroborated/);
  });
  // The two variants differ in nothing but the memory lines.
  assertEquals(
    SYSTEM_PROMPT_FULL.replace(memoryRecallPromptRules(false), memoryRecallPromptRules(true)),
    SYSTEM_PROMPT_FULL_LEGACY_MEMORY,
  );
});

// tools/recording.ts is deliberately NOT in this list: it is an unimported, auto-extracted mirror of the
// record_artifacts auto-recall (CLAUDE.md: "any older tools/*.ts files are stale mirrors, not the runtime
// source") and still carries the legacy hint. It does not run; re-syncing it from the live tool is a separate
// change.
Deno.test("no LIVE runtime source outside lib/memory-provenance.ts carries the escalating wording", async () => {
  const files = ["system-prompt.ts", "workflow_prompt.ts", "catalog.ts", "index.ts", "tool-registry.ts", "lib/base-prompt.ts", "lib/history-label.ts"];
  for (const f of files) {
    const src = await Deno.readTextFile(new URL(`./${f}`, import.meta.url));
    for (const re of [/previously corroborated/i, /Do NOT re-investigate values already covered/i, /weight these/i]) {
      assertFalse(re.test(src), `${f} still carries ${re}`);
    }
  }
});

// ---------------------------------------------------------------------------------------------
// 2. memory_recall — the REAL tool against a stubbed client
// ---------------------------------------------------------------------------------------------

Deno.test("memory_recall output: rows tagged with supportable provenance; analyst exclusion preserved, not downgraded", async () => {
  await withSwitch(undefined, async () => {
    const recall = await recallTool([
      analystLesson("rejected@example.com"),
      modelRow("m1", "identity", "operator@example.com", ["site.example"], 74),
      modelRow("m2", "connection", "site.example", ["other.example"], 60),
    ]);
    const out = await recall.execute({ subject: "site.example", kind: "any", limit: 20 }, {});
    assertEquals(out.ok, true);
    const memories = out.memories as Array<{ id: string; provenance: string; confidence: number }>;
    const byId = Object.fromEntries(memories.map((m) => [m.id, m]));
    assertEquals(byId["l-rejected@example.com"].provenance, "analyst_marker_pattern");
    assertEquals(byId["l-rejected@example.com"].confidence, 95, "analyst lesson confidence must not be altered");
    assertEquals(byId["m1"].provenance, "unreviewed");
    assertEquals(byId["m2"].provenance, "unreviewed");
    assertEquals(byId["m1"].confidence, 74, "a stored confidence is carried verbatim; only the framing changes");
    // The legend states the limits: unreviewed != model-authored; analyst tag is wording-inferred.
    const legend = out.provenance_legend as Record<string, string>;
    assertStringIncludes(legend.unreviewed, "unknown");
    assertStringIncludes(legend.analyst_marker_pattern, "inferred from wording only");
    assertStringIncludes(String(out.authority_note), "never counts as a source or as corroboration");
  });
});

Deno.test("memory_recall: supersession of a positive claim about an analyst-rejected selector is PRESERVED", async () => {
  await withSwitch(undefined, async () => {
    const recall = await recallTool([
      analystLesson("rejected@example.com"),
      modelRow("m-bad", "identity", "someone", ["rejected@example.com"], 74), // asserts the rejected selector
      modelRow("m-ok", "connection", "unrelated.example", [], 60),
    ]);
    const out = await recall.execute({ subject: "x", kind: "any", limit: 20 }, {});
    const ids = (out.memories as Array<{ id: string }>).map((m) => m.id);
    assertFalse(ids.includes("m-bad"), "a claim asserting a rejected selector must stay superseded");
    assert(ids.includes("m-ok") && ids.includes("l-rejected@example.com"));
    const sup = out.superseded as Array<{ id: string; source: string }>;
    assertEquals(sup.map((s) => s.id), ["m-bad"]);
    assertEquals(sup[0].source, "analyst_lesson");
  });
});

Deno.test("memory_recall under the kill switch returns the legacy shape (no tags, no legend)", async () => {
  await withSwitch("true", async () => {
    const recall = await recallTool([modelRow("m1", "identity", "a@example.com")]);
    const out = await recall.execute({ subject: "a@example.com", kind: "any", limit: 20 }, {});
    const m = (out.memories as Array<Record<string, unknown>>)[0];
    assertFalse("provenance" in m);
    assertFalse("provenance_legend" in out);
    assertFalse("authority_note" in out);
  });
});

// ---------------------------------------------------------------------------------------------
// 3. Provenance semantics — the limits of what the data supports
// ---------------------------------------------------------------------------------------------

Deno.test("missing or malformed provenance is 'unreviewed' (unknown), never promoted, never an error", () => {
  for (const row of [null, undefined, {}, { kind: null, content: null }, { kind: "identity", content: 42 as unknown as string }]) {
    assertEquals(memoryProvenance(row as never), "unreviewed");
  }
  assertEquals(tagMemoryProvenance(null).length, 0);
  const rows = [{ kind: "pattern", content: "x" }];
  const tagged = tagMemoryProvenance(rows);
  assertEquals(tagged[0].provenance, "unreviewed");
  assertFalse("provenance" in rows[0], "input rows are never mutated");
});

Deno.test("analyst provenance is inferred from WORDING only, and the tag says so (no writer column exists)", () => {
  // A model-authored row that imitates the analyst wording gets the same tag: the store cannot tell them apart.
  // That is exactly why the tag is named for the pattern and the legend states the inference.
  const imitation = { kind: "lesson", subject: "z", content: 'Analyst marked "z" as FALSE / incorrect data. imitation', confidence: 60 };
  assertEquals(memoryProvenance(imitation), "analyst_marker_pattern");
  // Wording alone never lifts an ordinary lesson: only the analyst false-positive wording does.
  assertEquals(memoryProvenance({ kind: "lesson", content: "breach DB Y has stale phones" }), "unreviewed");
  // And a positive 'identity' row is never tagged analyst, whatever its confidence.
  assertEquals(memoryProvenance({ kind: "identity", content: "owner is X", confidence: 95 }), "unreviewed");
});

// ---------------------------------------------------------------------------------------------
// 4. Planner hint and auto-recall hint
// ---------------------------------------------------------------------------------------------

Deno.test("planner hint: no corroboration wording; rows carry provenance; analyst exclusion named as such", async () => {
  await withSwitch(undefined, () => {
    assertEquals(renderPlannerMemoryHint([]), "");
    const hint = renderPlannerMemoryHint([analystLesson("rejected@example.com"), modelRow("m1", "identity", "a@example.com")]);
    for (const re of FORBIDDEN) assertFalse(re.test(hint), `planner hint still contains ${re}`);
    assertStringIncludes(hint, "NOT EVIDENCE");
    assertStringIncludes(hint, "· analyst_marker_pattern]");
    assertStringIncludes(hint, "· unreviewed]");
  });
  await withSwitch("true", () => {
    const legacy = renderPlannerMemoryHint([modelRow("m1", "identity", "a@example.com")]);
    assertStringIncludes(legacy, "weight these");
    assertFalse(legacy.includes("unreviewed"));
  });
});

Deno.test("auto-recall hint: context not evidence; one fresh check per claim, never a repeat of a lookup that already ran", async () => {
  await withSwitch(undefined, () => {
    const h = autoRecallHint();
    for (const re of FORBIDDEN) assertFalse(re.test(h), `auto-recall hint still contains ${re}`);
    assertStringIncludes(h, MEMORY_CITATION_LABEL);
    assertStringIncludes(h, "one fresh check per claim is enough");
    assertStringIncludes(h, "never repeat a lookup that already ran in this case");
    assertStringIncludes(h, "analyst_marker_pattern");
  });
  await withSwitch("true", () => assertStringIncludes(autoRecallHint(), "Do NOT re-investigate values already covered"));
});

Deno.test("WIRING (source assertion — record_artifacts auto-recall needs a full artifact pipeline): the real call sites use the helpers", async () => {
  const src = await Deno.readTextFile(new URL("./tool-registry.ts", import.meta.url));
  assertStringIncludes(src, "memories: tagMemoryProvenance(active)"); // auto-recall + memory_recall
  assertStringIncludes(src, "memory_hint: autoRecallHint(),");
  assertStringIncludes(src, "memoryHint = renderPlannerMemoryHint(active.slice(0, 8));");
  assertStringIncludes(src, "...recallAuthorityFields(),");
  // Supersession still runs BEFORE tagging at every surface.
  const recallIdx = src.indexOf("applyMemorySupersession((data ?? []) as MemoryRow[], autoRecallRejected)");
  assert(recallIdx > 0 && recallIdx < src.indexOf("memories: tagMemoryProvenance(active) }"));
});

// ---------------------------------------------------------------------------------------------
// 5. Proof key (tested locally — the production /health endpoint is side-effecting and is NOT called)
// ---------------------------------------------------------------------------------------------

Deno.test("checks.memory_authority: self-test passes, flags a regression, reports LEGACY under the switch, and is wired", async () => {
  await withSwitch(undefined, () => {
    const t = memoryAuthoritySelfTest();
    assert(t.ok, t.detail);
  });
  await withSwitch("true", () => assertEquals(memoryAuthoritySelfTest().detail, "LEGACY via MEMORY_AUTHORITY_WORDING_DISABLED"));
  const health = await Deno.readTextFile(new URL("./health-handler.ts", import.meta.url));
  assertStringIncludes(health, "r.checks.memory_authority = memoryAuthoritySelfTest();");
});

Deno.test("prompt rules: one fresh check per claim (spend brake kept) and the history marker is explained, only outside the legacy variant", async () => {
  await withSwitch(undefined, () => {
    const rules = memoryRecallPromptRules(false);
    assertStringIncludes(rules, "never repeat a lookup that already ran in this case");
    assertStringIncludes(rules, "[HISTORICAL MODEL OUTPUT");
    assertStringIncludes(rules, "never reproduce that marker in your own output");
    assertStringIncludes(autoRecallHint(), "never repeat a lookup that already ran in this case");
    // The assembled runtime prompt carries them.
    assertStringIncludes(staticSystemPrompt(), "never reproduce that marker in your own output");
    // The legacy variant is untouched by this addition.
    assertFalse(memoryRecallPromptRules(true).includes("HISTORICAL MODEL OUTPUT"));
  });
  await withSwitch("true", () => {
    assertFalse(staticSystemPrompt().includes("HISTORICAL MODEL OUTPUT"));
  });
});
