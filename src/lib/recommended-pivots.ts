import { detectSeed } from "@/lib/seed";
import { isInfraDomain, type Pivot, type PivotType } from "@/lib/intel";
import { looksLikeReasoning, stripInlineTags, stripReasoningMarkup } from "@/lib/sanitize-agent-text";

export type RecommendedPivot = {
  label: string;
  actionLabel: string;
  detail: string;
  reason: string;
  priority: "high" | "medium" | "low";
  prompt: string;
  value: string;
  type: PivotType;
};

const HEADING_RE = /recommended\s+(?:next\s+)?pivots?/i;
const NEXT_HEADING_RE = /^(?:#{1,6}\s+|(?:summary|findings|network|sources|limitations|conclusion|next steps)\s*:?\s*$)/i;

function cleanLine(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/\*\*/g, "")
    .trim();
}

const EMAIL_RE = /[^\s@]+@[^\s@]+\.[^\s@]+/i;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const USERNAME_RE = /@[a-z0-9_.-]{2,40}\b/i;
const URL_RE = /\bhttps?:\/\/[^\s)]+/i;
const DOMAIN_RE = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/i;
const PHONE_RE = /\b(?:\+?1[-.\s]*)?(?:\(?\d{3}\)?[-.\s]*)\d{3}[-.\s]*\d{4}\b/;
const STREET_RE = /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Ln|Lane|Blvd|Boulevard|Ct|Court|Way|Place|Pl|Pkwy|Parkway)\b[^.;]*/i;
const WALLET_RE = /\b(?:0x[a-f0-9]{40}|[13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-z0-9]{20,})\b/i;
const SECRET_RE = /\b(password|passcode|plaintext|secret|token|cookie|session|ssid|credential|hash|2fa|otp|cvv|ssn)\b/i;
const MINOR_RE = /\b(minor|underage|child|teen)\b/i;
const COLLISION_RE = /\b(excluded|collision|namesake|unrelated|wrong person|not the same person)\b/i;

function compact(text: string): string {
  return text.replace(/\s+/g, " ").replace(/\s+([,.;:])/g, "$1").trim();
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[),.;:]+$/, "").trim();
}

