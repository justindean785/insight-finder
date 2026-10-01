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
  /**
   * `runtime_marker` of the last deploy-log.jsonl entry — the field buildLogEntry
   * emits — or null when the log is empty OR could not be read. Null alone is
   * therefore ambiguous; pair it with `unreadableReason`.
   */
  lastEntryBuild: string | null;
  /** What deploy/live currently points at, or null when the ref does not exist. */
  refBuild: string | null;
  /**
   * Why the ledger could not be parsed, or null when it read cleanly. Set means
   * BLOCK: an unreadable ledger is not an empty one.
   */
  unreadableReason?: string | null;
};

/** Outcome of reading deploy-log.jsonl. `ok:false` blocks; `entryCount:0` is fine. */
export type LedgerRead = {
  ok: boolean;
  lastEntryBuild: string | null;
  /** Lines present in the file — what makes "empty" and "unreadable" distinct. */
  entryCount: number;
  reason?: string;
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
export type MirrorFacts = {
  commit: string | null;
  treeDigest: string | null;
  /** `git rev-parse HEAD` in the mirror checkout. */
  localHead?: string | null;
  /** `git rev-parse origin/main` in the mirror checkout, after a best-effort fetch. */
  remoteMain?: string | null;
  /** True when that fetch was attempted and FAILED — the cached ref cannot be trusted. */
  remoteFetchFailed?: boolean;
};

export type TreeComparison = {
  status: "equal" | "differs" | "not_run";
  note: Note | null;
};

/** Has the mirror's local HEAD actually reached its GitHub remote? */
export type PushComparison = {
  status: "pushed" | "not_pushed" | "not_run" | "fetch_failed";
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
  mirror_push_status: PushComparison["status"];
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
export function readLedger(text: string | null | undefined): LedgerRead;
export function verifyLedgerConsistency(state: LedgerState): Note[];
export function verifyDeployedCommit(input: {
  live: LiveHealthOk;
  repo: RepoFacts;
  ledger?: LedgerState;
  mirror?: MirrorFacts | null;
}): Verdict;
export function compareSourceTrees(input: {
  canonicalTreeDigest: string | null;
  mirrorTreeDigest: string | null;
}): TreeComparison;
export function verifyMirrorPushed(input: {
  localHead: string | null;
  remoteMain: string | null;
  /** The `git fetch origin main` that refreshes `remoteMain` was attempted and failed. */
  remoteFetchFailed?: boolean;
}): PushComparison;
export function buildLogEntry(input: {
  live: LiveHealthOk;
  repo: RepoFacts;
  verdict: Verdict;
  recordedAt: string;
  previousBuild: string | null;
  previousBuildSource: "ledger" | "operator" | "unknown";
  mirror?: MirrorFacts | null;
}): LogEntry;
