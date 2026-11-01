// lib/finding-prompt.ts — an ARTIFACT is an observation; a FINDING is an adjudicated claim.
//
// WHY (docs/AUDIT_2026-11-01_record-finding-gap-and-hitsticktaxfree-scan.md §3 and §6 item 3):
// `record_finding` is the only tool whose rows the scoring engine adjudicates, and finding rows
// (kind === "finding") are the only rows the authoritative Evidence Record block (#479,
// lib/evidence-record.ts) renders into the stored report. Measured 2026-11-01: it ran in 3 of 168
// runs in 14 days, so ~98% of stored reports carry model-asserted labels no engine scored and the
// block reads "no finding rows". The audit found the skip STRUCTURAL, in the wording the model
// reads: the system prompt said "a finding only exists once it is in record_artifacts", the
// closing-table rule pointed at record_artifacts, the workflow addendum made record_finding
// optional ("may run"), and finalize_no_findings described itself as "every tool-supported finding
// is already persisted" — thread 4c2df3b6-5558-43f1-ae04-ffcc88e0cd39 called it with reason
// all_supported_findings_already_persisted having recorded no finding at all. The model did what
// it was told.
//
// WHAT THIS MODULE IS: the wording for the surfaces that carried the conflation — the system
// prompt's Recording sentence and closing-table rule, the workflow addendum, the finalize persist
// directive, and the finalize_no_findings tool description — in BOTH the pre-change form and the
// replacement, plus the kill switch that picks between them. It is a LEAF (no imports) so
// system-prompt.ts, workflow_prompt.ts, orchestrator-finalize.ts and tool-registry.ts can all import
// it without a cycle, and it reads env through globalThis because the frontend vitest suites import
// system-prompt.ts where `Deno` does not exist (same pattern as lib/memory-provenance.ts).
//
// WHAT IT IS NOT: enforcement. A prompt rule is not enforcement (CLAUDE.md). Nothing here changes
// FINALIZE_*_ACTIVE_TOOLS, countFinalizeProgress, lib/confidence.ts, lib/finding-row.ts or the
// record_finding implementation, and record_finding stays OUT of the finalize window on purpose —
// that window owns this project's worst incidents. Whether the call rate moves is a runtime
// measurement over tool_usage_log (the audit's §2 query), which /health cannot prove.
//
// finalize_no_findings keeps its wire contract (name, reason enum, return shape). Its description is
// re-written as what the tool operationally IS — the ARTIFACT-persistence decision of the finalize
// persist phase, where record_finding is not offered — rather than as a claim about findings.
//
// KILL SWITCH, read at CALL TIME: FINDING_PROMPT_V2_DISABLED=true restores the pre-change wording
// verbatim on every surface, no deploy needed. /health proof key: checks.finding_prompt — PRESENCE
// proves the deployed bundle carries this module, `switch` names the env var, ok:false means a
// rendered surface lost its wording. finding_prompt_test.ts pins every string below.

export const FINDING_PROMPT_V2_DISABLED_ENV = "FINDING_PROMPT_V2_DISABLED";

