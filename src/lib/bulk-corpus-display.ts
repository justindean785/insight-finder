import type { Artifact } from "@/hooks/useThreadArtifacts";
import { isQuarantined } from "@/lib/quarantine";

/** Shared prefix every bulk-corpus quarantine row carries in metadata. */
export const BULK_CORPUS_REASON_MARK = "harvested from a bulk corpus return";

export function isBulkCorpusHarvestArtifact(a: Artifact): boolean {
  const kind = a.kind.toLowerCase();
  if (kind === "bulk_corpus_harvest") return true;
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  return meta.bulk_corpus === true;
}

/** Group key for legacy per-row bulk spam that predates the collapsed summary kind. */
export function legacyBulkCorpusGroupKey(a: Artifact): string | null {
  if (!isQuarantined(a.metadata)) return null;
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  const reason = String(meta.subject_unlinked_reason ?? "");
  if (!reason.includes(BULK_CORPUS_REASON_MARK)) return null;
  const source = (a.source ?? "").trim().toLowerCase();
  return `${source}|${reason}`;
}

export type BulkCorpusDisplayRow =
  | { type: "single"; artifact: Artifact }
  | {
      type: "bulk_group";
      key: string;
      artifacts: Artifact[];
      reason: string;
      source: string | null;
    };

/**
 * Collapse legacy bulk-corpus spam for display. New runs emit one
 * `bulk_corpus_harvest` row; older threads still carry dozens of rows that
 * share one quarantine reason — group them so the board stays scannable.
 */
export function partitionBulkCorpusRows(rows: Artifact[]): BulkCorpusDisplayRow[] {
  const singles: Artifact[] = [];
  const groups = new Map<string, Artifact[]>();

  for (const a of rows) {
    if (isBulkCorpusHarvestArtifact(a)) {
      singles.push(a);
      continue;
    }
    const key = legacyBulkCorpusGroupKey(a);
    if (!key) {
      singles.push(a);
      continue;
    }
    const bucket = groups.get(key) ?? [];
    bucket.push(a);
    groups.set(key, bucket);
  }

  const out: BulkCorpusDisplayRow[] = singles.map((artifact) => ({ type: "single", artifact }));

  for (const [key, artifacts] of groups) {
    if (artifacts.length < 3) {
      for (const artifact of artifacts) out.push({ type: "single", artifact });
      continue;
    }
    const meta = (artifacts[0].metadata ?? {}) as Record<string, unknown>;
    out.push({
      type: "bulk_group",
      key,
      artifacts,
      reason: String(meta.subject_unlinked_reason ?? BULK_CORPUS_REASON_MARK),
      source: artifacts[0].source,
    });
  }

  return out;
}

export function harvestedIdentityPreview(a: Artifact, limit = 6): string[] {
  const meta = (a.metadata ?? {}) as Record<string, unknown>;
  const raw = meta.harvested_identities;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const row = item as { kind?: unknown; value?: unknown };
    const value = typeof row.value === "string" ? row.value.trim() : "";
    if (!value) continue;
    out.push(value);
    if (out.length >= limit) break;
  }
  return out;
}
