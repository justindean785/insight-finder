// assessment-sheet.test.tsx — the right rail reads the agent's assessment.
//
// Production, 2026-11-10: the rail's bar read "Review 25" over a case the agent
// had already scored and correlated. The bar was the authority ladder's tally,
// where "Review" names a single-source row, so automatic scoring looked like a
// manual review queue. The rail now shows the R2 assessment: what links to the
// seed, why the rest does not, and what links to each other.
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { assessArtifacts } from "@/lib/agent-assessment";
import { tallyAuthority } from "@/lib/authority";
import { buildCaseSheet } from "@/lib/case-sheet";
import { assessmentReading, buildAssessmentSheet, casePosture, SHEET_CONNECTION_LIMIT, strataSegments } from "@/lib/assessment-sheet";
import { CaseSheetView } from "@/components/workspace/CaseSheet";

afterEach(cleanup);

const SEED = "subject@example.test";
const T = "2026-01-01T00:00:00Z";
const art = (over: Partial<Artifact> & { id: string; kind: string; value: string }): Artifact => ({
  confidence: 60, source: "fixture", created_at: T, metadata: {}, ...over,
});

const seedRow = art({ id: "seed", kind: "email", value: SEED, confidence: 88 });
// Carries the seed email, so the cluster engine joins it to the seed.
const linkedProfile = art({ id: "prof", kind: "social_profile", value: "https://social.example/subject_ops", confidence: 72, metadata: { email: SEED, handle: "subject_ops" } });
const loosePhone = art({ id: "phone", kind: "phone", value: "+1 555 0100", confidence: 55 });
const looseHandle = art({ id: "handle2", kind: "username", value: "someone_else", confidence: 50 });
const quarantined = art({ id: "q", kind: "username", value: "namesake_handle", confidence: 65, metadata: { subject_unlinked: true, subject_unlinked_reason: "harvested from a name-only query" } });

const CASE = [seedRow, linkedProfile, loosePhone, looseHandle, quarantined];
const sheetOf = (items: Artifact[], seed: string | null = SEED) => buildAssessmentSheet(assessArtifacts(items, seed), items);
const model = (items: Artifact[]) => buildCaseSheet(items, {}, tallyAuthority(items, () => "new"));

describe("buildAssessmentSheet", () => {
  it("never counts the seed as a finding linked to itself", () => {
    const s = sheetOf([seedRow, loosePhone]);
    expect(s.total).toBe(2);
    expect(s.others).toBe(1);
    expect(s.linkedTotal).toBe(0);
    expect(s.groups.find((g) => g.group === "supported")).toBeUndefined();
  });

  it("agrees with the engine's counts for every other group", () => {
    const report = assessArtifacts(CASE, SEED);
    const s = buildAssessmentSheet(report, CASE);
    const n = (g: string) => s.groups.find((x) => x.group === g)?.n ?? 0;
    expect(n("supported")).toBe(report.counts.supported - 1);
    expect(n("unresolved")).toBe(report.counts.unresolved);
    expect(n("quarantined")).toBe(report.counts.quarantined);
    expect(s.groups.reduce((sum, g) => sum + g.n, 0)).toBe(s.others);
  });

  it("lists linked rows strongest first, with the engine's own figure and reason", () => {
    const report = assessArtifacts(CASE, SEED);
    const s = buildAssessmentSheet(report, CASE);
    expect(s.connections.map((c) => c.artifact.id)).toEqual(["prof"]);
    expect(s.connections[0].linkage).toBe(report.byId.prof.subjectLinkage);
    expect(s.connections[0].reason).toBe(report.byId.prof.reasons[0]);
  });

  it("gives a quarantined row no place among the connections", () => {
    const s = sheetOf(CASE);
    expect(s.connections.some((c) => c.artifact.id === "q")).toBe(false);
  });

  it("says why unresolved rows do not link, in the engine's words, counted", () => {
    const report = assessArtifacts(CASE, SEED);
    const s = buildAssessmentSheet(report, CASE);
    expect(s.blockers.length).toBeGreaterThan(0);
    expect(s.blockers.reduce((sum, b) => sum + b.n, 0)).toBe(report.counts.unresolved);
    const engineSentences = new Set(report.items.flatMap((a) => a.reasons));
    for (const b of s.blockers) expect(engineSentences.has(b.reason), b.reason).toBe(true);
  });

  it("caps the list and still reports the full linked total", () => {
    const many = Array.from({ length: SHEET_CONNECTION_LIMIT + 3 }, (_, i) =>
      art({ id: `p${i}`, kind: "social_profile", value: `https://social.example/u${i}`, metadata: { email: SEED } }));
    const s = sheetOf([seedRow, ...many]);
    expect(s.connections.length).toBe(SHEET_CONNECTION_LIMIT);
    expect(s.linkedTotal).toBe(many.length);
  });
});

