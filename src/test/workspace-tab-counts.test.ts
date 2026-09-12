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
import { ANALYST_ACTIONABLE_STATES, type AuthorityState } from "@/lib/authority";

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
  it("with no authority tally, evidence.value falls back to every artifact", () => {
    // The degraded path: mid-load there is no tally yet, and a confident 0 would
    // read as "this case found nothing" on a case that found plenty.
    const items = [art("breach_exposure"), art("email"), art("domain")];
    expect(buildWorkspaceTabCounts(items, 0).evidence.value).toBe(3);
    expect(buildWorkspaceTabCounts(items, 0, null).evidence.value).toBe(3);
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

describe("buildWorkspaceTabCounts — the Evidence badge counts what needs a decision", () => {
  // The board's default filter has hidden weak leads, quarantined rows and
  // excluded namesakes since #543, but the badge beside it read `items.length`.
  // So the tab advertised 123 while the board showed a dozen — which is the whole
  // of "8 minute investigations and 123 artifacts to sort through".
  const tally = (over: Partial<Record<AuthorityState, number>> = {}): Record<AuthorityState, number> => ({
    verified: 0, infrastructure: 0, probable: 0, review: 0,
    weak: 0, quarantined: 0, conflict: 0, failed: 0, ...over,
  });

  it("counts only the states the board actually shows by default", () => {
    const t = tally({ verified: 3, infrastructure: 1, probable: 2, review: 5, conflict: 1 });
    expect(buildWorkspaceTabCounts([], 0, t).evidence.value).toBe(12);
  });

  it("the noise the board hides does not inflate the badge", () => {
    // 120 rows of leads, quarantine, exclusions and failures beside 5 real ones.
    const t = tally({ verified: 5, weak: 60, quarantined: 40, failed: 20 });
    const value = buildWorkspaceTabCounts(Array.from({ length: 125 }, () => art("url")), 0, t).evidence.value;
    expect(value).toBe(5);
    expect(value).not.toBe(125);
  });

  it("reads 0 only when there is genuinely nothing to act on", () => {
    const t = tally({ weak: 12, quarantined: 4 });
    expect(buildWorkspaceTabCounts([art("url")], 0, t).evidence.value).toBe(0);
  });

  it("counts through the SAME set the board filters on, so the two cannot drift", () => {
    // Not a restatement of the literal: it sums the badge over exactly the
    // membership of ANALYST_ACTIONABLE_STATES, so adding a state to that set
    // moves both surfaces together or this fails.
    const t = tally();
    let expected = 0;
    for (const state of ANALYST_ACTIONABLE_STATES) {
      t[state] = 7;
      expected += 7;
    }
    t.weak = 99;
    t.quarantined = 99;
    expect(buildWorkspaceTabCounts([], 0, t).evidence.value).toBe(expected);
  });

  it("carries a hint reconciling the badge with the case header's total", () => {
    // Both numbers are on screen at once — the header says "55 evidence", the
    // badge says 42 — so the gap must be explained, not left looking like two
    // surfaces disagreeing (the complaint this whole area exists to fix).
    const t = tally({ verified: 2, review: 1, weak: 9 });
    const items = Array.from({ length: 12 }, () => art("url"));
    const hint = buildWorkspaceTabCounts(items, 0, t).evidence.hint ?? "";
    expect(hint).toContain("3 of 12");
    expect(hint).toContain("All filter");
  });

  it("has no hint when there is no tally, because there is no gap to explain", () => {
    expect(buildWorkspaceTabCounts([art("url")], 0).evidence.hint).toBeUndefined();
  });

  it("the breach alert is unaffected by the tally", () => {
    const t = tally({ verified: 1 });
    const counts = buildWorkspaceTabCounts([art("breach_exposure"), art("email")], 0, t);
    expect(counts.evidence.alert).toBe(1);
    expect(counts.evidence.value).toBe(1);
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
