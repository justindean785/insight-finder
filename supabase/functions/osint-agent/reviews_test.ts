// reviews_test.ts — analyst-verdict visibility (public.artifact_reviews).
//
// Guards the fix for the integrity bug where analyst "False"/dismissed marks were
// written to artifact_reviews but NEVER read by any edge function, so a rejected
// artifact was fed to the model identically to a confirmed one and reappeared as
// the "most likely subject." These tests pin the contract every read path relies
// on: rejected rows are DROPPED, recheck is downweighted, and any load error
// fails OPEN (degrades to the prior unfiltered behavior — never breaks a run).
import { assertEquals } from "jsr:@std/assert@^1";
import {
  applyReviewsToArtifacts,
  isRejectedReview,
  loadReviewsForThread,
  RECHECK_CONFIDENCE_PENALTY,
  rejectedArtifacts,
} from "./reviews.ts";

// Minimal stub matching the .from(t).select(cols).eq(col,v)[.eq(col,v)] chain that
// loadReviewsForThread awaits. `capture` records the filters actually applied so a
// test can prove thread_id/user_id scoping. The terminal object is thenable.
function stubDb(
  rows: Array<Record<string, unknown>> | null,
  error: unknown = null,
  capture?: { table?: string; cols?: string; eqs: Array<[string, unknown]> },
) {
  const eqs: Array<[string, unknown]> = capture?.eqs ?? [];
  const builder = {
    eq(col: string, v: unknown) {
      eqs.push([col, v]);
      return builder;
    },
    then(resolve: (r: { data: typeof rows; error: unknown }) => unknown) {
      return Promise.resolve({ data: rows, error }).then(resolve);
    },
  };
  return {
    from(table: string) {
      if (capture) capture.table = table;
      return {
        select(cols: string) {
          if (capture) capture.cols = cols;
          return builder;
        },
      };
    },
  };
}

Deno.test("loadReviewsForThread builds an id→state map and scopes by thread + user", async () => {
  const capture = { eqs: [] as Array<[string, unknown]> };
  const db = stubDb(
    [
      { artifact_id: "a1", state: "dismissed" },
      { artifact_id: "a2", state: "confirmed" },
      { artifact_id: "a3", state: "recheck" },
      { artifact_id: null, state: "wrong" }, // malformed → skipped
    ],
    null,
    capture,
  );
  const map = await loadReviewsForThread(db, "thread-1", "user-9");
  assertEquals(map.size, 3);
  assertEquals(map.get("a1"), "dismissed");
  assertEquals(map.get("a2"), "confirmed");
  assertEquals(map.get("a3"), "recheck");
  assertEquals(capture.table, "artifact_reviews");
  assertEquals(capture.cols, "artifact_id,state");
  assertEquals(capture.eqs, [["thread_id", "thread-1"], ["user_id", "user-9"]]);
});

Deno.test("loadReviewsForThread omits the user filter when no userId is given", async () => {
  const capture = { eqs: [] as Array<[string, unknown]> };
  await loadReviewsForThread(stubDb([], null, capture), "thread-1");
  assertEquals(capture.eqs, [["thread_id", "thread-1"]]);
});

Deno.test("loadReviewsForThread FAILS OPEN on a query error (empty map)", async () => {
  const map = await loadReviewsForThread(stubDb(null, { message: "boom" }), "t", "u");
  assertEquals(map.size, 0);
});

Deno.test("loadReviewsForThread FAILS OPEN when db.from throws", async () => {
  const throwing = {
    from() {
      throw new Error("network down");
    },
  };
  const map = await loadReviewsForThread(throwing, "t", "u");
  assertEquals(map.size, 0);
});

