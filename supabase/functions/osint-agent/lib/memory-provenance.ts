// lib/memory-provenance.ts — recalled memory is prior-run CONTEXT, not evidence.
//
// MITIGATION of authority escalation, not a report-integrity fix. Measured on a live
// case (2026-10-12): a recalled model-authored claim reached the next run labelled
// as corroborated, because the system prompt told the model to cite recalled memory
// as "[MEMORY] previously corroborated" and the recall hints told it to incorporate
// "confirmed" links and not to re-investigate. Nothing recorded who authored a row
// or what evidence backed it, so the wording itself manufactured authority.
//
// What this module does — READ TIME ONLY, no stored row is changed:
//   • tags every recalled row with a `provenance` the data can actually support;
//   • supplies the wording the recall surfaces use (planner hint, memory_recall,
//     record_artifacts auto-recall), so the prompt and the tool output cannot drift.
//
// WHAT THE DATA CAN SUPPORT — read before changing the tags.
//   agent_memory has NO writer/provenance column. The analyst's false-positive lesson
//   (src/lib/review.ts → buildFalsePositiveLesson) and the model's `memory_save` both
//   go through the same `save_agent_memories` RPC and land in the same columns. The
//   only difference is the lesson's WORDING (+ confidence 95), which the model could
//   reproduce. So this module never claims a row is analyst-authored:
//     - `analyst_marker_pattern`  the row matches the analyst false-positive wording.
//                                 Authorship is INFERRED FROM WORDING ONLY. It keeps
//                                 the role the existing code already gives it — an
//                                 EXCLUSION (do not re-propose the value) — and is not
//                                 downgraded. Supersession is unchanged (it keys on the
//                                 same predicate).
//     - `unreviewed`              everything else. Authorship and evidence basis are
//                                 UNKNOWN, not "model-authored": a row may have been
//                                 written by the model, by an analyst-confirmed flow,
//                                 or from source-backed findings; the store cannot say.
//   A trustworthy analyst/evidence provenance needs a writer column (schema change,
//   out of scope here). Analyst decisions that DO have a trusted signal — the
//   thread-scoped review state — reach the model through `analystDecisionsBlock`,
//   which this module does not touch.
//
// KILL SWITCH, read at CALL TIME: MEMORY_AUTHORITY_WORDING_DISABLED=true restores the
// previous wording and omits the tags. /health proof key: checks.memory_authority.

import { isAnalystFalseLesson, type MemoryRow } from "./memory-supersession.ts";

