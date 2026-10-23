/**
 * orchestrator_finalize_test.ts — unit tests for the guaranteed closing-synthesis
 * guards (P0 "No report yet" fix). All logic under test is PURE (no live model, no
 * clock), mirroring orchestrator-budget.ts's testable-StopCondition precedent.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  activeToolsOutsideFinalize,
  countFinalizeProgress,
  buildFinalizeStepPlan,
  buildFinalizeMemoryDirective,
  buildFinalizePersistDirective,
  shouldForceFinalize,
  buildFinalizeDirective,
  buildPerCycleCompactDirective,
  extractAssistantReportText,
  needsReportSalvage,
  meetsCompletionContract,
  hasNoFindingsDecision,
  resolveTerminalState,
  REPORT_PERSIST_FAILED_REASON,
  MIN_TERMINAL_REPORT_CHARS,
  SALVAGE_ON_ZERO_TOOL_CALLS,
  stripReasoning,
  hasReportShape,
  buildSalvageSynthesisPrompt,
  toolCallCapReached,
  shouldSkipForToolCap,
  shouldSkipForFinalizeWindow,
  FINALIZE_ACTIVE_TOOLS,
  FINALIZE_MEMORY_ACTIVE_TOOLS,
  FINALIZE_PERSIST_ACTIVE_TOOLS,
  FINALIZE_REPORT_ACTIVE_TOOLS,
  FINALIZE_RESERVE_MS,
  FINALIZE_MAX_STEPS,
  MIN_REPORT_CHARS,
  resolveFinalizePhase,
  shouldStopFinalizeAtAttemptCap,
} from "../../functions/osint-agent/orchestrator-finalize.ts";
import { MAX_ORCHESTRATOR_STEPS, ORCHESTRATOR_WALL_CLOCK_MS, MAX_TOOL_CALLS_PER_RUN } from "../../functions/osint-agent/orchestrator-budget.ts";

// ---- Fix A: shouldForceFinalize -------------------------------------------------

Deno.test("shouldForceFinalize: opens exactly at the wall-clock reserve window", () => {
  const edge = ORCHESTRATOR_WALL_CLOCK_MS - FINALIZE_RESERVE_MS; // 180s - 90s = 90s
  assertEquals(shouldForceFinalize(edge - 1, 3), false, "1ms before the window stays open for lookups");
  assertEquals(shouldForceFinalize(edge, 3), true, "at the window edge we finalize");
  assertEquals(shouldForceFinalize(edge + 5_000, 3), true, "past the window we finalize");
});

Deno.test("shouldForceFinalize: forces on the last allowed step regardless of time", () => {
  assertEquals(shouldForceFinalize(1_000, MAX_ORCHESTRATOR_STEPS - 2), false, "two steps from cap: keep working");
  assertEquals(shouldForceFinalize(1_000, MAX_ORCHESTRATOR_STEPS - 1), true, "last step: finalize");
  assertEquals(shouldForceFinalize(1_000, MAX_ORCHESTRATOR_STEPS + 3), true, "past cap: finalize");
});

Deno.test("shouldForceFinalize: honors explicit budget/reserve/maxSteps overrides", () => {
  assertEquals(
    shouldForceFinalize(50, 2, { budgetMs: 100, reserveMs: 40, maxSteps: 10 }),
    false,
    "elapsed 50 < 60 window, step 2 < 9",
  );
  assertEquals(
    shouldForceFinalize(60, 2, { budgetMs: 100, reserveMs: 40, maxSteps: 10 }),
    true,
    "elapsed 60 == budget-reserve → finalize",
  );
  assertEquals(
    shouldForceFinalize(10, 9, { budgetMs: 100, reserveMs: 40, maxSteps: 10 }),
    true,
    "step 9 == maxSteps-1 → finalize",
  );
});

Deno.test("finalize constants are sane", () => {
  assert(FINALIZE_RESERVE_MS > 0 && FINALIZE_RESERVE_MS < ORCHESTRATOR_WALL_CLOCK_MS, "reserve fits inside budget");
  assert(FINALIZE_MAX_STEPS >= 1, "at least one finalize step");
  assertEquals(FINALIZE_ACTIVE_TOOLS.includes("record_artifacts"), true, "record_artifacts stays available to finalize");
});

Deno.test("finalize phases expose only the tool needed for the current decision", () => {
  assertEquals(FINALIZE_PERSIST_ACTIVE_TOOLS, ["record_artifacts", "finalize_no_findings"]);
  assertEquals(FINALIZE_MEMORY_ACTIVE_TOOLS, ["memory_save", "finalize_skip_memory"]);
  assertEquals(FINALIZE_REPORT_ACTIVE_TOOLS, []);
});

Deno.test("persistence and memory require tool execution; report forbids tools", () => {
  assertEquals(buildFinalizeStepPlan("persist").toolChoice, "required");
  assertEquals(buildFinalizeStepPlan("persist").activeTools, FINALIZE_PERSIST_ACTIVE_TOOLS);
  assertEquals(buildFinalizeStepPlan("memory").toolChoice, "required");
  assertEquals(buildFinalizeStepPlan("memory").activeTools, FINALIZE_MEMORY_ACTIVE_TOOLS);
  assertEquals(buildFinalizeStepPlan("report").toolChoice, "none");
  assertEquals(buildFinalizeStepPlan("report").activeTools, FINALIZE_REPORT_ACTIVE_TOOLS);
});

Deno.test("attempt cap never cuts off a successful decision before the report", () => {
  assertEquals(shouldStopFinalizeAtAttemptCap(true, FINALIZE_MAX_STEPS, false), true);
  assertEquals(shouldStopFinalizeAtAttemptCap(true, FINALIZE_MAX_STEPS, true), false);
  assertEquals(shouldStopFinalizeAtAttemptCap(true, FINALIZE_MAX_STEPS - 1, false), false);
  assertEquals(shouldStopFinalizeAtAttemptCap(false, FINALIZE_MAX_STEPS, false), false);
});

Deno.test("internal finalize decisions are hidden during ordinary investigation steps", () => {
  assertEquals(
    activeToolsOutsideFinalize(["google_dorks", "finalize_no_findings", "memory_save", "finalize_skip_memory"]),
    ["google_dorks", "memory_save"],
  );
});

Deno.test("finalize phase advances only after a successful post-boundary tool result", () => {
  const before = countFinalizeProgress([]);
  const recordOk = [{
    role: "tool",
    content: [{
      type: "tool-result",
      toolName: "record_artifacts",
      toolCallId: "record-1",
      output: { type: "json", value: { ok: true, count: 2 } },
    }],
  }];
  const memoryOk = [{
    role: "tool",
    content: [{
      type: "tool-result",
      toolName: "memory_save",
      toolCallId: "memory-1",
      output: { type: "json", value: { ok: true, saved: 1 } },
    }],
  }];

  assertEquals(resolveFinalizePhase(before, countFinalizeProgress([])), "persist");
  assertEquals(resolveFinalizePhase(before, countFinalizeProgress(recordOk)), "memory");
  assertEquals(resolveFinalizePhase(before, countFinalizeProgress([...recordOk, ...memoryOk])), "report");
});

Deno.test("failed persistence does not advance finalization", () => {
  const before = countFinalizeProgress([]);
  const failed = [{
    role: "tool",
    content: [{
      type: "tool-result",
      toolName: "record_artifacts",
      toolCallId: "record-bad",
      output: { type: "json", value: { ok: false, count: 0 } },
    }],
  }];
  assertEquals(resolveFinalizePhase(before, countFinalizeProgress(failed)), "persist");
});

Deno.test("explicit no-findings and skip-memory decisions reach the report without fabricating", () => {
  const before = countFinalizeProgress([]);
  const decisions = [
    {
      role: "tool",
      content: [{
        type: "tool-result",
        toolName: "finalize_no_findings",
        toolCallId: "none-1",
        output: { type: "json", value: { ok: true, decision: "no_additional_supported_findings" } },
      }],
    },
    {
      role: "tool",
      content: [{
        type: "tool-result",
        toolName: "finalize_skip_memory",
        toolCallId: "skip-1",
        output: { type: "json", value: { ok: true, decision: "memory_skipped" } },
      }],
    },
  ];
  assertEquals(resolveFinalizePhase(before, countFinalizeProgress(decisions)), "report");
});

Deno.test("phase directives prohibit narration-only escape and unsupported memory", () => {
  const persist = buildFinalizePersistDirective().toLowerCase();
  const memory = buildFinalizeMemoryDirective().toLowerCase();
  assert(persist.includes("exactly one tool call"));
  assert(persist.includes("finalize_no_findings"));
  assert(persist.includes("never invent"));
  assert(memory.includes("exactly one tool call"));
  assert(memory.includes("finalize_skip_memory"));
  assert(memory.includes("weak single-source"));
});

Deno.test("historical persistence and memory do not satisfy a new finalize window", () => {
  const historical = [{
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolName: "record_artifacts",
        toolCallId: "old-record",
        output: { type: "json", value: { ok: true, count: 20 } },
      },
      {
        type: "tool-result",
        toolName: "memory_save",
        toolCallId: "old-memory",
        output: { type: "json", value: { ok: true, saved: 1 } },
      },
    ],
  }];
  const boundary = countFinalizeProgress(historical);
  assertEquals(resolveFinalizePhase(boundary, countFinalizeProgress(historical)), "persist");
});

Deno.test("buildFinalizeDirective is a tool-free report phase", () => {
  const d = buildFinalizeDirective().toLowerCase();
  assert(d.includes("findings report") || d.includes("final") , "asks for the final report");
  assert(d.includes("do not call"), "forbids tool calls after persistence and memory decisions");
  assert(d.includes("memory_save"), "explicitly resolves the base prompt's memory_save conflict");
});

// ---- Per-cycle compact output directive -----------------------------------------

Deno.test("buildPerCycleCompactDirective: forbids the full dossier and demands new-only compact lines", () => {
  const d = buildPerCycleCompactDirective();
  const lower = d.toLowerCase();
  // Forbids the full-dossier shapes on an intermediate turn.
  assert(lower.includes("do not write a findings table"), "forbids a Findings table mid-run");
  assert(/network section/i.test(d), "names the Network section it must not write");
  assert(/summary/i.test(d), "names the Summary it must not write");
  // New-findings-only + compact one-line format.
  assert(/only .*new|new in this cycle/i.test(d), "asks for NEW findings only");
  assert(lower.includes("do not re-state"), "forbids re-stating earlier findings");
  assert(lower.includes("one"), "asks for one-line-per-finding output");
  // Defers the full report to the explicit finalize signal.
  assert(/do not pre-empt|explicitly when to write/i.test(d), "defers the closing report");
});

Deno.test("buildPerCycleCompactDirective: tier thresholds are the analyst's ladder (P1)", () => {
  const d = buildPerCycleCompactDirective();
  // P1 (2026-10-21): CONFIDENCE_TIERS, the ladder the UI badges use — no longer
  // lib/cluster.ts tierFor()'s 50/30 (see prompt_tier_ladder_test.ts).
  for (const [n, tier] of [["90", "Confirmed"], ["75", "Likely"], ["55", "Possible"], ["35", "Weak"]] as const) {
    assert(d.includes(`≥${n} ${tier}`), `directive states the ${tier} threshold ${n}`);
  }
  assert(d.includes("Unverified"), "directive names the Unverified (below-35) tier");
});

// ---- Run tool-call cap ----------------------------------------------------------

Deno.test("toolCallCapReached: trips at the cap, not before", () => {
  assertEquals(toolCallCapReached(MAX_TOOL_CALLS_PER_RUN - 1), false, "one under the cap keeps working");
  assertEquals(toolCallCapReached(MAX_TOOL_CALLS_PER_RUN), true, "at the cap → finalize");
  assertEquals(toolCallCapReached(MAX_TOOL_CALLS_PER_RUN + 10), true, "past the cap → finalize");
  assertEquals(toolCallCapReached(5, 5), true, "honors an explicit cap override");
});

Deno.test("shouldSkipForToolCap: skips a live lookup past the cap but NEVER a recording tool", () => {
  // A run that has already made cap genuine calls: further NON-recording lookups skip.
  assertEquals(shouldSkipForToolCap(MAX_TOOL_CALLS_PER_RUN, false), true, "lookup past cap → skip");
  assertEquals(shouldSkipForToolCap(MAX_TOOL_CALLS_PER_RUN - 1, false), false, "lookup under cap → run");
  // record_artifacts / evidence writes are exempt so capping can't strand evidence.
  assertEquals(shouldSkipForToolCap(MAX_TOOL_CALLS_PER_RUN + 50, true), false, "recording tool past cap → still runs");
});

Deno.test("shouldSkipForFinalizeWindow: skips late live lookups but never recorders", () => {
  const openAt = ORCHESTRATOR_WALL_CLOCK_MS - FINALIZE_RESERVE_MS;
  assertEquals(shouldSkipForFinalizeWindow(openAt - 1, false), false, "before reserve: lookup may run");
  assertEquals(shouldSkipForFinalizeWindow(openAt, false), true, "reserve open: lookup is skipped");
  assertEquals(shouldSkipForFinalizeWindow(openAt + 30_000, true), false, "recording tool still runs");
});

Deno.test("run-cap enforcement: a 61-call run cannot exceed the cap of genuine calls", () => {
  // Simulate the wrapper's per-call gate over 80 attempted NON-recording lookups.
  let genuine = 0;
  let capped = false;
  let skipped = 0;
  for (let i = 0; i < 80; i++) {
    if (shouldSkipForToolCap(genuine, false)) { capped = true; skipped++; continue; }
    genuine++; // a genuine live execution
  }
  assertEquals(genuine, MAX_TOOL_CALLS_PER_RUN, "genuine executions are clamped at the cap");
  assertEquals(capped, true, "run_capped is set once the cap is hit");
  assertEquals(skipped, 80 - MAX_TOOL_CALLS_PER_RUN, "every attempt past the cap is skipped, not run");
});

// ---- Fix B: report-salvage detection + synthesis prompt --------------------------

Deno.test("extractAssistantReportText: joins text parts of the LAST assistant message only", () => {
  const msgs = [
    { role: "user", parts: [{ type: "text", text: "seed" }] },
    { role: "assistant", parts: [{ type: "text", text: "old draft" }] },
    { role: "assistant", parts: [
      { type: "tool-whois", text: "ignored tool part" },
      { type: "text", text: "Final report line 1." },
      { type: "text", text: "Line 2." },
    ] },
  ];
  assertEquals(extractAssistantReportText(msgs), "Final report line 1.\nLine 2.");
});

Deno.test("extractAssistantReportText: returns empty string when no assistant text", () => {
  assertEquals(extractAssistantReportText([{ role: "assistant", parts: [{ type: "tool-x" }] }]), "");
  assertEquals(extractAssistantReportText([]), "");
});

Deno.test("needsReportSalvage: gap = work happened but no REPORT SHAPE (not mere length)", () => {
  assertEquals(needsReportSalvage("", 12), true, "12 tool calls, empty report → salvage");
  assertEquals(needsReportSalvage("too short", 12), true, "short + no report shape → salvage");
  // The real bug: lots of <think> + inter-step narration, NO report. Long, but not
  // a report → must still salvage (the old <MIN_REPORT_CHARS gate missed this).
  const narration =
    "<think>Let me keep digging into the surname and the TikTok sec_uid.</think>\n" +
    "Going deeper — SoundCloud, KUSH LIFE brand, TikTok scraping, and carrier triangulation.\n" +
    "KUSH LIFE confirmed as a separate brand. Recording now and diving into the next reel. " +
    "x".repeat(MIN_REPORT_CHARS + 1);
  assertEquals(needsReportSalvage(narration, 12), true, "long narration, no report shape → salvage");
  // A real report (heading + findings table + tier labels) → no salvage.
  const report =
    "<think>internal reasoning</think>\n## Investigation Report\n\n" +
    "| # | Finding | Source | Tier |\n|---|---|---|---|\n" +
    "| 1 | Phone confirmed | linktr.ee | [CONFIRMED] |\n" +
    "Confidence: 92%. One gap remains on the surname [VERIFY].";
  assertEquals(needsReportSalvage(report, 12), false, "real report shape → no salvage");
  // Report shape even when short / label-only (grouped findings with tiers).
  assertEquals(
    needsReportSalvage("Findings: handle [CONFIRMED]; email [VERIFY]; alias [LOW]", 12),
    false,
    "≥2 tier labels → report shape",
  );
});

Deno.test("needsReportSalvage: zero-tool-call runs are classified, not blanket-skipped (P0-B)", () => {
  // THE PRODUCTION FAILURE (thread 40f8a6eb, 2026-07-26): the analyst sent the seed
  // `jdean785`, the model emitted the 10-character text "I'll start" with no tool
  // call, the SDK ended the loop on finishReason:"stop", and THAT became the run's
  // durable final message with the thread flipped to a green COMPLETE. The old
  // `toolCalls <= 0 -> return false` bail made the salvage backstop structurally
  // blind to exactly this case.
  assertEquals(needsReportSalvage("I'll start", 0), true, "10-char stub → salvage");
  assertEquals(needsReportSalvage("", 0), true, "no text at all → salvage");

  // But a COMPLETE conversational reply with no tool calls is a legitimate terminal
  // message and must be left alone — this is the real 907-char reply from the same
  // thread, one turn earlier. Salvaging it would staple a bogus Findings report onto
  // a plain answer.
  const conversational =
    "I don't have any context about what's been discovered in this conversation — " +
    "this appears to be a fresh session with no prior investigation state carried over. " +
    "To help you, I need a seed to investigate. What are you looking into? For example: " +
    "an email address, a username or handle, a phone number, a domain or URL, a person's " +
    "name plus location, a crypto wallet, an IP address, or attached files with leads in them. " +
    "Drop a seed and I'll run the investigation from TRIAGE through REPORT.";
  assert(conversational.length > MIN_TERMINAL_REPORT_CHARS, "fixture must clear the length floor");
  assertEquals(needsReportSalvage(conversational, 0), false, "complete conversational reply → leave alone");

  // REGRESSION PIN — why there is no future-intent regex (see orchestrator-finalize.ts).
  // A pattern matching promises of work ("let me now run…") was implemented and this
  // fixture killed it: the reply above legitimately CLOSES with "Drop a seed and I'll
  // run the investigation from TRIAGE through REPORT". Inferring intent from prose
  // fabricates a Findings report on top of a plain answer. If someone reintroduces
  // that heuristic, the assertion above fails.
  assert(/I'll run the investigation/.test(conversational), "fixture must retain the trap phrase");

  assertEquals(SALVAGE_ON_ZERO_TOOL_CALLS, true, "kill switch must ship on");
});

Deno.test("needsReportSalvage: artifacts prove the investigating phase even with no tool parts", () => {
  // Tool parts can be trimmed out of the message history on a long run; artifacts
  // already on the thread still prove work happened, so a report is owed.
  assertEquals(needsReportSalvage("short narration", 0, { artifactCount: 7 }), true);
});

Deno.test("needsReportSalvage: an explicit no-findings decision is terminal, never papered over", () => {
  // A validated finalize_no_findings IS a real outcome. Synthesizing a report over it
  // would invent a conclusion the run deliberately declined to make.
  assertEquals(needsReportSalvage("", 12, { hadNoFindingsDecision: true }), false);
  assertEquals(needsReportSalvage("I'll start", 0, { hadNoFindingsDecision: true }), false);
});

Deno.test("meetsCompletionContract: only a report or an explicit no-findings decision may present as complete", () => {
  const report = { role: "assistant", parts: [{ type: "text", text: "## Findings report\n\n| a | b |\n|:--|:--|\n| 1 | 2 |" }] };
  const stub = { role: "assistant", parts: [{ type: "text", text: "I'll start" }] };
  const decision = { role: "assistant", parts: [{ type: "tool-finalize_no_findings" }] };

  assertEquals(meetsCompletionContract([report]), true, "durable report → complete");
  assertEquals(meetsCompletionContract([decision]), true, "explicit no-findings → complete");
  assertEquals(meetsCompletionContract([stub]), false, "unfinished stub → NOT complete");
  assertEquals(meetsCompletionContract([]), false, "no assistant message at all → NOT complete");

  // Scoping: a PRIOR turn's report must not let this turn's stub pass the contract.
  assertEquals(meetsCompletionContract([report, stub]), false, "last assistant wins");
});

Deno.test("resolveTerminalState: a report that FAILED to persist can never be a green COMPLETE", () => {
  // BLOCKER 2. The contract claims "durable report". Evaluating it from the
  // in-memory message meant a perfectly report-shaped finalMessages whose INSERT
  // failed still wrote status=finished with recovery_reason=null — the analyst
  // reloads and the report is simply gone, shown as a successful investigation.
  const report = { role: "assistant", parts: [{ type: "text", text: "## Findings report\n\n| a | b |\n|:--|:--|\n| 1 | 2 |" }] };
  assertEquals(
    resolveTerminalState({ assistantRowPersisted: false, finalMessages: [report] }),
    { status: "finished", recoveryReason: REPORT_PERSIST_FAILED_REASON },
    "report-shaped but not persisted → Interrupted",
  );
  assertEquals(
    resolveTerminalState({ assistantRowPersisted: true, finalMessages: [report] }),
    { status: "finished", recoveryReason: null },
    "report-shaped AND persisted → normal completion",
  );
});

Deno.test("resolveTerminalState: every salvage failure mode lands Interrupted, never COMPLETE", () => {
  // The salvage backstop is best-effort and its exception is swallowed. Each way it
  // can come up short must still produce an honest terminal state.
  const cases: Array<[string, unknown]> = [
    ["salvage returned empty text", { role: "assistant", parts: [{ type: "text", text: "" }] }],
    ["salvage returned non-report prose", { role: "assistant", parts: [{ type: "text", text: "Let me now run the core breach and cross-platform tools in parallel." }] }],
    // A thrown salvage leaves the pre-salvage stub as the terminal message.
    ["salvage threw; stub remains", { role: "assistant", parts: [{ type: "text", text: "I'll start" }] }],
    // A thrown salvage with no assistant at all leaves nothing.
    ["no assistant message at all", null],
  ];
  for (const [label, msg] of cases) {
    const finalMessages = (msg ? [msg] : []) as Array<{ role?: string; parts?: Array<{ type?: string; text?: unknown }> }>;
    assertEquals(
      resolveTerminalState({ assistantRowPersisted: !!msg, finalMessages }).recoveryReason !== null,
      true,
      `${label} → must NOT present as complete`,
    );
  }

  // …and the one case that legitimately completes without a report.
  const decision = [{ role: "assistant", parts: [{ type: "tool-finalize_no_findings" }] }];
  assertEquals(
    resolveTerminalState({ assistantRowPersisted: true, finalMessages: decision }).recoveryReason,
    null,
    "a durably persisted explicit no-findings decision IS a normal completion",
  );
});

Deno.test("hasNoFindingsDecision: scoped to the last assistant, not thread history", () => {
  const decision = { role: "assistant", parts: [{ type: "tool-finalize_no_findings" }] };
  const later = { role: "assistant", parts: [{ type: "text", text: "hi" }] };
  assertEquals(hasNoFindingsDecision([decision]), true);
  assertEquals(hasNoFindingsDecision([decision, later]), false, "a prior turn's decision does not carry over");
});

Deno.test("stripReasoning: removes closed AND dangling <think> blocks", () => {
  assertEquals(stripReasoning("<think>reasoning</think>Report body"), "Report body");
  assertEquals(stripReasoning("a<think>x</think>b<think>y</think>c"), "abc");
  // Truncation-severed opener (no closing tag) → drop to end.
  assertEquals(stripReasoning("Visible.\n<think>cut off mid-thought"), "Visible.");
  assertEquals(stripReasoning("<THINK>upper</THINK>ok").trim(), "ok");
});

Deno.test("hasReportShape: heading OR findings table OR ≥2 tier labels", () => {
  assert(hasReportShape("## Investigation Report\nbody"), "report heading");
  assert(hasReportShape("### Findings\n- x"), "findings heading");
  assert(hasReportShape("| # | Finding |\n|---|---|\n| 1 | x |"), "markdown table separator");
  assert(hasReportShape("handle [CONFIRMED], email [VERIFY]"), "two tier labels");
  // Inter-step narration (the truncated-turn shape) is NOT a report.
  assert(!hasReportShape("Going deeper — SoundCloud, KUSH LIFE, and carrier triangulation."), "narration");
  assert(!hasReportShape("Recording now and diving into the next reel."), "narration 2");
  assert(!hasReportShape("Found one [CONFIRMED] hit so far."), "single tier label is not enough");
  assert(!hasReportShape(""), "empty");
});

Deno.test("FINALIZE_RESERVE_MS widened so a single long step can't jump the window", () => {
  // Regression for thread 92a7d650: a ~30s tool step starting before the reserve
  // opened jumped the old 45s window [195s,240s] and the run hard-stopped with no
  // report. The reserve must be comfortably wider than the longest single step.
  assert(FINALIZE_RESERVE_MS >= 90_000, `reserve should be ≥90s, got ${FINALIZE_RESERVE_MS}`);
  const openAt = ORCHESTRATOR_WALL_CLOCK_MS - FINALIZE_RESERVE_MS;
  assert(openAt <= 150_000, `finalize should open by ~150s, opens at ${openAt}`);
});

Deno.test("buildSalvageSynthesisPrompt: grounds strictly in the passed artifacts, no tools", () => {
  const p = buildSalvageSynthesisPrompt("jane@example.com", [
    { kind: "username", value: "jdoe", confidence: 80, source: "github" },
    { kind: "location", value: "Austin, TX", confidence: 60, source: "exif" },
  ]);
  assert(p.includes("jane@example.com"), "includes the seed");
  assert(p.includes("jdoe") && p.includes("github"), "includes artifact value + source");
  assert(p.includes("Austin, TX"), "includes second artifact");
  assert(/do not invent|only these|from only/i.test(p), "instructs no fabrication");
  assert(/do not call any tools|no tools/i.test(p), "instructs tool-free synthesis");
});

Deno.test("buildSalvageSynthesisPrompt: tolerates zero artifacts", () => {
  const p = buildSalvageSynthesisPrompt("bob@example.com", []);
  assert(p.includes("bob@example.com"), "still includes the seed");
  assert(typeof p === "string" && p.length > 0, "produces a usable prompt");
});