// The headline already prints "N of M findings link to the seed", so the
// sentence under it never repeats that count. It says the one thing the count
// cannot: what needs reading first, or how the whole splits.
describe("assessmentReading — the rail's first sentence", () => {
  // `supported` includes the seed's own row, as in AssessmentReport.counts.
  const counts = (over: Partial<Record<"supported" | "unresolved" | "conflict" | "quarantined", number>>) => ({
    supported: 1, unresolved: 0, conflict: 0, quarantined: 0, ...over,
  });

  it("prints nothing when the seed is the only row", () => {
    expect(assessmentReading(counts({}), 0, 0)).toBeNull();
  });

  it("leads with contradictions, ahead of any amount of linkage", () => {
    expect(assessmentReading(counts({ supported: 9, conflict: 2 }), 8, 10))
      .toBe("2 findings contradict the case record. Read them before relying on the rest.");
  });

  it("uses the singular for one contradiction", () => {
    expect(assessmentReading(counts({ supported: 4, conflict: 1 }), 3, 4))
      .toBe("1 finding contradicts the case record. Read it before relying on the rest.");
  });

  it("says so when every finding links", () => {
    expect(assessmentReading(counts({ supported: 4 }), 3, 3)).toBe("Everything found links to the seed.");
  });

  it("says most links only when MORE than half do", () => {
    // 3 of 4 and 3 of 5 link
    expect(assessmentReading(counts({ supported: 4, unresolved: 1 }), 3, 4)).toBe("Most of what was found links to the seed.");
    expect(assessmentReading(counts({ supported: 4, unresolved: 2 }), 3, 5)).toBe("Most of what was found links to the seed.");
  });

  it("says about half when exactly half link", () => {
    // 2 of 4 and 1 of 2: half is not "most"
    expect(assessmentReading(counts({ supported: 3, unresolved: 2 }), 2, 4)).toBe("About half of what was found links to the seed.");
    expect(assessmentReading(counts({ supported: 2, unresolved: 1 }), 1, 2)).toBe("About half of what was found links to the seed.");
  });

  it("keeps 'does not link yet' just below half", () => {
    // 1 of 3 and 2 of 5
    expect(assessmentReading(counts({ supported: 2, unresolved: 2 }), 1, 3)).toBe("Most of what was found does not link to the seed yet.");
    expect(assessmentReading(counts({ supported: 3, unresolved: 3 }), 2, 5)).toBe("Most of what was found does not link to the seed yet.");
  });

  it("picks the sentence by the share alone, for every split up to 8 findings", () => {
    for (let others = 2; others <= 8; others++) {
      for (let linked = 1; linked < others; linked++) {
        const expected =
          linked * 2 > others ? "Most of what was found links to the seed."
          : linked * 2 === others ? "About half of what was found links to the seed."
          : "Most of what was found does not link to the seed yet.";
        // `supported` counts the seed's own row as well as the linked rows.
        expect(assessmentReading(counts({ supported: linked + 1, unresolved: others - linked }), linked, others)).toBe(expected);
      }
    }
  });

  it("says most does not link when fewer than half do", () => {
    expect(assessmentReading(counts({ supported: 2, unresolved: 5 }), 1, 6)).toBe("Most of what was found does not link to the seed yet.");
  });

  it("names the hold when nothing links and every finding is held", () => {
    expect(assessmentReading(counts({ quarantined: 3 }), 0, 3))
      .toBe("Everything found is held: its link to the subject is unproven.");
  });

  it("stays silent when nothing links for mixed reasons, leaving the why to the Connections section", () => {
    expect(assessmentReading(counts({ unresolved: 4, quarantined: 1 }), 0, 5)).toBeNull();
  });

  it("reaches the rail through buildAssessmentSheet", () => {
    expect(sheetOf(CASE).reading).toBe(assessmentReading(assessArtifacts(CASE, SEED).counts, 1, 4));
    expect(sheetOf(CASE).reading).not.toBeNull();
  });
});

