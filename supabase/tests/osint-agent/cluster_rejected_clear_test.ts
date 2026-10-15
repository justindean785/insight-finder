// cluster_rejected_clear_test.ts — rejecting clustered evidence clears its stale
// cluster assignment.
//
// `applyClusteringToThread` already filtered rejected rows OUT of union-find, but
// a row that an EARLIER run had assigned a cluster_id/subject_id (and
// promoted_confidence / confidence_tier in its metadata) kept those values
// forever: nothing wrote them back to null. Every surface keyed on the persisted
// columns therefore still read the rejected row as a member of the subject's
// cluster. Authority, not deletion: the row, its confidence and the rest of its
// metadata must survive untouched.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyClusteringToThread } from "../../functions/osint-agent/lib/cluster.ts";

const THREAD = "11111111-2222-4333-8444-555555555555";
const USER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

type Write = { table: string; op: string; id?: unknown; payload: unknown };

function fakeDb(rows: Array<Record<string, unknown>>, reviews: Array<Record<string, unknown>>, opts?: { reviewsError?: boolean }) {
  const writes: Write[] = [];
  const db = {
    from(table: string) {
      const q: Record<string, unknown> = {};
      let inIds: unknown[] | null = null;
      let pendingUpdate: unknown = null;
      const payload = () => {
        if (table === "artifact_reviews") {
          return opts?.reviewsError ? { data: null, error: { message: "boom" } } : { data: reviews, error: null };
        }
        if (table === "artifacts") {
          if (inIds) { const want = new Set(inIds.map(String)); return { data: rows.filter((r) => want.has(String(r.id))), error: null }; }
          return { data: rows, error: null };
        }
        return { data: [], error: null };
      };
      q.select = () => q;
      q.in = (_c: string, ids: unknown[]) => { inIds = ids; return q; };
      q.order = () => q;
      q.limit = () => q;
      q.update = (p: unknown) => { pendingUpdate = p; return q; };
      q.eq = (col: string, v: unknown) => {
        if (pendingUpdate && col === "id") { writes.push({ table, op: "update", id: v, payload: pendingUpdate }); pendingUpdate = null; }
        return q;
      };
      q.insert = (p: unknown) => { writes.push({ table, op: "insert", payload: p }); return Promise.resolve({ error: null }); };
      q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(pendingUpdate === null ? payload() : { error: null }).then(res, rej);
      return q;
    },
  };
  return { db, writes };
}

const STALE_META = { cluster_id: "C001", subject_id: "S001", promoted_confidence: 80, confidence_tier: "Probable", source_category: ["breach"], keep: "me" };

const ROWS: Array<Record<string, unknown>> = [
  { id: "r1", kind: "email", value: "a@b.test", source: "hibp", confidence: 65, cluster_id: "C001", subject_id: "S001", metadata: STALE_META },
  // A DIFFERENT selector on purpose: a second row carrying the SAME kind|value as
  // a rejected one is itself excluded (that is the re-record bypass closing), so
  // it would be cleared too and could not stand in for "an unrelated kept row".
  { id: "r2", kind: "email", value: "b@c.test", source: "court_record_search", confidence: 70, cluster_id: "C001", subject_id: "S001", metadata: { cluster_id: "C001", subject_id: "S001" } },
  { id: "r3", kind: "username", value: "nightjar", source: "sherlock", confidence: 50, cluster_id: null, subject_id: null, metadata: {} },
];

Deno.test("⛔ a rejected row with a stale cluster_id/subject_id is cleared, and only it", async () => {
  const { db, writes } = fakeDb(ROWS, [{ artifact_id: "r1", state: "dismissed" }]);
  const res = await applyClusteringToThread(db, THREAD, USER);
  assertEquals(res.cleared, 1);
  const clear = writes.find((w) => w.op === "update" && w.id === "r1");
  assert(clear, "the rejected row must receive a clearing update");
  const p = clear!.payload as Record<string, unknown>;
  assertEquals(p.cluster_id, null);
  assertEquals(p.subject_id, null);
  const meta = p.metadata as Record<string, unknown>;
  assertEquals(meta.cluster_id, undefined);
  assertEquals(meta.subject_id, undefined);
  assertEquals(meta.promoted_confidence, undefined);
  assertEquals(meta.confidence_tier, undefined);
  assertEquals(meta.cluster_cleared_reason, "analyst_rejected");
  // Authority, not deletion: everything else on the row survives.
  assertEquals(meta.source_category, ["breach"]);
  assertEquals(meta.keep, "me");
  assertEquals("confidence" in p, false, "the recorded confidence is never rewritten");
  // The surviving rows are still clustered normally.
  assert(writes.some((w) => w.op === "update" && w.id === "r2"), "kept rows still receive their assignment");
});

Deno.test("a rejected row that was never clustered gets no write", async () => {
  const { db, writes } = fakeDb(ROWS, [{ artifact_id: "r3", state: "wrong" }]);
  const res = await applyClusteringToThread(db, THREAD, USER);
  assertEquals(res.cleared, 0);
  assertEquals(writes.some((w) => w.op === "update" && w.id === "r3"), false);
});

Deno.test("re-clustering a rejected row must not restore its assignment (idempotent)", async () => {
  const { db, writes } = fakeDb(ROWS, [{ artifact_id: "r1", state: "dismissed" }]);
  await applyClusteringToThread(db, THREAD, USER);
  const r1Writes = writes.filter((w) => w.op === "update" && w.id === "r1");
  assertEquals(r1Writes.length, 1, "exactly the clearing write — never a re-assignment");
});

Deno.test("FAIL-CLOSED: an unreadable review set clusters nothing and clears nothing", async () => {
  const { db, writes } = fakeDb(ROWS, [], { reviewsError: true });
  const res = await applyClusteringToThread(db, THREAD, USER);
  assertEquals(res.updated, 0);
  assertEquals(res.cleared, 0);
  assertEquals(writes.filter((w) => w.op === "update").length, 0);
});

Deno.test("confirmed / key / recheck do not change the promoted confidence that enters clustering", async () => {
  // The old path applied ±deltas BEFORE union-find promotion, so a Key click
  // raised the number every member was promoted from. Now the recorded
  // confidence is what clusters — the assignment writes are identical with and
  // without the verdicts.
  const plain = fakeDb(ROWS, []);
  const marked = fakeDb(ROWS, [{ artifact_id: "r1", state: "key" }, { artifact_id: "r2", state: "recheck" }]);
  await applyClusteringToThread(plain.db, THREAD, USER);
  await applyClusteringToThread(marked.db, THREAD, USER);
  const pick = (ws: Write[]) => ws.filter((w) => w.op === "update").map((w) => [w.id, (w.payload as Record<string, unknown>).metadata]);
  assertEquals(pick(marked.writes), pick(plain.writes));
});
