// Regression tests for the 2026-07-14 audit fixes on the record_artifacts path:
//   F2 — every evidence_log row must reference the artifact it corroborates
//        (evidence_log.artifact_id), not the hardcoded null it used to send.
//   F3 — every artifact must carry structured provenance in metadata
//        (discovered_via, source_url-or-source_tool, rationale); missing fields
//        are REPAIRED from what's known, never rejected.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildTools, type ToolContext } from "./tool-registry.ts";

interface Mock {
  supabase: unknown;
  evidenceCalls: Array<Record<string, unknown>>;
  insertedArtifacts: Array<Record<string, unknown>>;
}

function makeMock(): Mock {
  const evidenceCalls: Array<Record<string, unknown>> = [];
  const insertedArtifacts: Array<Record<string, unknown>> = [];
  const builder: Record<string, unknown> = {
    then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res),
  };
  for (const m of ["select", "eq", "or", "order", "limit", "is", "update"]) builder[m] = () => builder;
  const supabase = {
    from(_table: string) {
      return {
        insert(rows: unknown) {
          const arr = Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [rows as Record<string, unknown>];
          const base = insertedArtifacts.length;
          insertedArtifacts.push(...arr);
          const data = arr.map((r, i) => ({ id: `art-${base + i}`, kind: r.kind, value: r.value }));
          return {
            select: () => Promise.resolve({ data, error: null }),
            then: (res: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(res),
          };
        },
        select: () => builder,
        update: () => builder,
      };
    },
    rpc(name: string, args: Record<string, unknown>) {
      if (name === "append_evidence") evidenceCalls.push(args);
      return Promise.resolve({ data: [{ id: "ev", seq: 1, chain_hash: "h" }], error: null });
    },
  };
  return { supabase, evidenceCalls, insertedArtifacts };
}

function ctx(supabase: unknown): ToolContext {
  return {
    supabase, supabaseAdmin: supabase,
    userId: "link-test-user", threadId: "link-test-thread",
    archiveEnabled: false, detectedSeedType: "email", messages: [], manualOverrideSelector: null,
  } as unknown as ToolContext;
}

function record(mock: Mock, artifacts: unknown[]) {
  const { tools } = buildTools(ctx(mock.supabase));
  return (tools as Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>)
    .record_artifacts.execute({ artifacts }, {});
}

Deno.test("F2: each evidence row references its artifact id (not null)", async () => {
  const mock = makeMock();
  await record(mock, [
    { kind: "email", value: "raheem@example.com", source: "oathnet_lookup", confidence: 70 },
    { kind: "username", value: "raheem14", source: "username_sweep", confidence: 55 },
  ]);

  assertEquals(mock.insertedArtifacts.length, 2);
  assertEquals(mock.evidenceCalls.length, 2);

  // Build the same kind|value → id map the recorder builds, then assert each
  // evidence row carries the matching, non-null artifact_id.
  const idByKey = new Map(mock.insertedArtifacts.map((_r, i) => {
    const r = mock.insertedArtifacts[i];
    return [`${String(r.kind)} ${String(r.value)}`, `art-${i}`] as const;
  }));
  for (const ev of mock.evidenceCalls) {
    const key = `${String(ev._kind)} ${String(ev._value)}`;
    assert(ev._artifact_id != null, `evidence for ${key} must not have null artifact_id`);
    assertEquals(ev._artifact_id, idByKey.get(key), `evidence for ${key} must point at its artifact`);
  }
});

Deno.test("F3: missing provenance is repaired from the tool source (never rejected)", async () => {
  const mock = makeMock();
  await record(mock, [
    { kind: "phone", value: "+13125550142", source: "indicia_phone", confidence: 60 },
  ]);

  // Not rejected — the artifact is still recorded.
  assertEquals(mock.insertedArtifacts.length, 1);
  const meta = mock.insertedArtifacts[0].metadata as Record<string, unknown>;
  // discovered_via repaired from the tool source.
  assertEquals(meta.discovered_via, "indicia_phone");
  // No URL exists for a phone lookup → source_tool is populated instead (never fabricated).
  assert(!meta.source_url, "must NOT fabricate a source_url when none exists");
  assertEquals(meta.source_tool, "indicia_phone");
  // A rationale is always present.
  assert(typeof meta.rationale === "string" && (meta.rationale as string).length > 0);
});

Deno.test("F3: a real source_url is preserved and flows into the evidence row", async () => {
  const mock = makeMock();
  await record(mock, [
    { kind: "social", value: "sc/raheem", source: "socialfetch_lookup", confidence: 65,
      metadata: { source_url: "https://soundcloud.com/raheem" } },
  ]);

  const meta = mock.insertedArtifacts[0].metadata as Record<string, unknown>;
  assertEquals(meta.source_url, "https://soundcloud.com/raheem", "existing source_url must not be overwritten");
  assertEquals(meta.discovered_via, "socialfetch_lookup");
  // The evidence row inherits the same source_url (provenance repair runs before it).
  assertEquals(mock.evidenceCalls[0]._source_url, "https://soundcloud.com/raheem");
});
