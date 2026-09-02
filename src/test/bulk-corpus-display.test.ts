import { describe, expect, it } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import {
  BULK_CORPUS_REASON_MARK,
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
