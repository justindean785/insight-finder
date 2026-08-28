// finding_synthesis_sweep_test.ts — the I/O half: idempotence, truncation, provenance.
//
// The selection logic is pinned in finding_synthesis_test.ts. What is pinned HERE
// is everything that can go wrong once a database is involved, and every one of
// these is a way a well-meaning sweep quietly corrupts a corpus:
//
//   - running twice and writing the conclusion twice
//   - reading 40 of a thread's 351 artifacts and adjudicating on the minority
//     (the exact shape of the recovery incident recovery_artifact_paging_test.ts
//     exists for)
//   - writing a derived conclusion that looks model-authored
//   - throwing inside a health probe

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { synthesizeMissingFindings, synthesisEnabled, MAX_ARTIFACTS_PER_THREAD } from "./finding-synthesis-sweep.ts";

const T1 = "11111111-1111-4111-8111-111111111111";
const U1 = "22222222-2222-4222-8222-222222222222";

function artifact(source: string, i = 0) {
  return {
    id: `a${i}-${source}`,
    kind: "email",
    value: "jordan.vale@example.test",
    source,
    confidence: 60,
    metadata: {},
    created_at: "2026-08-28T00:00:00Z",
  };
}

/** Two independent classes — clears the bar. */
const CORROBORATED = [artifact("court_record_search", 1), artifact("opencorporates_search", 2)];

/**
 * Fake PostgREST covering exactly the calls the sweep makes:
 *   threads.select().eq().order().limit()
 *   artifacts.select(_, {head,count}).eq().eq()
 *   artifacts.select().eq().limit()
 *   artifacts.insert()
 */
function fakeDb(cfg: {
  threads?: Array<{ id: string; user_id: string }>;
  priorFindings?: unknown[];
  artifacts?: unknown[];
  threadsError?: boolean;
  countError?: boolean;
  artifactsError?: boolean;
  insertError?: boolean;
}) {
  const inserted: unknown[][] = [];
  const db = {
    from(table: string) {
      let head = false;
      void head;
      // One chainable object. select/eq/order return it; `limit` and `then`
      // resolve. Modelling it as a THENABLE is what makes the count call
      // (select→eq→eq, awaited with no .limit()) and the artifact read
      // (select→eq→limit) both work off one shape, which is how PostgREST
      // actually behaves.
      const q: Record<string, unknown> = {};
      let cols = "";
      const payload = () => {
        if (table === "threads") {
          return cfg.threadsError
            ? { data: null, error: { message: "boom" } }
            : { data: cfg.threads ?? [{ id: T1, user_id: U1 }], error: null };
        }
        // The sweep issues TWO different artifact reads; the column list is what
        // distinguishes them, exactly as it does against real PostgREST.
        if (cols.startsWith("id,metadata")) {
          return cfg.countError
            ? { data: null, error: { message: "boom" } }
            : { data: cfg.priorFindings ?? [], error: null };
        }
        return cfg.artifactsError
          ? { data: null, error: { message: "boom" } }
          : { data: cfg.artifacts ?? CORROBORATED, error: null };
      };
      q.select = (c?: string, o?: { head?: boolean }) => { cols = c ?? ""; head = !!o?.head; return q; };
      q.eq = () => q;
      q.gte = () => q;
      q.lt = () => q;
      q.order = () => q;
      q.limit = () => q;
      q.insert = (rows: unknown[]) => {
        inserted.push(rows);
        return Promise.resolve({ error: cfg.insertError ? { message: "boom" } : null });
      };
      // deno-lint-ignore no-explicit-any
      q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(payload()).then(res, rej);
      return q;
    },
  };
  return { db, inserted };
}

Deno.test("a corroborated thread gets a finding, tagged as SYNTHESIZED", () => {
  const { db, inserted } = fakeDb({});
  return synthesizeMissingFindings(db, { limit: 1 }).then((res) => {
    assertEquals(res.errors, 0);
    assertEquals(res.threadsWithFindings, 1);
    assert(res.findingsWritten >= 1, "a two-class thread must produce a finding");
    const row = (inserted[0] as Record<string, unknown>[])[0];
    assertEquals(row.kind, "finding");
    const meta = row.metadata as Record<string, unknown>;
    assertEquals(
      meta.finding_origin,
      "synthesis",
      "an analyst must be able to tell a derived conclusion from a model-asserted one",
    );
    assert(Array.isArray(meta.supporting_artifact_ids), "provenance: the rows it rests on");
    assert((meta.supporting_artifact_ids as unknown[]).length >= 2);
    assert(meta.confidence_cap_applied !== undefined, "the engine's cap must ride along");
  });
});

Deno.test("⛔ IDEMPOTENCE: a thread that already has a finding is skipped", () => {
  // Including a MODEL-authored one. The model's own conclusion outranks a derived
  // one; synthesis fills silence, it does not argue with a conclusion that exists.
  const { db, inserted } = fakeDb({
    priorFindings: [{ id: "f1", metadata: { finding_origin: "model" } }],
  });
  return synthesizeMissingFindings(db, { limit: 1 }).then((res) => {
    assertEquals(res.findingsWritten, 0);
    assertEquals(res.threadsScanned, 0, "a model-authored finding takes the thread out of the queue");
    assertEquals(inserted.length, 0, "nothing may be written twice");
  });
});