describe("a dotted-handle seed whose sweep ran on the shortened handle", () => {
  // Production shape, 2026-11-10, with synthetic values: the seed is a handle
  // with a suffix, and every profile the sweep found is for the handle WITHOUT
  // it. Nothing shares a selector with the seed, so nothing may link to it.
  const dotted = art({ id: "seed", kind: "username", value: "sample.handle" });
  const hits = Array.from({ length: 6 }, (_, i) =>
    art({ id: `hit${i}`, kind: "social_profile", value: `https://site${i}.example/sample`, source: "username_sweep", metadata: { handle: "sample", platform: `Site${i}` } }));
  const items = [dotted, ...hits];

  it("links none of them to the seed, and prints no percentage", () => {
    const s = sheetOf(items, "sample.handle");
    expect(s.linkedTotal).toBe(0);
    expect(s.connections).toEqual([]);
  });

  it("reports what the profiles have in common with each other", () => {
    const s = sheetOf(items, "sample.handle");
    // Recorded, not assumed: this is what the rail can honestly show on that case.
    expect({ groupings: s.groupings.map((g) => [g.size, g.reason]), blockers: s.blockers }).toMatchInlineSnapshot(`
      {
        "blockers": [
          {
            "n": 6,
            "reason": "Clusters with 5 other findings, but none of them is the seed.",
          },
        ],
        "groupings": [
          [
            6,
            "HANDLE_MATCH: sample",
          ],
        ],
      }
    `);
  });
});

describe("buildAssessmentSheet — the analyst view's extra readings", () => {
  it("splits findings by kind across the engine's groups, the seed's own row excluded", () => {
    const report = assessArtifacts(CASE, SEED);
    const s = buildAssessmentSheet(report, CASE);
    // Every finding lands in exactly one kind row, and each row's cells add up to it.
    expect(s.kinds.reduce((sum, k) => sum + k.n, 0)).toBe(s.others);
    for (const k of s.kinds) {
      expect(k.counts.supported + k.counts.unresolved + k.counts.conflict + k.counts.quarantined).toBe(k.n);
    }
    // The seed is an email and is the only email here, so no email row is printed for it.
    expect(s.kinds.find((k) => k.kind === "email")).toBeUndefined();
    // Per group, the kind rows add up to the group totals the rail prints above them.
    for (const g of s.groups) {
      expect(s.kinds.reduce((sum, k) => sum + k.counts[g.group], 0)).toBe(g.n);
    }
  });

  it("orders kinds largest first and reports how many exist", () => {
    const s = sheetOf(CASE);
    const sizes = s.kinds.map((k) => k.n);
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    expect(s.kindTotal).toBeGreaterThanOrEqual(s.kinds.length);
  });

  it("carries every linkage figure the engine holds, strongest first, and nothing it does not", () => {
    const report = assessArtifacts(CASE, SEED);
    const s = buildAssessmentSheet(report, CASE);
    expect(s.figures.length).toBe(s.connectionTotal);
    expect(s.figures).toEqual([...s.figures].sort((a, b) => b - a));
    expect(s.figures[0]).toBe(report.byId.prof.subjectLinkage);
    expect(sheetOf([seedRow, loosePhone, looseHandle]).figures).toEqual([]);
  });
});

