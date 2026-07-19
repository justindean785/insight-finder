// reviews_test.ts — analyst-verdict visibility (public.artifact_reviews).
//
// Guards the fix for the integrity bug where analyst "False"/dismissed marks were
// written to artifact_reviews but NEVER read by any edge function, so a rejected
// artifact was fed to the model identically to a confirmed one and reappeared as
// the "most likely subject."
//
// Two contract changes after review (2026-07-19):
//   1. FAIL-CLOSED. Loading used to fail OPEN — a query error yielded an empty map,
//      silently restoring the exact pre-fix behavior. A transient DB error would
//      therefore re-promote artifacts the analyst marked FALSE: the incident,
//      reproduced by an outage. `ok:false` now means UNAVAILABLE and callers skip.
//   2. VALUE-LEVEL enforcement. Filtering only by artifact_id is bypassable by
//      re-recording the same kind+value under a fresh id.
import { assertEquals } from "jsr:@std/assert@^1";
import {
  applyReviewsToArtifacts,
  emptyReviewLoad,
  isRejectedReview,
  loadReviewsForThread,
  normalizeArtifactKey,
  RECHECK_CONFIDENCE_PENALTY,
  rejectedArtifacts,
  renderAnalystRejectionBlock,
  type ReviewLoad,
} from "./reviews.ts";

type Rows = Array<Record<string, unknown>> | null;

/** Stub for `.from(t).select(cols).eq(..)|.in(..)`; thenable terminal.
 *  `artifacts` serves the rejected-id → kind/value lookup. */
function stubDb(
  reviewRows: Rows,
  error: unknown = null,
  opts?: {
    capture?: { table?: string; cols?: string; eqs: Array<[string, unknown]> };
    artifactRows?: Rows;
    artifactError?: unknown;
  },
) {
  const eqs: Array<[string, unknown]> = opts?.capture?.eqs ?? [];
  const make = (data: Rows, err: unknown) => {
    const b = {
      eq(col: string, v: unknown) { eqs.push([col, v]); return b; },
      in(_col: string, _v: readonly unknown[]) { return b; },
      then(resolve: (r: { data: Rows; error: unknown }) => unknown) {
        return Promise.resolve({ data, error: err }).then(resolve);
      },
    };
    return b;
  };
  return {
    from(table: string) {
      if (opts?.capture && table === "artifact_reviews") opts.capture.table = table;
      return {
        select(cols: string) {
          if (opts?.capture && table === "artifact_reviews") opts.capture.cols = cols;
          return table === "artifacts"
            ? make(opts?.artifactRows ?? [], opts?.artifactError ?? null)
            : make(reviewRows, error);
        },
      };
    },
  };
}

const load = (byId: Record<string, string>, rejectedKeys: string[] = []): ReviewLoad => ({
  ok: true, byId: new Map(Object.entries(byId)), rejectedKeys: new Set(rejectedKeys), error: null,
});

Deno.test("isRejectedReview only treats dismissed/wrong as rejection", () => {
  assertEquals(isRejectedReview("dismissed"), true);
  assertEquals(isRejectedReview("wrong"), true);
  assertEquals(isRejectedReview("recheck"), false);
  assertEquals(isRejectedReview("confirmed"), false);
  assertEquals(isRejectedReview(null), false);
});

Deno.test("normalizeArtifactKey is case/whitespace insensitive", () => {
  assertEquals(normalizeArtifactKey("Email", " Foo@Example.COM "), normalizeArtifactKey("email", "foo@example.com"));
  assertEquals(normalizeArtifactKey("name", "Wayne   Young"), normalizeArtifactKey("name", "wayne young"));
});

Deno.test("loadReviewsForThread builds byId and scopes by thread + user", async () => {
  const capture = { eqs: [] as Array<[string, unknown]> };
  const db = stubDb([{ artifact_id: "a1", state: "dismissed" }, { artifact_id: "a2", state: "recheck" }], null, {
    capture, artifactRows: [{ id: "a1", kind: "email", value: "x@y.z" }],
  });
  const r = await loadReviewsForThread(db, "thread-1", "user-9");
  assertEquals(r.ok, true);
  assertEquals(r.byId.get("a1"), "dismissed");
  assertEquals(r.byId.get("a2"), "recheck");
  assertEquals(capture.table, "artifact_reviews");
  assertEquals(capture.eqs.some(([c, v]) => c === "thread_id" && v === "thread-1"), true);
  assertEquals(capture.eqs.some(([c, v]) => c === "user_id" && v === "user-9"), true);
});

Deno.test("loadReviewsForThread resolves rejected ids into value-level keys", async () => {
  const db = stubDb([{ artifact_id: "a1", state: "wrong" }], null, {
    artifactRows: [{ id: "a1", kind: "name", value: "Wayne Young" }],
  });
  const r = await loadReviewsForThread(db, "t", "u");
  assertEquals(r.ok, true);
  assertEquals(r.rejectedKeys.has(normalizeArtifactKey("name", "wayne young")), true);
});

Deno.test("loadReviewsForThread exposes rejectedRows for the DO-NOT-USE block", async () => {
  const db = stubDb([{ artifact_id: "a1", state: "dismissed" }], null, {
    artifactRows: [{ id: "a1", kind: "name", value: "Wayne Young" }],
  });
  const r = await loadReviewsForThread(db, "t", "u");
  assertEquals(r.rejectedRows.length, 1);
  assertEquals(r.rejectedRows[0].value, "Wayne Young");
  // and it renders straight into the authoritative prompt block
  assertEquals(renderAnalystRejectionBlock(r.rejectedRows).includes("Wayne Young"), true);
});