Deno.test("⛔ DEDUP KEY: a cluster already synthesized is never synthesized again", () => {
  // The key is metadata.synthesis_cluster_id. Re-running the sweep on a thread
  // whose cluster already has a derived finding must write nothing — this is what
  // makes the sweep safe to run every 60s forever.
  const first = fakeDb({});
  return synthesizeMissingFindings(first.db, { limit: 1 }).then((r1) => {
    assertEquals(r1.findingsWritten, 1);
    const written = (first.inserted[0] as Record<string, unknown>[])[0];
    const cid = (written.metadata as Record<string, unknown>).synthesis_cluster_id;
    assert(typeof cid === "string" && cid.length > 0, "a synthesized finding must carry its cluster key");

    // Second sweep, same thread, with the first run's output already present.
    const second = fakeDb({
      priorFindings: [{ id: "f1", metadata: { finding_origin: "synthesis", synthesis_cluster_id: cid } }],
    });
    return synthesizeMissingFindings(second.db, { limit: 1 }).then((r2) => {
      assertEquals(r2.findingsWritten, 0, "the same cluster must not yield a second finding");
      assertEquals(second.inserted.length, 0);
    });
  });
});

Deno.test("⛔ DRY RUN computes everything and writes NOTHING", () => {
  // Backfill is a production write into closed cases. This is the mode that
  // measures the distribution before any row lands.
  const { db, inserted } = fakeDb({});
  return synthesizeMissingFindings(db, { limit: 1, dryRun: true }).then((res) => {
    assertEquals(res.dryRun, true);
    assertEquals(res.findingsWritten, 0, "a dry run writes nothing");
    assert(res.findingsProposed >= 1, "but it still reports what WOULD be written");
    assertEquals(inserted.length, 0);
    assertEquals(res.distribution.one, 1, "and reports the per-thread distribution");
  });
});

Deno.test("forward and backfill are INDEPENDENT switches", () => {
  // Neither is on by default, so the feature ships dark and the backfill can be
  // withheld while the forward path runs.
  assertEquals(synthesisEnabled("forward"), false, "forward defaults OFF");
  assertEquals(synthesisEnabled("backfill"), false, "backfill defaults OFF");
});

Deno.test("⛔ TRUNCATION: an oversized thread is DECLINED, never partially adjudicated", () => {
  // Reading 40 of 351 rows and concluding on the minority is the recovery
  // incident's shape. A missing finding is recoverable; a finding derived from a
  // truncated corpus is a false conclusion carrying engine authority.
  const many = Array.from({ length: MAX_ARTIFACTS_PER_THREAD + 1 }, (_, i) => artifact("court_record_search", i));
  const { db, inserted } = fakeDb({ artifacts: many });
  return synthesizeMissingFindings(db, { limit: 1 }).then((res) => {
    assertEquals(res.findingsWritten, 0);
    assertEquals(inserted.length, 0);
    assertEquals(res.errors, 0, "declining is not an error");
  });
});

Deno.test("an uncorroborated thread writes nothing and reports no error", () => {
  const { db, inserted } = fakeDb({ artifacts: [artifact("breach_check", 1), artifact("leakcheck_lookup", 2)] });
  return synthesizeMissingFindings(db, { limit: 1 }).then((res) => {
    assertEquals(res.findingsWritten, 0);
    assertEquals(res.errors, 0, "the empty case is the COMMON case, not a failure");
    assertEquals(inserted.length, 0);
  });
});

/* ── every failure degrades, none throws ─────────────────────────────────── */

Deno.test("a threads-query failure is counted, not thrown", () => {
  const { db } = fakeDb({ threadsError: true });
  return synthesizeMissingFindings(db, { limit: 1 }).then((res) => {
    assertEquals(res.errors, 1);
    assertEquals(res.findingsWritten, 0);
  });
});

Deno.test("an artifact-read failure is counted, not thrown", () => {
  const { db } = fakeDb({ artifactsError: true });
  return synthesizeMissingFindings(db, { limit: 1 }).then((res) => {
    assertEquals(res.errors, 1);
    assertEquals(res.findingsWritten, 0);
  });
});

Deno.test("an insert failure is counted, not thrown", () => {
  const { db } = fakeDb({ insertError: true });
  return synthesizeMissingFindings(db, { limit: 1 }).then((res) => {
    assertEquals(res.errors, 1);
    assertEquals(res.threadsWithFindings, 0, "a failed insert must not be reported as a success");
  });
});

Deno.test("the sweep is BOUNDED per invocation", () => {
  const threads = Array.from({ length: 50 }, (_, i) => ({ id: `t${i}`, user_id: U1 }));
  const { db } = fakeDb({ threads });
  return synthesizeMissingFindings(db, { limit: 3 }).then((res) => {
    assertEquals(res.threadsScanned, 3, "a health probe must not turn into an unbounded backfill");
  });
});

/* ── wiring: a sweep nobody calls is not a sweep ─────────────────────────── */

const HEALTH = await Deno.readTextFile(new URL("./health-handler.ts", import.meta.url));

Deno.test("wiring: the health sweep actually calls synthesis", () => {
  assert(
    /await synthesizeMissingFindings\(\s*admin/.test(HEALTH),
    "the sweep must be invoked, unprefixed, from the health probe",
  );
  assert(HEALTH.includes("r.checks.synthesis"), "and its outcome must be reported as a check");
});

Deno.test("⛔ wiring: synthesis runs OUTSIDE any run, so it cannot fail finalize", () => {
  // The structural guarantee, not a promise: the only caller is health-handler.ts.
  // If index.ts (the run/finalize path) ever imports it, that guarantee is gone —
  // which is the one thing CLAUDE.md's termination invariants forbid.
  const INDEX = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  assert(
    !INDEX.includes("synthesizeMissingFindings") && !INDEX.includes("finding-synthesis"),
    "the run path must never import synthesis — it would put it inside the finalize window",
  );
});
