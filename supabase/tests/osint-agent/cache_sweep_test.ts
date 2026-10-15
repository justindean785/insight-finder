// cache_sweep_test.ts — the six ways a maintenance sweep quietly ruins a corpus.
//
// This one DELETES PRODUCTION ROWS, so the tests that matter are the ones that
// would fail if it deleted the wrong ones, deleted too many, or took the health
// probe down with it when the database said no.
//
// Context, measured 2026-08-29: tool_call_cache held 11,105 rows, 11,009 of them
// expired, oldest expiry 2026-06-25. The #510 pg_cron migration never ran and
// could not have — pg_cron is not installed, the `cron` schema does not exist,
// the migration is absent from schema_migrations, and its own second DO block
// references cron.job unconditionally so it would have thrown. This module
// replaces that approach with a bounded sweep on the existing health path.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  sweepExpiredCache,
  cacheSweepEnabled,
  cacheSweepDryRun,
  describeCacheSweep,
  CACHE_SWEEP_BATCH,
  CACHE_SWEEP_DELETE_CHUNK,
} from "../../functions/osint-agent/cache-sweep.ts";

type Row = { id: string; expires_at: string | null };

/**
 * Fake PostgREST over an in-memory table. Applies `lt` and `limit` for real, so
 * "preserves live rows" is a property of the QUERY under test, not of a fixture
 * that only contains expired rows.
 */
function fakeDb(rows: Row[], cfg: { selectError?: boolean; deleteError?: boolean; /** Succeed this many DELETE statements, then fail — models a fault partway through a chunked removal. */ deleteErrorAfter?: number; throwOn?: "select" | "delete" } = {}) {
  const table = [...rows];
  const deletes: string[][] = [];
  let deleteCalls = 0;
  const db = {
    from(_t: string) {
      let mode: "select" | "delete" = "select";
      let cutoff: string | null = null;
      let lim = Infinity;
      let ids: string[] | null = null;
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.delete = () => { mode = "delete"; return q; };
      q.lt = (_c: string, v: string) => { cutoff = v; return q; };
      q.in = (_c: string, v: string[]) => { ids = v; return q; };
      q.limit = (n: number) => { lim = n; return q; };
      const settle = () => {
        if (mode === "delete") {
          if (cfg.throwOn === "delete") throw new Error("boom");
          if (cfg.deleteError) return { error: { message: "delete denied" } };
          deleteCalls++;
          if (cfg.deleteErrorAfter !== undefined && deleteCalls > cfg.deleteErrorAfter) {
            deletes.push([...new Set(ids ?? [])]);
            return { error: { message: "delete denied" } };
          }
          const set = new Set(ids ?? []);
          deletes.push([...set]);
          for (let i = table.length - 1; i >= 0; i--) if (set.has(table[i].id)) table.splice(i, 1);
          return { error: null };
        }
        if (cfg.throwOn === "select") throw new Error("boom");
        if (cfg.selectError) return { data: null, error: { message: "select denied" } };
        // Real three-valued semantics: a NULL expires_at never satisfies `<`.
        const hit = table.filter((r) => r.expires_at !== null && cutoff !== null && r.expires_at < cutoff);
        return { data: hit.slice(0, lim).map((r) => ({ id: r.id })), error: null };
      };
      // deno-lint-ignore no-explicit-any
      q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => {
        try { return Promise.resolve(settle()).then(res, rej); } catch (e) { return Promise.reject(e).then(res, rej); }
      };
      return q;
    },
  };
  return { db, table, deletes };
}

const PAST = "2026-01-01T00:00:00.000Z";
const FUTURE = "2099-01-01T00:00:00.000Z";
const NOW = new Date("2026-08-29T00:00:00.000Z");

const expired = (n: number, p = "e") => Array.from({ length: n }, (_, i) => ({ id: `${p}${i}`, expires_at: PAST }));
const live = (n: number, p = "L") => Array.from({ length: n }, (_, i) => ({ id: `${p}${i}`, expires_at: FUTURE }));

/* ── (a) deletes expired rows ─────────────────────────────────────────────── */

Deno.test("(a) removes expired rows", async () => {
  const { db, table } = fakeDb([...expired(3), ...live(2)]);
  const r = await sweepExpiredCache(db, { now: NOW });
  assertEquals(r.attempted, 3);
  assertEquals(r.deleted, 3);
  assertEquals(r.errors, 0);
  assertEquals(table.length, 2);
});

/* ── (b) preserves live rows ──────────────────────────────────────────────── */

Deno.test("⛔ (b) NEVER removes a live row, and never one with no expiry at all", async () => {
  // The expensive direction. A cache row deleted early is a paid provider call
  // re-made; the whole table is provider results someone was billed for.
  const rows: Row[] = [...expired(2), ...live(2), { id: "noexpiry", expires_at: null }];
  const { db, table } = fakeDb(rows);
  const r = await sweepExpiredCache(db, { now: NOW });
  assertEquals(r.deleted, 2);
  const survivors = table.map((t) => t.id).sort();
  assertEquals(survivors, ["L0", "L1", "noexpiry"], "future expiries and NULL expiries both survive");
});

