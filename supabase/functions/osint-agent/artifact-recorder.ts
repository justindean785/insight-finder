import {
  convertCandidate,
  type ArtifactCandidate,
  type ArtifactConversionContext,
} from "./artifact-candidate.ts";
import { scrubArtifactRows } from "./safety.ts";

export interface PersistedArtifact {
  artifactId: string;
  evidenceId: string;
  inserted: boolean;
}

interface RpcResultRow {
  artifact_id?: unknown;
  evidence_id?: unknown;
  inserted?: unknown;
}

export async function recordArtifactCandidates(
  db: {
    rpc: (
      name: string,
      args: Record<string, unknown>,
    ) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
  },
  threadId: string,
  candidates: ArtifactCandidate[],
  context: ArtifactConversionContext = {},
): Promise<{
  persisted: PersistedArtifact[];
  rejected: Array<{ index: number; reason: string }>;
}> {
  const rows: Array<Record<string, unknown>> = [];
  const rowIndexes: number[] = [];
  const rejected: Array<{ index: number; reason: string }> = [];

  candidates.forEach((candidate, index) => {
    const converted = convertCandidate(candidate, context);
    if (!converted.row) {
      const reason = converted.reason ?? "candidate rejected";
      console.warn("[artifact-recorder] candidate rejected", {
        index,
        kind: candidate.kind,
        reason,
      });
      rejected.push({
        index,
        reason,
      });
      return;
    }

    rows.push(converted.row);
    rowIndexes.push(index);
  });

  if (rows.length === 0) {
    return { persisted: [], rejected };
  }

  const safeRows = scrubArtifactRows(rows);
  const { data, error } = await db.rpc("record_artifacts_with_evidence", {
    _thread_id: threadId,
    _rows: safeRows,
  });

  if (error) {
    console.warn("[artifact-recorder] transactional record failed:", error.message);
    return {
      persisted: [],
      rejected: [
        ...rejected,
        ...rowIndexes.map((index) => ({
          index,
          reason: `persistence failed: ${error.message}`,
        })),
      ],
    };
  }

  const results = Array.isArray(data) ? (data as RpcResultRow[]) : [];
  const persisted: PersistedArtifact[] = [];

  rowIndexes.forEach((index, resultIndex) => {
    const result = results[resultIndex];
    const artifactId =
      typeof result?.artifact_id === "string" ? result.artifact_id : null;
    const evidenceId =
      typeof result?.evidence_id === "string" ? result.evidence_id : null;

    if (!artifactId || !evidenceId) {
      console.warn("[artifact-recorder] persistence contract failure", {
        index,
        reason: "missing artifact_id or evidence_id",
      });
      rejected.push({
        index,
        reason: "contract failure: missing artifact_id or evidence_id",
      });
      return;
    }

    persisted.push({
      artifactId,
      evidenceId,
      inserted: result?.inserted === true,
    });
  });

  return { persisted, rejected };
}
