import { detectSeed } from "@/lib/seed";
import type { Pivot, PivotType } from "@/lib/intel";

export type RecommendedPivot = {
  label: string;
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

function targetFromRecommendation(label: string): string {
  const directIdentifier =
    label.match(/[^\s@]+@[^\s@]+\.[^\s@]+/)?.[0] ??
    label.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/)?.[0] ??
    label.match(/@[a-z0-9_.-]{2,40}\b/i)?.[0];
  if (directIdentifier) return directIdentifier.replace(/[),.;]+$/, "");

  const action = label.match(
    /^(?:investigate|pivot on|verify|cross-reference|check|review)\s+(.+?)(?:\s+[—–]\s+|\s+\b(?:with|against|via|using)\b|$)/i,
  )?.[1];
  return (action ?? label)
    .replace(/['’]s\b.*$/i, "")
    .replace(/^["'`]|["'`]$/g, "")
    .trim();
}

function pivotType(value: string): PivotType {
  const kind = detectSeed(value)?.kind;
  if (kind === "crypto") return "wallet";
  if (kind === "other" || !kind) return "name";
  return kind;
}

export function extractRecommendedPivots(text: string): RecommendedPivot[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => HEADING_RE.test(cleanLine(line)));
  if (start < 0) return [];

  const pivots: RecommendedPivot[] = [];
  const seen = new Set<string>();
  for (const rawLine of lines.slice(start + 1)) {
    const line = cleanLine(rawLine);
    if (!line) continue;
    if (NEXT_HEADING_RE.test(line)) break;
    if (line.endsWith(":") && !/^(?:investigate|pivot|verify|cross-reference|check|review)\b/i.test(line)) break;

    const value = targetFromRecommendation(line);
    const key = line.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    pivots.push({
      label: line,
      prompt: `Execute this recommended investigation pivot: ${line}`,
      value,
      type: pivotType(value),
    });
    if (pivots.length >= 6) break;
  }
  return pivots;
}

export function recommendedPivotsStorageKey(threadId: string): string {
  return `swarmbot:recommended-pivots:${threadId}`;
}

export function toDisplayPivots(recommendations: RecommendedPivot[]): Pivot[] {
  return recommendations.map((recommendation, index) => ({
    value: recommendation.value,
    type: recommendation.type,
    why: recommendation.label,
    source: "Final report",
    sourceArtifactId: `report-pivot-${index}`,
    confidence: 0,
    fanout: "Analyst-recommended follow-up",
    status: "new",
  }));
}
