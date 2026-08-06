/**
 * workspace-tab-counts.test.ts — the Evidence tab's red-dot alert badge.
 *
 * WHY THIS EXISTS. PR #405 collapsed per-corpus `kind:"breach"` artifacts into
 * `breach_exposure` rows and shipped `isBreachKind` so downstream consumers
 * would not silently read zero. It migrated five consumers — and MISSED two,
 * because both live inline in page components rather than in a lib module:
 *
 *   src/pages/CaseViewPage.tsx   const breachCount = items.filter(a => a.kind.toLowerCase() === "breach")
 *   src/pages/ChatPage.tsx       (byte-identical duplicate)
 *
 * Nothing emits the bare kind any more, so both badges read 0 in production
 * even when the subject appears in several breach corpora.
 *
 * The duplication is the root cause: one expression, copy-pasted into two
 * pages, so a sweep that greps lib/ finds neither. These tests cover the single
 * extracted helper both pages now call, and the last case pins that neither
 * page has re-grown its own copy.
 *
 * Every test here fails against the pre-fix code.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildWorkspaceTabCounts } from "@/lib/workspace-tab-counts";

const art = (kind: string) => ({ kind });

describe("buildWorkspaceTabCounts — Evidence alert badge", () => {
  it("counts the collapsed breach_exposure kind that auto-persist actually emits", () => {
    // The live bug: three real breach rows, badge reads 0.
    const items = [art("breach_exposure"), art("breach_exposure"), art("email")];
    expect(buildWorkspaceTabCounts(items, 0).evidence.alert).toBe(2);
  });

  it("still counts the legacy bare kind, so old threads do not regress", () => {
    const items = [art("breach"), art("email")];
    expect(buildWorkspaceTabCounts(items, 0).evidence.alert).toBe(1);
  });

  it("counts every breach-shaped kind, not just the two obvious ones", () => {
    const items = [
      art("breach"),
      art("breach_exposure"),
      art("credential_exposure"),
      art("leak_paste"),
      art("stealer_log"),
      art("leak"),
    ];
    expect(buildWorkspaceTabCounts(items, 0).evidence.alert).toBe(6);
  });

  it("is case-insensitive, matching the predicate the rest of the app uses", () => {
    const items = [art("Breach_Exposure"), art("  BREACH  ")];
    expect(buildWorkspaceTabCounts(items, 0).evidence.alert).toBe(2);
  });

  it("does not inflate the alert with unrelated kinds", () => {
    const items = ["email", "phone", "name", "url", "username", "domain"].map(art);
    expect(buildWorkspaceTabCounts(items, 0).evidence.alert).toBe(0);
  });
});

describe("buildWorkspaceTabCounts — the surrounding counts are unchanged", () => {
  it("evidence.value is every artifact, breach-shaped or not", () => {
    const items = [art("breach_exposure"), art("email"), art("domain")];
    expect(buildWorkspaceTabCounts(items, 0).evidence.value).toBe(3);
  });

  it("tools.value is the persisted tool total and carries no alert", () => {
    const counts = buildWorkspaceTabCounts([art("breach_exposure")], 33);
    expect(counts.tools).toEqual({ value: 33, alert: 0 });
  });

  it("handles an empty thread without throwing", () => {
    expect(buildWorkspaceTabCounts([], 0)).toEqual({
      evidence: { value: 0, alert: 0 },
      tools: { value: 0, alert: 0 },
    });
  });
});

describe("neither page has re-grown its own private breach counter", () => {
  // #405's sweep searched lib/ and missed both pages. This is the assertion
  // that would have caught it: the retired literal must not be compared
  // against `kind` anywhere in the two files that regressed.
  const PAGES = ["src/pages/CaseViewPage.tsx", "src/pages/ChatPage.tsx"];

  for (const rel of PAGES) {
    it(`${rel} derives its badge from the shared helper`, () => {
      const src = readFileSync(path.resolve(process.cwd(), rel), "utf8");
      expect(src).not.toMatch(/kind[^\n]*===\s*["']breach["']/);
      expect(src).toContain("buildWorkspaceTabCounts");
    });
  }
});
