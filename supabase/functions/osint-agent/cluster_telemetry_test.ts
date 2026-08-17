// cluster_telemetry_test.ts — clustering bookkeeping must never be persisted as evidence.
//
// applyClusteringToThread used to INSERT a `cluster_decision` artifact at
// confidence 100. Nothing consumed it (zero backend readers; the only frontend
// reference was the filter that excludes it), yet it out-ranked every real finding
// — highest genuine artifact in production is 75, breach cap 60, quarantine
// ceiling 55 — and it carried no source_category / confidence_cap_applied /
// subject_unlinked, so it bypassed every write-path control.
//
// These tests DRIVE the shipped function with a fake DB that records every write,
// rather than grepping the source for an absent string.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyClusteringToThread } from "./lib/cluster.ts";

const THREAD = "11111111-2222-4333-8444-555555555555";
const USER = "99999999-8888-4777-8666-555555555555";

type Write = { table: string; op: "insert" | "update"; payload: unknown };

/** Minimal PostgREST-shaped fake. Records inserts/updates so a test can assert on
 *  what the function actually wrote, not on what the source appears to say. */
function fakeDb(artifacts: Array<Record<string, unknown>>) {
  const writes: Write[] = [];
  const thenable = (data: unknown) => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      is: () => chain,
      then: (res: (v: { data: unknown; error: null }) => unknown) => res({ data, error: null }),
    };
    return chain;
  };
  const db = {
    from(table: string) {
      return {
        select: (_cols?: string) => thenable(table === "artifacts" ? artifacts : []),
        insert: (payload: unknown) => {
          writes.push({ table, op: "insert", payload });
          return thenable(null);
        },
        update: (payload: unknown) => {
          writes.push({ table, op: "update", payload });
          return thenable(null);
        },
      };
    },
  };
  return { db, writes };
}

/**
 * Two artifacts that share a STRONG token so union-find records a merge —
 * `decisions.length` must be non-zero or the telemetry branch never runs.
 *
 * strongTokens() takes handles from the VALUE by kind and from a fixed set of
 * metadata keys (associated_handle / seed_association / instagram / handle /
 * github) — `metadata.email` is NOT one of them. So the join here is
 * `handle:jdoe`: the username's value, and the email row's asserted handle.
 */
const MERGEABLE: Array<Record<string, unknown>> = [
  { id: "a1", kind: "username", value: "jdoe", source: "socialfetch_lookup", confidence: 50,
    metadata: {} },
  { id: "a2", kind: "email", value: "jdoe@example.com", source: "breach_check", confidence: 60,
    metadata: { handle: "jdoe" } },
];

Deno.test("clustering NEVER inserts a cluster_decision artifact", async () => {
  const { db, writes } = fakeDb(MERGEABLE);
  await applyClusteringToThread(db, THREAD, USER);

  const inserts = writes.filter((w) => w.op === "insert");
  const artifactInserts = inserts.filter((w) => w.table === "artifacts");
  assertEquals(
    artifactInserts.length,
    0,
    `clustering inserted ${artifactInserts.length} artifact row(s): ${JSON.stringify(artifactInserts)}`,
  );

  // Belt and braces: no write anywhere may carry the kind or the old value string.
  const blob = JSON.stringify(writes);
  assertEquals(blob.includes("cluster_decision"), false, "no write may carry kind cluster_decision");
  assertEquals(blob.includes("Deterministic clustering"), false, "the old telemetry value must not be persisted");
});

Deno.test("clustering still updates member rows — the fix removed telemetry, not clustering", async () => {
  // Guards against 'fixing' the inflation by disabling clustering altogether.
  const { db, writes } = fakeDb(MERGEABLE);
  const res = await applyClusteringToThread(db, THREAD, USER);
  const updates = writes.filter((w) => w.op === "update" && w.table === "artifacts");
  assert(updates.length > 0, "member rows must still receive cluster_id/subject_id");
  assert(res.subjects > 0, `expected at least one subject, got ${res.subjects}`);
});

Deno.test("the clustering summary still reaches the caller via the return value", async () => {
  // This is why deleting the artifact loses nothing: the counts were already
  // returned, so the row was redundant with the function's own contract.
  const { db } = fakeDb(MERGEABLE);
  const res = await applyClusteringToThread(db, THREAD, USER);
  assertEquals(typeof res.updated, "number");
  assertEquals(typeof res.subjects, "number");
  assertEquals(typeof res.merges, "number");
});

Deno.test("clustering telemetry is emitted as a structured log line", async () => {
  const seen: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => { seen.push(a.map(String).join(" ")); };
  try {
    const { db } = fakeDb(MERGEABLE);
    await applyClusteringToThread(db, THREAD, USER);
  } finally {
    console.log = orig;
  }
  const line = seen.find((s) => s.includes("clustering_applied"));
  assert(line, `expected a clustering_applied log line, got: ${JSON.stringify(seen)}`);
  const parsed = JSON.parse(line!);
  assertEquals(parsed.event, "clustering_applied");
  assertEquals(parsed.thread_id, THREAD);
  assertEquals(typeof parsed.subject_count, "number");
  assertEquals(typeof parsed.merge_count, "number");
});
