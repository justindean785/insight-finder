// cluster_adjudication_sweep_test.ts — the I/O half of the Claude cluster
// adjudicator. Every test here is a way a well-meaning sweep that pays per call
// quietly costs money or authority:
//
//   - re-billing a cluster it already answered, every 60 seconds
//   - calling the model during a DRY RUN (which writes nothing, so it would never stop)
//   - storing a refusal as if it were the model's verdict
//   - adjudicating on rows the analyst rejected, or when it cannot tell which those are
//   - writing anything to `artifacts`
//   - running past the cron interval

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  adjudicateContradictedClusters,
  clusterAdjudicationEnabled,
  clusterAdjudicationMaxCalls,
  describeAdjudication,
} from "../../functions/osint-agent/cluster-adjudication-sweep.ts";
import { adjudicationInputHash, selectAdjudicationCandidates } from "../../functions/osint-agent/lib/cluster-adjudication.ts";

const T1 = "11111111-1111-4111-8111-111111111111";
const U1 = "22222222-2222-4222-8222-222222222222";
const EMAIL = "jordan.vale@example.test";

function row(id: string, kind: string, value: string, source: string, metadata: Record<string, unknown> = {}) {
  return { id, kind, value, source, confidence: 50, metadata, created_at: "2026-11-02T00:00:00Z" };
}

/** One contradicted cluster: the collision marker plus two records on the email. */
function contradicted(prefix = "") {
  const e = prefix ? `${prefix}.${EMAIL}` : EMAIL;
  return [
    row(`${prefix}c1`, "contradiction", `${e} is attached to two names`, "collision_detector", { collision_value: e }),
    row(`${prefix}e1`, "email", e, "breach_lookup", { name: "Jordan Vale", city: "Oakland" }),
    row(`${prefix}e2`, "email", e, "people_search", { name: "Jordan Vale-Smith", city: "Leeds" }),
  ];
}

type Op = { table: string; op: string };

/**
 * Fake PostgREST. Every builder method is chainable; awaiting the builder
 * resolves the table's payload. Every table touched and every write verb is
 * recorded, so a test can assert the exact set of tables the sweep wrote to.
 */
