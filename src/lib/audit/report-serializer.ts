/**
 * Serializes a ReportCard's props to a copy-pasteable Markdown case file.
 * Designed for chain-of-custody — every claim carries a source, every source
 * carries a retrieval timestamp and a SHA-256 fingerprint.
 *
 * This module is a PURE FORMATTER: it does no hashing itself. The caller injects
 * a `hash` function (see ./report-hash) so the same serializer runs unchanged in
 * the browser (Web Crypto) and in Node/CI (node:crypto). Because Web Crypto is
 * async, `serializeReport` is async too.
 */

import type { ClusterAudit, ConfidenceFinding } from "./confidence-linter";
import { effectiveTier } from "./confidence-linter";
import type { IndependenceFinding, Source } from "./source-independence";
import { computeEffectiveSourceCount } from "./source-independence";
import type { HashFn } from "./report-hash";

export interface ReportInput {
  seed: { value: string; type: string };
  clusters: ClusterAudit[];
  hypotheses: {
    id: string;
    label: string;
    evidence: string;
    confidence: number;
    distinguishingEvidence: string;
  }[];
  sources: Source[];
  confidenceFindings: ConfidenceFinding[];
  independenceFindings: IndependenceFinding[];
  cost: number;
  caseId?: string;
  analyst?: string;
  generatedAt?: string;
}

/** Stable per-source custody string. Order-independent — each row stands alone. */
const custodyInput = (s: Source): string => `${s.id}|${s.url ?? ""}|${s.retrievedAt}`;

export async function serializeReport(input: ReportInput, hash: HashFn): Promise<string> {
  const now = input.generatedAt ?? new Date().toISOString();
  const caseId =
    input.caseId ?? `CASE-${(await hash(input.seed.value + now)).slice(0, 12).toUpperCase()}`;
  const analyst = input.analyst ?? "Unattributed";

  const errors =
    input.confidenceFindings.filter((f) => f.severity === "error").length +
    input.independenceFindings.filter((f) => f.severity === "error").length;
  const warns =
    input.confidenceFindings.filter((f) => f.severity === "warn").length +
    input.independenceFindings.filter((f) => f.severity === "warn").length;
  const status = errors > 0 ? "🔴 BLOCKED" : warns > 0 ? "🟡 ADVISORY" : "🟢 CLEAN";

  const declared = input.sources.length;
  const effective = computeEffectiveSourceCount(input.sources);

  // Per-source custody hashes (order-independent).
  const custody = new Map<string, string>();
  for (const s of input.sources) custody.set(s.id, await hash(custodyInput(s)));

  // Report fingerprint is computed over sources SORTED BY id, so a re-run that
  // supplies the same sources in a different order yields the SAME fingerprint.
  const fingerprintBasis =
    [...input.sources]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(custodyInput)
      .join("\n") + `|${now}`;
  const fingerprint = (await hash(fingerprintBasis)).slice(0, 12).toUpperCase();

  return [
    header(caseId, analyst, now, status, input.cost),
    seedBlock(input.seed),
    clustersBlock(input.clusters, input.confidenceFindings),
    hypothesesBlock(input.hypotheses),
    sourcesBlock(input.sources, declared, effective, input.independenceFindings),
    auditBlock(input.confidenceFindings, input.independenceFindings, errors, warns),
    custodyBlock(input.sources, custody, fingerprint),
    "",
  ].join("\n\n");
}

/* ─── Sections ─── */

function header(caseId: string, analyst: string, now: string, status: string, cost: number): string {
  return [
    `# OSINT Investigation Report`,
    ``,
    `| Field | Value |`,
    `|---|---|`,
    `| **Case ID** | \`${caseId}\` |`,
    `| **Analyst** | ${analyst} |`,
    `| **Generated** | \`${now}\` |`,
    `| **Status** | ${status} |`,
    `| **Cost** | \`$${cost.toFixed(4)}\` |`,
  ].join("\n");
}

function seedBlock(seed: { value: string; type: string }): string {
  return [
    `## 1. Seed`,
    ``,
    `| Field | Value |`,
    `|---|---|`,
    `| **Seed** | \`${seed.value}\` |`,
    `| **Type** | ${seed.type} |`,
  ].join("\n");
}

