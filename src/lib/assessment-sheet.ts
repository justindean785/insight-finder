import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { AssessmentGroup, AssessmentReport } from "@/lib/agent-assessment";

/**
 * The case sheet's reading of the agent assessment (the R2 engine).
 *
 * IT COMPUTES NOTHING NEW. Every count is `AssessmentReport.counts`, every
 * linkage figure is the cluster engine's, and every sentence is one of the
 * engine's own `reasons`. This module only selects and orders what the rail
 * shows, so the rail, the Overview and the transcript's "Connections
 * identified" card read one assessment and cannot disagree.
 *
 * What the rail needs that a count cannot say:
 *  - connections   the rows the engine links to the seed, strongest first;
 *  - blockers      when rows do NOT link, the engine's stated reason, grouped,
 *                  so "24 unresolved" comes with why;
 *  - groupings     identity clusters that hold together but do not include the
 *                  seed. They are real correlations between findings, and
 *                  one selector joining any of them to the seed links them all.
 */

export const GROUP_ORDER: readonly AssessmentGroup[] = ["supported", "unresolved", "conflict", "quarantined"];

export const GROUP_LABEL: Record<AssessmentGroup, string> = {
  supported: "Linked to seed",
  unresolved: "Unresolved",
  conflict: "Contradicts",
  quarantined: "Held, unproven",
};

export const GROUP_HINT: Record<AssessmentGroup, string> = {
  supported: "Shares an identity cluster with the seed at linkage 60 or higher. The seed itself is not counted.",
  unresolved: "Not linked to the seed at 60 or higher: either nothing joins it to the seed, or the link is weak.",
  conflict: "Contradicts the case record.",
  quarantined: "Recorded and disclosed, but its link to the subject is unproven, so it gets no linkage figure.",
};

export const SHEET_CONNECTION_LIMIT = 5;
export const SHEET_BLOCKER_LIMIT = 3;
export const SHEET_GROUPING_LIMIT = 3;

export interface SheetConnection {
  artifact: Artifact;
  /** 0–100, the cluster engine's figure. Never null here: only rows that share the seed's cluster are listed. */
  linkage: number;
  /** The engine's first reason for the link. */
  reason: string;
  /** The engine's plain words for the figure (`linkageWord`), e.g. "Possibly the same person". */
  verdict: string;
}

export interface SheetBlocker {
  /** The engine's sentence, verbatim. */
  reason: string;
  n: number;
}

export interface SheetGrouping {
  id: string;
  label: string;
  size: number;
  /** The engine's first merge reason, or null when it recorded none. */
  reason: string | null;
  /** A member to open, so the row leads somewhere. */
  firstArtifactId: string;
}

export interface AssessmentSheet {
  /** Findings assessed (meta rows excluded, as on every counting surface). */
  total: number;
  /**
   * `total` without the seed's own row(s). The seed is "supported" by
   * definition (linkage 100), so counting it would print "1 links to the seed"
   * on a case where nothing does. Every share on the rail is out of this.
   */
  others: number;
  groups: { group: AssessmentGroup; label: string; n: number }[];
  /** Rows the engine calls supported (linkage 60 or higher), the seed itself excluded. */
  linkedTotal: number;
  /** Every row with a linkage figure, weak links included. `connections` is the top of this. */
  connectionTotal: number;
  connections: SheetConnection[];
  blockers: SheetBlocker[];
  groupings: SheetGrouping[];
  groupingTotal: number;
  /** One plain sentence for the top of the section, or null to print none. */
  reading: string | null;
}

/**
 * The first thing the rail says about the case, in plain words.
 *
 * Return null to print no sentence (the bar and counts still render).
 */
