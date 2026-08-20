#!/usr/bin/env -S deno run --allow-net --allow-env
/**
 * Read-only, aggregate-only measurement of the recording provenance boundary.
 * It compares the historical deployed caller topology (including the
 * metadata.sources pre-union and occurrence-count breach behavior) with the
 * proposed channel policy.
 *
 * SCOPE — current operator account, NOT a multi-tenant population.
 * Both reads below run as the authenticated user (anon key + user JWT), and
 * RLS restricts each to that account: `Users view own artifacts` and
 * `Users view own tool usage` are both `auth.uid() = user_id`. Artifact and
 * execution visibility are therefore symmetric — the comparison is internally
 * consistent — but the figures describe this account only. Reporting them as a
 * population measurement would overstate them. Multi-tenant measurement needs a
 * separately authorized aggregate path and is deliberately out of scope here.
 *
 * No artifact values are selected or printed. Credentials are read from the
 * environment only and are never logged or written.
 *
 * Required:
 *   SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_EMAIL, SUPABASE_PASSWORD
 */
import {
  applyEvidenceCapsLegacyOccurrenceBaseline,
  isBioCrossLinkName,
  isUnrelatedEntity,
} from "../supabase/functions/osint-agent/confidence.ts";
import {
  applyRecordingSourcePolicy,
  resolveRecordingStatus,
} from "../supabase/functions/osint-agent/recording-source-policy.ts";
import { isSameSurnameOnlyLead } from "../supabase/functions/osint-agent/collision-policy.ts";
import {
  evaluateDuplicateBreachTransport,
  executionTimesByTool,
  isAutoRecordedStatusRow,
  isExecutionAvailableAt,
  surfaceTokensForExecutionMatch,
  type UnmatchedOrigin,
  unmatchedOrigin,
} from "./metadata-source-measurement-policy.ts";

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
const email = Deno.env.get("SUPABASE_EMAIL");
const password = Deno.env.get("SUPABASE_PASSWORD");

if (!supabaseUrl || !anonKey || !email || !password) {
  console.error(
    "SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_EMAIL, and SUPABASE_PASSWORD are required.",
  );
  console.error(
    "They are read from env only, never written to disk or logged.",
  );
  Deno.exit(2);
}

