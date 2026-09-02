// Engine bookkeeping must not be counted as evidence — on ANY surface.
//
// `isMetaArtifact` filtered meta kinds out of the artifact LIST, and that was
// mistaken for a fix. Every artifact COUNT is a bare `count(*)` and all three
// bypassed the filter, so a `cluster_decision` row was invisible where you would
// look for it and still inflated every number an analyst reads:
//
//   src/hooks/useInsightsData.ts   Brain / Intelligence totals
//   src/pages/HomeHub.tsx          workspace header totals
//   get_case_metrics RPC           per-case totals in the cases list
//
// These tests read the shipped sources, because the defect was a MISSING filter —
// a unit test of the filter itself passed the whole time it was broken.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { META_ARTIFACT_KINDS, isMetaArtifact, type Artifact } from "@/hooks/useThreadArtifacts";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

const artifact = (over: Partial<Artifact> = {}): Artifact =>
  ({ id: "x", kind: "email", value: "a@b.c", confidence: 50, source: "t", metadata: {}, ...over }) as Artifact;

describe("meta artifact kinds are excluded from every count surface", () => {
  it("the list filter still recognises them", () => {
    for (const kind of META_ARTIFACT_KINDS) {
      expect(isMetaArtifact(artifact({ kind }))).toBe(true);
    }
    expect(isMetaArtifact(artifact({ kind: "email" }))).toBe(false);
  });

  it("cluster_decision is one of them — it is the row that caused this", () => {
    expect(META_ARTIFACT_KINDS).toContain("cluster_decision");
    expect(META_ARTIFACT_KINDS).toContain("triage_decision");
  });

  it("useInsightsData excludes them from its exact count", () => {
    const src = read("src/hooks/useInsightsData.ts");
    // The count query must carry the exclusion, not just import the constant.
    expect(src).toMatch(/from\("artifacts"\)[\s\S]{0,400}?\.not\("kind",\s*"in",/);
    expect(src).toContain("META_ARTIFACT_KINDS");
  });

  it("HomeHub excludes them from its exact count", () => {
    const src = read("src/pages/HomeHub.tsx");
    expect(src).toMatch(/from\("artifacts"\)[\s\S]{0,400}?\.not\("kind",\s*"in",/);
    expect(src).toContain("META_ARTIFACT_KINDS");
  });

  it("the get_case_metrics RPC excludes them, and its SQL list matches the TS list", () => {
    // Two sources of truth that must agree. If someone adds a meta kind to the TS
    // constant and forgets the migration, the per-case count silently re-inflates.
    const sql = read("supabase/migrations/20260817000000_case_metrics_exclude_meta_kinds.sql");
    expect(sql).toMatch(/kind\s+NOT\s+IN\s*\(/i);
    const inList = sql.match(/kind\s+NOT\s+IN\s*\(([^)]*)\)/i)?.[1] ?? "";
    const sqlKinds = [...inList.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(sqlKinds).toEqual([...META_ARTIFACT_KINDS].sort());
  });

  it("the clustering engine no longer writes cluster_decision as an artifact", () => {
    // The producer half. Read from the edge function so the frontend suite fails
    // too if the insert comes back — the two halves are one fix.
    const src = read("supabase/functions/osint-agent/lib/cluster.ts");
    expect(src).not.toMatch(/insert\(\[\{[\s\S]{0,300}kind:\s*"cluster_decision"/);
    expect(src).toContain('event: "clustering_applied"');
  });
});
