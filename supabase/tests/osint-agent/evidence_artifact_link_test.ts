// evidence_artifact_link_test.ts — record_artifacts links each chain-of-custody
// row to the artifact it was appended for.
//
// Measured 2026-10-30: all 17,575 production evidence_log rows had artifact_id
// NULL, because every append_evidence writer passed `_artifact_id: null`. These
// tests pin that record_artifacts now sends the real id, that the lookup never
// fails a write (it falls back to null), and that it keys by kind as well as
// value so a username can never inherit a name's artifact id.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  evidenceArtifactKey,
  lookupArtifactIdsForEvidence,
} from "../../functions/osint-agent/lib/evidence-artifact-link.ts";
import { buildTools, type ToolContext } from "../../functions/osint-agent/tool-registry.ts";

type Rec = Record<string, unknown>;

/** A query builder that records its filters and resolves to `rows`. */
function linkDb(rows: Rec[], opts: { error?: unknown; throws?: boolean } = {}) {
  const calls: Array<[string, unknown[]]> = [];
  const q: Rec = {};
  for (const m of ["select", "eq", "in", "order"]) {
    q[m] = (...a: unknown[]) => {
      calls.push([m, a]);
      if (opts.throws) throw new Error("boom");
      return q;
    };
  }
  q.limit = (...a: unknown[]) => {
    calls.push(["limit", a]);
    return Promise.resolve({ data: opts.error ? null : rows, error: opts.error ?? null });
  };
  return { db: { from: (_t: string) => q }, calls };
}

// ── unit ────────────────────────────────────────────────────────────────────

Deno.test("lookup: maps (kind, value) to the artifact id, scoped to the thread", async () => {
  const { db, calls } = linkDb([
    { id: "art-email", kind: "email", value: "j@example.com" },
    { id: "art-domain", kind: "domain", value: "example.com" },
  ]);
  const ids = await lookupArtifactIdsForEvidence(db, "t1", [
    { kind: "email", value: "j@example.com" },
    { kind: "domain", value: "example.com" },
  ]);
  assertEquals(ids.get(evidenceArtifactKey("email", "j@example.com")), "art-email");
  assertEquals(ids.get(evidenceArtifactKey("domain", "example.com")), "art-domain");
  assert(calls.some(([m, a]) => m === "eq" && a[0] === "thread_id" && a[1] === "t1"), "must filter by thread");
});

Deno.test("lookup: newest row wins when the same (kind, value) exists twice", async () => {
  // Rows arrive newest-first (order created_at desc); the first one is kept.
  const { db } = linkDb([
    { id: "art-new", kind: "email", value: "j@example.com" },
    { id: "art-old", kind: "email", value: "j@example.com" },
  ]);
  const ids = await lookupArtifactIdsForEvidence(db, "t1", [{ kind: "email", value: "j@example.com" }]);
  assertEquals(ids.get(evidenceArtifactKey("email", "j@example.com")), "art-new");
});

Deno.test("lookup: a username never inherits a name's id for the same text", async () => {
  const { db } = linkDb([{ id: "art-name", kind: "name", value: "jordan vale" }]);
  const ids = await lookupArtifactIdsForEvidence(db, "t1", [{ kind: "username", value: "jordan vale" }]);
  assertEquals(ids.get(evidenceArtifactKey("username", "jordan vale")), undefined);
});

Deno.test("lookup: a query error, a throw, or no rows all fail open to an empty map", async () => {
  const rows = [{ kind: "email", value: "j@example.com" }];
  assertEquals((await lookupArtifactIdsForEvidence(linkDb([], { error: { message: "denied" } }).db, "t1", rows)).size, 0);
  assertEquals((await lookupArtifactIdsForEvidence(linkDb([], { throws: true }).db, "t1", rows)).size, 0);
  assertEquals((await lookupArtifactIdsForEvidence({ from: () => ({}) }, "t1", rows)).size, 0);
  assertEquals((await lookupArtifactIdsForEvidence(linkDb([]).db, "t1", [])).size, 0);
});

// ── record_artifacts integration ───────────────────────────────────────────

function recordMock(idRows: Rec[]) {
  const evidenceCalls: Rec[] = [];
  const inserted: Rec[] = [];
  const builder: Rec = {
    then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res),
  };
  for (const m of ["eq", "or", "order", "is", "update"]) builder[m] = () => builder;
  // `.in(...)` only appears on the artifact-link lookup; answer it with ids.
  builder.in = () => ({
    order: () => ({ limit: () => Promise.resolve({ data: idRows, error: null }) }),
  });
  builder.limit = () => Promise.resolve({ data: [], error: null });
  const supabase = {
    from(_t: string) {
      return {
        insert(rows: unknown) {
          inserted.push(...(Array.isArray(rows) ? rows as Rec[] : [rows as Rec]));
          return Promise.resolve({ error: null });
        },
        select: () => builder,
        update: () => builder,
      };
    },
    rpc(name: string, args: Rec) {
      if (name === "append_evidence") evidenceCalls.push(args);
      return Promise.resolve({ data: [{ id: "ev", seq: 1, chain_hash: "h" }], error: null });
    },
  };
  return { supabase, evidenceCalls, inserted };
}

function ctx(supabase: unknown): ToolContext {
  return {
    supabase, supabaseAdmin: supabase, userId: "u-link", threadId: "t-link",
    archiveEnabled: false, detectedSeedType: "email", messages: [], manualOverrideSelector: null,
  } as unknown as ToolContext;
}

async function record(mock: ReturnType<typeof recordMock>, artifacts: Rec[]) {
  const { tools } = buildTools(ctx(mock.supabase));
  await (tools as Record<string, { execute: (i: unknown, o: unknown) => Promise<unknown> }>)
    .record_artifacts.execute({ artifacts }, {});
}

Deno.test("record_artifacts: the evidence row carries the artifact id it was appended for", async () => {
  const mock = recordMock([{ id: "art-123", kind: "email", value: "victim@example.com" }]);
  await record(mock, [{ kind: "email", value: "victim@example.com", source: "oathnet_lookup" }]);
  assertEquals(mock.evidenceCalls.length, 1);
  assertEquals(mock.evidenceCalls[0]._artifact_id, "art-123");
});

Deno.test("record_artifacts: when the lookup finds nothing the row is still written, with a null id", async () => {
  const mock = recordMock([]);
  await record(mock, [{ kind: "email", value: "victim@example.com", source: "oathnet_lookup" }]);
  assertEquals(mock.inserted.length, 1);
  assertEquals(mock.evidenceCalls.length, 1);
  assertEquals(mock.evidenceCalls[0]._artifact_id, null);
});
