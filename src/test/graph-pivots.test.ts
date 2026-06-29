import { describe, it, expect } from "vitest";
import { buildNodes, type ArtifactInput } from "../../supabase/functions/osint-agent/graph.ts";
import {
  selectPivots,
  pivotTargetNode,
  type PivotCandidate,
} from "../../supabase/functions/osint-agent/graph_pivots.ts";

// Phase 9 — pure graph-driven pivot selection. Exercised with rich nodes from
// the audited trace; wired in index.ts behind a default-off flag.

const EMAIL = "taylorquinn@example.com";

const nodesFrom = (arts: ArtifactInput[]) => buildNodes(arts);

const deadDomain: ArtifactInput = {
  kind: "domain", value: "example.com", source: "whois_lookup", confidence: 30,
  metadata: { status: "exhausted", note: "defunct or parked domain", source_category: ["infra"] },
};
const genericHandle: ArtifactInput = {
  kind: "username", value: "aladewuraadegboyega", source: "username_sweep", confidence: 45,
  metadata: { platform_hits: 22, source_category: ["username_sweep"] },
};
const verifiedPerson: ArtifactInput[] = [
  { kind: "name", value: "Aladewura Adegboyega", source: "news", confidence: 80, metadata: { source_category: ["news"] } },
  { kind: "name", value: "Aladewura Adegboyega", source: "linkedin", confidence: 80, metadata: { source_category: ["official_profile_match"] } },
];

describe("pivotTargetNode", () => {
  it("matches a pivot's args to the right entity node", () => {
    const nodes = nodesFrom([{ kind: "email", value: EMAIL, source: "leakcheck", metadata: { source_category: ["breach"] } }]);
    expect(pivotTargetNode({ email: "TaylorQuinn@Example.com" }, nodes)?.id).toBe(`email:${EMAIL}`);
    expect(pivotTargetNode({ email: "nobody@x.com" }, nodes)).toBeNull();
  });
});

describe("selectPivots — drops", () => {
  it("drops a pivot targeting a dead-end node", () => {
    const nodes = nodesFrom([deadDomain]);
    const { selected, dropped } = selectPivots([{ tool: "whois_lookup", args: { domain: "example.com" } }], nodes);
    expect(selected).toHaveLength(0);
    expect(dropped[0]).toMatchObject({ tool: "whois_lookup", reason: "dead_end" });
  });

  it("drops a premium pivot on an over-broad, unconfirmed handle", () => {
    const nodes = nodesFrom([genericHandle]);
    const { selected, dropped } = selectPivots([{ tool: "oathnet_lookup", args: { username: "aladewuraadegboyega" } }], nodes);
    expect(selected).toHaveLength(0);
    expect(dropped[0].reason).toBe("over_broad_unconfirmed");
  });

  it("drops a premium pivot on an already-verified entity", () => {
    const nodes = nodesFrom(verifiedPerson);
    const { selected, dropped } = selectPivots([{ tool: "exa_search", args: { value: "aladewura adegboyega" } }], nodes);
    expect(selected).toHaveLength(0);
    expect(dropped[0].reason).toBe("already_confirmed");
  });

  it("does NOT drop a non-premium pivot on an over-broad handle (only premium gated)", () => {
    const nodes = nodesFrom([genericHandle]);
    const { selected } = selectPivots([{ tool: "username_sweep", args: { username: "aladewuraadegboyega" } }], nodes);
    expect(selected).toHaveLength(1);
  });
});

describe("selectPivots — ordering & budget", () => {
  it("orders cheapest-justified first (free validation before premium)", () => {
    const cands: PivotCandidate[] = [
      { tool: "oathnet_lookup", args: { email: "new@x.com" }, priority: 9 }, // 10000
      { tool: "dns_records", args: { domain: "x.com" }, priority: 1 },        // 50
      { tool: "jina_reader_scrape", args: { url: "https://x.com" } },         // 0
    ];
    const { selected } = selectPivots(cands, []);
    expect(selected.map((c) => c.tool)).toEqual(["jina_reader_scrape", "dns_records", "oathnet_lookup"]);
  });

  it("respects budget and records over-budget drops", () => {
    const cands: PivotCandidate[] = [
      { tool: "jina_reader_scrape", args: {} },
      { tool: "dns_records", args: {} },
      { tool: "exa_search", args: {} },
    ];
    const { selected, dropped } = selectPivots(cands, [], { budget: 2 });
    expect(selected).toHaveLength(2);
    expect(dropped.some((d) => d.reason === "over_budget")).toBe(true);
  });

  it("is conservative — keeps candidates whose target isn't in the graph", () => {
    const cands: PivotCandidate[] = [{ tool: "oathnet_lookup", args: { email: "unknown@x.com" } }];
    expect(selectPivots(cands, []).selected).toHaveLength(1);
  });
});