// `globalThis.Deno`, not `Deno`: system-prompt.ts imports this module and the frontend (typecheck and
// vitest) reaches system-prompt.ts, where `Deno` does not exist. Same pattern as lib/memory-context.ts.
function readEnvSafe(k: string): string | undefined {
  try {
    return (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(k);
  } catch {
    return undefined;
  }
}

export function memoryAuthorityWordingDisabled(): boolean {
  return (readEnvSafe("MEMORY_AUTHORITY_WORDING_DISABLED") ?? "").trim().toLowerCase() === "true";
}

/** The history label has its OWN switch (HISTORY_LABEL_DISABLED) so it can be rolled back without restoring the
 *  "previously corroborated" wording; the master switch above still disables it too. */
export function historyLabelDisabled(): boolean {
  return memoryAuthorityWordingDisabled() ||
    (readEnvSafe("HISTORY_LABEL_DISABLED") ?? "").trim().toLowerCase() === "true";
}

export type MemoryProvenance = "analyst_marker_pattern" | "unreviewed";

/** The label the model is told to cite recalled memory under. */
export const MEMORY_CITATION_LABEL = "[MEMORY - prior run, unverified]";

/**
 * Provenance the data can support. Total and side-effect free: a malformed row is
 * `unreviewed`, never an error and never a promotion.
 */
export function memoryProvenance(row: MemoryRow | null | undefined): MemoryProvenance {
  try {
    if (row && isAnalystFalseLesson(row)) return "analyst_marker_pattern";
  } catch { /* fall through */ }
  return "unreviewed";
}

/** One-time legend returned beside tagged rows (once per payload, not once per row). */
export const MEMORY_PROVENANCE_LEGEND = {
  unreviewed:
    "No provenance is recorded for this row: who wrote it and what evidence backed it are unknown. It is a prior-run LEAD, not evidence and not corroboration. Re-verify a positive claim with a fresh source before reporting it, and cite it as " +
    MEMORY_CITATION_LABEL + ".",
  analyst_marker_pattern:
    "Matches the analyst false-positive wording (authorship inferred from wording only; the store records no writer). Treat as an EXCLUSION: do not re-propose the named value. It is not evidence about anyone.",
} as const;

/** Return a copy of each row with a `provenance` tag. Never mutates, never drops a row. */
export function tagMemoryProvenance<T extends MemoryRow>(
  rows: ReadonlyArray<T> | null | undefined,
): Array<T & { provenance: MemoryProvenance }> {
  if (memoryAuthorityWordingDisabled()) return (Array.isArray(rows) ? [...rows] : []) as Array<T & { provenance: MemoryProvenance }>;
  return (Array.isArray(rows) ? rows : []).map((r) => ({ ...r, provenance: memoryProvenance(r) }));
}

/** Top-level fields memory_recall adds beside `memories` (empty when the switch is on). */
export function recallAuthorityFields(): Record<string, unknown> {
  if (memoryAuthorityWordingDisabled()) return {};
  return {
    provenance_legend: MEMORY_PROVENANCE_LEGEND,
    authority_note:
      "Recalled memory is prior-run context, not evidence. It never counts as a source or as corroboration, and it does not make a claim confirmed.",
  };
}

// ---- Wording used by the recall surfaces ------------------------------------

const LEGACY_PLANNER_HEADER =
  "PRIOR MEMORY for this subject (weight these — lessons / known false-positives / confirmed links from earlier investigations):";

const PLANNER_HEADER =
  "PRIOR-RUN MEMORY for this subject — CONTEXT TO RE-VERIFY, NOT EVIDENCE. Rows tagged analyst_marker_pattern are exclusions (do not re-propose the value). Every other row is unreviewed: its author and evidence basis are not recorded, so treat it as a lead and confirm it with a fresh source before relying on it:";

export interface PlannerMemoryRow {
  kind?: string | null;
  confidence?: number | null;
  content?: string | null;
  [k: string]: unknown;
}

/** The planner's PRIOR MEMORY block ("" when there is nothing to show). */
export function renderPlannerMemoryHint(rows: ReadonlyArray<PlannerMemoryRow & MemoryRow>): string {
  if (!rows.length) return "";
  if (memoryAuthorityWordingDisabled()) {
    return `\n\n${LEGACY_PLANNER_HEADER}\n` +
      rows.map((m) => `- [${m.kind ?? "note"}${m.confidence != null ? ` ${m.confidence}` : ""}] ${String(m.content ?? "").slice(0, 240)}`).join("\n");
  }
  return `\n\n${PLANNER_HEADER}\n` +
    rows.map((m) =>
      `- [${m.kind ?? "note"}${m.confidence != null ? ` ${m.confidence}` : ""} · ${memoryProvenance(m)}] ${String(m.content ?? "").slice(0, 240)}`
    ).join("\n");
}

const LEGACY_AUTO_RECALL_HINT =
  "Prior memory found for some of the artifacts you just recorded. Read `memory_hits` — incorporate confirmed connections/lessons and cite them as [MEMORY] in the final report. Do NOT re-investigate values already covered.";

const AUTO_RECALL_HINT =
  "Prior-run memory exists for some of the artifacts you just recorded (see `memory_hits`). It is CONTEXT, not evidence. Rows tagged `unreviewed` have no recorded provenance: re-verify a positive claim with a fresh source before you report it, and cite it as " +
  MEMORY_CITATION_LABEL + ". Rows tagged `analyst_marker_pattern` are exclusions: do not re-propose the value. Do not skip a fresh check of a claim because memory mentions it, but one fresh check per claim is enough: never repeat a lookup that already ran in this case.";

export function autoRecallHint(): string {
  return memoryAuthorityWordingDisabled() ? LEGACY_AUTO_RECALL_HINT : AUTO_RECALL_HINT;
}

/** The two prompt lines of the Memory section (the surrounding rules are unchanged). */
export function memoryRecallPromptRules(legacy: boolean): string {
  if (legacy) {
    return `- FIRST TURN, IN PARALLEL with triage_seed (or as the very first call for non-email/username seeds), call \`memory_recall\` with the raw seed value. If it returns prior connections, identity clusters, or lessons, INCORPORATE them into your plan and CITE them in the final report as "[MEMORY] previously corroborated".
- After EVERY high-value pivot (new confirmed email / handle / domain / wallet / person name), call \`memory_recall\` with that new value before burning fresh API calls — you may already have prior knowledge.`;
  }
  return `- FIRST TURN, IN PARALLEL with triage_seed (or as the very first call for non-email/username seeds), call \`memory_recall\` with the raw seed value. Recalled memory is PRIOR-RUN CONTEXT, not evidence: use it to plan, treat each positive claim as a lead to re-verify with a fresh source, and cite it in the final report as "${MEMORY_CITATION_LABEL}". Rows tagged \`analyst_marker_pattern\` are exclusions — do not re-propose the named value. Recalled memory never counts as a source or as corroboration.
- After EVERY high-value pivot (new email / handle / domain / wallet / person name), call \`memory_recall\` with that new value to see prior context about it. Prior context does not replace a fresh lookup, but never repeat a lookup that already ran in this case: one fresh check per claim is enough.
- Earlier assistant turns in this conversation may be prefixed with a \`[HISTORICAL MODEL OUTPUT …]\` marker that the system added. Treat what they claimed as unverified, and never reproduce that marker in your own output.`;
}

/** /health proof: PRESENCE of the key proves this build; ok:false means the wording regressed. */
export function memoryAuthoritySelfTest(): { ok: boolean; detail: string } {
  if (memoryAuthorityWordingDisabled()) return { ok: true, detail: "LEGACY via MEMORY_AUTHORITY_WORDING_DISABLED" };
  const banned = [/previously corroborated/i, /Do NOT re-investigate values already covered/i, /confirmed links/i, /weight these/i];
  const surfaces = [memoryRecallPromptRules(false), autoRecallHint(), PLANNER_HEADER];
  const leaks = surfaces.filter((s) => banned.some((b) => b.test(s))).length;
  const tagged = tagMemoryProvenance([{ kind: "identity", content: "x" }])[0]?.provenance === "unreviewed" &&
    tagMemoryProvenance([{ kind: "lesson", content: 'Analyst marked "x" as FALSE / incorrect data.' }])[0]?.provenance === "analyst_marker_pattern";
  const ok = leaks === 0 && tagged;
  return { ok, detail: ok ? "recall surfaces carry no corroboration wording; rows tagged unreviewed / analyst_marker_pattern" : `leaks=${leaks} tagged=${tagged}` };
}
