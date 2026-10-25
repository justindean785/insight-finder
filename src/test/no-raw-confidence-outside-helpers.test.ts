import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Regression guard — raw `.confidence` reads under src/ outside the display-
 * confidence helpers.
 *
 * CLAUDE.md rail: "`displayConfidence(a).effective` is the only path for
 * confidence rendering, project-wide." The design-system audit flagged 11 raw
 * `.confidence` reads under `src/components/` by grep; tracing confirmed every
 * one of them reads a field that was ALREADY computed through
 * `displayConfidence` / `effectiveConfidence` / `effectiveConfidenceOrZero`
 * upstream at the data layer (`GraphNode.confidence`, `TimelineItem.confidence`,
 * `IdentityCluster.confidence`, `EvidenceCell.confidence`,
 * `AuthoritativeFinding.confidence`). The remaining raw reads are either chain-
 * of-custody records (`EvidenceRow.confidence` from the evidence_log table),
 * stored-vs-cap comparisons, or DB writes.
 *
 * This test LOCKS that allowlist. Any new raw `.confidence` read that is NOT
 * one of these justified cases will fail the test with a diff, forcing the
 * contributor to either (a) migrate the read to `displayConfidence(a).effective`
 * or (b) document the justification here.
 */

const REPO = resolve(__dirname, "..", "..");

/**
 * The allowed raw `.confidence` reads. Each entry carries the audit justification.
 * Keep sorted by file for easier maintenance.
 *
 * `.confidence` after an identifier that is a field on a type whose construction
 * is listed here IS the effective value — the computation happened at
 * construction, not at render.
 */
const ALLOWED: Array<{ file: string; count: number; why: string }> = [
  {
    file: "src/components/ChatWindow.tsx",
    count: 1,
    why: "DB insert of cached-artifact rows. Writing the capped value would silently drop the stored score.",
  },
  {
    file: "src/components/investigation/ReportCardV2.tsx",
    count: 5,
    why: "cell.confidence / x.confidence read EvidenceCell.confidence, built from effectiveConfidenceOrZero(a) at src/lib/audit/from-artifacts.ts:138.",
  },
  {
    file: "src/components/panel/AnalysisTab.tsx",
    count: 4,
    why: "Comparing stored score vs applicable cap, raw by design.",
  },
  {
    file: "src/components/panel/CaseReport.tsx",
    count: 3,
    why: "f.confidence is AuthoritativeFinding.confidence, documented as 'Effective confidence: min(stored, recorded cap)' at src/lib/authoritative-findings.ts:67.",
  },
  {
    file: "src/components/panel/ClustersTab.tsx",
    count: 1,
    why: "c.confidence is IdentityCluster.confidence, built from effectiveConfidenceOrZero(a) at src/lib/intel.ts:2920 (see comment there).",
  },
  {
    file: "src/components/panel/CustodyTab.tsx",
    count: 2,
    why: "r.confidence is from the evidence_log table (chain-of-custody record), not Artifact. The chain faithfully records what was captured, not a UI-filtered value.",
  },
  {
    file: "src/components/panel/TimelineTab.tsx",
    count: 1,
    why: "it.confidence is TimelineItem.confidence, built from effectiveConfidence(a) at src/lib/intel.ts:1011.",
  },
  {
    file: "src/components/workspace/GraphTab.tsx",
    count: 4,
    why: "data.confidence / n.confidence / selectedNode.confidence read GraphNode.confidence, built from effectiveConfidenceOrZero(a) at src/lib/entity-graph.ts:280.",
  },
  {
    file: "src/pages/BrainGlobalPage.tsx",
    count: 16,
    why: "memory list surface, outside the case workspace — out of scope for Stage 1b. Documented follow-up.",
  },
];

/**
 * Files where any raw `.confidence` read is a defect, never justified. These are
 * the renderers that MUST go through `displayConfidence(a).effective` because
 * their input IS an Artifact (not a pre-computed derived type).
 *
 * This list is complementary to ALLOWED and documents the enforced boundary.
 */
const FILES_THAT_MUST_USE_DISPLAY_CONFIDENCE = [
  "src/components/workspace/ArtifactInspector.tsx",
  "src/components/workspace/CaseSheet.tsx",
  "src/components/panel/EvidenceMatrixTab.tsx",
  "src/components/ResourcesPanel.tsx",
] as const;

