import type { Artifact } from "@/hooks/useThreadArtifacts";
import { isQuarantined } from "@/lib/quarantine";

/** Shared prefix every bulk-corpus quarantine row carries in metadata. */
export const BULK_CORPUS_REASON_MARK = "harvested from a bulk corpus return";

/**
 * Shared prefix every NAME-ONLY harvest quarantine row carries in metadata.
 *
 * A name-only lookup (e.g. `oathnet_lookup {type:"name"}`) returns every person
 * sharing that name, so each returned address/phone/email is a same-name
 * stranger's until proven otherwise. The write path already quarantines them —
 * but one production run persisted 42 of them as 42 separate cards, because the
 * backend's bulk-corpus collapse skips rows that are ALREADY quarantined and
 * these are stamped by the name-only gate first.
 *
 * Grouping them here is display-only and retroactive: it needs no edge-function
 * deploy, and it repairs threads that have already been run. Nothing is hidden —
 * the group expands to every row, and each row keeps its reason.
 *
 * MUST be the full phrase, not just "name-only query": the ECHO row (the queried
 * name itself) carries "echo of a name-only query …", and that row is the
 * subject's own apparent name. It has to stay a card of its own.
 */
export const NAME_ONLY_HARVEST_REASON_MARK = "harvested from a name-only query";

/** Quarantine reason prefixes whose rows collapse into one display group. */
const GROUPABLE_REASON_MARKS = [
  BULK_CORPUS_REASON_MARK,
  NAME_ONLY_HARVEST_REASON_MARK,
] as const;

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
  if (!GROUPABLE_REASON_MARKS.some((mark) => reason.includes(mark))) return null;
  const source = (a.source ?? "").trim().toLowerCase();
  return `${source}|${reason}`;
}

/** Which collapse class a quarantine reason belongs to, as an analyst-facing noun. */
export function groupLabelForReason(reason: string): string {
  return reason.includes(NAME_ONLY_HARVEST_REASON_MARK)
    ? "same-name identities"
    : "bulk-corpus identities";
}

export type BulkCorpusDisplayRow =
  | { type: "single"; artifact: Artifact }
  | {
      type: "bulk_group";
      key: string;
      artifacts: Artifact[];
      reason: string;
      source: string | null;
      /** Noun phrase naming WHY these rows group, e.g. "same-name identities".
       *  The two collapse classes are different findings and must not both read
       *  as a bulk corpus: one is a dataset of many people, the other is a set of
       *  strangers who merely share the subject's name. */
      label: string;
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
    const reason = String(meta.subject_unlinked_reason ?? BULK_CORPUS_REASON_MARK);
    out.push({
      type: "bulk_group",
      key,
      artifacts,
      reason,
      source: artifacts[0].source,
      label: groupLabelForReason(reason),
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
