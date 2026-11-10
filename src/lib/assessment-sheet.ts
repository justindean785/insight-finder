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
  unresolved: "Not linked yet",
  conflict: "Contradicts",
  quarantined: "Held, unproven",
};

export const GROUP_HINT: Record<AssessmentGroup, string> = {
  supported: "Shares an identity cluster with the seed at linkage 60 or higher. The seed itself is not counted.",
  unresolved: "No email, phone, handle or infrastructure joins it to the seed. Not a low score: no link at all.",
  conflict: "Contradicts the case record.",
  quarantined: "Recorded and disclosed, but its link to the subject is unproven, so it gets no linkage figure.",
};

export const SHEET_CONNECTION_LIMIT = 5;
export const SHEET_BLOCKER_LIMIT = 3;
export const SHEET_GROUPING_LIMIT = 3;

export interface SheetConnection {
  artifact: Artifact;
  /** 0–100, the cluster engine's figure. Never null here: only linked rows are listed. */
  linkage: number;
  /** The engine's first reason for the link. */
  reason: string;
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
  /** Rows linked to the seed, the seed itself excluded. */
  linkedTotal: number;
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
  // TODO(human): choose what the rail says first. See the Learn by Doing note.
  void counts; void linkedTotal; void others;
  return null;
}

export function buildAssessmentSheet(report: AssessmentReport, items: readonly Artifact[]): AssessmentSheet {
  const byId = new Map(items.map((a) => [a.id, a] as const));

  const seedRows = report.items.filter((a) => a.isSeed && a.group === "supported").length;
  const groups = GROUP_ORDER
    .map((group) => ({ group, label: GROUP_LABEL[group], n: report.counts[group] - (group === "supported" ? seedRows : 0) }))
    .filter((g) => g.n > 0);

  const linked = report.items
    .filter((a) => a.group === "supported" && !a.isSeed && a.subjectLinkage !== null && byId.has(a.artifactId))
    .sort((a, b) => (b.subjectLinkage ?? 0) - (a.subjectLinkage ?? 0) || a.artifactId.localeCompare(b.artifactId));

  const connections = linked.slice(0, SHEET_CONNECTION_LIMIT).map((a) => {
    const artifact = byId.get(a.artifactId)!;
    return { artifact, linkage: a.subjectLinkage ?? 0, reason: a.reasons[0] ?? artifact.kind };
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
    linkedTotal: linked.length,
    connections,
    blockers,
    groupings,
    groupingTotal: apart.length,
    reading: assessmentReading(report.counts, linked.length, others),
  };
}
