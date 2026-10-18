// rejected_cluster_sweep_test.ts — an analyst rejection clears the persisted
// cluster columns from the health path, without a re-run.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { resetSweepMemo, sweepRejectedClusterAssignments, describeSweep } from "../../functions/osint-agent/lib/rejected-cluster-sweep.ts";

const T1 = "11111111-2222-4333-8444-555555555555";
const T2 = "22222222-2222-4333-8444-555555555555";
const USER = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

type Write = { table: string; id: unknown; payload: Record<string, unknown> };

function fakeDb(rows: Array<Record<string, unknown>>, reviews: Array<Record<string, unknown>>, opts: { reviewsError?: boolean } = {}) {
  const writes: Write[] = [];
  const stale = (r: Record<string, unknown>) => r.cluster_id != null || r.subject_id != null;
  const db = {
    from(table: string) {
      const f: { inCol?: string; inVals?: unknown[]; eqs: Record<string, unknown>; or?: boolean; update?: Record<string, unknown> } = { eqs: {} };
      const q: Record<string, unknown> = {};
      const payload = () => {
        if (table === "artifact_reviews") {
          if (opts.reviewsError) return { data: null, error: { message: "boom" } };
          let out = reviews;
          if (f.inCol === "state") out = out.filter((r) => (f.inVals ?? []).includes(r.state));
          if (f.eqs.thread_id) out = out.filter((r) => r.thread_id === f.eqs.thread_id);
          if (f.eqs.user_id) out = out.filter((r) => r.user_id === f.eqs.user_id);
          return { data: out, error: null };
        }
        if (table === "artifacts") {
          let out = rows;
          if (f.inCol === "id") { const want = new Set((f.inVals ?? []).map(String)); out = out.filter((r) => want.has(String(r.id))); }
          if (f.eqs.thread_id) out = out.filter((r) => r.thread_id === f.eqs.thread_id);
          if (f.or) out = out.filter(stale);
          return { data: out, error: null };
        }
        return { data: [], error: null };
      };
      q.select = () => q;
      q.in = (c: string, v: unknown[]) => { f.inCol = c; f.inVals = v; return q; };
      q.or = () => { f.or = true; return q; };
      q.limit = () => q;
      q.order = () => q;
      q.update = (p: Record<string, unknown>) => { f.update = p; return q; };
      q.eq = (c: string, v: unknown) => {
        if (f.update && c === "id") {
          writes.push({ table, id: v, payload: f.update });
          const row = rows.find((r) => r.id === v);
          if (row) Object.assign(row, f.update);
          f.update = undefined;
          return q;
        }
        f.eqs[c] = v; return q;
      };
      q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(f.update === undefined ? payload() : { error: null }).then(res, rej);
      return q;
    },
  };
  return { db, writes };
}

const META = { cluster_id: "C1", subject_id: "S1", promoted_confidence: 80, confidence_tier: "Probable", keep: "me" };
const rows = () => [
  { id: "rej", thread_id: T1, kind: "email", value: "a@b.test", cluster_id: "C1", subject_id: "S1", metadata: { ...META } },
  // alias twin of a rejected selector: NOT itself reviewed, must clear too
  { id: "twin-a", thread_id: T1, kind: "ip_address", value: "203.0.113.57", cluster_id: "C1", subject_id: "S1", metadata: { ...META } },
  { id: "twin-b", thread_id: T1, kind: "ip", value: "203.0.113.57", cluster_id: "C1", subject_id: "S1", metadata: { ...META } },
  { id: "kept", thread_id: T1, kind: "email", value: "b@c.test", cluster_id: "C1", subject_id: "S1", metadata: { ...META } },
  { id: "never", thread_id: T1, kind: "username", value: "nightjar", cluster_id: null, subject_id: null, metadata: {} },
  { id: "t2-rej", thread_id: T2, kind: "email", value: "z@z.test", cluster_id: "C9", subject_id: "S9", metadata: { ...META } },
];
const reviews = () => [
  { artifact_id: "rej", thread_id: T1, user_id: USER, state: "dismissed", note: null },
  { artifact_id: "twin-a", thread_id: T1, user_id: USER, state: "wrong", note: null },
  { artifact_id: "kept", thread_id: T1, user_id: USER, state: "confirmed", note: null },
  { artifact_id: "t2-rej", thread_id: T2, user_id: USER, state: "dismissed", note: null },
  { artifact_id: "never", thread_id: T1, user_id: USER, state: "dismissed", note: null },
];