export function assessmentReading(
  counts: Record<AssessmentGroup, number>,
  linkedTotal: number,
  others: number,
): string | null {
  // The headline above this sentence already prints "N of M findings link to
  // the seed", so the sentence never repeats the count. It says what the count
  // cannot: what to read first, or how the whole splits.
  if (others <= 0) return null;
  // A contradiction outranks any amount of linkage: it can undo the rest.
  if (counts.conflict > 0) {
    return counts.conflict === 1
      ? "1 finding contradicts the case record. Read it before relying on the rest."
      : `${counts.conflict} findings contradict the case record. Read them before relying on the rest.`;
  }
  if (linkedTotal <= 0) {
    // Mixed reasons are listed, counted, in the Connections section below.
    return counts.quarantined >= others ? "Everything found is held: its link to the subject is unproven." : null;
  }
  if (linkedTotal >= others) return "Everything found links to the seed.";
  // "Most" means MORE than half. Exactly half is its own sentence: calling 2 of 4
  // "most" overstates the link.
  if (linkedTotal * 2 > others) return "Most of what was found links to the seed.";
  if (linkedTotal * 2 === others) return "About half of what was found links to the seed.";
  return "Most of what was found does not link to the seed yet.";
}

export function buildAssessmentSheet(report: AssessmentReport, items: readonly Artifact[]): AssessmentSheet {
  const byId = new Map(items.map((a) => [a.id, a] as const));

  const seedRows = report.items.filter((a) => a.isSeed && a.group === "supported").length;
  const groups = GROUP_ORDER
    .map((group) => ({ group, label: GROUP_LABEL[group], n: report.counts[group] - (group === "supported" ? seedRows : 0) }))
    .filter((g) => g.n > 0);

  // Every row that shares the seed's cluster carries a figure, including the
  // weak links the engine still files under "unresolved" (below 60). Listing
  // only the supported ones would hide a 45% link behind "nothing links".
  const withFigure = report.items
    .filter((a) => (a.group === "supported" || a.group === "unresolved") && !a.isSeed && a.subjectLinkage !== null && byId.has(a.artifactId))
    .sort((a, b) => (b.subjectLinkage ?? 0) - (a.subjectLinkage ?? 0) || a.artifactId.localeCompare(b.artifactId));
  const linkedTotal = withFigure.filter((a) => a.group === "supported").length;

  const connections = withFigure.slice(0, SHEET_CONNECTION_LIMIT).map((a) => {
    const artifact = byId.get(a.artifactId)!;
    return { artifact, linkage: a.subjectLinkage ?? 0, reason: a.reasons[0] ?? artifact.kind, verdict: a.verdict };
  });

  // Why the unresolved rows do not link. The engine writes that sentence first
  // for every unresolved, unlinked row; identical sentences are counted once.
  const tally = new Map<string, number>();
  for (const a of report.items) {
    if (a.group !== "unresolved" || a.isSeed || a.linkedToSeed) continue;
    const reason = a.reasons[0];
    if (reason) tally.set(reason, (tally.get(reason) ?? 0) + 1);
  }
  const blockers = Array.from(tally, ([reason, n]) => ({ reason, n }))
    .sort((a, b) => b.n - a.n || a.reason.localeCompare(b.reason))
    .slice(0, SHEET_BLOCKER_LIMIT);

  const apart = report.clusters
    .filter((c) => c.id !== report.seedClusterId && c.artifacts.length > 1)
    .sort((a, b) => b.artifacts.length - a.artifacts.length || b.confidence - a.confidence || a.id.localeCompare(b.id));
  const groupings = apart.slice(0, SHEET_GROUPING_LIMIT).map((c) => ({
    id: c.id,
    label: c.label,
    size: c.artifacts.length,
    reason: c.mergeReasons[0] ?? null,
    firstArtifactId: c.artifacts[0].id,
  }));

  const total = report.items.length;
  const others = total - seedRows;
  return {
    total,
    others,
    groups,
    linkedTotal,
    connectionTotal: withFigure.length,
    connections,
    blockers,
    groupings,
    groupingTotal: apart.length,
    reading: assessmentReading(report.counts, linkedTotal, others),
  };
}
