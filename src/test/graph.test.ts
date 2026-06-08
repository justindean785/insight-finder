import { describe, it, expect } from "vitest";
import {
  SOURCE_CLASS_WEIGHT,
  GENERIC_HANDLE_MIN_PLATFORMS,
  classifySource,
  classifyArtifact,
  strongestSourceClass,
  normalizeSelector,
  inferNodeType,
  buildNodes,
  isGenericHandle,
  isDeadEnd,
  distinctSourceClasses,
  gradeConfidence,
  type ArtifactInput,
  type GraphNode,
} from "../../supabase/functions/osint-agent/graph.ts";

// Pure entity-graph foundation (Phase 1/4/5/10). Shapes mirror the audited
// trace 65910da5 (boobz_sexy vs Aladewura Adegboyega, johnd-style handles).

describe("source-class model (Phase 10)", () => {
  it("orders weights official > news > breach > sweep > marketing > generic", () => {
    const w = SOURCE_CLASS_WEIGHT;
    expect(w.official).toBeGreaterThan(w.news);
    expect(w.news).toBeGreaterThan(w.breach);
    expect(w.breach).toBeGreaterThan(w.username_sweep);
    expect(w.username_sweep).toBeGreaterThan(w.marketing);
    expect(w.marketing).toBeGreaterThan(w.generic);
  });

  it("maps categories to classes", () => {
    expect(classifySource("news")).toBe("news");
    expect(classifySource("social_profile_active")).toBe("social");
    expect(classifySource("breach")).toBe("breach");
    expect(classifySource("username_sweep")).toBe("username_sweep");
    expect(classifySource("official_profile_match")).toBe("official");
    expect(classifySource("infra")).toBe("unknown");
    expect(classifySource("")).toBe("unknown");
  });

  it("strongestSourceClass picks the highest-weight category", () => {
    expect(strongestSourceClass(["news", "official_profile_match", "unknown"])).toBe("official");
    expect(strongestSourceClass(["social_profile_active"])).toBe("social");
  });

  it("classifyArtifact treats marketing-leak data as marketing despite an optimistic category", () => {
    const phone: ArtifactInput = {
      kind: "phone",
      value: "+18131198511",
      source: "breach_check (Apollo.io marketing data)",
      metadata: { note: "marketing data, not confirmed direct", source_category: ["official_profile_match"] },
    };
    expect(classifyArtifact(phone)).toBe("marketing");
  });
});

describe("normalization & node typing (Phase 1)", () => {
  it("strips profile URLs and @ to a bare handle", () => {
    expect(normalizeSelector("username", "https://x.com/boobz_sexy")).toBe("boobz_sexy");
    expect(normalizeSelector("username", "@AladewuraAdegboyega")).toBe("aladewuraadegboyega");
  });
  it("normalizes email, phone, domain", () => {
    expect(normalizeSelector("email", " Official@Gmail.com ")).toBe("official@gmail.com");
    expect(normalizeSelector("phone", "+1 (813) 119-8511")).toBe("+18131198511");
    expect(normalizeSelector("domain", "HTTPS://Hardeyghold.com/path")).toBe("hardeyghold.com");
  });
  it("infers node types incl. loose engine kinds", () => {
    expect(inferNodeType("name", "Aladewura Adegboyega")).toBe("person");
    expect(inferNodeType("username", "boobz_sexy")).toBe("username");
    expect(inferNodeType("weak_lead", "http://wp.me/p5CDKO-dv")).toBe("url");
    expect(inferNodeType("other", "https://x.supabase.co/obj")).toBe("url");
  });
});

describe("buildNodes — dedup is the structural fix (Phase 1)", () => {
  it("collapses repeated lookups of one selector into a single node", () => {
    // The trace billed leakcheck twice and oathnet twice on the same email.
    const arts: ArtifactInput[] = [
      { kind: "email", value: "officialhardeyghold@gmail.com", source: "leakcheck_lookup", confidence: 60, metadata: { source_category: ["breach"] } },
      { kind: "email", value: "OfficialHardeyghold@gmail.com", source: "oathnet_lookup", confidence: 60, metadata: { source_category: ["breach"] } },
    ];
    const nodes = buildNodes(arts);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].id).toBe("email:officialhardeyghold@gmail.com");
    expect(nodes[0].evidence).toHaveLength(2);
  });
});