type Hit = { file: string; count: number };

// Match `.confidence` followed by a non-identifier char (space, `)`, `,`, `.`,
// `}`, `[`, `+`, etc.) — not `confidenceCap`, `confidenceLabel`, etc. — AND
// not inside a single-line comment or inside a quoted string.
const STRIP_LINE_COMMENT = /\/\/.*$/;
const STRIP_BLOCK_COMMENT_SINGLE_LINE = /\/\*.*?\*\//g;

function isCommentOnlyLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*") ||
    trimmed === ""
  );
}

function countRawReadsInFile(file: string): number {
  const text = readFileSync(resolve(REPO, file), "utf8");
  let count = 0;
  for (const rawLine of text.split("\n")) {
    if (isCommentOnlyLine(rawLine)) continue;
    // Strip inline block-comments and the trailing line comment, so a comment
    // next to real code (`foo() // see a.confidence`) doesn't count.
    const codeOnly = rawLine
      .replace(STRIP_BLOCK_COMMENT_SINGLE_LINE, "")
      .replace(STRIP_LINE_COMMENT, "");
    // Strip simple string literals (single, double, backtick) so a hard-coded
    // docstring containing ".confidence" doesn't count.
    const noStrings = codeOnly
      .replace(/"[^"]*"/g, '""')
      .replace(/'[^']*'/g, "''")
      .replace(/`[^`]*`/g, "``");
    const matches = noStrings.match(/\.confidence(?![A-Za-z0-9_])/g);
    if (matches) count += matches.length;
  }
  return count;
}

function greppedRawReads(): Hit[] {
  // List candidate files via grep first for speed, then filter in Node to
  // exclude comment-only lines and string literals.
  const cmd = `grep -rln --include="*.ts" --include="*.tsx" --exclude-dir=node_modules -E '\\.confidence[^A-Za-z0-9_]' src/components/ src/pages/ | sort -u`;
  const files = execSync(cmd, { cwd: REPO, encoding: "utf8" }).trim().split("\n").filter(Boolean);
  const hits: Hit[] = [];
  for (const file of files) {
    const count = countRawReadsInFile(file);
    if (count > 0) hits.push({ file, count });
  }
  return hits.sort((a, b) => a.file.localeCompare(b.file));
}

describe("no raw .confidence reads outside the display-confidence helpers", () => {
  it("every raw .confidence render-site is on the allowlist with a justification", () => {
    const hits = greppedRawReads();
    const allowedMap = new Map(ALLOWED.map((e) => [e.file, e]));

    const unexpected: Hit[] = [];
    const countMismatches: Array<{ file: string; actual: number; expected: number; why: string }> = [];

    for (const hit of hits) {
      const entry = allowedMap.get(hit.file);
      if (!entry) {
        unexpected.push(hit);
        continue;
      }
      if (hit.count !== entry.count) {
        countMismatches.push({ file: hit.file, actual: hit.count, expected: entry.count, why: entry.why });
      }
    }

    const problems: string[] = [];
    if (unexpected.length) {
      problems.push(
        "New raw `.confidence` reads found. Either migrate to `displayConfidence(a).effective` OR add an entry to ALLOWED with a justification.\n" +
          unexpected.map((u) => `  - ${u.file} (${u.count} raw read${u.count === 1 ? "" : "s"})`).join("\n"),
      );
    }
    if (countMismatches.length) {
      problems.push(
        "Raw `.confidence` read count changed. Audit the file and update ALLOWED.count if the new reads are justified.\n" +
          countMismatches
            .map(
              (m) =>
                `  - ${m.file} — expected ${m.expected}, found ${m.actual}\n    why: ${m.why}`,
            )
            .join("\n"),
      );
    }

    expect(problems, problems.join("\n\n")).toEqual([]);
  });

  it("each file in FILES_THAT_MUST_USE_DISPLAY_CONFIDENCE has zero raw reads", () => {
    const hits = greppedRawReads();
    const violations = hits.filter((h) =>
      (FILES_THAT_MUST_USE_DISPLAY_CONFIDENCE as readonly string[]).includes(h.file),
    );
    expect(violations, `files that must use displayConfidence have raw reads: ${JSON.stringify(violations)}`).toEqual([]);
  });
});
