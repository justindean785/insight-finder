// contradiction_claims_test.ts — which rows may testify about the SUBJECT.
//
// Production 2026-10-01: a finding resting on a federal wanted listing, a DOJ
// release and ~20 news reports persisted `contradicted` at case confidence 15.
// Replayed exactly (penalty 105 → identity 0 → case 15): the thread-wide
// fallback fed the conflict check four people-search relatives, an excluded
// collision, one-word breach tokens, a neighbour's name the analyst could only
// dismiss, and a leaked IP's geolocation read as the subject's residence; then
// one stale-breach fact was charged seven times. Fixtures here are neutral.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  contradictionClaimSelfTest,
  detectContradictions,
  isNetworkLocationRow,
  makesSubjectClaim,
} from "./contradictions.ts";
import { contradictionPenalty } from "./confidence.ts";
import { buildFindingRow } from "./lib/finding-row.ts";

type Row = { kind: string; value: string; source?: string; metadata?: Record<string, unknown> };

const KILL = "CONTRADICTION_CLAIM_FILTER_DISABLED";
function withLegacy<T>(fn: () => T): T {
  Deno.env.set(KILL, "true");
  try {
    return fn();
  } finally {
    Deno.env.delete(KILL);
  }
}

// The shape of the production thread, every value invented.
const THREAD: Row[] = [
  { kind: "name", value: "Jane Q. Example", metadata: { cluster_id: "c1" } },
  { kind: "name", value: "Jane Quinn Example", metadata: { cluster_id: "c2" } },
  { kind: "social_profile", value: "profile", metadata: { cluster_id: "c3", location: "Springfield" } },
  { kind: "name", value: "Pat Example", metadata: { cluster_id: "c4", relationship: "Spouse" } },
  { kind: "name", value: "Lee Other", metadata: { cluster_id: "c5", relationship: "Associate" } },
  { kind: "name", value: "Kim Example", metadata: { cluster_id: "c6", relationship: "Relative (likely child)" } },
  { kind: "name", value: "Qwerty", metadata: { cluster_id: "c7" } },
  { kind: "name", value: "Jane", metadata: { cluster_id: "c8" } },
  { kind: "name", value: "Example", metadata: { cluster_id: "c9" } },
  { kind: "excluded_collision", value: "other person", metadata: { status: "excluded", location: "Portland, OR", employer: "Other Co" } },
  { kind: "ip", value: "192.0.2.10", metadata: { cluster_id: "c10", country: "CA", breach_date: "2020-06-29" } },
  { kind: "infrastructure", value: "ip geolocation", metadata: { cluster_id: "c11", city: "Toronto", isp: "Example Cable" } },
  ...Array.from({ length: 6 }, (_, n) => ({
    kind: "breach_exposure", value: `breach row ${n}`, metadata: { cluster_id: "c12", breach_date: "2019-09-01" },
  })),
];

const INPUT = {
  conclusion: "Jane Q. Example is the subject behind the seed selector",
  supporting_sources: ["exa_search", "breach_check"],
  // Cited values span several clusters → artifactsForFinding falls back to the
  // whole thread, which is the production path.
  supporting_artifact_values: ["Jane Q. Example", "Jane Quinn Example", "192.0.2.10"],
  drivers: ["d"],
  identity_evidence_strength: 80,
  relationship_evidence_strength: 75,
  label: "CONFIRMED",
};

function build() {
  return buildFindingRow(INPUT, { threadId: "t", userId: "u", contraRows: THREAD as never });
}

Deno.test("a production-shaped finding is no longer contradicted by rows that are not about the subject", () => {
  const { row, axes } = build();
  const meta = row.metadata as Record<string, unknown>;
  assertEquals(meta.contradictions, [], "no explicit conflict survives");
  assert(meta.status !== "contradicted", `status ${meta.status}`);
  const advisory = (meta.advisory_signals as string[]).join("\n");
  assert(advisory.includes("network_location_mismatch"), "the IP's geolocation is still disclosed");
  assert(advisory.includes("thin_name"), "one-word names are still disclosed");
  // thin_name 5 + stale_breach 5 + network_location_mismatch 12, each ONCE.
  assertEquals(axes.identity, 80 - 22);
});