Deno.test("loadReviewsForThread FAILS CLOSED on a query error", async () => {
  const r = await loadReviewsForThread(stubDb(null, { message: "boom" }), "t", "u");
  assertEquals(r.ok, false);
  assertEquals(r.byId.size, 0);
  assertEquals(String(r.error).includes("boom"), true);
});

Deno.test("loadReviewsForThread FAILS CLOSED when db.from throws", async () => {
  const throwing = { from() { throw new Error("db down"); } } as unknown as Parameters<typeof loadReviewsForThread>[0];
  const r = await loadReviewsForThread(throwing, "t", "u");
  assertEquals(r.ok, false);
  assertEquals(String(r.error).includes("db down"), true);
});

Deno.test("a failed rejected-key lookup keeps ok:true (id-level enforcement survives)", async () => {
  const db = stubDb([{ artifact_id: "a1", state: "dismissed" }], null, {
    artifactError: { message: "artifacts read failed" },
  });
  const r = await loadReviewsForThread(db, "t", "u");
  assertEquals(r.ok, true);                 // verdicts WERE readable
  assertEquals(r.byId.get("a1"), "dismissed");
  assertEquals(r.rejectedKeys.size, 0);     // keys unavailable, ids still enforced
});

Deno.test("applyReviewsToArtifacts DROPS dismissed and wrong", () => {
  const rows = [
    { id: "a1", kind: "email", value: "a@b.c", confidence: 80 },
    { id: "a2", kind: "email", value: "d@e.f", confidence: 70 },
    { id: "a3", kind: "name", value: "X", confidence: 60 },
  ];
  const out = applyReviewsToArtifacts(rows, load({ a1: "dismissed", a3: "wrong" }));
  assertEquals(out.map((r) => r.id), ["a2"]);
});

Deno.test("BYPASS CLOSED: same kind+value under a NEW id is still dropped", () => {
  // The analyst marked a1 FALSE. The agent later re-records the identical finding
  // as a9 (fresh id, different casing/spacing). Id-only filtering would let a9
  // through — which is the bypass.
  const rows = [
    { id: "a1", kind: "name", value: "Wayne Young", confidence: 80 },
    { id: "a9", kind: "Name", value: "  wayne   young ", confidence: 85 },
    { id: "a2", kind: "name", value: "Someone Else", confidence: 50 },
  ];
  const out = applyReviewsToArtifacts(rows, load({ a1: "dismissed" }));
  assertEquals(out.map((r) => r.id), ["a2"]);
});

Deno.test("BYPASS CLOSED: value-level key from the DB drops a re-record even when the original row is absent", () => {
  const rows = [{ id: "a9", kind: "name", value: "Wayne Young", confidence: 85 }];
  const out = applyReviewsToArtifacts(rows, load({}, [normalizeArtifactKey("name", "wayne young")]));
  assertEquals(out.length, 0);
});

Deno.test("applyReviewsToArtifacts downweights recheck, floors at zero, tags states", () => {
  const out = applyReviewsToArtifacts(
    [{ id: "a1", kind: "e", value: "v", confidence: 50 }, { id: "a2", kind: "e", value: "w", confidence: 5 }],
    load({ a1: "recheck", a2: "recheck" }),
  );
  assertEquals(out[0].confidence, 50 - RECHECK_CONFIDENCE_PENALTY);
  assertEquals(out[0].review_state, "recheck");
  assertEquals(out[1].confidence, 0);
  const kept = applyReviewsToArtifacts([{ id: "a1", kind: "e", value: "v", confidence: 50 }], load({ a1: "confirmed" }));
  assertEquals(kept[0].confidence, 50);
  assertEquals(kept[0].review_state, "confirmed");
});

Deno.test("applyReviewsToArtifacts is identity when nothing is reviewed", () => {
  const rows = [{ id: "a1", kind: "e", value: "v", confidence: 10 }];
  assertEquals(applyReviewsToArtifacts(rows, load({})), rows);
});

Deno.test("FAIL-CLOSED: unavailable review state surfaces NOTHING, not everything", () => {
  const rows = [{ id: "a1", kind: "e", value: "v", confidence: 10 }];
  assertEquals(applyReviewsToArtifacts(rows, emptyReviewLoad(false, "boom")).length, 0);
  assertEquals(rejectedArtifacts(rows, emptyReviewLoad(false, "boom")).length, 0);
});

Deno.test("rejectedArtifacts returns rejected rows by id AND by value key", () => {
  const rows = [
    { id: "a1", kind: "name", value: "Wayne Young" },
    { id: "a9", kind: "name", value: "wayne young" },
    { id: "a2", kind: "name", value: "Other" },
  ];
  const out = rejectedArtifacts(rows, load({ a1: "dismissed" }, [normalizeArtifactKey("name", "wayne young")]));
  assertEquals(out.map((r) => r.id).sort(), ["a1", "a9"]);
});

Deno.test("renderAnalystRejectionBlock names the rejected values and is authoritative", () => {
  const block = renderAnalystRejectionBlock([{ kind: "name", value: "Wayne Young" }]);
  assertEquals(block.includes("ANALYST-REJECTED"), true);
  assertEquals(block.includes("Wayne Young"), true);
  assertEquals(block.includes("SUPERSEDED"), true);
  assertEquals(renderAnalystRejectionBlock([]), "");
  assertEquals(renderAnalystRejectionBlock(null), "");
});
