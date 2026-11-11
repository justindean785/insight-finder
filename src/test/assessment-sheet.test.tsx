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
import { assessmentReading, buildAssessmentSheet, SHEET_CONNECTION_LIMIT } from "@/lib/assessment-sheet";
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

  it("says most links when at least half do", () => {
    expect(assessmentReading(counts({ supported: 3, unresolved: 2 }), 2, 4)).toBe("Most of what was found links to the seed.");
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
