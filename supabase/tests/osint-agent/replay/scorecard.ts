// replay/scorecard.ts — re-run today's deterministic engines over one stored case.
//
// `summary` holds counts only and is safe to print or paste. `details` carries row
// ids and the 60-character value slices `clusterArtifacts` already logs; it stays in
// the local, gitignored `replay-out/` folder and is never printed.
import { clusterArtifacts, isClusterInert } from "../../../functions/osint-agent/lib/cluster.ts";
import {
  isWrittenRow,
  originOf,
  type RuleDecision,
  ruleV1,
  ruleV2,
  type RuleScore,
  scoreDecisions,
  selectorOf,
} from "./attribution-rules.ts";
import { latestReviewState, type Snapshot, toClusterArtifact } from "./snapshot.ts";

export const SCORECARD_SCHEMA = 1;

/** A nameserver or mail-exchanger label, as `lib/cluster.ts` INFRA_LABEL reads it. */
const INFRA_HOST = /^(?:ns|dns|mx|aspmx|smtp|mail)(?:-?\d+|-[a-z])*\./i;

const countBy = (xs: readonly string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const x of [...xs].sort()) out[x] = (out[x] ?? 0) + 1;
  return out;
};

export interface Scorecard {
  schema: number;
  summary: {
    rows: {
      artifacts: number;
      reviews_by_state: Record<string, number>;
      tool_calls_by_outcome: Record<string, number>;
    };
    evidence: {
      tool_derived: number;
      typed_by_model_or_analyst: number;
      written_rows: number;
      selector_rows: number;
    };
    clustering: {
      clusters_with_2_plus: number;
      singletons: number;
      joins: number;
      joins_by_rule: Record<string, number>;
      written_rows_in_shared_clusters: number;
      clusters_bridged_only_by_written_rows: number;
      infra_host_joins: number;
      released_rows: number;
      released_rows_still_inert: number;
    };
    attribution: {
      v1_literal_strict: RuleScore;
      v1_counted_strict: RuleScore;
      v1_literal_engine: RuleScore;
      v1_counted_engine: RuleScore;
      v2_edge: RuleScore & {
        anchors: number;
        candidates: number;
        vetoed: number;
        blocked_by_origin: number;
        insufficient_corroboration: number;
        selectors_without_edges: number;
      };
    };
  };
  details: {
    joins: Array<{ a: string; b: string; token: string; rule: string }>;
    bridged_clusters: Array<{ cluster_id: string; non_written_ids: string[]; split_into: number }>;
    released_still_inert_ids: string[];
    decisions: RuleDecision[];
  };
}

export function buildScorecard(s: Snapshot): Scorecard {
  const reviews = latestReviewState(s);
  const all = s.artifacts;
  const A = clusterArtifacts(all.map(toClusterArtifact));
  const clusterA = new Map(A.members.map((m) => [m.id!, m.cluster_id]));
  const sizeA = new Map<string, number>();
  for (const m of A.members) if (m.cluster_id) sizeA.set(m.cluster_id, (sizeA.get(m.cluster_id) ?? 0) + 1);

  // Counterfactual: the same engine with every written row removed. A cluster whose
  // non-written members fall apart here was held together only by prose.
  const nonWritten = all.filter((a) => !isWrittenRow(a));
  const B = clusterArtifacts(nonWritten.map(toClusterArtifact));
  const clusterB = new Map(B.members.map((m) => [m.id!, m.cluster_id]));
  const nonWrittenByA = new Map<string, string[]>();
  for (const a of nonWritten) {
    const c = clusterA.get(a.id);
    if (c) (nonWrittenByA.get(c) ?? nonWrittenByA.set(c, []).get(c)!).push(a.id);
  }
  const bridged: Scorecard["details"]["bridged_clusters"] = [];
  for (const [cid, ids] of [...nonWrittenByA].sort(([x], [y]) => (x < y ? -1 : 1))) {
    if (ids.length < 2) continue;
    const parts = new Set(ids.map((id) => clusterB.get(id) ?? `single:${id}`));
    if (parts.size > 1) bridged.push({ cluster_id: cid, non_written_ids: [...ids].sort(), split_into: parts.size });
  }

  const released = all.filter((a) => a.metadata?.subject_unlinked === true && a.metadata?.linkage_confirmed === true);
  const releasedInert = released.filter((a) => isClusterInert(toClusterArtifact(a))).map((a) => a.id).sort();

  const joins = A.decisions.map((d) => ({ a: d.a, b: d.b, token: d.shared_selector, rule: d.rule }));

  const v1ls = ruleV1(s, "literal", "strict");
  const v1cs = ruleV1(s, "counted", "strict");
  const v1le = ruleV1(s, "literal", "engine");
  const v1ce = ruleV1(s, "counted", "engine");
  const v2 = ruleV2(s);

  return {
    schema: SCORECARD_SCHEMA,
    summary: {
      rows: {
        artifacts: all.length,
        reviews_by_state: countBy([...reviews.values()]),
        tool_calls_by_outcome: countBy(s.tool_usage.map((t) => t.outcome ?? "unknown")),
      },
      evidence: {
        tool_derived: all.filter((a) => originOf(a) === "tool").length,
        typed_by_model_or_analyst: all.filter((a) => originOf(a) === "recorded").length,
        written_rows: all.length - nonWritten.length,
        selector_rows: all.filter((a) => selectorOf(a) !== null).length,
      },
      clustering: {
        clusters_with_2_plus: A.subjects.filter((x) => x.members.length >= 2).length,
        singletons: A.subjects.filter((x) => x.members.length === 1).length,
        joins: joins.length,
        joins_by_rule: countBy(joins.map((j) => j.rule)),
        written_rows_in_shared_clusters: all.filter((a) => {
          const c = clusterA.get(a.id);
          return isWrittenRow(a) && !!c && (sizeA.get(c) ?? 0) >= 2;
        }).length,
        clusters_bridged_only_by_written_rows: bridged.length,
        infra_host_joins: joins.filter((j) => j.rule === "shared first-party domain" && INFRA_HOST.test(j.a) && INFRA_HOST.test(j.b)).length,
        released_rows: released.length,
        released_rows_still_inert: releasedInert.length,
      },
      attribution: {
        v1_literal_strict: scoreDecisions(s, v1ls),
        v1_counted_strict: scoreDecisions(s, v1cs),
        v1_literal_engine: scoreDecisions(s, v1le),
        v1_counted_engine: scoreDecisions(s, v1ce),
        v2_edge: {
          ...scoreDecisions(s, v2.decisions),
          anchors: v2.anchors,
          candidates: v2.candidates,
          vetoed: v2.vetoed,
          blocked_by_origin: v2.blocked_by_origin,
          insufficient_corroboration: v2.insufficient_corroboration,
          selectors_without_edges: v2.selectors_without_edges,
        },
      },
    },
    details: {
      joins,
      bridged_clusters: bridged,
      released_still_inert_ids: releasedInert,
      decisions: [...v1ls, ...v1cs, ...v1le, ...v1ce, ...v2.decisions],
    },
  };
}

/** SHA-256 over the canonical JSON of the scorecard: same rows in, same hash out. */
export async function scorecardHash(card: Scorecard): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(card));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