describe("case sheet — analyst view", () => {
  it("draws the linkage scale only when a figure exists, with the engine's threshold", () => {
    const { container, unmount } = render(<CaseSheetView model={model(CASE)} hydrated assessment={sheetOf(CASE)} />);
    const scale = container.querySelector("[data-linkage-scale]");
    expect(scale?.textContent).toMatch(/1 finding carries a linkage figure; 1 at 60 or higher/);
    unmount();
    const items = [seedRow, loosePhone, looseHandle];
    const { container: none } = render(<CaseSheetView model={model(items)} hydrated assessment={sheetOf(items)} />);
    expect(none.querySelector("[data-linkage-scale]")).toBeNull();
  });

  it("prints all four groups, zero included, so an empty group reads as none rather than missing", () => {
    render(<CaseSheetView model={model(CASE)} hydrated assessment={sheetOf(CASE)} />);
    const region = screen.getByRole("region", { name: "Agent assessment" });
    expect(Array.from(region.querySelectorAll("[data-group]")).map((el) => el.getAttribute("data-group")))
      .toEqual(["supported", "unresolved", "conflict", "quarantined"]);
    expect(region.querySelector("[data-group='conflict']")?.textContent).toBe("0Contradicts");
  });

  it("withholds the kind breakdown with the rest when review decisions could not load", () => {
    const { container } = render(<CaseSheetView model={model(CASE)} hydrated reviewsUnavailable assessment={sheetOf(CASE)} />);
    expect(container.querySelector("[data-kinds]")).toBeNull();
    expect(container.querySelector("[data-linkage-scale]")).toBeNull();
  });
});