async function signIn(): Promise<string> {
  const response = await fetch(
    `${supabaseUrl}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: { apikey: anonKey, "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `auth failed: ${response.status} ${
        (await response.text()).slice(0, 120)
      }`,
    );
  }
  const body: unknown = await response.json();
  if (
    !body || typeof body !== "object" ||
    !("access_token" in body) || typeof body.access_token !== "string"
  ) {
    throw new Error("no access token returned");
  }
  return body.access_token;
}

interface KeysetRow {
  id: string;
  created_at: string;
}

interface KeysetCursor {
  id: string;
  createdAt: string;
}

async function* keysetPages<T extends KeysetRow>(
  token: string,
  path: string,
  select: string,
  parse: (value: unknown) => T,
  scanStart: string,
): AsyncGenerator<T[]> {
  const size = 1_000;
  let cursor: KeysetCursor | null = null;
  for (;;) {
    const params = new URLSearchParams({
      select,
      created_at: `lte.${scanStart}`,
      order: "created_at.asc,id.asc",
      limit: String(size),
    });
    if (cursor) {
      params.set(
        "or",
        `(created_at.gt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.gt.${cursor.id}))`,
      );
    }
    const response = await fetch(`${supabaseUrl}/rest/v1/${path}?${params}`, {
      headers: {
        apikey: anonKey,
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) {
      throw new Error(
        `${path} read failed: ${response.status} ${
          (await response.text()).slice(0, 120)
        }`,
      );
    }
    const rawBatch: unknown = await response.json();
    if (!Array.isArray(rawBatch)) {
      throw new Error(`${path} returned a non-array response`);
    }
    const batch = rawBatch.map(parse);
    if (batch.length === 0) return;
    yield batch;
    const last = batch[batch.length - 1];
    const next = { id: last.id, createdAt: last.created_at };
    if (cursor?.id === next.id && cursor.createdAt === next.createdAt) {
      throw new Error(`${path} keyset cursor did not advance`);
    }
    cursor = next;
    if (batch.length < size) return;
  }
}

function metadataLabels(metadata: Record<string, unknown> | null): string[] {
  if (!metadata) return [];
  const labels: string[] = [];
  if (typeof metadata.source === "string") labels.push(metadata.source);
  if (Array.isArray(metadata.sources)) {
    for (const source of metadata.sources) {
      if (typeof source === "string") labels.push(source);
    }
  }
  return labels;
}

/** Reproduce the historical deployed caller's metadata.sources pre-union. */
function historicalCallerSources(
  source: string | null,
  metadata: Record<string, unknown> | null,
): string[] {
  const sources = source ? [source] : [];
  if (Array.isArray(metadata?.sources)) {
    for (const candidate of metadata.sources) {
      if (typeof candidate === "string" && candidate) sources.push(candidate);
    }
  }
  return sources;
}

type Artifact = {
  id: string;
  created_at: string;
  thread_id: string;
  kind: string;
  source: string | null;
  confidence: number | null;
  metadata: Record<string, unknown> | null;
};

type ToolRow = {
  id: string;
  created_at: string;
  thread_id: string;
  tool_name: string;
};

function hasSpecialStatusOverride(artifact: Artifact): boolean {
  const metadata = artifact.metadata;
  const collisionExcluded = artifact.kind === "excluded_collision" ||
    isUnrelatedEntity(metadata) ||
    ((artifact.kind === "name" || artifact.kind === "person") &&
      isSameSurnameOnlyLead(metadata));
  return collisionExcluded || isBioCrossLinkName(artifact.kind, metadata);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseArtifact(value: unknown): Artifact {
  if (!isRecord(value)) throw new Error("artifacts returned a non-object row");
  if (typeof value.thread_id !== "string" || typeof value.kind !== "string") {
    throw new Error("artifacts row is missing thread_id or kind");
  }
  if (typeof value.id !== "string" || typeof value.created_at !== "string") {
    throw new Error("artifacts row is missing keyset columns");
  }
  if (value.source !== null && typeof value.source !== "string") {
    throw new Error("artifacts row has an invalid source");
  }
  if (value.confidence !== null && typeof value.confidence !== "number") {
    throw new Error("artifacts row has an invalid confidence");
  }
  if (value.metadata !== null && !isRecord(value.metadata)) {
    throw new Error("artifacts row has invalid metadata");
  }
  return {
    id: value.id,
    created_at: value.created_at,
    thread_id: value.thread_id,
    kind: value.kind,
    source: value.source,
    confidence: value.confidence,
    metadata: value.metadata,
  };
}

function parseToolRow(value: unknown): ToolRow {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.created_at !== "string" ||
    typeof value.thread_id !== "string" ||
    typeof value.tool_name !== "string"
  ) {
    throw new Error("tool_usage_log returned an invalid row");
  }
  return {
    id: value.id,
    created_at: value.created_at,
    thread_id: value.thread_id,
    tool_name: value.tool_name,
  };
}

const scanStart = new Date().toISOString();
const token = await signIn();
console.log("signed in; reading aggregate inputs (read-only)…\n");

// Per thread, EVERY instant each tool was observed executing. A timeless set
// would let a later execution on a reused thread retroactively evidence an
// older artifact; matching is bounded against each artifact's write time below.
const executedByThread = new Map<string, Map<string, number[]>>();
let toolRowCount = 0;
for await (
  const rows of keysetPages<ToolRow>(
    token,
    "tool_usage_log",
    "id,created_at,thread_id,tool_name",
    parseToolRow,
    scanStart,
  )
) {
  const pageRowsByThread = new Map<string, ToolRow[]>();
  for (const row of rows) {
    toolRowCount++;
    let pageRows = pageRowsByThread.get(row.thread_id);
    if (!pageRows) {
      pageRows = [];
      pageRowsByThread.set(row.thread_id, pageRows);
    }
    pageRows.push(row);
  }
  for (const [threadId, pageRows] of pageRowsByThread) {
    let observed = executedByThread.get(threadId);
    if (!observed) {
      observed = new Map<string, number[]>();
      executedByThread.set(threadId, observed);
    }
    for (const [tool, instants] of executionTimesByTool(pageRows)) {
      const known = observed.get(tool);
      if (known) known.push(...instants);
      else observed.set(tool, [...instants]);
    }
  }
}
// Keyset pages arrive in created_at order, but merge across pages regardless.
for (const observed of executedByThread.values()) {
  for (const instants of observed.values()) instants.sort((a, b) => a - b);
}

let withMetadata = 0;
let capLowered = 0;
let capRaised = 0;
let capUnchanged = 0;
let statusChanged = 0;
let statusChangedAtEqualCap = 0;
let historicalMetadataDemotions = 0;
let metadataDemotionsPreserved = 0;
let metadataDemotionsLost = 0;
let proposedMetadataDemotions = 0;
let duplicateBreachTransportShapes = 0;
let duplicateBreachHistoricalNudges = 0;
let duplicateBreachShapesFixedAt60 = 0;
let duplicateBreachInvariantViolations = 0;
let specialStatusRowsExcluded = 0;
let autoRecordedStatusRowsExcluded = 0;
let noSurfaceProvenance = 0;
let fullyExecutionMatched = 0;
let partiallyExecutionMatched = 0;
let zeroExecutionMatched = 0;
let anyTokenUnmatched = 0;
let artifactsOnThreadsWithoutToolLog = 0;
let backdatedExecutionArtifacts = 0;
const capDeltas = new Map<string, number>();
const statusTransitions = new Map<string, number>();
const unmatchedOrigins = new Map<UnmatchedOrigin, number>();

let artifactsScanned = 0;
for await (
  const artifactPage of keysetPages<Artifact>(
    token,
    "artifacts",
    "id,created_at,thread_id,kind,source,confidence,metadata",
    parseArtifact,
    scanStart,
  )
) {
  for (const artifact of artifactPage) {
    artifactsScanned++;
    const metadata = artifact.metadata ?? null;
    if (metadataLabels(metadata).length > 0) withMetadata++;

    // Baseline: reproduce the historical deployed call topology. metadata.sources
    // is copied into sources here, then read again from metadata by the retained
    // occurrence-count compatibility entry. metadata.source is read there too.
    const baseline = applyEvidenceCapsLegacyOccurrenceBaseline({
      rawConfidence: artifact.confidence ?? 50,
      sources: historicalCallerSources(artifact.source, metadata),
      kind: artifact.kind,
      metadata,
    });

    // Proposed: singular surface provenance and metadata remain separate until
    // two complete cap-pipeline runs select the lower cap.
    const policy = applyRecordingSourcePolicy({
      rawConfidence: artifact.confidence ?? 50,
      source: artifact.source,
      kind: artifact.kind,
      metadata,
    });
    const proposed = policy.effective;

    if (policy.withMetadata.cap < policy.surfaceOnly.cap) {
      proposedMetadataDemotions++;
    }
    if (baseline.cap < policy.surfaceOnly.cap) {
      historicalMetadataDemotions++;
      if (proposed.cap <= baseline.cap) metadataDemotionsPreserved++;
      else metadataDemotionsLost++;
    }

    const duplicateTransport = evaluateDuplicateBreachTransport({
      source: artifact.source,
      metadata,
      legacy: baseline,
      proposed: policy.withMetadata,
    });
    if (duplicateTransport.singleLogicalBreachShape) {
      duplicateBreachTransportShapes++;
    }
    if (duplicateTransport.historicalNudgeAffected) {
      duplicateBreachHistoricalNudges++;
    }
    if (duplicateTransport.proposedFixedAtSingleSourceCap) {
      duplicateBreachShapesFixedAt60++;
    }
    if (duplicateTransport.invariantViolation) {
      duplicateBreachInvariantViolations++;
    }

    if (proposed.cap < baseline.cap) capLowered++;
    else if (proposed.cap > baseline.cap) capRaised++;
    else capUnchanged++;

    if (proposed.cap !== baseline.cap) {
      const transition = `${baseline.cap}->${proposed.cap}`;
      capDeltas.set(transition, (capDeltas.get(transition) ?? 0) + 1);
    }

    // Compare every ordinary-status artifact through the exact shared recording
    // helper. Collision and bio-linked rows have explicit live overrides; report
    // and exclude them rather than claiming false status parity.
    if (isAutoRecordedStatusRow(metadata)) {
      autoRecordedStatusRowsExcluded++;
    } else if (hasSpecialStatusOverride(artifact)) {
      specialStatusRowsExcluded++;
    } else {
      const beforeStatus = resolveRecordingStatus(baseline, metadata).status;
      const afterStatus = resolveRecordingStatus(proposed, metadata).status;
      if (beforeStatus !== afterStatus) {
        statusChanged++;
        if (proposed.cap === baseline.cap) statusChangedAtEqualCap++;
        const transition = `${beforeStatus} -> ${afterStatus}`;
        statusTransitions.set(
          transition,
          (statusTransitions.get(transition) ?? 0) + 1,
        );
      }
    }

    const surfaceTokens = surfaceTokensForExecutionMatch(artifact.source);
    const threadTools = executedByThread.get(artifact.thread_id);
    if (!threadTools) artifactsOnThreadsWithoutToolLog++;
    if (surfaceTokens.length === 0) {
      noSurfaceProvenance++;
      continue;
    }

    // Bound every match against this artifact's own write time. A tool that
    // first ran only AFTER the artifact was written is not its provenance.
    const artifactAt = Date.parse(artifact.created_at);
    const matchedCount = surfaceTokens.filter((surface) =>
      isExecutionAvailableAt(threadTools, surface, artifactAt)
    ).length;
    if (matchedCount === surfaceTokens.length) {
      fullyExecutionMatched++;
    } else if (matchedCount > 0) {
      partiallyExecutionMatched++;
    } else zeroExecutionMatched++;

    // How much of the historical "matched" count came from post-dating
    // executions on reused threads — the overstatement this bound removes.
    const timelessMatchedCount = surfaceTokens.filter((surface) =>
      threadTools?.has(surface)
    ).length;
    if (timelessMatchedCount > matchedCount) backdatedExecutionArtifacts++;

    const unmatched = surfaceTokens.filter((surface) =>
      !isExecutionAvailableAt(threadTools, surface, artifactAt)
    );
    if (unmatched.length > 0) {
      anyTokenUnmatched++;
      for (const surface of unmatched) {
        const origin = unmatchedOrigin(surface);
        unmatchedOrigins.set(origin, (unmatchedOrigins.get(origin) ?? 0) + 1);
      }
    }
  }
}

function top(values: Map<string, number>, limit = 12): string {
  return [...values.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([label, count]) => `    ${String(count).padStart(6)}  ${label}`)
    .join("\n") || "    (none)";
}

console.log("=".repeat(72));
console.log("METADATA PROVENANCE — HISTORICAL CALLER / PROPOSED POLICY");
console.log(
  "SCOPE: current operator account only — NOT a multi-tenant population.",
);
console.log("=".repeat(72));
console.log(
  `1. artifacts scanned                                    ${artifactsScanned}`,
);
console.log(
  `2. carrying metadata.source / metadata.sources          ${withMetadata}`,
);
console.log("3. cap-ceiling direction under caller-boundary partition:");
console.log(
  `     proposed lower                                     ${capLowered}`,
);
console.log(
  `     proposed raised (MUST BE 0)                        ${capRaised}`,
);
console.log(
  `     unchanged                                          ${capUnchanged}`,
);
console.log(
  `4. projected status changes across ordinary rows        ${statusChanged}`,
);
console.log(
  `     ...at an equal cap ceiling                         ${statusChangedAtEqualCap}`,
);
console.log(
  `     collision/bio override rows excluded              ${specialStatusRowsExcluded}`,
);
console.log(
  `     auto-recorded status rows excluded                ${autoRecordedStatusRowsExcluded}`,
);
console.log("5. metadata demotions:");
console.log(
  `     present in historical deployed caller              ${historicalMetadataDemotions}`,
);
console.log(
  `     preserved                                          ${metadataDemotionsPreserved}`,
);
console.log(
  `     lost (MUST BE 0)                                   ${metadataDemotionsLost}`,
);
console.log(
  `     present under proposed policy                      ${proposedMetadataDemotions}`,
);
console.log("6. surface provenance vs execution log:");
console.log(
  `     fully execution-matched                            ${fullyExecutionMatched}`,
);
console.log(
  `     partially matched compound                        ${partiallyExecutionMatched}`,
);
console.log(
  `     any token unmatched                               ${anyTokenUnmatched}`,
);
console.log(
  `     zero tokens execution-matched                     ${zeroExecutionMatched}`,
);
console.log(
  `     no surface provenance                             ${noSurfaceProvenance}`,
);
console.log(
  `     artifacts on threads with no tool log             ${artifactsOnThreadsWithoutToolLog}`,
);
console.log(
  `     rejected: execution post-dates the artifact       ${backdatedExecutionArtifacts}`,
);
console.log("7. single-logical breach transport-duplicate shapes:");
console.log(
  `     historical caller shapes                          ${duplicateBreachTransportShapes}`,
);
console.log(
  `     historical deployed 60->65 nudge reproduced       ${duplicateBreachHistoricalNudges}`,
);
console.log(
  `     proposed fixed at single-source cap 60            ${duplicateBreachShapesFixedAt60}`,
);
console.log(
  `     invariant violations                              ${duplicateBreachInvariantViolations}`,
);
console.log(
  `\n   threads with tool logs: ${executedByThread.size}; tool rows: ${toolRowCount}`,
);
console.log("\nCAP DELTAS (historical deployed caller -> proposed policy):");
console.log(top(capDeltas));
console.log("\nSTATUS TRANSITIONS:");
console.log(top(statusTransitions));
console.log(
  "\nUNMATCHED ORIGIN BUCKETS (token counts; conservative, not suspicion labels):",
);
console.log(top(unmatchedOrigins));
console.log("\nGATES:");
console.log(
  `  metadata cannot raise cap ceiling: ${capRaised === 0 ? "PASS" : "FAIL"}`,
);
console.log(
  `  existing metadata demotions retained: ${
    metadataDemotionsLost === 0 ? "PASS" : "FAIL"
  }`,
);
console.log(
  `  duplicate breach transport invariant: ${
    duplicateBreachInvariantViolations === 0 ? "PASS" : "FAIL"
  }`,
);
console.log(
  "\nCAVEAT: artifacts.confidence is already persisted/capped. This compares the historical deployed",
);
console.log(
  "and proposed source-policy CAP CEILINGS; it cannot reconstruct the historical",
);
console.log(
  "model-requested or pre-cap effective confidence without a separately stored raw value.",
);
console.log(
  "Status changes are projected from persisted metadata through the current ordinary",
);
console.log(
  "recording helper; they are not a reconstruction of historical write-time status.",
);
console.log(
  "Collision-excluded and bio-link override rows are counted separately and excluded.",
);
console.log(
  "\nEXECUTION MATCHING IS AN UPPER BOUND ONLY. A tool counts as an artifact's provenance",
);
console.log(
  "when it ran at or before that artifact's write time (plus a same-call write-order",
);
console.log(
  "allowance, because auto-insert tools persist the artifact inside execute while the",
);
console.log(
  "usage-log row is written afterwards). There is no durable run_id or call identity on",
);
console.log(
  "artifacts or tool_usage_log, so no defensible LOWER bound exists: on a reused thread a",
);
console.log(
  "tool that ran long before an artifact still qualifies. These figures therefore bound",
);
console.log(
  "execution provenance from above; they do not prove per-call attribution.",
);
console.log(
  "Scope is the current operator account (RLS-scoped), not a multi-tenant population.",
);
console.log(
  "Auto-recorded rows retain cap-policy measurement but are separately counted and",
);
console.log(
  "excluded from ordinary status deltas because they use a different status writer.",
);
console.log("No artifact values were selected or printed.");

if (
  capRaised > 0 || metadataDemotionsLost > 0 ||
  duplicateBreachInvariantViolations > 0
) Deno.exitCode = 1;
