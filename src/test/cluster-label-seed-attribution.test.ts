/**
 * cluster-label-seed-attribution.test.ts — issue #485
 *
 * `clusterLabel()` ranked the SEED's name above the cluster's own selectors:
 *
 *     const who = c.names[0] ?? seedName ?? c.emails[0] ?? c.usernames[0] ?? "unknown";
 *
 * so any cluster with no `name` artifact inherited the seed subject's identity.
 * On live thread `4a1bea49-000d-428e-9f89-472b81b1cb89` this published a second
 * man's SSN, home address, phone and a 2014 felony arrest under the wrong named
 * private individual, while the engine had separated the two subjects and a
 * `collision_detector` had fired.
 *
 * These tests DRIVE THE REAL PATH — `buildIdentityClusters(...)` — and assert on
 * the `label` actually handed to every consumer (`intel.ts:1424` corroborated
 * section, `intel.ts:2092` cluster heading, `entity-graph.ts:377`,
 * `audit/from-artifacts.ts:112`, `ClustersTab.tsx:101`). `clusterLabel` is not
 * exported and must not be tested directly: an inline re-derivation cannot catch
 * a regression in the shipped call path.
 *
 * Every assertion is written against `report.seedName` rather than a hardcoded
 * string, so the test proves the trigger is armed before it proves the label is
 * clean — a seed that stopped producing a name would make these vacuous.
 */
import { describe, expect, it } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { UNATTRIBUTED_CLUSTER_LABEL, buildIdentityClusters } from "@/lib/intel";

let artifactId = 0;

function artifact(
  kind: string,
  value: string,
  metadata: Record<string, unknown> | null = null,
): Artifact {
  artifactId += 1;
  return {
    id: `artifact-${artifactId}`,
    kind,
    value,
    confidence: 80,
    source: "test",
    created_at: "2026-06-12T00:00:00.000Z",
    metadata,
  };
}

/** A free-text name seed — the only shape that makes `seedName` non-null. */
const NAME_SEED = "Marcus Webb NY";

/** The verbatim seed of live thread 4a1bea49, read from production 2026-08-23. */
const PRODUCTION_MIXED_SEED =
  "@jayttf @jay_ttf 133 https://www.instagram.com/_jay133/, 133 entertainment syracuse ny,\n\n" +
  "Attached files:\n- [oathnet_export_2026-08-23_05-34-37.html](https://skzqwbyvmwqarfgfvyky.supabase.co/storage/v1)";

function labelsOf(artifacts: Artifact[], seed: string) {
  const report = buildIdentityClusters(artifacts, seed);
  return { report, labels: report.clusters.map((c) => c.label) };
}

describe("#485 · a cluster is named by its own evidence, never by the seed", () => {
  it("arms the trigger: a free-text name seed really does produce a seedName", () => {
    // Guard against a vacuous suite. If this fails, every assertion below is
    // meaningless because the defective branch could never have been reached.
    const { report } = labelsOf([artifact("email", "solo@example.com")], NAME_SEED);
    expect(report.seedName).toBeTruthy();
  });

  it("a cluster with no name artifact does NOT inherit the seed's identity from its email", () => {
    const { report, labels } = labelsOf([artifact("email", "other.person@example.com")], NAME_SEED);
    const seedName = report.seedName!;
    expect(labels).toHaveLength(1);
    expect(labels[0]).not.toContain(seedName);
    expect(labels[0]).toContain("other.person@example.com");
  });

  it("a cluster with no name artifact does NOT inherit the seed's identity from its username", () => {
    const { report, labels } = labelsOf(
      [artifact("username", "jayttf", { platform: "instagram" })],
      NAME_SEED,
    );
    const seedName = report.seedName!;
    expect(labels).toHaveLength(1);
    expect(labels[0]).not.toContain(seedName);
    expect(labels[0]).toContain("jayttf");
  });

  it("a cluster with its own name artifact is named by that name", () => {
    const { labels } = labelsOf(
      [
        artifact("name", "Dana Okoro"),
        artifact("email", "dana@example.com", { name: "Dana Okoro" }),
      ],
      NAME_SEED,
    );
    expect(labels.some((l) => l.includes("Dana Okoro"))).toBe(true);
  });

  it("a genuinely seed-linked cluster keeps the seed identity — because it owns that name artifact", () => {
    // Dropping `seedName` from the chain loses NOTHING legitimate: when the
    // cluster really is the subject's, the subject's name is in `c.names`.
    const { report, labels } = labelsOf(
      [artifact("name", "Marcus Webb"), artifact("email", "marcus.webb@example.com")],
      NAME_SEED,
    );
    expect(report.seedName).toBeTruthy();
    expect(labels.some((l) => l.includes("Marcus Webb"))).toBe(true);
  });

  it("a collision-separated cluster is never rendered as the seed subject", () => {
    // The live shape of #485: subject A carries the name; subject B is a
    // distinct person reached through his own selectors and carrying his own
    // PII. B must not be published under A's — or the seed's — identity.
    const { report, labels } = labelsOf(
      [
        artifact("name", "Marcus Webb"),
        artifact("email", "marcus.webb@example.com", { name: "Marcus Webb" }),
        artifact("username", "jayttf", { platform: "instagram" }),
        artifact("address", "118 Cortland Ave, Syracuse NY", { username: "jayttf" }),
      ],
      NAME_SEED,
    );
    const seedName = report.seedName!;
    const unnamed = report.clusters.filter((c) => c.names.length === 0);
    expect(unnamed.length).toBeGreaterThan(0);
    for (const c of unnamed) {
      expect(c.label).not.toContain(seedName);
      expect(c.label).not.toContain("Marcus Webb");
    }
    expect(labels.some((l) => l.includes("Marcus Webb"))).toBe(true);
  });

  it("regression — the verbatim production seed of thread 4a1bea49 cannot name a foreign cluster", () => {
    const { report } = labelsOf(
      [
        artifact("email", "unrelated.subject@example.com"),
        artifact("phone", "(315) 555-0142", { email: "unrelated.subject@example.com" }),
      ],
      PRODUCTION_MIXED_SEED,
    );
    // The real seed is mixed free text + a URL; `stripUrls` leaves enough tokens
    // that a seed name IS derived. That is precisely why the live case fired.
    expect(report.seedName).toBeTruthy();
    for (const c of report.clusters) {
      expect(c.names).toHaveLength(0);
      expect(c.label).not.toContain(report.seedName!);
    }
  });

  it("a cluster with no identity selector of its own reads as unattributed, never as a person", () => {
    const { report } = labelsOf(
      [
        artifact("ip", "203.0.113.44"),
        artifact("domain", "example-host.test", { ip: "203.0.113.44" }),
      ],
      NAME_SEED,
    );
    const seedName = report.seedName!;
    const anonymous = report.clusters.filter(
      (c) => c.names.length === 0 && c.emails.length === 0 && c.usernames.length === 0,
    );
    expect(anonymous.length).toBeGreaterThan(0);
    for (const c of anonymous) {
      expect(c.label).not.toContain(seedName);
      expect(c.label.endsWith(UNATTRIBUTED_CLUSTER_LABEL)).toBe(true);
    }
  });
});
