// deno-lint-ignore no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";

import type { ArtifactCandidate } from "./artifact-candidate.ts";
import { recordArtifactCandidates } from "./artifact-recorder.ts";

function candidate(overrides: Partial<ArtifactCandidate> = {}): ArtifactCandidate {
  return {
    kind: "email",
    value: "alice@example.com",
    source: "breach_check",
    sourceUrl: null,
    discoveredVia: "test fixture",
    rationale: "Observed in test data",
    confidence: 72,
    metadata: {},
    autoRecorded: false,
    ...overrides,
  };
}

Deno.test("recorder sends normalized rows to exactly one transactional RPC", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const db = {
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return Promise.resolve({ data: [{ artifact_id: "a1", evidence_id: "e1", inserted: true }], error: null });
    },
  };

  const result = await recordArtifactCandidates(db, "t1", [candidate({ kind: "email", value: " A@EXAMPLE.COM " })]);

  assertEquals(calls.length, 1);
  assertEquals(calls[0].name, "record_artifacts_with_evidence");
  const row = (calls[0].args._rows as Array<Record<string, unknown>>)[0];
  assertEquals(row.normalized_value, "a@example.com");
  assertEquals(row.source, "breach_check");
  assertEquals(row.evidence_tool_name, "breach_check");
  assertEquals(row.evidence_source, "breach_check");
  assertEquals(result.persisted[0], { artifactId: "a1", evidenceId: "e1", inserted: true });
  assertEquals(result.rejected, []);
});

Deno.test("recorder passes recognized-domain context into candidate conversion", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const db = {
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return Promise.resolve({
        data: [{ artifact_id: "a1", evidence_id: "e1", inserted: false }],
        error: null,
      });
    },
  };

  await recordArtifactCandidates(
    db,
    "t1",
    [candidate({ source: "seed.example" })],
    { recognizedDomains: ["seed.example"] },
  );

  const row = (calls[0].args._rows as Array<Record<string, unknown>>)[0];
  assertEquals(row.source, "seed.example");
  assertEquals(row.evidence_tool_name, "seed.example");
  assertEquals(row.evidence_source, "seed.example");
});

Deno.test("recorder rejects contract-success rows missing persisted identifiers", async () => {
  const db = {
    rpc: () =>
      Promise.resolve({
        data: [{ artifact_id: "a1", evidence_id: null, inserted: false }],
        error: null,
      }),
  };

  const result = await recordArtifactCandidates(db, "t1", [candidate()]);

  assertEquals(result.persisted, []);
  assertEquals(result.rejected, [{ index: 0, reason: "contract failure: missing artifact_id or evidence_id" }]);
});

Deno.test("recorder reports candidate rejections without calling the RPC", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const db = {
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return Promise.resolve({ data: [], error: null });
    },
  };

  const result = await recordArtifactCandidates(db, "t1", [candidate({ kind: "tool_failure" })]);

  assertEquals(calls.length, 0);
  assertEquals(result.persisted, []);
  assertEquals(result.rejected, [{ index: 0, reason: "unsupported artifact kind: tool_failure" }]);
});

Deno.test("recorder ignores malformed metadata sources without throwing", async () => {
  for (const malformedSources of [
    "breach_check",
    { provider: "breach_check" },
  ]) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const db = {
      rpc: (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return Promise.resolve({
          data: [{ artifact_id: "a1", evidence_id: "e1", inserted: true }],
          error: null,
        });
      },
    };

    const result = await recordArtifactCandidates(db, "t1", [
      candidate({ metadata: { sources: malformedSources } }),
    ]);

    assertEquals(calls.length, 1);
    assertEquals(result.persisted, [{
      artifactId: "a1",
      evidenceId: "e1",
      inserted: true,
    }]);
    assertEquals(result.rejected, []);
  }
});