function clustersBlock(clusters: ClusterAudit[], findings: ConfidenceFinding[]): string {
  const parts: string[] = [`## 2. Identity Clusters`];

  for (const c of clusters) {
    const effective = effectiveTier(c);
    const drift = effective !== c.declaredTier;
    const tierLabel = drift
      ? `**Declared:** ${c.declaredTier} · **Effective:** ${effective}`
      : `**Tier:** ${c.declaredTier}`;

    parts.push(``, `### ${c.name}`, ``, tierLabel, ``);
    parts.push(`| Claim | Value | Source | Conf. |`);
    parts.push(`|---|---|---|---:|`);
    for (const cell of c.cells) {
      parts.push(
        `| ${escape(cell.claim)} | ${escape(String(cell.value))} | ${escape(cell.source)} | ${cell.confidence} |`
      );
    }

    const issues = findings.filter((f) => f.cluster === c.name);
    if (issues.length) {
      parts.push(``, `**Audit findings:**`);
      for (const f of issues) {
        const icon = f.severity === "error" ? "🔴" : f.severity === "warn" ? "🟡" : "🔵";
        parts.push(`- ${icon} ${f.message}${f.suggestion ? ` → _${f.suggestion}_` : ""}`);
      }
    }
  }

  return parts.join("\n");
}

function hypothesesBlock(hs: ReportInput["hypotheses"]): string {
  const parts = [
    `## 3. Competing Hypotheses`,
    ``,
    `| ID | Hypothesis | Evidence | Conf. | Distinguishing Evidence Needed |`,
    `|---|---|---|---:|---|`,
  ];
  for (const h of hs) {
    parts.push(
      `| ${h.id} | ${escape(h.label)} | ${escape(h.evidence)} | ${h.confidence} | ${escape(h.distinguishingEvidence)} |`
    );
  }
  return parts.join("\n");
}

function sourcesBlock(
  sources: Source[],
  declared: number,
  effective: number,
  findings: IndependenceFinding[]
): string {
  const parts = [
    `## 4. Source Independence`,
    ``,
    `**Declared:** ${declared} · **Effective:** ${effective} · **Collapsed:** ${declared - effective}`,
    ``,
    `| ID | Type | Origin | URL | Retrieved | Conf. |`,
    `|---|---|---|---|---|---:|`,
  ];
  for (const s of sources) {
    parts.push(
      `| ${s.id} | ${s.type} | ${s.origin ?? "—"} | ${s.url ? `[link](${s.url})` : "—"} | \`${s.retrievedAt}\` | ${s.confidence} |`
    );
  }

  if (findings.length) {
    parts.push(``, `**Independence audit:**`);
    for (const f of findings) {
      const icon = f.severity === "error" ? "🔴" : f.severity === "warn" ? "🟡" : "🔵";
      parts.push(`- ${icon} ${f.message}`);
    }
  }
  return parts.join("\n");
}

function auditBlock(
  conf: ConfidenceFinding[],
  indep: IndependenceFinding[],
  errors: number,
  warns: number
): string {
  const parts = [`## 5. Audit Summary`, ``, `**Errors:** ${errors} · **Warnings:** ${warns}`];

  if (errors + warns === 0) {
    parts.push(``, `_No issues flagged._`);
    return parts.join("\n");
  }

  parts.push(``, `### Confidence findings`);
  for (const f of conf) {
    const icon = f.severity === "error" ? "🔴" : f.severity === "warn" ? "🟡" : "🔵";
    parts.push(`- ${icon} **${f.cluster}** — ${f.message}${f.suggestion ? ` → _${f.suggestion}_` : ""}`);
  }
  parts.push(``, `### Independence findings`);
  for (const f of indep) {
    const icon = f.severity === "error" ? "🔴" : f.severity === "warn" ? "🟡" : "🔵";
    parts.push(`- ${icon} ${f.message} (sources: ${f.sources.join(", ")})`);
  }
  return parts.join("\n");
}

function custodyBlock(sources: Source[], custody: Map<string, string>, fingerprint: string): string {
  const parts = [
    `## 6. Chain of Custody`,
    ``,
    `Report fingerprint: \`${fingerprint}\``,
    ``,
    `| ID | SHA-256 (id+url+retrievedAt) | Retrieved |`,
    `|---|---|---|`,
  ];
  for (const s of sources) {
    parts.push(`| ${s.id} | \`${custody.get(s.id) ?? ""}\` | \`${s.retrievedAt}\` |`);
  }
  parts.push(
    ``,
    `> **Custody note:** Hashes are over (id, url, retrievedAt) only — re-fetching content and hashing the response body is recommended for full evidentiary integrity. The report fingerprint is computed over id-sorted sources, so re-ordering the input does not change it.`
  );
  return parts.join("\n");
}

/* ─── Helpers ─── */

function escape(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
