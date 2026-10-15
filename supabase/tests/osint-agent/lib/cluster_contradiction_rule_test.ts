// Contradiction rule + cluster identity (audit 2026-09-24, handoff §3a.1–2).
//
// Measured across production: 1,528 rows carried status "needs_review" (the
// model's "unverified" stamp); 1,348 of them were capped at <=40 and cut off from
// the subject, against 155 real kind:"contradiction" rows. And contradicted
// singletons that shared one handle token all hashed to the same `clus_…`.
// Values are synthetic.
import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@^1";
import { clusterArtifacts, type Artifact } from "../../../functions/osint-agent/lib/cluster.ts";

const art = (id: string, kind: string, value: string, confidence: number, meta: Record<string, unknown> = {}): Artifact => ({
  id, kind, value, source: "username_sweep", confidence, metaRaw: JSON.stringify(meta),
});

const SEED = art("a1", "username", "quietfalcon77", 90, { handle: "quietfalcon77" });

Deno.test("needs_review is NOT a contradiction: an unverified hit joins the subject and is not capped at 40", () => {
  const hit = art("a2", "social_profile", "https://example-social.com/quietfalcon77", 70, {
    handle: "quietfalcon77", status: "needs_review",
  });
  const r = clusterArtifacts([SEED, hit]);
  const m = r.members.find((x) => x.id === "a2")!;
  const s = r.members.find((x) => x.id === "a1")!;
  assertEquals(m.cluster_id, s.cluster_id, "the unverified hit must join the seed's cluster");
  assert(m.promoted_confidence > 40, `capped to ${m.promoted_confidence}`);
});

Deno.test("an explicit contradiction still caps at <=40 and never joins", () => {
  for (const meta of [
    { collision_value: "quietfalcon77", handle: "quietfalcon77" },
    { contradiction: true, handle: "quietfalcon77" },
    { status: "contradicted", handle: "quietfalcon77" },
  ]) {
    const bad = art("c1", "social_profile", "https://other.example/quietfalcon77", 80, meta);
    const r = clusterArtifacts([SEED, bad]);
    const m = r.members.find((x) => x.id === "c1")!;
    assert(m.promoted_confidence <= 40, `${JSON.stringify(meta)} → ${m.promoted_confidence}`);
    assertNotEquals(m.cluster_id, r.members.find((x) => x.id === "a1")!.cluster_id);
  }
});

Deno.test("contradicted singletons sharing one handle token get DISTINCT cluster ids", () => {
  const rows = ["x1", "x2", "x3"].map((id) =>
    art(id, "social_profile", `https://site-${id}.example/quietfalcon77`, 60, { contradiction: true, handle: "quietfalcon77" }),
  );
  const r = clusterArtifacts(rows);
  const ids = new Set(rows.map((a) => r.members.find((m) => m.id === a.id)!.cluster_id));
  assertEquals(ids.size, 3, "three unrelated contradicted rows must not share one fake cluster");
});

Deno.test("a contradicted group on the SAME selector is still ONE cluster, and its id is stable", () => {
  const rows = [
    art("e1", "email", "dup@example.com", 50, { contradiction: true }),
    art("e2", "breach_record", "dup@example.com", 50, { contradiction: true }),
  ];
  const r1 = clusterArtifacts(rows), r2 = clusterArtifacts([...rows].reverse());
  const c = (r: typeof r1, id: string) => r.members.find((m) => m.id === id)!.cluster_id;
  assertEquals(c(r1, "e1"), c(r1, "e2"));
  assertEquals(c(r1, "e1"), c(r2, "e1"), "cluster id must not depend on input order");
});

Deno.test("kill switch: CLUSTER_LEGACY_NEEDS_REVIEW_CONTRADICTION=true restores the old rule", () => {
  const hit = art("a2", "social_profile", "https://example-social.com/quietfalcon77", 70, {
    handle: "quietfalcon77", status: "needs_review",
  });
  Deno.env.set("CLUSTER_LEGACY_NEEDS_REVIEW_CONTRADICTION", "true");
  try {
    const m = clusterArtifacts([SEED, hit]).members.find((x) => x.id === "a2")!;
    assert(m.promoted_confidence <= 40, "legacy rule must cap needs_review again");
  } finally {
    Deno.env.delete("CLUSTER_LEGACY_NEEDS_REVIEW_CONTRADICTION");
  }
});

Deno.test("health: checks.cluster_contradiction_rule is reported from the same switch", async () => {
  const src = await Deno.readTextFile(new URL("../../../functions/osint-agent/health-handler.ts", import.meta.url));
  assert(src.includes("r.checks.cluster_contradiction_rule = legacyNeedsReviewContradiction()"));
  assert(src.includes('"explicit signals only; group-keyed contradicted cluster ids"'));
});