Deno.test("the kill switch restores the legacy verdict on the same thread", () => {
  const { row, axes } = withLegacy(build);
  const meta = row.metadata as Record<string, unknown>;
  assertEquals(meta.status, "contradicted");
  const contras = (meta.contradictions as string[]).join("\n");
  assert(contras.includes("name_conflict"), contras);
  assert(contras.includes("location_conflict"), contras);
  assertEquals(axes.identity, 0);
});

Deno.test("a genuinely different named person in another state still conflicts", () => {
  const rows = [...THREAD, { kind: "name", value: "Robert Different", metadata: { location: "Austin, TX" } }];
  const kinds = detectContradictions(rows as never).map((f) => f.kind);
  assert(kinds.includes("name_conflict"), kinds.join());
  assert(kinds.includes("location_conflict"), kinds.join());
});

Deno.test("subject-claim predicates", () => {
  assertEquals(makesSubjectClaim({ kind: "name", value: "A B" }), true);
  assertEquals(makesSubjectClaim({ kind: "excluded_collision", value: "x" }), false);
  assertEquals(makesSubjectClaim({ kind: "name", value: "A B", metadata: { status: "excluded" } }), false);
  assertEquals(makesSubjectClaim({ kind: "name", value: "A B", metadata: { excluded_collision: true } }), false);
  assertEquals(makesSubjectClaim({ kind: "name", value: "A B", metadata: { false_positive: true } }), false);
  assertEquals(makesSubjectClaim({ kind: "name", value: "A B", metadata: { relationship: "Associate" } }), false);
  assertEquals(makesSubjectClaim({ kind: "name", value: "A B", metadata: { relationship: "self" } }), true);
  assertEquals(isNetworkLocationRow({ kind: "ip", value: "192.0.2.1" }), true);
  assertEquals(isNetworkLocationRow({ kind: "infrastructure", value: "x", metadata: { isp: "Example" } }), true);
  assertEquals(isNetworkLocationRow({ kind: "infrastructure", value: "parcel", metadata: { city: "Springfield" } }), false);
  assertEquals(isNetworkLocationRow({ kind: "social_profile", value: "x", metadata: { location: "Springfield" } }), false);
});

Deno.test("advisory signals are charged once per kind; explicit conflicts in full", () => {
  const stale = Array.from({ length: 7 }, () => ({ kind: "stale_breach", detail: "", involved: [], severity: "low" as const }));
  assertEquals(contradictionPenalty(stale), 5);
  const mixed = [
    ...stale,
    { kind: "name_conflict", field: "name", detail: "", involved: [], claims: [], severity: "high" as const },
    { kind: "cdn_shared_infra", detail: "", involved: [], severity: "high" as const },
    { kind: "cdn_shared_infra", detail: "", involved: [], severity: "high" as const },
  ];
  assertEquals(contradictionPenalty(mixed), 5 + 25 + 25);
  assertEquals(withLegacy(() => contradictionPenalty(stale)), 35);
});

Deno.test("/health self-test passes on this build", () => {
  const r = contradictionClaimSelfTest();
  assert(r.ok, r.detail);
  assert(r.detail.includes("network geolocation"), r.detail);
});

Deno.test("record_finding scores on review-filtered rows, like the synthesis path", async () => {
  const src = await Deno.readTextFile(new URL("./tool-registry.ts", import.meta.url));
  const block = src.slice(src.indexOf('.select("id,kind,value,source,metadata,created_at")\n        .eq("thread_id", threadId);\n      // Rows the analyst DISMISSED'));
  assert(block.length > 0, "record_finding must select ids so dismissals can match");
  const head = block.slice(0, 1500);
  assert(head.includes("loadReviewsForThread("), "record_finding must load analyst verdicts");
  assert(head.includes("dropRejectedArtifacts(contraRows, reviews)"), "record_finding must drop dismissed rows");
  assert(head.includes("buildFindingRow(i, {"), "…before the shared builder scores them");
});
