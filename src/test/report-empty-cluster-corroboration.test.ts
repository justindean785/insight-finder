import { describe, it, expect } from "vitest";
import { buildReportMarkdown } from "@/lib/intel";
import type { Artifact } from "@/hooks/useThreadArtifacts";

/**
 * Regression from a live name-seed run (2026-08-26, seed "Jesus Acosta, age 31").
 *
 * The published report contained BOTH of these, three lines apart:
 *
 *   ## What Is Actually Corroborated
 *   _No cluster is corroborated by 2 or more independent source classes yet._
 *
 *   ## What Is Not Corroborated
 *   _Every cluster reaches 2 or more independent source classes._
 *
 * Cause: with zero clusters both fallbacks fire, because both are vacuously
 * true of an empty set — nothing is corroborated AND nothing fails to be. The
 * second one was reached via `[].join("\n") || fallback`, where an empty array
 * joins to "" and trips the `||`.
 *
 * The run that produced it recorded 41 artifacts and formed 0 clusters, so this
 * is the ordinary outcome of a common-name seed, not an exotic edge case.
 */

const iso = (minsAgo: number) => new Date(Date.now() - minsAgo * 60_000).toISOString();

/** A name-only harvest row: quarantined, so it can never form a cluster. */
function quarantined(id: string, kind: string, value: string): Artifact {
  return {
    id,
    thread_id: "t1",
    kind,
    value,
    confidence: 45,
    confidence_cap_applied: null,
    source: "oathnet_lookup",
    created_at: iso(10),
    metadata: {
      subject_unlinked: true,
      subject_unlinked_reason:
        "harvested from a name-only query — same-name collision axis; linkage to the subject is unproven",
    },
  } as unknown as Artifact;
}

function reportFor(artifacts: Artifact[]): string {
  return buildReportMarkdown({
    seedValue: "Jesus Acosta, age 31",
    seedType: "name",
    artifacts,
  });
}

describe("report corroboration sections with zero clusters", () => {
  const artifacts = [
    quarantined("q1", "email", "jacosta0417@example.com"),
    quarantined("q2", "email", "jizus9758@example.com"),
    quarantined("q3", "username", "jesus-acosta-77"),
    quarantined("q4", "username", "jesus-acosta-83"),
  ];

  it("never publishes both corroboration fallbacks at once", () => {
    const md = reportFor(artifacts);
    const saysNoneAreCorroborated = md.includes("No cluster is corroborated by 2 or more");
    const saysAllAreCorroborated = md.includes("Every cluster reaches 2 or more");
    // The defect was that BOTH were true. Either alone is a coherent report.
    expect(saysNoneAreCorroborated && saysAllAreCorroborated).toBe(false);
  });

  it("states the empty-cluster case once, as its own thing", () => {
    const md = reportFor(artifacts);
    expect(md).toContain("No identity clusters were formed");
    // And it must not then also assert a verdict about those absent clusters.
    expect(md).not.toContain("Every cluster reaches 2 or more");
  });

  it("does not repeat one shared quarantine reason once per artifact", () => {
    const md = reportFor(artifacts);
    const reason = "harvested from a name-only query";
    const occurrences = md.split(reason).length - 1;
    // Four artifacts share one reason; the live report printed it 25 times for
    // 25 rows. Stating it once for the set is the point of the grouping.
    expect(occurrences).toBeLessThan(artifacts.length);
    // Every value still appears — grouping must not drop evidence.
    for (const a of artifacts) expect(md).toContain(a.value);
  });
});