/* ── (c) respects the batch bound ─────────────────────────────────────────── */

Deno.test("⛔ (c) is BOUNDED — a 11k backlog is not one statement", async () => {
  const { db, table, deletes } = fakeDb(expired(50));
  const r = await sweepExpiredCache(db, { batch: 10, now: NOW });
  assertEquals(r.attempted, 10);
  assertEquals(r.deleted, 10);
  assertEquals(r.more, true, "the caller must be able to see that more remain");
  assertEquals(table.length, 40);
  assertEquals(deletes[0].length, 10, "the delete carried exactly the bounded id set");
});

Deno.test("(c2) the default bound is the documented one", () => {
  assertEquals(CACHE_SWEEP_BATCH, 5_000);
});

/* ── (c3) the delete is chunked, because the transport cannot carry the batch ── */

Deno.test("⛔ (c3) no DELETE ever carries more ids than the transport accepts", async () => {
  // PostgREST renders `.in("id", ids)` into the URL query string. The full 5,000-id
  // batch builds a ~185 KB URL and the gateway rejects past ~24 KB, so an unchunked
  // sweep errors on EVERY probe and drains nothing. This is the regression guard:
  // it asserts the SHAPE of what goes over the wire, not just the row count.
  const n = CACHE_SWEEP_DELETE_CHUNK * 2 + 7;
  const { db, table, deletes } = fakeDb(expired(n), {});
  const r = await sweepExpiredCache(db, { now: NOW });

  assertEquals(r.deleted, n, "every eligible row is still removed");
  assertEquals(table.length, 0);
  assertEquals(deletes.length, 3, "the removal is split across statements");
  for (const d of deletes) {
    assert(
      d.length <= CACHE_SWEEP_DELETE_CHUNK,
      `a delete carried ${d.length} ids, past the ${CACHE_SWEEP_DELETE_CHUNK} transport bound`,
    );
  }
  // No id may be dropped or duplicated by the slicing.
  assertEquals(new Set(deletes.flat()).size, n);
});

Deno.test("⛔ (c3) the chunk bound is the one the working sweep already uses", () => {
  // 300 is `lib/rejected-cluster-sweep.ts`'s measured figure (that sweep converged
  // 216 → 0 in production), not a guess. Raising it re-opens the URL-cap fault.
  assertEquals(CACHE_SWEEP_DELETE_CHUNK, 300);
  assert(CACHE_SWEEP_DELETE_CHUNK < CACHE_SWEEP_BATCH);
});

Deno.test("⛔ (c3) a mid-loop DELETE fault stops and reports only what was removed", async () => {
  // Reporting the full batch after a partial failure would be a lie the operator
  // acts on. The remaining rows are still expired; the next probe retries them.
  const n = CACHE_SWEEP_DELETE_CHUNK + 5;
  const { db, deletes } = fakeDb(expired(n), { deleteErrorAfter: 1 });
  const r = await sweepExpiredCache(db, { now: NOW });

  assertEquals(r.errors, 1);
  assertEquals(r.deleted, CACHE_SWEEP_DELETE_CHUNK, "only the chunk that succeeded counts");
  assertEquals(deletes.length, 2, "the loop stops at the fault rather than pressing on");
});

/* ── (d) a failure is recorded, never thrown ──────────────────────────────── */

Deno.test("⛔ (d) a SELECT failure is counted, not thrown — /health must survive it", async () => {
  const { db, table } = fakeDb(expired(3), { selectError: true });
  const r = await sweepExpiredCache(db, { now: NOW });
  assertEquals(r.errors, 1);
  assertEquals(r.deleted, 0);
  assertEquals(table.length, 3, "nothing may be removed on a failed read");
});

Deno.test("⛔ (d2) a DELETE failure is counted, not thrown, and reports no deletions", async () => {
  const { db, table } = fakeDb(expired(3), { deleteError: true });
  const r = await sweepExpiredCache(db, { now: NOW });
  assertEquals(r.errors, 1);
  assertEquals(r.deleted, 0, "a failed delete must never be reported as a success");
  assertEquals(table.length, 3);
});

Deno.test("⛔ (d3) a THROWN driver error is caught on both statements", async () => {
  for (const stage of ["select", "delete"] as const) {
    const { db } = fakeDb(expired(3), { throwOn: stage });
    const r = await sweepExpiredCache(db, { now: NOW });
    assertEquals(r.errors, 1, `${stage} throw must be caught`);
    assertEquals(r.deleted, 0);
  }
});

Deno.test("(d4) a missing or malformed client is an error, not a crash", async () => {
  for (const bad of [null, undefined, {}, 42, "db"]) {
    const r = await sweepExpiredCache(bad, { now: NOW });
    assertEquals(r.errors, 1);
    assertEquals(r.deleted, 0);
  }
});

