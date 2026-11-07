/**
 * lib/findings-table-directive.ts — the closing-report instructions that ask for the ENGINE's
 * Findings table.
 *
 * WHY THIS FILE EXISTS: #974 made the server author the closing Findings table from the rows
 * the run persisted: the model writes `## Findings` then the single line `{{FINDINGS_TABLE}}`
 * and `persistFinalMessages` replaces it. The system prompt asks for that (system-prompt.ts),
 * but a report is written under one of two LATER instructions that never mentioned the marker
 * and asked the model to type "confirmed findings grouped by type with confidence and source":
 *
 *   - `buildFinalizeDirective()`        — the forced-finalize report phase
 *   - `buildSalvageSynthesisPrompt()`   — the post-loop salvage generation
 *
 * Those override the system prompt, so the model typed its own table and the engine table never
 * rendered (adoption measured 0 of 1, SESSION_HANDOFF_2026-11-07). This file owns the text both
 * now use. PROMPT TEXT ONLY: no toolChoice, stopWhen, phase gate, report-shape or salvage-trigger
 * change; the `## Findings` heading it asks for is what satisfies `hasReportShape` /
 * `REPORT_HEADING_RE` when the expansion decides whether the message is a report.
 *
 * KILL SWITCH: the SAME `FINDINGS_TABLE_EXPANSION_DISABLED=true` that turns the expansion off
 * (env.ts `findingsTableExpansionEnabled`). With it set, both directives return the previous
 * wording byte-for-byte, so the switch rolls back both prompts as well as the expansion and a
 * raw `{{FINDINGS_TABLE}}` line cannot reach a finalize/salvage report through THESE prompts.
 * (system-prompt.ts:173 still asks for the marker unconditionally; that is unchanged here.)
 *
 * Zero imports beyond the marker constant: orchestrator-finalize.ts is loaded by tests and by
 * the health probe, and env.ts drags the AI-SDK packages in. The env read is therefore local;
 * findings_table_directives_test.ts pins that it parses the variable exactly as env.ts does.
 */
import { FINDINGS_TABLE_MARKER } from "./findings-table.ts";

export const FINDINGS_TABLE_EXPANSION_DISABLED_ENV = "FINDINGS_TABLE_EXPANSION_DISABLED";

function readEnvSafe(k: string): string | undefined {
  try {
    return (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(k);
  } catch {
    return undefined;
  }
}

/** True unless the literal "true" (trimmed, case-insensitive) — the same parse as env.ts
 *  `findingsTableExpansionEnabled`. Read at CALL TIME so the switch needs no deploy. */
export function findingsTableDirectiveEnabled(env: (k: string) => string | undefined = readEnvSafe): boolean {
  return (env(FINDINGS_TABLE_EXPANSION_DISABLED_ENV) ?? "").trim().toLowerCase() !== "true";
}

// ---- finalize directive (orchestrator-finalize.ts buildFinalizeDirective) ------------------

/** Pre-change report instruction (two lines). Frozen: the rollback is asserted byte-for-byte. */
export const LEGACY_FINALIZE_REPORT_LINES: readonly string[] = [
  "Write the complete final Findings report as message text: a short summary, confirmed",
  "findings grouped by type with confidence and source, and all material gaps.",
];

/** The layout both directives show the model, one marker line directly under the heading. */
const LAYOUT_LINES: readonly string[] = ["## Findings", FINDINGS_TABLE_MARKER];

export const FINALIZE_REPORT_LINES: readonly string[] = [
  "Write the complete final Findings report as message text: a short summary, then the findings",
  "section laid out exactly as the next two lines (each on a line of its own, no backticks or other text):",
  ...LAYOUT_LINES,
  "The server replaces the second line with the findings table built from the evidence record.",
  "Do not type a findings table, tier labels or confidence numbers yourself. Then state all material gaps.",
];

// ---- salvage prompt (orchestrator-finalize.ts buildSalvageSynthesisPrompt) -----------------

/** Pre-change bullets of the salvage instruction block. Frozen, like the finalize lines. */
export const LEGACY_SALVAGE_REPORT_BULLETS: readonly string[] = [
  "- One short paragraph summarizing who or what was identified.",
  "- Confirmed findings grouped by type, each with its confidence and source.",
  "- Explicit gaps and unverified leads.",
];

export const SALVAGE_REPORT_BULLETS: readonly string[] = [
  "- One short paragraph summarizing who or what was identified.",
  "- The findings section, laid out exactly as the next two lines (each on a line of its own, no backticks or other text):",
  ...LAYOUT_LINES,
  "  The server replaces the second line with the findings table built from the evidence record. Do not type a findings table, tier labels or confidence numbers yourself.",
  "- Explicit gaps and unverified leads.",
];