describe("generic-handle detection (Phase 4)", () => {
  const handle = (over: Partial<GraphNode> = {}): GraphNode => ({
    id: "username:x", type: "username", value: "x", raw: "x",
    evidence: [], metadata: {}, ...over,
  });
  it("flags a handle confirmed on >= threshold platforms", () => {
    expect(GENERIC_HANDLE_MIN_PLATFORMS).toBe(15);
    expect(isGenericHandle(handle({ value: "aladewuraadegboyega", metadata: { platform_hits: 22 } }))).toBe(true);
    expect(isGenericHandle(handle({ metadata: { sites: new Array(21).fill("x") } }))).toBe(true);
  });
  it("does not flag a narrow handle", () => {
    expect(isGenericHandle(handle({ value: "j_doe_91", metadata: { platform_hits: 3 } }))).toBe(false);
  });
  it("flags obvious dictionary tokens", () => {
    expect(isGenericHandle(handle({ value: "official" }))).toBe(true);
    expect(isGenericHandle(handle({ value: "admin" }))).toBe(true);
  });
});

describe("dead-end detection (Phase 5)", () => {
  const node = (metadata: Record<string, unknown>): GraphNode => ({
    id: "n", type: "domain", value: "n", raw: "n", evidence: [], metadata,
  });
  it("flags exhausted / 404 / no-records / expired", () => {
    expect(isDeadEnd(node({ status: "exhausted" }))).toBe(true);
    expect(isDeadEnd(node({ http_status: 404 }))).toBe(true);
    expect(isDeadEnd(node({ dns_result: "no records" }))).toBe(true);
    expect(isDeadEnd(node({ note: "defunct or parked domain" }))).toBe(true);
  });
  it("does not flag a live node", () => {
    expect(isDeadEnd(node({ status: "verified" }))).toBe(false);
  });
});

describe("confidence grading (Phase 10)", () => {
  const nodeFrom = (arts: ArtifactInput[]): GraphNode => buildNodes(arts)[0];

  it("caps marketing-leak PII at 30 and never marks it verified", () => {
    const g = gradeConfidence(nodeFrom([
      { kind: "phone", value: "+18131198511", source: "breach_check (Apollo.io marketing data)", confidence: 55, metadata: { note: "marketing data", source_category: ["official_profile_match"] } },
    ]));
    expect(g.score).toBeLessThanOrEqual(30);
    expect(g.status).not.toBe("verified");
  });

  it("keeps a breach-only identity below verified", () => {
    const g = gradeConfidence(nodeFrom([
      { kind: "username", value: "hardeyghold", source: "breach_check (000webhost)", confidence: 50, metadata: { source_category: ["breach"] } },
    ]));
    expect(g.status).not.toBe("verified");
    expect(g.score).toBeLessThanOrEqual(SOURCE_CLASS_WEIGHT.breach + 10);
  });

  it("verifies an identity corroborated across >=2 independent classes", () => {
    const g = gradeConfidence(nodeFrom([
      { kind: "name", value: "Aladewura Adegboyega", source: "minimax_web_search (news)", confidence: 80, metadata: { source_category: ["news"] } },
      { kind: "name", value: "Aladewura Adegboyega", source: "linkedin", confidence: 80, metadata: { source_category: ["official_profile_match"] } },
    ]));
    expect(g.distinctClasses.length).toBeGreaterThanOrEqual(2);
    expect(g.status).toBe("verified");
  });

  it("caps an over-broad handle at the generic weight", () => {
    const g = gradeConfidence(nodeFrom([
      { kind: "username", value: "aladewuraadegboyega", source: "username_sweep", confidence: 45, metadata: { platform_hits: 22, source_category: ["username_sweep"] } },
    ]));
    expect(g.overBroad).toBe(true);
    expect(g.score).toBeLessThanOrEqual(SOURCE_CLASS_WEIGHT.generic);
  });

  it("marks dead-end nodes exhausted", () => {
    const g = gradeConfidence(nodeFrom([
      { kind: "domain", value: "hardeyghold.com", source: "whois_lookup", confidence: 30, metadata: { status: "exhausted", note: "defunct or parked domain", source_category: ["infra"] } },
    ]));
    expect(g.status).toBe("exhausted");
  });
});