function fakeDb(cfg: {
  threads?: Array<{ id: string; user_id: string }>;
  artifacts?: unknown[];
  reviews?: unknown[];
  existing?: Array<{ cluster_id: string; input_hash: string }>;
  reviewsError?: boolean;
  existingError?: boolean;
  insertError?: { code?: string; message: string };
}) {
  const ops: Op[] = [];
  const inserted: Record<string, unknown>[] = [];
  const db = {
    from(table: string) {
      const payload = () => {
        if (table === "threads") return { data: cfg.threads ?? [{ id: T1, user_id: U1 }], error: null };
        if (table === "artifacts") return { data: cfg.artifacts ?? contradicted(), error: null };
        if (table === "artifact_reviews") {
          return cfg.reviewsError ? { data: null, error: { message: "boom" } } : { data: cfg.reviews ?? [], error: null };
        }
        if (table === "cluster_adjudications") {
          return cfg.existingError ? { data: null, error: { message: "boom" } } : { data: cfg.existing ?? [], error: null };
        }
        return { data: [], error: null };
      };
      const write = (op: string) => (rows: unknown) => {
        ops.push({ table, op });
        if (op === "insert") inserted.push(...(Array.isArray(rows) ? rows : [rows]) as Record<string, unknown>[]);
        return Promise.resolve({ error: op === "insert" && cfg.insertError ? cfg.insertError : null });
      };
      const q: Record<string | symbol, unknown> = new Proxy({}, {
        get(_t, prop) {
          if (prop === "then") {
            return (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(payload()).then(res, rej);
          }
          if (prop === "insert" || prop === "update" || prop === "upsert" || prop === "delete") return write(String(prop));
          if (prop === "select") return () => { ops.push({ table, op: "select" }); return q; };
          return () => q;
        },
      });
      return q;
    },
  };
  return { db, ops, inserted };
}

/** A fake Messages API. Records every request body; answers with `reply`. */
function fakeFetch(reply: string | ((n: number) => Response | Promise<Response>)) {
  const bodies: Record<string, unknown>[] = [];
  const fn = (_url: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    if (typeof reply === "function") return Promise.resolve(reply(bodies.length));
    return Promise.resolve(new Response(JSON.stringify({
      content: [{ type: "text", text: reply }],
      usage: { input_tokens: 900, output_tokens: 60 },
    }), { status: 200 }));
  };
  return { fn: fn as typeof fetch, bodies };
}

const VERDICT = JSON.stringify({ verdict: "different_subjects", probability: 15, rationale: "Different surnames and cities." });

function opts(fetchFn: typeof fetch, extra: Record<string, unknown> = {}) {
  return { apiKey: "test-key", model: "claude-sonnet-5-5", fetchFn, ...extra };
}

Deno.test("a contradicted cluster gets one call and one advisory row", async () => {
  const { db, inserted } = fakeDb({});
  const f = fakeFetch(VERDICT);
  const r = await adjudicateContradictedClusters(db, opts(f.fn));
  assertEquals(r.errors, 0);
  assertEquals(r.calls, 1);
  assertEquals(r.written, 1);
  assertEquals(f.bodies.length, 1);
  assertEquals(f.bodies[0].model, "claude-sonnet-5-5");
  const w = inserted[0];
  assertEquals(w.thread_id, T1);
  assertEquals(w.user_id, U1);
  assertEquals(w.verdict, "different_subjects");
  assertEquals(w.probability, 15);
  assertEquals(w.model, "claude-sonnet-5-5");
  assertEquals((w.member_artifact_ids as string[]).sort(), ["c1", "e1", "e2"]);
  assert(typeof w.input_hash === "string" && (w.input_hash as string).length === 64);
  assert(typeof w.cluster_id === "string" && (w.cluster_id as string).startsWith("clus_"));
});

Deno.test("⛔ AUTHORITY: the sweep writes to cluster_adjudications and nowhere else", async () => {
  const { db, ops } = fakeDb({});
  await adjudicateContradictedClusters(db, opts(fakeFetch(VERDICT).fn));
  const writes = ops.filter((o) => o.op !== "select");
  assert(writes.length > 0, "the happy path must write");
  for (const w of writes) {
    assertEquals(w, { table: "cluster_adjudications", op: "insert" }, "no artifact, cap, quarantine or linkage write");
  }
});

Deno.test("⛔ IDEMPOTENCE: an already-answered cluster is never sent again", async () => {
  const [c] = selectAdjudicationCandidates(contradicted()).candidates;
  const hash = await adjudicationInputHash(c);
  const { db, inserted } = fakeDb({ existing: [{ cluster_id: c.clusterId, input_hash: hash }] });
  const f = fakeFetch(VERDICT);
  const r = await adjudicateContradictedClusters(db, opts(f.fn));
  assertEquals(f.bodies.length, 0, "no second bill for an unchanged cluster");
  assertEquals(inserted.length, 0);
  assertEquals(r.alreadyAdjudicated, 1);
});

Deno.test("⛔ IDEMPOTENCE: an unreadable verdict table means no call, not a blind one", async () => {
  const { db } = fakeDb({ existingError: true });
  const f = fakeFetch(VERDICT);
  const r = await adjudicateContradictedClusters(db, opts(f.fn));
  assertEquals(f.bodies.length, 0);
  assertEquals(r.errors, 1);
});

Deno.test("⛔ DRY RUN makes no model call and writes nothing", async () => {
  // A dry run writes no row, so nothing would ever mark the cluster answered:
  // calling the model here would re-bill the same clusters every minute, forever.
  const { db, ops } = fakeDb({ artifacts: [...contradicted("a"), ...contradicted("b")] });
  const f = fakeFetch(VERDICT);
  const r = await adjudicateContradictedClusters(db, opts(f.fn, { dryRun: true }));
  assertEquals(f.bodies.length, 0);
  assertEquals(ops.filter((o) => o.op !== "select").length, 0);
  assertEquals(r.queued, 2, "the dry run still measures the queue");
  assertEquals(r.calls, 0);
  assert(describeAdjudication(r).includes("DRY RUN"));
});

Deno.test("⛔ ANALYST REJECTION: a rejected record is not shown to the model", async () => {
  // e2 rejected → one evidence record left → no question to ask.
  const { db } = fakeDb({ reviews: [{ artifact_id: "e2", state: "dismissed", note: null }] });
  const f = fakeFetch(VERDICT);
  const r = await adjudicateContradictedClusters(db, opts(f.fn));
  assertEquals(f.bodies.length, 0);
  assertEquals(r.queued, 0);
});

Deno.test("⛔ FAIL-CLOSED: unreadable reviews skip the thread", async () => {
  const { db } = fakeDb({ reviewsError: true });
  const f = fakeFetch(VERDICT);
  const r = await adjudicateContradictedClusters(db, opts(f.fn));
  assertEquals(f.bodies.length, 0, "could not read the verdicts is not nothing rejected");
  assertEquals(r.errors, 1);
});

Deno.test("⛔ a refusal is never stored as a verdict", async () => {
  const { db, inserted } = fakeDb({});
  const r = await adjudicateContradictedClusters(db, opts(fakeFetch("They look like the same person to me.").fn));
  assertEquals(r.calls, 1);
  assertEquals(r.unparseable, 1);
  assertEquals(r.written, 0);
  assertEquals(inserted.length, 0);
});

Deno.test("a transient HTTP failure writes nothing and counts an error", async () => {
  const { db, inserted } = fakeDb({});
  const f = fakeFetch(() => new Response("overloaded", { status: 529 }));
  const r = await adjudicateContradictedClusters(db, opts(f.fn));
  assertEquals(r.errors, 1);
  assertEquals(inserted.length, 0);
});

Deno.test("SPEND CAP: no more than maxCalls model calls per sweep", async () => {
  const arts = ["a", "b", "c", "d", "e"].flatMap((p) => contradicted(p));
  const { db } = fakeDb({ artifacts: arts });
  const f = fakeFetch(VERDICT);
  const r = await adjudicateContradictedClusters(db, opts(f.fn, { maxCalls: 2 }));
  assertEquals(f.bodies.length, 2);
  assertEquals(r.queued, 5);
  assertEquals(r.calls, 2);
});

Deno.test("DEADLINE: no new call is issued once the sweep's deadline has passed", async () => {
  // The cron fires every 60s with no lease; a sweep that overruns is overlapped,
  // and unlike synthesis the loser of that race has already paid for a call.
  let t = 0;
  const arts = ["a", "b", "c"].flatMap((p) => contradicted(p));
  const { db } = fakeDb({ artifacts: arts });
  const f = fakeFetch((n) => {
    t += 30_000; // each call "takes" 30s of the clock
    void n;
    return new Response(JSON.stringify({ content: [{ type: "text", text: VERDICT }], usage: {} }), { status: 200 });
  });
  const r = await adjudicateContradictedClusters(db, opts(f.fn, { maxCalls: 3, deadlineMs: 25_000, now: () => t }));
  assertEquals(f.bodies.length, 1, "the first call ran past the deadline; the second never starts");
  assertEquals(r.deadlineHit, true);
});

Deno.test("⛔ QUEUE PROGRESS: threads with no pending work do not use up the thread limit", async () => {
  // Counting a no-work thread toward the limit meant every sweep re-read the same
  // newest five threads, so a sixth eligible thread was never reached until newer
  // ones left the 24h window and it could age out unadjudicated.
  const threads = Array.from({ length: 7 }, (_, i) => ({ id: `3333333${i}-3333-4333-8333-333333333333`, user_id: U1 }));
  const clean = [row("u1", "username", "selftesthandle", "username_sweep"), row("u2", "social_profile", "https://example.test/selftesthandle", "username_sweep")];
  const { db } = fakeDb({ threads, artifacts: clean });
  const f = fakeFetch(VERDICT);
  const r = await adjudicateContradictedClusters(db, opts(f.fn, { threadLimit: 5 }));
  assertEquals(r.threadsScanned, 7, "all seven were examined, not just the first five");
  assertEquals(r.threadsWithWork, 0);
  assertEquals(f.bodies.length, 0);
});

Deno.test("the thread limit still bounds threads that DO have work", async () => {
  const threads = Array.from({ length: 4 }, (_, i) => ({ id: `4444444${i}-4444-4444-8444-444444444444`, user_id: U1 }));
  const { db } = fakeDb({ threads });
  const f = fakeFetch(VERDICT);
  const r = await adjudicateContradictedClusters(db, opts(f.fn, { threadLimit: 2, maxCalls: 10 }));
  assertEquals(r.threadsWithWork, 2);
  assertEquals(f.bodies.length, 2);
});

Deno.test("an already-answered thread is not 'work' either", async () => {
  const [c] = selectAdjudicationCandidates(contradicted()).candidates;
  const hash = await adjudicationInputHash(c);
  const threads = Array.from({ length: 3 }, (_, i) => ({ id: `5555555${i}-5555-4555-8555-555555555555`, user_id: U1 }));
  const { db } = fakeDb({ threads, existing: [{ cluster_id: c.clusterId, input_hash: hash }] });
  const r = await adjudicateContradictedClusters(db, opts(fakeFetch(VERDICT).fn, { threadLimit: 1 }));
  assertEquals(r.threadsScanned, 3);
  assertEquals(r.threadsWithWork, 0);
});

Deno.test("a duplicate insert (another sweep won the race) is success, not an error", async () => {
  const { db } = fakeDb({ insertError: { code: "23505", message: "duplicate key value" } });
  const r = await adjudicateContradictedClusters(db, opts(fakeFetch(VERDICT).fn));
  assertEquals(r.errors, 0);
  assertEquals(r.duplicates, 1);
});

Deno.test("any other insert error is counted", async () => {
  const { db } = fakeDb({ insertError: { code: "42501", message: "permission denied" } });
  const r = await adjudicateContradictedClusters(db, opts(fakeFetch(VERDICT).fn));
  assertEquals(r.errors, 1);
  assertEquals(r.written, 0);
});

Deno.test("the request goes to the Messages API with the key in a header, not the URL", async () => {
  let seenUrl = "";
  let seenHeaders: Headers | null = null;
  const fn = ((url: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(url);
    seenHeaders = new Headers(init?.headers);
    return Promise.resolve(new Response(JSON.stringify({ content: [{ type: "text", text: VERDICT }] }), { status: 200 }));
  }) as typeof fetch;
  const { db } = fakeDb({});
  await adjudicateContradictedClusters(db, opts(fn));
  assertEquals(seenUrl, "https://api.anthropic.com/v1/messages");
  assert(!seenUrl.includes("test-key"));
  assertEquals(seenHeaders!.get("x-api-key"), "test-key");
  assert(seenHeaders!.get("anthropic-version"));
});

Deno.test("switches default OFF and the cap is bounded", () => {
  const prev = Deno.env.get("CLUSTER_ADJUDICATION_ENABLED");
  const prevCap = Deno.env.get("CLUSTER_ADJUDICATION_MAX_CALLS");
  try {
    Deno.env.delete("CLUSTER_ADJUDICATION_ENABLED");
    Deno.env.delete("CLUSTER_ADJUDICATION_MAX_CALLS");
    assertEquals(clusterAdjudicationEnabled(), false, "ships dark");
    assertEquals(clusterAdjudicationMaxCalls(), 3);
    Deno.env.set("CLUSTER_ADJUDICATION_MAX_CALLS", "500");
    assertEquals(clusterAdjudicationMaxCalls(), 10, "a typo cannot unbound the spend");
    Deno.env.set("CLUSTER_ADJUDICATION_MAX_CALLS", "nope");
    assertEquals(clusterAdjudicationMaxCalls(), 3);
  } finally {
    if (prev === undefined) Deno.env.delete("CLUSTER_ADJUDICATION_ENABLED"); else Deno.env.set("CLUSTER_ADJUDICATION_ENABLED", prev);
    if (prevCap === undefined) Deno.env.delete("CLUSTER_ADJUDICATION_MAX_CALLS"); else Deno.env.set("CLUSTER_ADJUDICATION_MAX_CALLS", prevCap);
  }
});
