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
import type { ReviewAvailability } from "@/lib/review";

export const DRAFT_MARK = "UNVERIFIED DRAFT";

/**
 * Report-ready, failing closed on the analyst's verdicts.
 *
 * `buildConfidenceProfile` reads verdicts as an input: a row the analyst
 * dismissed or marked wrong stops counting. While those verdicts are still
 * loading — or could not be read at all — an empty verdict map is
 * indistinguishable from "nothing was ever rejected", so a strong-looking case
 * could claim report-ready on evidence the analyst already threw out.
 *
 * Only `reportReady` is withheld; every score and dimension is left exactly as
 * computed. Returns the SAME object when nothing is withheld, so memoised
 * consumers do not churn.
 */
export function withReviewGate(profile: ConfidenceProfile, reviews: ReviewAvailability): ConfidenceProfile {
  return reviews === "ok" || !profile.reportReady ? profile : { ...profile, reportReady: false };
}

function reviewReason(reviews: ReviewAvailability): string | null {
  if (reviews === "unknown") return "Analyst verdicts are still loading, so evidence marked wrong or dismissed cannot be left out yet.";
  if (reviews === "unavailable") return "Analyst verdicts could not be read, so evidence marked wrong or dismissed cannot be left out.";
  return null;
}

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

/**
 * `reviews` is the analyst-verdict read state. Report-safe needs it to be "ok":
 * the gate fails closed on its own, whatever profile it is handed.
 */
export function evaluateExportGate(profile: ConfidenceProfile | null, reviews: ReviewAvailability): ExportGate {
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
  const verdicts = reviewReason(reviews);
  if (profile.reportReady && !verdicts) {
    return { mode: "report-safe", readinessPct: readiness, reasons: [], mark: "REPORT-SAFE" };
  }
  const reasons: string[] = [];
  if (verdicts) reasons.push(verdicts);
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
  const body = redactSecretsInText(markdown);
  if (gate.mode === "report-safe") return `${line}\n\n${body}`;
  const why = gate.reasons.map((r) => `> - ${r}`).join("\n");
  return `${line}\n${why}\n\n${body.trimEnd()}\n\n---\n\n${line}\n`;
}

/**
 * Export-time credential masking — independent of REVEAL_BREACH_DATA, which is
 * a settled workbench decision (CLAUDE.md) and stays on. A document that leaves
 * the app is a different surface: the production markdown + PDF export of
 * 2026-09-20 printed three breach passwords in the Artifact Table, the Network
 * section and the Timeline, because the extractor writes them into the artifact
 * VALUE ("password='…'", "passwords a b c"). The value is masked here, on the
 * way out, so the analyst still sees it in the workbench.
 *
 * Deliberately narrow: only text that announces itself as a password. A generic
 * token regex would eat handles and hashes the analyst needs in the export.
 */
export const SECRET_MASK = "[redacted]";
const PASSWORD_ASSIGN_RE = /\b(password|passwd|pwd|passcode)(s?)\s*(=|:)\s*(['"]?)([^\s'",;)\]]+)\4/gi;
const PASSWORD_FIELD_STOP = "name|names|phone|phones|email|emails|username|usernames|ip|zip|city|state|address|extracted";
const PASSWORDS_LIST_RE = new RegExp(
  `\\b(passwords?)\\s+(?!(?:${PASSWORD_FIELD_STOP})\\b)([^\\s;,)]+(?:[ \\t]+(?!(?:${PASSWORD_FIELD_STOP})\\b)[^\\s;,)]+)*)`,
  "gi",
);

export function redactSecretsInText(text: string): string {
  if (!text) return text;
  return text
    .replace(PASSWORD_ASSIGN_RE, (_m, k: string, plural: string, sep: string) => `${k}${plural}${sep}${SECRET_MASK}`)
    // "passwords djpueo2001 pueoluv1 pueoluv@1; name …" → "passwords [redacted]; name …"
    .replace(PASSWORDS_LIST_RE, (_m, k: string) => `${k} ${SECRET_MASK}`);
}

const SECRET_KEY_RE = /^(passwords?|passwd|pwd|passcode|extracted_password|password_hash|hash(?:es)?|plaintext)$/i;

/** Deep-copy `value`, masking secret-named keys and password phrases in strings. */
export function redactSecretsDeep<T>(value: T): T {
  if (typeof value === "string") return redactSecretsInText(value) as T;
  if (Array.isArray(value)) return value.map((v) => redactSecretsDeep(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) ? (Array.isArray(v) ? v.map(() => SECRET_MASK) : SECRET_MASK) : redactSecretsDeep(v);
    }
    return out as T;
  }
  return value;
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
      artifacts: redactSecretsDeep(records),
    },
    null,
    2,
  );
}
