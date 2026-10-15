// recovery_artifact_paging_test.ts — recovery must EXAMINE every artifact on the
// thread, not just the first page.
//
// THE BUG (observed in production, thread 6dd454fa, 2026-08-06): the recovered
// stub closed with
//
//   "Recovery examined only the first 40 of 85 artifacts on this thread
//    (highest-confidence first); 45 were not examined by this pass."
//   "45 artifacts on this thread were never read by recovery and are not
//    represented above."
//
// That disclosure was HONEST — and that is precisely why it is the bug report.
// `recoverOneStaleThread` used ONE `.limit(RECOVERY_ARTIFACT_LIMIT)` as both the
// READ cap and the RENDER cap, so 53% of the durable evidence on that thread was
// never even classified. The analyst's interrupted run was closed with a report
// built from a minority of its own findings.
//
// Read and render are different questions. Rendering a bounded table is a
// legitimate readability choice ("Showing 40 of 85"); never LOOKING at 45 rows is
// evidence loss. This file pins the split.
//
// The fake `artifacts` table here HONORS `.limit()` / `.range()`. The fakes in
// recovery_race_test.ts deliberately do not — they return a fixed row set for any
// query — which is why none of them could ever have caught this.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import type { createClient } from "npm:@supabase/supabase-js@2";
import {
  RECOVERY_ARTIFACT_LIMIT,
  RECOVERY_ARTIFACT_PAGE_SIZE,
  RECOVERY_ARTIFACT_SCAN_MAX,
  recoverStaleThreadById,
  STALE_RUN_AFTER_MS,
} from "../../functions/osint-agent/recovery.ts";

type SupabaseClient = ReturnType<typeof createClient>;

/** One model-reviewed artifact row: non-null metadata, not auto_recorded. */
function artifactRow(i: number, now: Date) {
  return {
    id: `a-${i}`,
    kind: "email",
    value: `row-${i}@example.com`,
    // Strictly descending so "highest-confidence first" ordering is unambiguous
    // and the fake needs no real sort.
    confidence: 1000 - i,
    source: "test_tool",
    created_at: now.toISOString(),
    metadata: { status: "observed" },
  };
}

/**
 * Stateful fake with a PAGING `artifacts` table. Records every artifacts query so
 * a test can assert the read is bounded in round-trips as well as in rows.
 */
function buildFakeDb(
  threadId: string,
  userId: string,
  now: Date,
  totalArtifacts: number,
  opts?: {
    /** Fail every artifacts query after this many successful pages. */
    failAfterPages?: number;
    /** Override the row at index i (e.g. to make the highest-confidence rows telemetry). */
    rowAt?: (i: number, base: Record<string, unknown>) => Record<string, unknown>;
  },
) {
  const staleHeartbeat = new Date(now.getTime() - STALE_RUN_AFTER_MS - 5_000).toISOString();
  const threadRow: Record<string, unknown> = {
    id: threadId,
    user_id: userId,
    title: "paging-test",
    seed_value: "paging-test.example",
    status: "active",
    run_started_at: staleHeartbeat,
    last_heartbeat_at: staleHeartbeat,
    updated_at: staleHeartbeat,
    recovered_at: null,
    recovery_reason: null,
  };
  const allArtifacts = Array.from({ length: totalArtifacts }, (_, i) => {
    const base = artifactRow(i, now) as Record<string, unknown>;
    return opts?.rowAt ? opts.rowAt(i, base) : base;
  });
  const insertedMessages: Array<Record<string, unknown>> = [];
  // [from, to] inclusive, as PostgREST reports them, per artifacts query.
  const artifactQueries: Array<{ from: number; to: number }> = [];

  function threadsChain() {
    const filters: Array<[string, unknown]> = [];
    let pendingUpdate: Record<string, unknown> | null = null;
    const node: Record<string, unknown> = {
      select: () => node,
      eq: (col: string, val: unknown) => { filters.push([col, val]); return node; },
      is: (col: string, val: unknown) => { filters.push([col, val]); return node; },
      update: (patch: Record<string, unknown>) => { pendingUpdate = patch; return node; },
      maybeSingle: () => {
        const matches = filters.every(([col, val]) => threadRow[col] === val);
        return Promise.resolve({ data: matches ? { ...threadRow } : null, error: null });
      },
      then: (resolve: (v: { data: unknown; error: unknown }) => void) => {
        const matches = filters.every(([col, val]) => threadRow[col] === val);
        if (pendingUpdate) {
          if (matches) {
            Object.assign(threadRow, pendingUpdate);
            resolve({ data: [{ id: threadId }], error: null });
          } else {
            resolve({ data: [], error: null });
          }
          return;
        }
        resolve({ data: matches ? [{ ...threadRow }] : [], error: null });
      },
    };
    return node;
  }

  /**
   * PostgREST paging semantics: `.limit(n)` takes the first n rows; `.range(a, b)`
   * takes rows a..b INCLUSIVE. Whichever is applied last wins, and `count:"exact"`
   * always reports the TRUE unpaged total — which is exactly how the production
   * stub knew there were 85 rows while holding only 40.
   */
  function artifactsChain() {
    let from = 0;
    let to = allArtifacts.length - 1;
    const node: Record<string, unknown> = {
      select: () => node,
      eq: () => node,
      in: () => node,
      order: () => node,
      limit: (n: number) => { from = 0; to = n - 1; return node; },
      range: (a: number, b: number) => { from = a; to = b; return node; },
      then: (resolve: (v: { data: unknown; error: unknown; count: number | null }) => void) => {
        artifactQueries.push({ from, to });
        if (opts?.failAfterPages != null && artifactQueries.length > opts.failAfterPages) {
          resolve({ data: null, error: { message: "simulated page failure" }, count: null });
          return;
        }
        resolve({
          data: allArtifacts.slice(from, to + 1).map((r) => ({ ...r })),
          error: null,
          count: allArtifacts.length,
        });
      },
    };
    return node;
  }

  const db = {
    from: (table: string) => {
      if (table === "threads") return threadsChain();
      if (table === "artifacts") return artifactsChain();
      if (table === "messages") {
        const node: Record<string, unknown> = {};
        for (const m of ["select", "eq", "in", "order", "limit"]) node[m] = () => node;
        node.maybeSingle = () => Promise.resolve({ data: null, error: null });
        node.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
        node.insert = (row: Record<string, unknown>) => {
          insertedMessages.push(row);
          return Promise.resolve({ error: null });
        };
        return node;
      }
      if (table === "artifact_reviews") {
        const node: Record<string, unknown> = {};
        for (const m of ["select", "eq"]) node[m] = () => node;
        node.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
        return node;
      }
      throw new Error(`unexpected table in fake db: ${table}`);
    },
  } as unknown as SupabaseClient;

  return { db, insertedMessages, artifactQueries };
}

