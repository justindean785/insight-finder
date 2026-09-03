import { describe, expect, it } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import {
  BULK_CORPUS_REASON_MARK,
  NAME_ONLY_HARVEST_REASON_MARK,
  groupLabelForReason,
  isBulkCorpusHarvestArtifact,
  legacyBulkCorpusGroupKey,
  partitionBulkCorpusRows,
} from "@/lib/bulk-corpus-display";

const art = (over: Partial<Artifact> & Pick<Artifact, "id" | "kind" | "value">): Artifact => ({
  confidence: 45,
  source: "indicia_address",
  created_at: "2026-01-01T00:00:00Z",
  metadata: null,
  ...over,
});

describe("bulk-corpus display grouping", () => {
  it("groups legacy quarantined rows that share one bulk-corpus reason", () => {
    const reason =
      `${BULK_CORPUS_REASON_MARK} — this one lookup yielded 67 person identities for a single selector`;
    const rows = [
      art({ id: "1", kind: "name", value: "Gabriel G. Salas", metadata: { subject_unlinked: true, subject_unlinked_reason: reason } }),
      art({ id: "2", kind: "name", value: "Esther Salas", metadata: { subject_unlinked: true, subject_unlinked_reason: reason } }),
      art({ id: "3", kind: "email", value: "a@example.com", metadata: { subject_unlinked: true, subject_unlinked_reason: reason } }),
      art({ id: "4", kind: "phone", value: "+15551234567", metadata: {} }),
    ];
    const out = partitionBulkCorpusRows(rows);
    expect(out.filter((r) => r.type === "bulk_group")).toHaveLength(1);
    expect(out.filter((r) => r.type === "single")).toHaveLength(1);
    const group = out.find((r) => r.type === "bulk_group");
    expect(group && group.type === "bulk_group" ? group.artifacts.length : 0).toBe(3);
  });

  it("leaves pairs ungrouped", () => {
    const reason = `${BULK_CORPUS_REASON_MARK} — example`;
    const rows = [
      art({ id: "1", kind: "name", value: "A", metadata: { subject_unlinked: true, subject_unlinked_reason: reason } }),
      art({ id: "2", kind: "name", value: "B", metadata: { subject_unlinked: true, subject_unlinked_reason: reason } }),
    ];
    expect(partitionBulkCorpusRows(rows).every((r) => r.type === "single")).toBe(true);
  });

  it("recognizes collapsed backend summary rows", () => {
    const row = art({
      id: "s",
      kind: "bulk_corpus_harvest",
      value: "67 unlinked identities — bulk corpus (gsalas916@icloud.com)",
      metadata: { bulk_corpus: true, harvested_identities: [{ kind: "name", value: "Gabriel G. Salas" }] },
    });
    expect(isBulkCorpusHarvestArtifact(row)).toBe(true);
    expect(legacyBulkCorpusGroupKey(row)).toBeNull();
  });
});

/**
 * Retroactive repair of name-only harvest spam.
 *
 * Production thread `c599a5bc` (domain seed) carries 42 rows from
 * two `oathnet_lookup{type:"name"}` calls — 15 addresses, 14 phones, 12 emails —
 * each its own card. The backend now collapses these at write time, but that
 * only helps FUTURE runs; every scan already on the board still has them. This
 * grouping is display-only and needs no edge-function deploy, so it repairs the
 * existing threads too.
 */
describe("name-only harvest grouping", () => {
  const harvestReason =
    `${NAME_ONLY_HARVEST_REASON_MARK} — same-name collision axis; linkage to the subject is unproven`;
  // The queried name echoing back. Shares the phrase "name-only query" but is the
  // subject's own apparent name, so it must stay a card of its own.
  const echoReason =
    "echo of a name-only query whose queried name is not itself linked to the subject — " +
    "same-name collision axis; the matching name does not prove this record is the subject's";

  const harvested = (id: string, kind: string, value: string) =>
    art({ id, kind, value, source: "oathnet_lookup", metadata: { subject_unlinked: true, subject_unlinked_reason: harvestReason } });

  it("groups same-name strangers harvested from one name lookup", () => {
    const rows = [
      harvested("1", "address", "101 Example Street, Springfield, IL"),
      harvested("2", "address", "202 Example Street, Arlington, TX"),
      harvested("3", "phone", "+15550100001"),
      harvested("4", "email", "jordan.vale1@example.invalid"),
    ];
    const out = partitionBulkCorpusRows(rows);
    const group = out.find((r) => r.type === "bulk_group");
    expect(group && group.type === "bulk_group" ? group.artifacts.length : 0).toBe(4);
  });

  it("labels the group as a same-name collision, NOT a bulk corpus", () => {
    expect(groupLabelForReason(harvestReason)).toBe("same-name identities");
    expect(groupLabelForReason(`${BULK_CORPUS_REASON_MARK} — x`)).toBe("bulk-corpus identities");
  });

  it("NEGATIVE: the queried-name echo is never folded into the group", () => {
    const rows = [
      harvested("1", "address", "101 Example Street, Springfield, IL"),
      harvested("2", "phone", "+15550100001"),
      harvested("3", "email", "jordan.vale1@example.invalid"),
      art({ id: "echo", kind: "name", value: "Jordan Vale", source: "oathnet_lookup", metadata: { subject_unlinked: true, subject_unlinked_reason: echoReason } }),
    ];
    const out = partitionBulkCorpusRows(rows);
    expect(legacyBulkCorpusGroupKey(rows[3])).toBeNull();
    const singles = out.filter((r) => r.type === "single");
    expect(singles).toHaveLength(1);
    expect(singles[0].type === "single" ? singles[0].artifact.value : "").toBe("Jordan Vale");
  });

  it("NEGATIVE: an unquarantined row is never grouped", () => {
    const row = art({ id: "x", kind: "address", value: "1 Real Street", metadata: { subject_unlinked_reason: harvestReason } });
    expect(legacyBulkCorpusGroupKey(row)).toBeNull();
  });
});
