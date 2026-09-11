/**
 * report-export-gate.ts — is this report safe to hand to someone?
 *
 * PURE. Reads the EXISTING report-ready decision (`buildConfidenceProfile`'s
 * `reportReady`, unchanged) and turns it into an export mode plus the labels
 * every export must carry. It invents no threshold and changes no score.
 *
 * WHY. Production showed "Needs review · 0% corroboration · 2% report readiness"
 * beside five fully live export buttons. A 2%-ready report left the tool looking
 * exactly like a finished one: same filename, same cover, same Markdown. The gate
 * does not block the analyst — drafts are legitimate working documents — but it
 * makes a draft impossible to mistake for a report-safe product, on screen, on
 * paper, in the file name and inside the payload.
 */
import {
  REPORT_READY_MIN_CONFLICT_FREE,
  REPORT_READY_MIN_READINESS,
  type ConfidenceProfile,
} from "@/lib/confidence-dimensions";

export const DRAFT_MARK = "UNVERIFIED DRAFT";

export type ExportMode = "report-safe" | "draft";

export interface ExportGate {
  mode: ExportMode;
  /** Report readiness, 0–100, as the Confidence signals panel shows it. */
  readinessPct: number;
  /** Why the report is not report-safe, in plain words. Empty when it is. */
  reasons: string[];
  /** The marking for covers, filenames and payloads. */
  mark: typeof DRAFT_MARK | "REPORT-SAFE";
}

export function evaluateExportGate(profile: ConfidenceProfile | null): ExportGate {
  if (!profile) {
    return {
      mode: "draft",
      readinessPct: 0,
      reasons: ["The case has not finished loading, so readiness is unknown."],
      mark: DRAFT_MARK,
    };
  }
  const dim = (key: string) => profile.dimensions.find((d) => d.key === key);
  const readiness = dim("readiness")?.value ?? 0;
  if (profile.reportReady) {
    return { mode: "report-safe", readinessPct: readiness, reasons: [], mark: "REPORT-SAFE" };
  }
  const reasons: string[] = [];
  if (readiness < REPORT_READY_MIN_READINESS) {
    reasons.push(`Report readiness is ${readiness}% — report-safe needs ${REPORT_READY_MIN_READINESS}%.`);
  }
  const conflictFree = dim("conflictFree")?.value ?? 0;
  if (conflictFree < REPORT_READY_MIN_CONFLICT_FREE) {
    reasons.push(`Conflict-free is ${conflictFree}% — report-safe needs ${REPORT_READY_MIN_CONFLICT_FREE}%.`);
  }
  if (!dim("identity")?.sufficient) {
    reasons.push("No identity cluster is strong enough to anchor the subject.");
  }
  if (reasons.length === 0) reasons.push("The report-ready checks are not met.");
  return { mode: "draft", readinessPct: readiness, reasons, mark: DRAFT_MARK };
}

/** "osint-report-UNVERIFIED-DRAFT-<slug>.md" for a draft; unchanged when report-safe. */
export function exportFilename(base: string, slug: string, ext: string, gate: ExportGate): string {
  const tag = gate.mode === "draft" ? "UNVERIFIED-DRAFT-" : "";
  return `${base}-${tag}${slug}.${ext}`;
}

function markingLine(gate: ExportGate, generatedAt: string): string {
  return gate.mode === "draft"
    ? `> **${DRAFT_MARK}** — report readiness ${gate.readinessPct}% (report-safe needs ${REPORT_READY_MIN_READINESS}%). Not report-safe. Generated ${generatedAt}.`
    : `> **REPORT-SAFE** — report readiness ${gate.readinessPct}%. Generated ${generatedAt}.`;
}

/**
 * Mark a Markdown export. A draft carries the marking at the top AND the bottom,
 * the way a classified document is marked on both ends, so a copy that has been
 * cut down from either end still says what it is.
 */
export function markMarkdown(markdown: string, gate: ExportGate, generatedAt: string): string {
  const line = markingLine(gate, generatedAt);
  if (gate.mode === "report-safe") return `${line}\n\n${markdown}`;
  const why = gate.reasons.map((r) => `> - ${r}`).join("\n");
  return `${line}\n${why}\n\n${markdown.trimEnd()}\n\n---\n\n${line}\n`;
}

/**
 * JSON export envelope. The status travels INSIDE the payload — a filename is
 * lost the moment the data is pasted or re-saved.
 */
export function wrapJsonExport<T>(records: T[], gate: ExportGate, generatedAt: string): string {
  return JSON.stringify(
    {
      export_status: gate.mark,
      report_ready: gate.mode === "report-safe",
      report_readiness_pct: gate.readinessPct,
      not_report_safe_because: gate.reasons,
      generated_at: generatedAt,
      artifacts: records,
    },
    null,
    2,
  );
}
