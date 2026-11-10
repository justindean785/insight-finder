// replay/snapshot.ts — the L1 replay harness's input: one case's STORED rows.
//
// A snapshot is what `replay/snapshot.sql` exports for one thread: artifacts,
// analyst reviews and the tool-usage log. Nothing here talks to a database or a
// model; the harness only re-runs today's deterministic engines over stored rows.
//
// ⛔ The repo is PUBLIC. Real snapshots live only in the gitignored `src/dev/raw/`
// folder. Committed fixtures (`replay/fixtures/`) are synthetic: RFC 2606 domains,
// 555-01xx phones, invented handles.
import type { Artifact as ClusterArtifact } from "../../../functions/osint-agent/lib/cluster.ts";

export interface SnapshotArtifact {
  id: string;
  kind: string;
  value: string;
  source: string | null;
  confidence: number | null;
  metadata: Record<string, unknown> | null;
  cluster_id?: string | null;
  created_at?: string | null;
}

export interface SnapshotReview {
  artifact_id: string;
  state: string;
  created_at?: string | null;
}

export interface SnapshotToolCall {
  tool_name: string;
  outcome: string | null;
  input_json?: unknown;
  created_at?: string | null;
}

export interface Snapshot {
  version: 1;
  case: { label?: string | null; seed_kind?: string | null; seed_value?: string | null };
  artifacts: SnapshotArtifact[];
  reviews: SnapshotReview[];
  tool_usage: SnapshotToolCall[];
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const str = (x: unknown): string => (typeof x === "string" ? x : x == null ? "" : String(x));

/** Stable order so a replay never depends on how rows arrived: created_at, then id. */
function byCreatedThenId<T extends { created_at?: string | null; id?: string; artifact_id?: string; tool_name?: string }>(
  a: T,
  b: T,
): number {
  const ca = str(a.created_at), cb = str(b.created_at);
  if (ca !== cb) return ca < cb ? -1 : 1;
  const ia = str(a.id ?? a.artifact_id ?? a.tool_name), ib = str(b.id ?? b.artifact_id ?? b.tool_name);
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/**
 * Validate and normalise a snapshot. Accepts the bare object or the SQL export's
 * `{ "snapshot": {...} }` wrapper. Throws on a shape it cannot trust — a replay
 * over half-parsed rows would measure the parser, not the engines.
 */
export function parseSnapshot(raw: unknown): Snapshot {
  const root = isRecord(raw) && isRecord(raw.snapshot) ? raw.snapshot : raw;
  if (!isRecord(root)) throw new Error("snapshot: expected a JSON object");
  if (root.version !== 1) throw new Error(`snapshot: unsupported version ${String(root.version)}`);
  if (!Array.isArray(root.artifacts)) throw new Error("snapshot: artifacts must be an array");

  const artifacts: SnapshotArtifact[] = root.artifacts.map((a, i) => {
    if (!isRecord(a)) throw new Error(`snapshot: artifacts[${i}] is not an object`);
    const id = str(a.id);
    if (!id) throw new Error(`snapshot: artifacts[${i}] has no id`);
    return {
      id,
      kind: str(a.kind),
      value: str(a.value),
      source: a.source == null ? null : str(a.source),
      confidence: typeof a.confidence === "number" && Number.isFinite(a.confidence) ? a.confidence : null,
      metadata: isRecord(a.metadata) ? a.metadata : null,
      cluster_id: a.cluster_id == null ? null : str(a.cluster_id),
      created_at: a.created_at == null ? null : str(a.created_at),
    };
  });
  const ids = new Set(artifacts.map((a) => a.id));
  if (ids.size !== artifacts.length) throw new Error("snapshot: duplicate artifact ids");

  const reviews: SnapshotReview[] = (Array.isArray(root.reviews) ? root.reviews : []).flatMap((r) => {
    if (!isRecord(r) || !str(r.artifact_id) || !str(r.state)) return [];
    return [{ artifact_id: str(r.artifact_id), state: str(r.state).toLowerCase(), created_at: r.created_at == null ? null : str(r.created_at) }];
  });
  const tool_usage: SnapshotToolCall[] = (Array.isArray(root.tool_usage) ? root.tool_usage : []).flatMap((t) => {
    if (!isRecord(t) || !str(t.tool_name)) return [];
    return [{ tool_name: str(t.tool_name), outcome: t.outcome == null ? null : str(t.outcome), input_json: t.input_json, created_at: t.created_at == null ? null : str(t.created_at) }];
  });
  const c = isRecord(root.case) ? root.case : {};

  return {
    version: 1,
    case: {
      label: c.label == null ? null : str(c.label),
      seed_kind: c.seed_kind == null ? null : str(c.seed_kind),
      seed_value: c.seed_value == null ? null : str(c.seed_value),
    },
    artifacts: [...artifacts].sort(byCreatedThenId),
    reviews: [...reviews].sort(byCreatedThenId),
    tool_usage: [...tool_usage].sort(byCreatedThenId),
  };
}

/** The shape `lib/cluster.ts` reads. `metaRaw` is the full JSONB stringified,
 *  exactly as the runtime path builds it. */
export function toClusterArtifact(a: SnapshotArtifact): ClusterArtifact {
  return {
    id: a.id,
    created_at: a.created_at ?? undefined,
    kind: a.kind,
    value: a.value,
    source: a.source ?? "",
    confidence: a.confidence ?? 0,
    metaRaw: JSON.stringify(a.metadata ?? {}),
  };
}

/** Latest analyst verdict per artifact (reviews are already in time order). */
export function latestReviewState(s: Snapshot): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of s.reviews) out.set(r.artifact_id, r.state);
  return out;
}

/** Analyst verdicts that mean "this row is wrong or not wanted". */
export const REJECTING_STATES: ReadonlySet<string> = new Set(["dismissed", "wrong"]);