function stubText(insertedMessages: Array<Record<string, unknown>>): string {
  assertEquals(insertedMessages.length, 1, "expected exactly one recovery stub");
  const parts = insertedMessages[0].parts as Array<{ type?: string; text?: string }>;
  return parts.filter((p) => p?.type === "text").map((p) => p.text ?? "").join("\n");
}

Deno.test("recovery EXAMINES every artifact on the thread, not just the first page", async () => {
  const now = new Date("2026-08-06T12:00:00.000Z");
  // The production shape: 85 durable artifacts, page cap 40, 45 rows unread.
  const { db, insertedMessages, artifactQueries } = buildFakeDb("t-paging", "u1", now, 85);

  const res = await recoverStaleThreadById(db, "t-paging", { now, reason: "sweep" });
  const text = stubText(insertedMessages);

  assertEquals(res.recovered, true);
  assertEquals(res.artifactCount, 85, "the exact count must still reflect the whole thread");

  // THE REGRESSION: no row on this thread may go unexamined.
  assert(
    !/never read by recovery/.test(text),
    `recovery left artifacts unread:\n${text}`,
  );
  assert(
    !/not examined/.test(text),
    `recovery claimed an unexamined gap on a fully-scanned thread:\n${text}`,
  );

  // Bounded RENDERING is still correct and must stay disclosed — the fix separates
  // the two caps, it does not make the report unbounded.
  assert(
    new RegExp(`Showing ${RECOVERY_ARTIFACT_LIMIT} of 85 recovered rows`).test(text),
    `render bound was lost or mis-disclosed:\n${text}`,
  );
  const tableRows = text.split("\n").filter((l) => /^\| \d+ \|/.test(l));
  assertEquals(tableRows.length, RECOVERY_ARTIFACT_LIMIT, "the rendered table must stay capped");

  // Scanning the thread must not degenerate into a row-at-a-time crawl: the sweep
  // recovers many threads inside one CPU-bounded invocation.
  assert(
    artifactQueries.length <= 3,
    `paged read took ${artifactQueries.length} round-trips for 85 rows`,
  );
});

// ── The less visible half of the same defect ─────────────────────────────────
//
// When the read cap WAS the render cap, any row that is not renderable evidence —
// control/telemetry records (triage_decision, coverage_audit, tool_audit), excluded
// same-name collisions, analyst-dismissed rows — still consumed one of the 40 slots
// in the page. Those slots were spent before a single further finding was fetched,
// so real evidence was displaced out of the report by rows that are not evidence,
// with no way to recover it. Splitting read from render is what fixes this; a
// larger single `.limit()` would not have.
Deno.test("control/telemetry rows no longer displace real findings out of the table", async () => {
  const now = new Date("2026-08-06T12:00:00.000Z");
  // The 20 HIGHEST-confidence rows are telemetry, so under the old single cap they
  // ate half the page and only 20 findings could ever render.
  const { db, insertedMessages } = buildFakeDb("t-telemetry", "u1", now, 80, {
    rowAt: (i, base) => (i < 20 ? { ...base, kind: i % 2 === 0 ? "triage_decision" : "coverage_audit" } : base),
  });

  await recoverStaleThreadById(db, "t-telemetry", { now, reason: "sweep" });
  const text = stubText(insertedMessages);

  const tableRows = text.split("\n").filter((l) => /^\| \d+ \|/.test(l));
  assertEquals(
    tableRows.length,
    RECOVERY_ARTIFACT_LIMIT,
    "telemetry rows displaced real findings out of the rendered table",
  );
  assert(
    /20 control\/telemetry records \(triage decisions, audits\) omitted/.test(text),
    `telemetry suppression was not disclosed:\n${text}`,
  );
  assert(
    new RegExp(`Showing ${RECOVERY_ARTIFACT_LIMIT} of 60 recovered rows`).test(text),
    `eligible-row total should exclude telemetry:\n${text}`,
  );
  assert(!/never read by recovery/.test(text), `left rows unread:\n${text}`);
});

