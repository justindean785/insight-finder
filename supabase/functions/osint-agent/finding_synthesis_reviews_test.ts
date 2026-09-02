// finding_synthesis_reviews_test.ts — P0: analyst rejection binds on synthesis.
//
// A synthesized finding carries ENGINE authority and a NEW artifact id. Before
// this boundary, `finding-synthesis-sweep.ts` never consulted `artifact_reviews`,
// so a row the analyst had marked FALSE could (a) supply a source class to the
// corroboration bar and (b) be republished inside `supporting_artifact_ids`
// under a fresh id — the exact bypass id-only exclusion exists to close.
//
// These tests drive the REAL sweep against a fake PostgREST that serves
// `artifact_reviews` alongside `threads` and `artifacts`.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { synthesizeMissingFindings } from "./finding-synthesis-sweep.ts";

const T1 = "11111111-1111-4111-8111-111111111111";
const U1 = "22222222-2222-4222-8222-222222222222";

function artifact(id: string, source: string, value = "jordan.vale@example.test") {
  return { id, kind: "email", value, source, confidence: 60, metadata: {}, created_at: "2026-08-28T00:00:00Z" };
}

/** Two independent classes — clears the bar ONLY if both rows are admissible. */
const A_COURT = artifact("a-court", "court_record_search");
const A_CORP = artifact("a-corp", "opencorporates_search");

function fakeDb(cfg: {
  artifacts: unknown[];
  reviews?: Array<{ artifact_id: string; state: string; note?: string | null }>;
  reviewsError?: boolean;
}) {
  const inserted: unknown[][] = [];
  const db = {
    from(table: string) {
      const q: Record<string, unknown> = {};
      let cols = "";
      let inIds: unknown[] | null = null;
      const payload = () => {
        if (table === "threads") return { data: [{ id: T1, user_id: U1 }], error: null };
        if (table === "artifact_reviews") {
          return cfg.reviewsError
            ? { data: null, error: { message: "boom" } }
            : { data: cfg.reviews ?? [], error: null };
        }
        // artifacts: the prior-findings read (id,metadata), the review loader's
        // id → row lookup (.in), and the full read.
        if (cols.startsWith("id,metadata")) return { data: [], error: null };
        if (inIds) {
          const want = new Set(inIds.map(String));
          return { data: (cfg.artifacts as Array<{ id: string }>).filter((a) => want.has(a.id)), error: null };
        }
        return { data: cfg.artifacts, error: null };
      };
      q.select = (c?: string) => { cols = c ?? ""; return q; };
      q.eq = () => q;
      q.in = (_c: string, ids: unknown[]) => { inIds = ids; return q; };
      q.gte = () => q;
      q.lt = () => q;
      q.order = () => q;
      q.limit = () => q;
      q.insert = (rows: unknown[]) => { inserted.push(rows); return Promise.resolve({ error: null }); };
      q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
        Promise.resolve(payload()).then(res, rej);
      return q;
    },
  };
  return { db, inserted };
}

Deno.test("control: with no rejection the two-class thread synthesizes a finding", async () => {
  const { db, inserted } = fakeDb({ artifacts: [A_COURT, A_CORP] });
  const res = await synthesizeMissingFindings(db, { limit: 1 });
  assertEquals(res.errors, 0);
  assertEquals(res.findingsWritten, 1);
  const meta = ((inserted[0] as Record<string, unknown>[])[0].metadata) as Record<string, unknown>;
  assertEquals((meta.supporting_artifact_ids as string[]).sort(), ["a-corp", "a-court"]);
});

Deno.test("⛔ rejected evidence cannot contribute to a new finding (by artifact id)", async () => {
  // Rejecting one of the two class-bearing rows drops the thread below the bar:
  // the rejected row neither counts as a source class nor appears as support.
  const { db, inserted } = fakeDb({
    artifacts: [A_COURT, A_CORP],
    reviews: [{ artifact_id: "a-corp", state: "dismissed" }],
  });
  const res = await synthesizeMissingFindings(db, { limit: 1 });
  assertEquals(res.errors, 0);
  assertEquals(res.findingsWritten, 0, "one admissible class cannot clear a two-class bar");
  assertEquals(inserted.length, 0);
});

Deno.test("⛔ a NEW artifact id cannot revive the same rejected normalized selector", async () => {
  // The analyst rejected a-corp. A later run re-recorded the same kind+value
  // under a fresh id with different casing/spacing. Id-only exclusion would let
  // it through; kind|value exclusion must not.
  const revived = artifact("a-corp-NEW", "opencorporates_search", "  Jordan.Vale@Example.TEST ");
  const { db, inserted } = fakeDb({
    artifacts: [A_COURT, revived, artifact("a-corp", "opencorporates_search")],
    reviews: [{ artifact_id: "a-corp", state: "wrong" }],
  });
  const res = await synthesizeMissingFindings(db, { limit: 1 });
  assertEquals(res.errors, 0);
  assertEquals(res.findingsWritten, 0, "the re-recorded selector must be excluded by normalized kind|value");
  assertEquals(inserted.length, 0);
});

Deno.test("a rejection on an UNRELATED row leaves the finding intact and out of its support", async () => {
  const stranger = artifact("a-stranger", "hibp", "someone.else@example.test");
  const { db, inserted } = fakeDb({
    artifacts: [A_COURT, A_CORP, stranger],
    reviews: [{ artifact_id: "a-stranger", state: "dismissed" }],
  });
  const res = await synthesizeMissingFindings(db, { limit: 1 });
  assertEquals(res.findingsWritten, 1);
  const meta = ((inserted[0] as Record<string, unknown>[])[0].metadata) as Record<string, unknown>;
  assert(!(meta.supporting_artifact_ids as string[]).includes("a-stranger"));
});

Deno.test("⛔ FAIL-CLOSED: an unreadable review set skips the thread and counts an error", async () => {
  const { db, inserted } = fakeDb({ artifacts: [A_COURT, A_CORP], reviewsError: true });
  const res = await synthesizeMissingFindings(db, { limit: 1 });
  assertEquals(res.findingsWritten, 0, "must not adjudicate on unfiltered rows");
  assertEquals(inserted.length, 0);
  assertEquals(res.errors, 1, "the skip must be visible in the sweep result, not silent");
});

Deno.test("confirmed / key / recheck verdicts do not change the synthesized number", async () => {
  // A positive decision is not a second source. The finding's engine confidence
  // must be identical with and without the verdicts.
  const plain = fakeDb({ artifacts: [A_COURT, A_CORP] });
  const marked = fakeDb({
    artifacts: [A_COURT, A_CORP],
    reviews: [{ artifact_id: "a-court", state: "key" }, { artifact_id: "a-corp", state: "confirmed" }],
  });
  await synthesizeMissingFindings(plain.db, { limit: 1 });
  await synthesizeMissingFindings(marked.db, { limit: 1 });
  const c1 = (plain.inserted[0] as Record<string, unknown>[])[0].confidence;
  const c2 = (marked.inserted[0] as Record<string, unknown>[])[0].confidence;
  assertEquals(c2, c1);
});