function readEnvSafe(k: string): string | undefined {
  try {
    return (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(k);
  } catch {
    return undefined;
  }
}

/** True only for the literal "true" (trimmed, case-insensitive), like MEMORY_AUTHORITY_WORDING_DISABLED. */
export function findingPromptV2Disabled(env: (k: string) => string | undefined = readEnvSafe): boolean {
  return (env(FINDING_PROMPT_V2_DISABLED_ENV) ?? "").trim().toLowerCase() === "true";
}

// ---- Surface 1: system-prompt.ts ------------------------------------------------------------------

/** Pre-change tail of the "RECORD INCREMENTALLY" bullet in the Recording section. */
export const LEGACY_RECORDING_FINDING_SENTENCE =
  "Your narration and the Findings prose are NOT a substitute for structured evidence: a finding only exists once it is in `record_artifacts`.";

export const RECORDING_FINDING_SENTENCE =
  "Your narration and the Findings prose are NOT a substitute for structured evidence. Two writers, two different things: " +
  "`record_artifacts` persists ARTIFACTS — observations a tool returned (a selector, an infra record, a breach hit) — and " +
  "`record_finding` persists FINDINGS — adjudicated claims about the subject, each citing the artifacts and source tools that support it. " +
  "Recording an artifact never makes it a finding; a finding exists ONLY once it is in `record_finding`. " +
  "The server scores every finding itself: the confidence and label you pass are advisory, and the call returns the label it applied (`applied_label`).";

/** Pre-change closing-table rule in the Output discipline section (whole bullet). */
export const LEGACY_CLOSING_TABLE_RULE =
  "- Every Findings-table row MUST correspond to an artifact you already persisted via `record_artifacts` this run — the table is a VIEW of recorded artifacts, never a substitute for recording them. Record findings as you go (see Recording); the closing table just renders what is already persisted.";

export const CLOSING_TABLE_RULE =
  "- Every Findings-table row MUST correspond to a finding you already persisted via `record_finding` this run, and every artifact a row cites must already be in `record_artifacts` — " +
  "the table is a VIEW of recorded findings, never a substitute for recording them. " +
  "The Evidence Record block appended to the stored report renders `record_finding` rows and nothing else: a claim that reached only your prose or `record_artifacts` is not in it. " +
  "Record findings as you go (see Recording); the closing table just renders what is already persisted.";

// ---- Surface 2: workflow_prompt.ts ----------------------------------------------------------------

/** Pre-change line in the ADVISORY WORKFLOW section — the one that made record_finding optional. */
export const LEGACY_WORKFLOW_FINDING_LINE =
  "- `record_finding` may run whenever source-backed evidence exists. Each finding still needs named sources, drivers, reducers, contradictions, unresolved questions, and next pivots.";

/** Replacement: a required step of the main loop, appended to the ARTIFACT vs FINDING section (where it belongs). */
export const WORKFLOW_FINDING_STEP = [
  "- `record_artifacts` writes artifacts; `record_finding` writes findings. They are different tools for different things, and only `record_finding` rows are scored by the server and shown in the report's Evidence Record. An artifact cluster is NOT a finding until you call `record_finding` for it.",
  "- REQUIRED STEP of the main investigation loop, not a finalize task: the moment any cluster is supported by TWO OR MORE independent source classes (e.g. a breach corpus AND a live profile — not two mirrors of one leak), call `record_finding` for that cluster BEFORE you move to the next pivot and before any finalize phase. It is a free recording tool, exempt from the run budget like `record_artifacts`, so budget is never a reason to skip it. `record_finding` is not offered inside finalize, so a finding you did not record during the loop is a gap the report must disclose. Pass the supporting source tools, the supporting artifact values, named drivers and reducers, any contradictions and what remains unresolved; the server scores it and returns `applied_label`.",
  "- A cluster below the bar stays an artifact cluster, labelled as such. Never call `record_finding` to make the Evidence Record non-empty, and never carry an unrecorded cluster into the report as \"confirmed\".",
  "- Synthetic example: `record_finding({ conclusion: \"example_user and alias@example.test are operated by the same account holder\", cluster_label: \"Cluster A\", supporting_sources: [\"username_sweep\", \"rapidapi_breach_search\"], supporting_artifact_values: [\"example_user\", \"alias@example.test\"], drivers: [\"handle reused as the email local part\", \"breach row ties the email to the handle\"], reducers: [\"handle is a dictionary word\"], contradictions: [], unresolved: [\"no profile page names the owner\"] })`.",
].join("\n");

// ---- Surface 3: orchestrator-finalize.ts (persist directive) + tool-registry.ts (tool description) ----

/** Pre-change decision lines of buildFinalizePersistDirective(). */
export const LEGACY_FINALIZE_PERSIST_DECISION_LINES: readonly string[] = [
  "- Call record_artifacts with every tool-supported finding not yet persisted; OR",
  "- Call finalize_no_findings with a short reason if there is genuinely no additional",
  "  supported finding to persist.",
];

export const FINALIZE_PERSIST_DECISION_LINES: readonly string[] = [
  "- Call record_artifacts with every tool-supported ARTIFACT not yet persisted; OR",
  "- Call finalize_no_findings with a short reason if there is genuinely no additional",
  "  tool-supported artifact to persist. This is an ARTIFACT decision: persisted artifacts",
  "  are not findings, record_finding is not offered in this phase, and a finding you did",
  "  not record during the investigation is a gap for the report to state, not something",
  "  to invent here.",
];

/** Pre-change finalize_no_findings tool description (tool-registry.ts), as one string. */
export const LEGACY_FINALIZE_NO_FINDINGS_DESCRIPTION =
  "Finalize-only decision: declare that every tool-supported finding is already persisted. " +
  "Never call during normal investigation work.";

export const FINALIZE_NO_FINDINGS_DESCRIPTION =
  "Finalize-only persistence decision about ARTIFACTS: declare that nothing further remains for record_artifacts to persist in this phase. " +
  "It makes no claim about findings. Persisted artifacts are NOT findings: record_artifacts stores observations, record_finding stores " +
  "adjudicated claims, and only record_finding rows reach the report's Evidence Record. record_finding is not available in this phase, so a " +
  "cluster that clears the two-independent-source bar with no finding row is a gap to disclose in the report, not something this call closes. " +
  "reason: all_supported_findings_already_persisted = every tool-supported artifact is already recorded; no_tool_supported_findings = no " +
  "tool-supported artifact exists to record. Never call during normal investigation work.";

// ---- /health self-test ------------------------------------------------------------------------------

export interface FindingPromptSurfaces {
  /** lib/base-prompt.ts staticSystemPrompt() — the static prompt that ships on every cycle. */
  systemPrompt: string;
  /** workflow_prompt.ts buildWorkflowAddendum(seedType). */
  workflowAddendum: string;
  /** orchestrator-finalize.ts buildFinalizePersistDirective(). */
  persistDirective: string;
}

const LEGACY_SENTENCES = [
  LEGACY_RECORDING_FINDING_SENTENCE,
  LEGACY_CLOSING_TABLE_RULE,
  LEGACY_WORKFLOW_FINDING_LINE,
  LEGACY_FINALIZE_PERSIST_DECISION_LINES.join("\n"),
];

/**
 * Pure probe over the RENDERED surfaces the caller passes in (health-handler.ts renders them with the
 * real builders). PRESENCE of `checks.finding_prompt` proves the deployed bundle; ok:false means a
 * surface lost its wording. It proves the wording shipped — NOT that the model calls record_finding
 * more often; that is a tool_usage_log measurement.
 */
export function findingPromptSelfTest(s: FindingPromptSurfaces): { ok: boolean; switch: string; detail: string } {
  if (findingPromptV2Disabled()) {
    const legacyOk = s.systemPrompt.includes(LEGACY_RECORDING_FINDING_SENTENCE) &&
      s.systemPrompt.includes(LEGACY_CLOSING_TABLE_RULE) &&
      s.workflowAddendum.includes(LEGACY_WORKFLOW_FINDING_LINE) &&
      s.persistDirective.includes(LEGACY_FINALIZE_PERSIST_DECISION_LINES.join("\n"));
    return {
      ok: legacyOk,
      switch: FINDING_PROMPT_V2_DISABLED_ENV,
      detail: legacyOk
        ? "LEGACY via FINDING_PROMPT_V2_DISABLED: pre-change wording on system prompt, workflow addendum and persist directive"
        : "LEGACY via FINDING_PROMPT_V2_DISABLED, but a rendered surface lost the pre-change wording",
    };
  }
  const missing: string[] = [];
  if (!s.systemPrompt.includes(RECORDING_FINDING_SENTENCE) || !s.systemPrompt.includes(CLOSING_TABLE_RULE)) missing.push("system_prompt");
  if (!s.workflowAddendum.includes(WORKFLOW_FINDING_STEP)) missing.push("workflow_addendum");
  if (!s.persistDirective.includes(FINALIZE_PERSIST_DECISION_LINES.join("\n"))) missing.push("persist_directive");
  const surfaces = [s.systemPrompt, s.workflowAddendum, s.persistDirective];
  const leaks = LEGACY_SENTENCES.filter((legacy) => surfaces.some((text) => text.includes(legacy))).length;
  const ok = missing.length === 0 && leaks === 0;
  return {
    ok,
    switch: FINDING_PROMPT_V2_DISABLED_ENV,
    detail: ok
      ? "artifact (record_artifacts, an observation) vs finding (record_finding, server-scored, the only rows in the Evidence Record) " +
        "distinct on system prompt, workflow addendum and persist directive; finalize_no_findings re-described as the artifact decision " +
        "(pinned by finding_prompt_test.ts). Proves the wording shipped, not that the model follows it."
      : `missing=${missing.join(",") || "none"} legacy_leaks=${leaks}`,
  };
}