// ── The ceiling must degrade HONESTLY, not silently ──────────────────────────
//
// The disclosure this change exists to eliminate is still correct beyond the scan
// ceiling, and must not be deleted along with the bug. Losing it would convert a
// visible, auditable gap into a silent one — strictly worse than the original.
Deno.test("a thread beyond the scan ceiling still discloses the true gap", async () => {
  const now = new Date("2026-08-06T12:00:00.000Z");
  const total = RECOVERY_ARTIFACT_SCAN_MAX + 100;
  const { db, insertedMessages, artifactQueries } = buildFakeDb("t-huge", "u1", now, total);

  await recoverStaleThreadById(db, "t-huge", { now, reason: "sweep" });
  const text = stubText(insertedMessages);

  assert(
    new RegExp(`only the first ${RECOVERY_ARTIFACT_SCAN_MAX} of ${total} artifacts`).test(text),
    `ceiling truncation was not disclosed:\n${text}`,
  );
  assert(
    new RegExp(`100 artifacts on this thread were never read by recovery`).test(text),
    `the honest gap disclosure was lost:\n${text}`,
  );
  assertEquals(
    artifactQueries.length,
    Math.ceil(RECOVERY_ARTIFACT_SCAN_MAX / RECOVERY_ARTIFACT_PAGE_SIZE),
    "the scan must stop at the ceiling, not walk the whole thread",
  );
  // The final page must be CLAMPED to the ceiling, never overshoot it.
  assertEquals(
    artifactQueries[artifactQueries.length - 1].to,
    RECOVERY_ARTIFACT_SCAN_MAX - 1,
    "the last page read past the scan ceiling",
  );
});

// ── A failed page is a partial read, and must present as one ─────────────────
Deno.test("a mid-scan page failure degrades to an honest partial read", async () => {
  const now = new Date("2026-08-06T12:00:00.000Z");
  const { db, insertedMessages } = buildFakeDb("t-page-fail", "u1", now, 480, { failAfterPages: 1 });

  await recoverStaleThreadById(db, "t-page-fail", { now, reason: "sweep" });
  const text = stubText(insertedMessages);

  // One page read (200) of a 480-row thread => 280 unexamined, disclosed as such
  // rather than the partial read being presented as the complete record.
  assert(
    new RegExp(`only the first ${RECOVERY_ARTIFACT_PAGE_SIZE} of 480 artifacts`).test(text),
    `a failed page was presented as a complete read:\n${text}`,
  );
  assert(/280 artifacts on this thread were never read by recovery/.test(text), `wrong partial gap:\n${text}`);
});

// Paging without a UNIQUE final sort key can repeat or skip rows between
// round-trips whenever the leading keys tie — and confidence ties are common
// (breach rows are pushed at a flat 55). Source-level, because the defect lives in
// the query's ORDER BY, not in any value a fake can return.
Deno.test("the paged artifact read orders by a unique tiebreaker", async () => {
  const src = await Deno.readTextFile(new URL("../../functions/osint-agent/recovery.ts", import.meta.url));
  const at = src.indexOf("async function fetchRecoveryArtifacts");
  assert(at !== -1, "the paged artifact reader moved or was renamed");
  const body = src.slice(at, at + 1600);
  assert(/\.range\(/.test(body), "the artifact read stopped paging");
  assert(
    /\.order\("id"/.test(body),
    "the paged read lost its unique tiebreaker — pages can now duplicate or skip rows on confidence ties",
  );
});

Deno.test("a thread that fits in one page still issues a single query", async () => {
  const now = new Date("2026-08-06T12:00:00.000Z");
  const { db, insertedMessages, artifactQueries } = buildFakeDb("t-small", "u1", now, 12);

  await recoverStaleThreadById(db, "t-small", { now, reason: "sweep" });
  const text = stubText(insertedMessages);

  assertEquals(artifactQueries.length, 1, "a small thread must not pay for extra round-trips");
  assert(!/not examined/.test(text), `invented a gap on a complete fetch:\n${text}`);
  assert(/12 recovered rows/.test(text), `wrong row count on a complete fetch:\n${text}`);
});