describe("case sheet — agent assessment", () => {
  it("shows the assessment's groups and no authority-ladder 'Review' bucket", () => {
    render(<CaseSheetView model={model(CASE)} hydrated assessment={sheetOf(CASE)} seed={{ value: SEED, type: "email" }} />);
    const region = screen.getByRole("region", { name: "Agent assessment" });
    expect(region.textContent).toContain("1of 4 findings links to the seed");
    expect(within(region).getByText("Unresolved")).toBeTruthy();
    expect(within(region).getByText("Held, unproven")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Evidence" })).toBeNull();
    expect(within(region).queryByText(/^Review$/)).toBeNull();
  });

  it("names its population, never a bare 'items'", () => {
    render(<CaseSheetView model={model(CASE)} hydrated assessment={sheetOf(CASE)} />);
    const region = screen.getByRole("region", { name: "Agent assessment" });
    expect(region.textContent).toContain("4 findings + seed");
    expect(region.textContent).not.toMatch(/\bitems?\b/);
    expect(region.querySelector("[title*='chain-of-custody']")).toBeTruthy();
  });

  it("a connection opens that finding", () => {
    const opened: string[] = [];
    render(<CaseSheetView model={model(CASE)} hydrated assessment={sheetOf(CASE)} onSelect={(id) => opened.push(id)} />);
    const region = screen.getByRole("region", { name: "Connections to the seed" });
    fireEvent.click(within(region).getByRole("button", { name: /social\.example\/subject_ops/ }));
    expect(opened).toEqual(["prof"]);
  });

  it("with nothing linked it says so and says why, without inventing a link", () => {
    const items = [seedRow, loosePhone, looseHandle];
    render(<CaseSheetView model={model(items)} hydrated assessment={sheetOf(items)} />);
    const region = screen.getByRole("region", { name: "Connections to the seed" });
    expect(region.textContent).toContain("Nothing links to the seed yet");
    expect(within(region).getByText("Why the rest does not link")).toBeTruthy();
    expect(region.textContent).not.toMatch(/\d+%/);
  });

  it("the map and the next pivots are one click away", () => {
    const seen: unknown[] = [];
    const on = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener("swarmbot:workbench-tab", on);
    render(<CaseSheetView model={model(CASE)} hydrated assessment={sheetOf(CASE)} />);
    const region = screen.getByRole("region", { name: "Connections to the seed" });
    fireEvent.click(within(region).getByRole("button", { name: /connection map/ }));
    fireEvent.click(within(region).getByRole("button", { name: /Next pivots/ }));
    window.removeEventListener("swarmbot:workbench-tab", on);
    expect(seen).toEqual([{ tab: "connections" }, { tab: "pivots" }]);
  });

  it("anchors on the seed when no name holds, and labels it a seed, not a subject name", () => {
    const items = [seedRow, loosePhone];
    render(<CaseSheetView model={model(items)} hydrated assessment={sheetOf(items)} seed={{ value: SEED, type: "email" }} />);
    const subject = screen.getByRole("region", { name: "Subject" });
    expect(subject.textContent).toContain(SEED);
    expect(subject.textContent).toContain("Email seed");
    expect(subject.textContent).toContain("No name holds for the subject yet");
  });

  it("fails closed when review decisions could not load: no linkage is shown", () => {
    // Linkage is computed with the analyst's verdicts; without them a rejected
    // row could lend linkage to its neighbours.
    render(<CaseSheetView model={model(CASE)} hydrated reviewsUnavailable assessment={sheetOf(CASE)} />);
    expect(screen.queryByRole("region", { name: "Connections to the seed" })).toBeNull();
    expect(screen.getByRole("region", { name: "Agent assessment" }).textContent).toMatch(/Linkage is withheld/);
  });
});

// JD's ruling, 2026-11-12: one word for the case's standing. The word is a
// reading of the same numbers as the sentence under it, so the two are tested
// against each other, and "Linked" is never allowed to mean "confirmed".
describe("casePosture — the rail's one word", () => {
  // `supported` includes the seed's own row, as in AssessmentReport.counts.
  const counts = (over: Partial<Record<"supported" | "unresolved" | "conflict" | "quarantined", number>>) => ({
    supported: 1, unresolved: 0, conflict: 0, quarantined: 0, ...over,
  });

  it("prints no word when the seed is the only row", () => {
    expect(casePosture(counts({}), 0, 0)).toBeNull();
  });

  it("is Contested on any contradiction, ahead of any amount of linkage", () => {
    const p = casePosture(counts({ supported: 10, conflict: 1 }), 9, 10);
    expect(p).toMatchObject({ word: "Contested", tone: "contested" });
    expect(p?.hint).toMatch(/^1 finding contradicts/);
    expect(casePosture(counts({ conflict: 3, quarantined: 2 }), 0, 5)?.hint).toMatch(/^3 findings contradict/);
  });

  it("is Held when every finding is held", () => {
    expect(casePosture(counts({ quarantined: 4 }), 0, 4)).toMatchObject({ word: "Held", tone: "held" });
  });

  it("is Linked only when MORE than half link", () => {
    expect(casePosture(counts({ supported: 4, unresolved: 2 }), 3, 5)).toMatchObject({ word: "Linked", tone: "linked" });
    expect(casePosture(counts({ supported: 5 }), 4, 4)).toMatchObject({ word: "Linked", tone: "linked" });
  });

  it("is Open at exactly half, not Linked", () => {
    const p = casePosture(counts({ supported: 3, unresolved: 2 }), 2, 4);
    expect(p).toMatchObject({ word: "Open", tone: "open" });
    expect(p?.hint).toMatch(/About half/);
  });

  it("is Open below half, including 1 of 56 and none at all", () => {
    expect(casePosture(counts({ supported: 2, unresolved: 55 }), 1, 56)).toMatchObject({ word: "Open", tone: "open" });
    expect(casePosture(counts({ unresolved: 3, quarantined: 2 }), 0, 5)).toMatchObject({ word: "Open", tone: "open" });
    expect(casePosture(counts({ unresolved: 3, quarantined: 2 }), 0, 5)?.hint).toBe("No finding links to the seed yet.");
  });

  it("never claims more than linkage: Linked says it is not a confirmed identity", () => {
    expect(casePosture(counts({ supported: 5 }), 4, 4)?.hint).toMatch(/not a confirmed identity/);
    const words = new Set<string>();
    for (let others = 0; others <= 6; others++) {
      for (let linked = 0; linked <= others; linked++) {
        for (const conflict of [0, 1]) {
          for (const held of [0, others - linked]) {
            const p = casePosture(counts({ supported: linked + 1, conflict, quarantined: held }), linked, others);
            if (p) words.add(p.word);
          }
        }
      }
    }
    expect([...words].sort()).toEqual(["Contested", "Held", "Linked", "Open"]);
  });

  it("agrees with the sentence under it, for every split up to 8 findings", () => {
    for (let others = 1; others <= 8; others++) {
      for (let linked = 0; linked <= others; linked++) {
        for (const conflict of [0, 1]) {
          if (linked + conflict > others) continue;
          for (const held of new Set([0, others - linked - conflict])) {
            const c = counts({ supported: linked + 1, conflict, quarantined: held, unresolved: others - linked - conflict - held });
            const tone = casePosture(c, linked, others)?.tone;
            const reading = assessmentReading(c, linked, others);
            const label = `${linked}/${others} conflict=${conflict} held=${held}`;
            if (conflict > 0) {
              expect(tone, label).toBe("contested");
              expect(reading, label).toMatch(/contradict/);
            } else if (held >= others) {
              expect(tone, label).toBe("held");
              expect(reading, label).toMatch(/is held/);
            } else if (linked * 2 > others) {
              expect(tone, label).toBe("linked");
              expect(reading, label).toMatch(/^(Everything found links|Most of what was found links)/);
            } else {
              expect(tone, label).toBe("open");
              // Open never sits over a sentence that says the case links.
              expect(reading ?? "", label).not.toMatch(/^(Everything found links|Most of what was found links)/);
            }
          }
        }
      }
    }
  });

  it("reaches the rail through buildAssessmentSheet, and is withheld with the rest", () => {
    expect(sheetOf(CASE).posture).toMatchObject({ word: "Open", tone: "open" });
    expect(sheetOf([seedRow]).posture).toBeNull();
    const { container, unmount } = render(<CaseSheetView model={model(CASE)} hydrated assessment={sheetOf(CASE)} />);
    const chip = container.querySelector("[data-posture]");
    expect(chip?.textContent).toBe("Open");
    expect(chip?.getAttribute("title")).toBe(sheetOf(CASE).posture?.hint);
    unmount();
    const { container: closed } = render(<CaseSheetView model={model(CASE)} hydrated reviewsUnavailable assessment={sheetOf(CASE)} />);
    expect(closed.querySelector("[data-posture]")).toBeNull();
  });

  it("a contradicting finding makes the real case Contested", () => {
    const clash = art({ id: "clash", kind: "email", value: "other@example.test", metadata: { conflict: true } });
    const s = sheetOf([...CASE, clash]);
    expect(s.posture?.tone).toBe("contested");
    expect(s.reading).toMatch(/contradicts the case record/);
  });
});

// The bars draw counts. A bar that gives a small group a minimum width draws
// evidence that is not there, so a segment's share is its count and nothing else.
describe("strataSegments — bar proportions are the counts", () => {
  const c = (supported: number, unresolved: number, conflict: number, quarantined: number) => ({ supported, unresolved, conflict, quarantined });
  const shares = (x: ReturnType<typeof c>) => Object.fromEntries(strataSegments(x).map((s) => [s.group, s.share]));

  it("1 linked of 56 is one fifty-sixth of the bar", () => {
    expect(shares(c(1, 55, 0, 0))).toEqual({ supported: 1 / 56, unresolved: 55 / 56 });
  });

  it("1 linked of 1 is the whole bar", () => {
    expect(strataSegments(c(1, 0, 0, 0))).toEqual([{ group: "supported", n: 1, share: 1 }]);
  });

  it("0 linked of 56 draws no linked segment", () => {
    expect(strataSegments(c(0, 56, 0, 0)).map((s) => s.group)).toEqual(["unresolved"]);
  });

  it("four populated groups keep their order and their exact shares", () => {
    const segs = strataSegments(c(3, 5, 2, 10));
    expect(segs.map((s) => s.group)).toEqual(["supported", "unresolved", "conflict", "quarantined"]);
    expect(segs.map((s) => s.share)).toEqual([3 / 20, 5 / 20, 2 / 20, 10 / 20]);
  });

  it("all zero draws nothing", () => {
    expect(strataSegments(c(0, 0, 0, 0))).toEqual([]);
  });

  it("an extremely uneven split is not rounded up", () => {
    const segs = strataSegments(c(1, 9998, 1, 0));
    expect(segs.find((s) => s.group === "supported")?.share).toBe(1 / 10000);
    expect(segs.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1, 12);
  });
});

describe("case sheet — the bar and the counts beside it", () => {
  const loose = (i: number) => art({ id: `loose${i}`, kind: "phone", value: `+1 555 01${String(i).padStart(2, "0")}`, confidence: 50 });
  const BIG = [seedRow, linkedProfile, ...Array.from({ length: 55 }, (_, i) => loose(i))];

  it("draws 1 of 56 at its real share, with no minimum width", () => {
    const s = sheetOf(BIG);
    expect(s.linkedTotal).toBe(1);
    expect(s.others).toBe(56);
    render(<CaseSheetView model={model(BIG)} hydrated assessment={s} />);
    const region = screen.getByRole("region", { name: "Agent assessment" });
    const bar = region.querySelector("[data-strata]") as HTMLElement;
    const segs = Array.from(bar.querySelectorAll<HTMLElement>("[data-segment]"));
    expect(segs.map((el) => [el.dataset.segment, el.style.flexGrow])).toEqual([["supported", "1"], ["unresolved", "55"]]);
    for (const el of segs) {
      expect(el.style.minWidth).toBe("0");
      expect(el.className).not.toMatch(/min-w-/);
    }
    // The count the bar may be too small to show is printed under it.
    expect(region.querySelector("[data-group='supported']")?.textContent).toBe("1Linked to seed");
  });

  it("an empty group has no segment and no filled swatch", () => {
    render(<CaseSheetView model={model(BIG)} hydrated assessment={sheetOf(BIG)} />);
    const region = screen.getByRole("region", { name: "Agent assessment" });
    expect(region.querySelector("[data-strata] [data-segment='conflict']")).toBeNull();
    const swatch = region.querySelector<HTMLElement>("[data-group='conflict'] [data-present]");
    expect(swatch?.dataset.present).toBe("false");
    expect(swatch?.style.background).toBe("");
    expect(region.querySelector<HTMLElement>("[data-group='supported'] [data-present]")?.dataset.present).toBe("true");
  });

  it("the headline, the four cells and the kind rows are one count", () => {
    const clash = art({ id: "clash", kind: "email", value: "other@example.test", metadata: { conflict: true } });
    const items = [...BIG, quarantined, clash];
    const report = assessArtifacts(items, SEED);
    const s = buildAssessmentSheet(report, items);
    render(<CaseSheetView model={model(items)} hydrated assessment={s} />);
    const region = screen.getByRole("region", { name: "Agent assessment" });
    const cell = (g: string) => Number(region.querySelector(`[data-group='${g}']`)?.textContent?.match(/^\d+/)?.[0]);
    // The engine's counts, less the seed's own row, and nothing else.
    expect(cell("supported")).toBe(report.counts.supported - 1);
    expect(cell("unresolved")).toBe(report.counts.unresolved);
    expect(cell("conflict")).toBe(report.counts.conflict);
    expect(cell("quarantined")).toBe(report.counts.quarantined);
    expect(cell("supported") + cell("unresolved") + cell("conflict") + cell("quarantined")).toBe(s.others);
    // The headline's linked figure is the Linked cell.
    expect(s.linkedTotal).toBe(cell("supported"));
    expect(region.textContent).toContain(`${s.linkedTotal}of ${s.others} findings`);
    // Every kind row adds up to the same population.
    expect(s.kindTotal).toBeGreaterThan(1);
    const all = buildAssessmentSheet(report, items);
    expect(all.kinds.reduce((sum, k) => sum + k.n, 0)).toBe(s.others);
  });

  it("says the kind split in words, not only in a tooltip", () => {
    const { container } = render(<CaseSheetView model={model(CASE)} hydrated assessment={sheetOf(CASE)} />);
    const rows = Array.from(container.querySelectorAll("[data-kinds] li"));
    expect(rows.length).toBeGreaterThan(1);
    for (const li of rows) expect(li.querySelector(".sr-only")?.textContent).toMatch(/^\d+ /);
  });

  it("with only the seed recorded it prints no figure, no bar and no connections", () => {
    const { container } = render(<CaseSheetView model={model([seedRow])} hydrated assessment={sheetOf([seedRow])} />);
    expect(container.querySelector("[data-seed-only]")).toBeTruthy();
    expect(container.querySelector("[data-strata]")).toBeNull();
    expect(container.querySelector("[data-posture]")).toBeNull();
    expect(screen.queryByRole("region", { name: "Connections to the seed" })).toBeNull();
    expect(screen.getByRole("region", { name: "Agent assessment" }).textContent).not.toMatch(/of 0 findings/);
  });

  it("with no assessment at all it says nothing is recorded", () => {
    render(<CaseSheetView model={model([])} hydrated assessment={null} />);
    const region = screen.getByRole("region", { name: "Agent assessment" });
    expect(region.textContent).toContain("Nothing recorded yet.");
    expect(region.querySelector("[data-strata]")).toBeNull();
    expect(screen.queryByRole("region", { name: "Connections to the seed" })).toBeNull();
  });
});