function extractTarget(label: string): string {
  const directIdentifier =
    label.match(EMAIL_RE)?.[0] ??
    label.match(IPV4_RE)?.[0] ??
    label.match(URL_RE)?.[0] ??
    label.match(USERNAME_RE)?.[0] ??
    label.match(PHONE_RE)?.[0] ??
    label.match(STREET_RE)?.[0] ??
    label.match(WALLET_RE)?.[0] ??
    label.match(DOMAIN_RE)?.[0];
  if (directIdentifier) return stripTrailingPunctuation(directIdentifier);

  const action = label.match(
    /^(?:investigate|pivot on|verify|cross-reference|check|review|corroborate|confirm|compare)\s+(.+?)(?:\s+[—–]\s+|\s+\b(?:with|against|via|using|through|from)\b|$)/i,
  )?.[1];
  return stripTrailingPunctuation(
    (action ?? label)
      .replace(/^(?:excluded collision|collision|excluded)\s+/i, "")
      .replace(/['’]s\b.*$/i, "")
      .replace(/^["'`]|["'`]$/g, "")
      .trim(),
  );
}

function isAddressLike(value: string, label: string): boolean {
  return STREET_RE.test(value) || /\b(address|assessor|property|parcel|tax)\b/i.test(label);
}

function priorityForRecommendation(label: string, value: string, type: PivotType): RecommendedPivot["priority"] {
  const text = `${label} ${value}`.toLowerCase();
  if (
    type === "email" ||
    type === "phone" ||
    type === "domain" ||
    /\bofficial|assessor|property|tax|court|record|registry|breach|correlat|verify\b/.test(text)
  ) return "high";
  if (type === "name" || type === "username" || /\bsocial|platform|profile|source|archive\b/.test(text)) return "medium";
  return "low";
}

function pivotType(value: string): PivotType {
  const kind = detectSeed(value)?.kind;
  if (kind === "crypto") return "wallet";
  if (kind === "other" || !kind) return "name";
  return kind;
}

function isBlockedRecommendation(label: string, value: string): boolean {
  if (!value) return true;
  if (SECRET_RE.test(label) || SECRET_RE.test(value)) return true;
  if (MINOR_RE.test(label) || MINOR_RE.test(value)) return true;
  return false;
}

function splitReason(label: string): { title: string; reason: string } {
  const [head, ...tail] = label.split(/\s+[—–-]\s+/);
  return {
    title: compact(head || label),
    reason: compact(tail.join(" — ")) || compact(head || label),
  };
}

function actionLabelForRecommendation(label: string, value: string, type: PivotType): string {
  if (COLLISION_RE.test(label)) return "Review excluded collision";
  if (type === "email") return "Verify email ownership";
  if (type === "phone") return "Check phone association";
  if (isAddressLike(value, label)) return "Corroborate address";
  if (type === "domain" || type === "url") return "Review domain footprint";
  if (type === "ip") return "Check IP attribution";
  if (type === "username") return "Verify username linkage";
  if (/\b(property|assessor|court|registry|record|official)\b/i.test(label)) return "Corroborate with independent records";
  return "Review lead";
}

function detailForRecommendation(actionLabel: string, value: string, reason: string): string {
  const detail = compact(reason);
  if (!detail || detail.toLowerCase() === actionLabel.toLowerCase()) return value;
  if (detail.toLowerCase().includes(value.toLowerCase())) return detail;
  return `${value} · ${detail}`;
}

export function extractRecommendedPivots(text: string): RecommendedPivot[] {
  // Strip agent chain-of-thought before parsing: the report text can carry
  // <think>…</think> blocks (model reasoning), and the chat renderer removes
  // them but this parser previously read the raw text, so reasoning lines leaked
  // into Next Steps cards. Sanitize once here so cards never show it.
  const lines = stripReasoningMarkup(text).split(/\r?\n/);
  const start = lines.findIndex((line) => HEADING_RE.test(cleanLine(line)));
  if (start < 0) return [];

  const pivots: RecommendedPivot[] = [];
  const seen = new Set<string>();
  for (const rawLine of lines.slice(start + 1)) {
    const line = cleanLine(rawLine);
    if (!line) continue;
    if (NEXT_HEADING_RE.test(line)) break;
    // Skip markdown table delimiter rows (|---|---|…), column-separator rows, and
    // horizontal rules — they are table formatting, not pivot data. When the
    // report renders recommended pivots as a table, the separator row otherwise
    // leaks through as a bogus pivot whose Target/Reason render as "|---|---|---|".
    if (/^[\s|:_-]*-[\s|:_-]*$/.test(line)) continue;
    // Defense-in-depth: drop any first-person reasoning line that survived
    // block stripping (e.g. a malformed/unterminated think block).
    if (looksLikeReasoning(line)) continue;
    // Verb list kept in sync with extractTarget()'s — a pivot line that happens
    // to end with ":" (e.g. "Corroborate the PO Box:") must not be mistaken for a
    // section heading and stop extraction early.
    if (line.endsWith(":") && !/^(?:investigate|pivot|verify|cross-reference|check|review|corroborate|confirm|compare)\b/i.test(line)) break;

    const value = extractTarget(line);
    const key = line.toLowerCase();
    if (seen.has(key) || isBlockedRecommendation(line, value)) continue;
    seen.add(key);
    const split = splitReason(line);
    const type = pivotType(value);
    // Report-recommended domains that are OSINT source infrastructure
    // (linkedin.com, bizfileonline.sos.ca.gov, opencorporates.com…) bypass
    // buildPivots' filter, so drop them here too — they are never actionable
    // "Review domain footprint" pivots.
    if ((type === "domain" || type === "url") && isInfraDomain(value)) continue;
    const priority = priorityForRecommendation(line, value, type);
    const actionLabel = actionLabelForRecommendation(line, value, type);
    const reason = stripInlineTags(split.reason);
    const detail = stripInlineTags(detailForRecommendation(actionLabel, value, reason));
    pivots.push({
      label: stripInlineTags(line),
      actionLabel,
      detail,
      reason,
      priority,
      prompt: `Run this ${priority}-priority pivot.\n\nAction: ${actionLabel}\nTarget: ${value}\nType: ${type}\nReason: ${reason}\n\nUse authorized public-source methods only. Corroborate with independent sources when possible. RECORD every confirmed or observed finding via record_artifacts BEFORE you summarize — never report a case-graph change you have not recorded. Then give source URLs and a confidence tier for each finding.`,
      value,
      type,
    });
    if (pivots.length >= 6) break;
  }
  return pivots;
}

/**
 * Per-thread localStorage key for pivots the user explicitly skipped. This is
 * the ONLY pivot persistence: report recommendations are NEVER cached (they are
 * recomputed live from the latest assistant message via the
 * `swarmbot:report-pivots` event) so the Next-steps surface can never freeze.
 */
export function pivotSkipStorageKey(threadId: string): string {
  return `proximity:pivot-skip:${threadId}`;
}

export function toDisplayPivots(recommendations: RecommendedPivot[]): Pivot[] {
  return recommendations.map((recommendation, index) => ({
    value: recommendation.value,
    type: recommendation.type,
    why: recommendation.reason,
    source: "Report recommendation",
    sourceArtifactId: `report-pivot-${index}`,
    confidence: 0,
    fanout: recommendation.actionLabel,
    status: "new",
  }));
}