Deno.test("⛔ clears rejected rows AND their alias twins, leaves kept rows, never touches unassigned rows", async () => {
  resetSweepMemo();
  const { db, writes } = fakeDb(rows(), reviews());
  const r = await sweepRejectedClusterAssignments(db, { ignoreMemo: true });
  assert(r.ok, JSON.stringify(r));
  assertEquals(r.stale, 3, "rej, twin-a, t2-rej still held an assignment");
  assertEquals(new Set(writes.map((w) => String(w.id))), new Set(["rej", "twin-a", "twin-b", "t2-rej"]));
  assertEquals(r.cleared, 4);
  for (const w of writes) {
    assertEquals(w.payload.cluster_id, null);
    assertEquals(w.payload.subject_id, null);
    const m = w.payload.metadata as Record<string, unknown>;
    assertEquals(m.cluster_cleared_reason, "analyst_rejected");
    assertEquals(m.keep, "me", "the rest of the metadata survives");
    assertEquals(m.promoted_confidence, undefined);
  }
  assert(describeSweep(r).includes("cleared 4 of 3"));
});

Deno.test("idempotent: a second pass finds nothing stale and arms the clean memo", async () => {
  resetSweepMemo();
  const { db, writes } = fakeDb(rows(), reviews());
  await sweepRejectedClusterAssignments(db, { ignoreMemo: true, now: 1_000 });
  const n = writes.length;
  const again = await sweepRejectedClusterAssignments(db, { ignoreMemo: true, now: 2_000 });
  assertEquals(again.stale, 0);
  assertEquals(again.cleared, 0);
  assertEquals(writes.length, n, "no further writes");
  const memo = await sweepRejectedClusterAssignments(db, { now: 3_000 });
  assertEquals(memo.skipped, "recently_clean");
  const later = await sweepRejectedClusterAssignments(db, { now: 3_000 + 11 * 60 * 1000 });
  assertEquals(later.skipped, null, "the memo expires");
});

Deno.test("FAIL-CLOSED: an unreadable review set clears nothing", async () => {
  resetSweepMemo();
  const { db, writes } = fakeDb(rows(), reviews(), { reviewsError: true });
  const r = await sweepRejectedClusterAssignments(db, { ignoreMemo: true });
  assertEquals(r.ok, false);
  assertEquals(writes.length, 0);
});

Deno.test("bounded: maxThreads caps the per-probe work, the rest waits for the next probe", async () => {
  resetSweepMemo();
  const { db, writes } = fakeDb(rows(), reviews());
  const r = await sweepRejectedClusterAssignments(db, { ignoreMemo: true, maxThreads: 1 });
  assertEquals(r.threads, 1);
  assert(writes.length > 0 && writes.length < 4);
});

Deno.test("kill switch: REJECTED_CLUSTER_SWEEP_DISABLED skips without reading", async () => {
  resetSweepMemo();
  Deno.env.set("REJECTED_CLUSTER_SWEEP_DISABLED", "1");
  try {
    const { db, writes } = fakeDb(rows(), reviews());
    const r = await sweepRejectedClusterAssignments(db, { ignoreMemo: true });
    assertEquals(r.skipped, "disabled");
    assertEquals(writes.length, 0);
  } finally {
    Deno.env.delete("REJECTED_CLUSTER_SWEEP_DISABLED");
  }
});

/* ── wiring ─────────────────────────────────────────────────────────────── */
const HEALTH = await Deno.readTextFile(new URL("../../functions/osint-agent/health-handler.ts", import.meta.url));
const INDEX = await Deno.readTextFile(new URL("../../functions/osint-agent/index.ts", import.meta.url));
const CLUSTER = await Deno.readTextFile(new URL("../../functions/osint-agent/lib/cluster.ts", import.meta.url));

Deno.test("wiring: the health probe runs the sweep and reports it as a check", () => {
  assert(/await sweepRejectedClusterAssignments\(\s*admin/.test(HEALTH));
  assert(HEALTH.includes("r.checks.rejected_cluster_sweep"));
});

Deno.test("⛔ wiring: the sweep runs OUTSIDE any run — index.ts never imports it", () => {
  assert(!INDEX.includes("rejected-cluster-sweep"));
});

Deno.test("wiring: finalize clustering and the sweep clear by ONE definition", () => {
  assert(CLUSTER.includes("export async function clearStaleClusterAssignments("));
  assert(/await clearStaleClusterAssignments\(admin, data/.test(CLUSTER));
});
