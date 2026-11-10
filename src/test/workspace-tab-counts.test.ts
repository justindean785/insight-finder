/**
 * workspace-tab-counts.test.ts — one source per tab number.
 *
 * The Evidence badge once counted the board's Analyst view while the header
 * counted every row and the case sheet asked for a third number, so one case
 * read "55 evidence", "Evidence 42" and "Needs your call 10" at once, none of
 * them labelled. It also carried a red dot counting breach rows as "need
 * attention". The badge now IS the case sheet's queue count, and there is no
 * dot. These tests pin both, and pin that the pages take the number from the
 * case sheet's model rather than re-deriving it.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildWorkspaceTabCounts } from "@/lib/workspace-tab-counts";
import { buildCaseSheet } from "@/lib/case-sheet";
import { tallyAuthority } from "@/lib/authority";
import type { Artifact } from "@/hooks/useThreadArtifacts";

// Synthetic fixtures only — no case identifiers.
let n = 0;
function art(kind: string, value: string, metadata: Record<string, unknown> = {}): Artifact {
  n += 1;
  return { id: `t${n}`, kind, value, confidence: 60, source: "fixture", created_at: "2026-01-01T00:00:00Z", metadata };
}

describe("buildWorkspaceTabCounts", () => {
  it("Evidence prints exactly the case sheet's Needs-your-call count", () => {
    const items = [
      art("username", "h1", { subject_unlinked: true }),
      art("phone", "+15550100", { conflict: true }),
      art("username", "namesake", { possible_collision: true }),
      art("email", "a@example.test"),
      art("breach_exposure", "corpus-a"),
    ];
    const sheet = buildCaseSheet(items, {}, tallyAuthority(items, () => "new"));
    const counts = buildWorkspaceTabCounts(0, sheet.queueTotal);
    expect(sheet.queueTotal).toBe(2);
    expect(counts.evidence.value).toBe(sheet.queueTotal);
    expect(counts.evidence.hint).toMatch(/2 open for optional review/);
  });

  it("never carries a dot — breach rows are not 'needs attention'", () => {
    expect(buildWorkspaceTabCounts(0, 3).evidence.alert).toBe(0);
    expect(buildWorkspaceTabCounts(0, null).evidence.alert).toBe(0);
  });

  it("shows no number until the review verdicts have been read", () => {
    const counts = buildWorkspaceTabCounts(7, null);
    expect(counts.evidence).toEqual({ value: 0, alert: 0 });
  });

  it("uses the singular for one call", () => {
    expect(buildWorkspaceTabCounts(0, 1).evidence.hint).toMatch(/^1 open for optional review/);
  });

  it("Tools prints the persisted tool total the header prints", () => {
    expect(buildWorkspaceTabCounts(33, 0).tools).toEqual({ value: 33, alert: 0, unit: "tool calls" });
  });
});

describe("both pages take the Evidence number from the case sheet's model", () => {
  const PAGES = ["src/pages/CaseViewPage.tsx", "src/pages/ChatPage.tsx"];
  for (const rel of PAGES) {
    it(`${rel}`, () => {
      const src = readFileSync(path.resolve(process.cwd(), rel), "utf8");
      expect(src).toContain("useCaseSheetModel(threadId)");
      expect(src).toMatch(/buildWorkspaceTabCounts\([\s\S]*?sheet\.model\.queueTotal/);
      // #405: no page may grow its own breach counter again.
      expect(src).not.toMatch(/kind[^\n]*===\s*["']breach["']/);
    });
  }
});
