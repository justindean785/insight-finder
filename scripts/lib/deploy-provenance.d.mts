/**
 * Type declarations for deploy-provenance.mjs.
 *
 * The implementation stays plain .mjs because scripts/record-deploy.mjs is run
 * by bare `node` with no loader; this file gives the vitest suite full typing
 * without a second, drift-prone TypeScript restatement of the same logic.
 */

export type Note = { code: string; detail: string };

export type LiveHealthOk = {
  ok: true;
  build: string;
  committedAt: string | null;
  revealBreachData: boolean | null;
};
export type LiveHealthFailed = { ok: false; reason: string };
export type LiveHealth = LiveHealthOk | LiveHealthFailed;

export type BuildInfo =
  | { ok: true; marker: string; committedAt: string | null }
  | { ok: false; reason: string };

/** What the repository knows about the SHA the deployed code reported. */
export type RepoFacts = {
  /** The marker SHA resolves to a commit here. */
  exists: boolean;
  /** Commit that introduced `BUILD_MARKER = "<marker>"`; null if none ever did. */
  stampCommit: string | null;
  /** Parent of the stamp commit — must be the marker commit. */
  stampParent: string | null;
  /** Reachable from origin/main. null when there is no stamp commit to ask about. */
  onMain: boolean | null;
  /** Contents of build-info.ts AT the stamp commit. */
  buildInfoSource: string | null;
  /** git tree OID of supabase/functions/osint-agent/ at the stamp commit. */
  sourceTreeDigest?: string | null;
};

/** The ledger's own state, checked so the ref and the log cannot silently diverge. */
export type LedgerState = {
  /** `build` of the last deploy-log.jsonl entry, or null when the log is empty. */
  lastEntryBuild: string | null;
  /** What deploy/live currently points at, or null when the ref does not exist. */
  refBuild: string | null;
};

export type Verdict = {
  /**
   * Marker provenance ONLY: the observed runtime marker maps to canonical source
   * history. Never deployed-byte identity — see verifyDeployedCommit's doc
   * comment for the explicit bound.
   */
  markerProvenanceOk: boolean;
  problems: Note[];
  warnings: Note[];
  stampCommit?: string;
};

/** The mirror checkout the sync was pushed to, when one is available. */
export type MirrorFacts = { commit: string | null; treeDigest: string | null };

export type TreeComparison = {
  status: "equal" | "differs" | "not_run";
  note: Note | null;
};

/** Every field is a separate fact. See buildLogEntry's doc comment. */
export type LogEntry = {
  recorded_at: string;
  runtime_marker: string;
  runtime_marker_committed_at: string | null;
  canonical_commit: string | null;
  stamp_commit: string | null;
  stamp_parent: string | null;
  canonical_tree_digest: string | null;
  mirror_commit: string | null;
  mirror_tree_digest: string | null;
  mirror_tree_equality: TreeComparison["status"];
  /** Always null: the deploy path exposes no artifact digest or attestation. */
  deployed_artifact_digest: null;
  /** Always false: unestablished, never rounded up to "probably fine". */
  deployed_bytes_verified: false;
  previous_build: string | null;
  /** Where previous_build came from — never conflate "none" with "not known". */
  previous_build_source: "ledger" | "operator" | "unknown";
  reveal_breach_data: boolean | null;
  marker_provenance_ok: boolean;
  /** Fixed string naming the bound of this evidence, so the ledger self-documents. */
  proves: "observed-runtime-marker-maps-to-canonical-source-history";
  warnings: string[];
  problems: string[];
};

export function parseHealth(body: unknown): LiveHealth;
export function parseBuildInfo(source: string | null): BuildInfo;
export function verifyLedgerConsistency(state: LedgerState): Note[];
export function verifyDeployedCommit(input: {
  live: LiveHealthOk;
  repo: RepoFacts;
  ledger?: LedgerState;
}): Verdict;
export function compareSourceTrees(input: {
  canonicalTreeDigest: string | null;
  mirrorTreeDigest: string | null;
}): TreeComparison;
export function buildLogEntry(input: {
  live: LiveHealthOk;
  repo: RepoFacts;
  verdict: Verdict;
  recordedAt: string;
  previousBuild: string | null;
  previousBuildSource: "ledger" | "operator" | "unknown";
  mirror?: MirrorFacts | null;
}): LogEntry;