/* ── (e) repeated invocation is safe ──────────────────────────────────────── */

Deno.test("⛔ (e) running it repeatedly is safe and converges", async () => {
  const { db, table } = fakeDb([...expired(25), ...live(3)]);
  let guard = 0;
  let last = await sweepExpiredCache(db, { batch: 10, now: NOW });
  while (last.more && guard++ < 10) last = await sweepExpiredCache(db, { batch: 10, now: NOW });
  assertEquals(table.length, 3, "it drains to exactly the live rows");
  // And once more against the drained table: still safe, still zero errors.
  const again = await sweepExpiredCache(db, { batch: 10, now: NOW });
  assertEquals(again.attempted, 0);
  assertEquals(again.deleted, 0);
  assertEquals(again.errors, 0);
});

Deno.test("(e2) concurrent invocations do not error on rows already taken", async () => {
  // Two sweeps racing the same batch: the second deletes an id set that is
  // already gone. Deleting by explicit id makes that a no-op, not a fault.
  const { db } = fakeDb(expired(6));
  const [a, b] = await Promise.all([
    sweepExpiredCache(db, { batch: 6, now: NOW }),
    sweepExpiredCache(db, { batch: 6, now: NOW }),
  ]);
  assertEquals(a.errors, 0);
  assertEquals(b.errors, 0);
});

/* ── (f) empty table is safe ──────────────────────────────────────────────── */

Deno.test("(f) an empty table, and a table with nothing expired, are both no-ops", async () => {
  for (const rows of [[], live(4)]) {
    const { db } = fakeDb(rows);
    const r = await sweepExpiredCache(db, { now: NOW });
    assertEquals(r.attempted, 0);
    assertEquals(r.deleted, 0);
    assertEquals(r.errors, 0);
    assertEquals(r.more, false);
  }
});

/* ── dry run + defaults ───────────────────────────────────────────────────── */

Deno.test("⛔ DRY RUN measures the backlog and deletes NOTHING", async () => {
  const { db, table, deletes } = fakeDb(expired(7));
  const r = await sweepExpiredCache(db, { dryRun: true, now: NOW });
  assertEquals(r.dryRun, true);
  assertEquals(r.attempted, 7, "it still reports what WOULD go");
  assertEquals(r.deleted, 0);
  assertEquals(table.length, 7);
  assertEquals(deletes.length, 0, "no delete statement may be issued at all");
});

Deno.test("⛔ ships DARK — the sweep is off unless explicitly enabled", () => {
  // It deletes production rows. It does not get to start doing that because a
  // deploy landed.
  assertEquals(cacheSweepEnabled(), false);
  assertEquals(cacheSweepDryRun(), false);
});

Deno.test("the summary line carries counts only — never a row value", () => {
  // tool_call_cache holds input_json, output_json and selector_normalized: the
  // selectors under investigation. A maintenance log is not a place for them.
  const s = describeCacheSweep({ attempted: 12, deleted: 12, errors: 0, more: true, dryRun: false });
  assert(/12 expired row\(s\) removed of 12 found/.test(s), s);
  assert(/more remain/.test(s), s);
  assert(!/select|json|@|selector_normalized/i.test(s), `summary must not leak row shape: ${s}`);
});

/* ── wiring: a sweep nobody calls is not a sweep ──────────────────────────── */

const HEALTH = await Deno.readTextFile(new URL("../../functions/osint-agent/health-handler.ts", import.meta.url));

Deno.test("wiring: the health sweep actually calls it, gated on the flag", () => {
  assert(/await sweepExpiredCache\(\s*admin/.test(HEALTH), "must be invoked with the admin client");
  assert(HEALTH.includes("r.checks.cache_sweep"), "and its outcome reported as a check");
  assert(/if \(!cacheSweepEnabled\(\)\)/.test(HEALTH), "and gated off by default");
});

Deno.test("⛔ wiring: it runs OUTSIDE any investigation, so it cannot fail a run", () => {
  // The structural guarantee. index.ts is the run/finalize path; if it ever
  // imports this, cache housekeeping is inside the finalize window, which is
  // where this project's worst incidents live.
  const INDEX = Deno.readTextFileSync(new URL("../../functions/osint-agent/index.ts", import.meta.url));
  assert(
    !INDEX.includes("sweepExpiredCache") && !INDEX.includes("cache-sweep"),
    "the run path must never import the cache sweep",
  );
});

Deno.test("⛔ wiring: the sweep is placed AFTER r.ok is decided, so it cannot turn /health red", () => {
  // Not a promise — a position. `r.ok = gate.ok` happens at the orchestrator
  // gate; every maintenance check below only mutates r.checks.*.
  const okAt = HEALTH.indexOf("r.ok = gate.ok");
  const sweepAt = HEALTH.indexOf("r.checks.cache_sweep");
  assert(okAt > 0 && sweepAt > 0, "both anchors must exist");
  assert(sweepAt > okAt, "the cache sweep must come after the readiness verdict, never before it");
});
