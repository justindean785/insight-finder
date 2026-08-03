import { describe, it, expect } from "vitest";
import {
  buildReportMarkdown,
  buildClusterSection,
  buildIdentityClusters,
  labelForArtifact,
} from "@/lib/intel";
import type { Artifact } from "@/hooks/useThreadArtifacts";

const art = (over: Partial<Artifact> = {}): Artifact => ({
  id: "1",
  kind: "email",
  value: "a@b.com",
  confidence: 60,
  source: "whois",
  created_at: "2026-08-01T00:00:00.000Z",
  metadata: null,
  ...over,
});

/** Pull one `## Section` body out of the rendered markdown. */
function section(md: string, heading: string): string {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${heading}`);
  if (start === -1) return "";
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

// ---------------------------------------------------------------------------
// Contract 5, remainder — empty Key Findings vs an expansive identity narrative.
//
// The failure being pinned: Key Findings says nothing is corroborated, while
// Executive Summary / Candidate Identity Clusters / Network Connections /
// Recommended Next Steps carry on describing candidates as though one of them
// were the subject. Candidate information may be DISPLAYED; it may not be
// ASSERTED. All five surfaces must report one certainty level.
//
// The fixture is deliberately expansive: several observations that merge into
// clusters and populate the graph, none of which reaches CONFIRMED (which needs
// 2+ independent source classes or an analyst verdict). Everything below shares
// one `source`, so corroboration cannot be reached by accident.
// ---------------------------------------------------------------------------

const UNCORROBORATED_FIXTURE: Artifact[] = [
  art({ id: "e1", kind: "email", value: "r.doe@example.com", confidence: 62, source: "breach_lookup" }),
  art({ id: "u1", kind: "username", value: "ronnydoe", confidence: 58, source: "breach_lookup" }),
  art({ id: "p1", kind: "phone", value: "+15305550142", confidence: 55, source: "breach_lookup" }),
  art({ id: "n1", kind: "name", value: "Ronny Doe", confidence: 60, source: "breach_lookup" }),
  art({ id: "a1", kind: "address", value: "12 Example St, Sacramento, CA", confidence: 51, source: "breach_lookup" }),
];

const build = (artifacts = UNCORROBORATED_FIXTURE) =>
  buildReportMarkdown({
    seedValue: "r.doe@example.com",
    seedType: "email",
    artifacts,
  });

describe("Contract 5 remainder — one certainty level across every surface", () => {
  it("the fixture really does produce candidates with nothing corroborated", () => {
    // Guard. Without this the whole suite could pass because the fixture is
    // empty rather than because the wording is consistent.
    const md = build();
    expect(section(md, "Key Findings")).toMatch(/No fully-corroborated findings yet|No findings recorded yet/i);
    // Assert the labelling directly rather than by string-matching the report,
    // whose prose now legitimately contains the word CONFIRMED.
    expect(UNCORROBORATED_FIXTURE.map((a) => labelForArtifact(a))).not.toContain("CONFIRMED");
    const clusters = buildIdentityClusters(UNCORROBORATED_FIXTURE, "r.doe@example.com");
    expect(clusters.clusters.length).toBeGreaterThan(0);
  });

  it("Executive Summary states that nothing is corroborated", () => {
    const exec = section(build(), "Executive Summary");
    expect(exec).toMatch(/No finding is corroborated/i);
    expect(exec).toMatch(/candidate observation rather than an established fact/i);
  });

  it("Candidate Identity Clusters says no cluster is established as the subject", () => {
    const clusters = section(build(), "Candidate Identity Clusters");
    expect(clusters).toMatch(/No finding is corroborated/i);
    expect(clusters).toMatch(/CANDIDATE observation/);
    expect(clusters).toMatch(/NOT established as the subject/i);
  });

  it("Network Connections carries the same notice, in the same words", () => {
    const md = build();
    const network = section(md, "Network Connections");
    expect(network).toMatch(/No finding is corroborated/i);
    // Literally the same sentence as the cluster section — one wording, not two
    // paraphrases that can drift apart.
    const notice = network.split("\n").find((l) => l.includes("No finding is corroborated"))!;
    expect(section(md, "Candidate Identity Clusters")).toContain(notice);
  });

  it("Recommended Next Steps leads with corroboration, not with expanding a candidate", () => {
    const steps = section(build(), "Recommended Next Steps")
      .split("\n")
      .filter((l) => l.trim().startsWith("- "));
    expect(steps.length).toBeGreaterThan(0);
    const first = steps[0];
    // The association step outranks it when it applies; otherwise corroboration
    // must lead. Either way the FIRST step must not be a tool-expansion pivot.
    expect(first).toMatch(/Resolve identity association first|Corroborate before expanding/);
    expect(first).not.toMatch(/consider:/);
  });

  it("does not encourage pivoting off an uncorroborated candidate", () => {
    const steps = section(build(), "Recommended Next Steps");
    expect(steps).toMatch(/expanding an uncorroborated candidate compounds the assumption|propagates the association error/i);
  });
});

describe("Contract 5 remainder — corroboration leads when association is not the problem", () => {
  // The fixture above always has unassigned rows, so the ASSOCIATION step leads
  // and the corroboration step could be deleted without failing anything. This
  // fixture removes that cover: every row is seed-linked, so association is
  // settled — and nothing is corroborated, so corroboration must lead instead.
  const SEED = "r.doe@example.com";
  const LINKED: Artifact[] = [
    art({ id: "s1", kind: "email", value: SEED, confidence: 62, source: "breach_lookup" }),
    art({ id: "s2", kind: "email", value: SEED, confidence: 58, source: "breach_lookup" }),
  ];
  const md = () => buildReportMarkdown({ seedValue: SEED, seedType: "email", artifacts: LINKED });

  it("has no unassigned observations to resolve", () => {
    // Guard: if this fixture ever grows an unassigned row, the assertion below
    // would start passing for the wrong reason.
    expect(section(md(), "Unassigned Observations")).toMatch(/Every retained observation is linked/i);
    expect(section(md(), "Recommended Next Steps")).not.toMatch(/Resolve identity association first/);
  });

  it("still has nothing corroborated", () => {
    expect(LINKED.map((a) => labelForArtifact(a))).not.toContain("CONFIRMED");
  });

  it("leads Recommended Next Steps with the corroboration step", () => {
    const steps = section(md(), "Recommended Next Steps")
      .split("\n")
      .filter((l) => l.trim().startsWith("- "));
    expect(steps[0]).toMatch(/Corroborate before expanding/);
    expect(steps[0]).toMatch(/expanding an uncorroborated candidate compounds the assumption/i);
  });
});

describe("Contract 5 remainder — the notice is suppressed once something IS corroborated", () => {
  // One analyst-reviewed row reaches CONFIRMED — the "or analyst review" half of
  // the same bar Key Findings uses. Without this control the suite would pass by
  // always printing the notice, which would be its own dishonesty.
  const CORROBORATED: Artifact[] = [
    ...UNCORROBORATED_FIXTURE,
    art({
      id: "c1",
      kind: "email",
      value: "confirmed@example.com",
      confidence: 88,
      source: "whois",
      metadata: { reviewed: true },
    }),
  ];

  it("drops the uncorroborated notice from every surface when a finding is CONFIRMED", () => {
    const md = build(CORROBORATED);
    expect(section(md, "Key Findings")).not.toMatch(/No fully-corroborated findings yet/i);
    for (const heading of ["Executive Summary", "Candidate Identity Clusters", "Network Connections"]) {
      expect(section(md, heading)).not.toMatch(/No finding is corroborated/i);
    }
  });

  it("stops leading next steps with the corroboration item", () => {
    const steps = section(build(CORROBORATED), "Recommended Next Steps");
    expect(steps).not.toMatch(/Corroborate before expanding/);
  });
});

describe("Contract 5 remainder — buildClusterSection's notice is caller-supplied", () => {
  it("prints nothing extra when the caller does not flag it", () => {
    const report = buildIdentityClusters(UNCORROBORATED_FIXTURE, "r.doe@example.com");
    const plain = buildClusterSection(report, { includeWarnings: false });
    expect(plain).not.toMatch(/No finding is corroborated/i);
  });

  it("prints the caller's notice, once, above the clusters", () => {
    const report = buildIdentityClusters(UNCORROBORATED_FIXTURE, "r.doe@example.com");
    const flagged = buildClusterSection(report, {
      includeWarnings: false,
      uncorroborated: true,
      uncorroboratedNotice: "_NOTICE-SENTINEL_",
    });
    expect(flagged.split("_NOTICE-SENTINEL_").length - 1).toBe(1);
    expect(flagged.indexOf("_NOTICE-SENTINEL_")).toBeLessThan(flagged.indexOf("###"));
  });
});