Deno.test("applyReviewsToArtifacts DROPS dismissed and wrong", () => {
  const rows = [
    { id: "a1", kind: "email", value: "x@y.z", confidence: 90 },
    { id: "a2", kind: "email", value: "bad@y.z", confidence: 88 },
    { id: "a3", kind: "phone", value: "555", confidence: 70 },
  ];
  const map = new Map([["a1", "dismissed"], ["a3", "wrong"]]);
  const out = applyReviewsToArtifacts(rows, map);
  assertEquals(out.map((r) => r.id), ["a2"]);
});

Deno.test("applyReviewsToArtifacts downweights recheck by the penalty and tags it", () => {
  const rows = [{ id: "a1", kind: "email", value: "x@y.z", confidence: 90 }];
  const out = applyReviewsToArtifacts(rows, new Map([["a1", "recheck"]]));
  assertEquals(out.length, 1);
  assertEquals(out[0].confidence, 90 - RECHECK_CONFIDENCE_PENALTY);
  assertEquals(out[0].review_state, "recheck");
});

Deno.test("applyReviewsToArtifacts never drives recheck confidence below zero", () => {
  const rows = [{ id: "a1", kind: "email", value: "x@y.z", confidence: 10 }];
  const out = applyReviewsToArtifacts(rows, new Map([["a1", "recheck"]]));
  assertEquals(out[0].confidence, 0);
});

Deno.test("applyReviewsToArtifacts tags confirmed/key but keeps them", () => {
  const rows = [
    { id: "a1", kind: "email", value: "x@y.z", confidence: 90 },
    { id: "a2", kind: "handle", value: "@k", confidence: 60 },
  ];
  const out = applyReviewsToArtifacts(rows, new Map([["a1", "confirmed"], ["a2", "key"]]));
  assertEquals(out.length, 2);
  assertEquals(out[0].review_state, "confirmed");
  assertEquals(out[1].review_state, "key");
  assertEquals(out[0].confidence, 90);
});

Deno.test("applyReviewsToArtifacts is a no-op (identity) when the review map is empty", () => {
  const rows = [{ id: "a1", kind: "email", value: "x@y.z", confidence: 90 }];
  const out = applyReviewsToArtifacts(rows, new Map());
  assertEquals(out, rows);
});

Deno.test("applyReviewsToArtifacts leaves un-reviewed rows untouched (no review_state tag)", () => {
  const rows = [
    { id: "a1", kind: "email", value: "x@y.z", confidence: 90 },
    { id: "a2", kind: "phone", value: "555", confidence: 70 },
  ];
  const out = applyReviewsToArtifacts(rows, new Map([["a1", "dismissed"]]));
  assertEquals(out.length, 1);
  assertEquals(out[0].id, "a2");
  assertEquals("review_state" in out[0], false);
});

Deno.test("rejectedArtifacts returns only the dismissed/wrong rows", () => {
  const rows = [
    { id: "a1", kind: "email", value: "bad@y.z", confidence: 90 },
    { id: "a2", kind: "phone", value: "555", confidence: 70 },
    { id: "a3", kind: "name", value: "Wrong Person", confidence: 55 },
  ];
  const map = new Map([["a1", "dismissed"], ["a2", "confirmed"], ["a3", "wrong"]]);
  const out = rejectedArtifacts(rows, map);
  assertEquals(out.map((r) => r.id), ["a1", "a3"]);
});

Deno.test("rejectedArtifacts is empty when the review map is empty", () => {
  const rows = [{ id: "a1", kind: "email", value: "x@y.z", confidence: 90 }];
  assertEquals(rejectedArtifacts(rows, new Map()), []);
});

Deno.test("isRejectedReview only true for dismissed/wrong", () => {
  assertEquals(isRejectedReview("dismissed"), true);
  assertEquals(isRejectedReview("wrong"), true);
  assertEquals(isRejectedReview("confirmed"), false);
  assertEquals(isRejectedReview("recheck"), false);
  assertEquals(isRejectedReview("key"), false);
  assertEquals(isRejectedReview(null), false);
  assertEquals(isRejectedReview(undefined), false);
  assertEquals(isRejectedReview(""), false);
});
