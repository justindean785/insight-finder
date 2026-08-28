/**
 * review-load-availability.test.ts — #500.
 *
 * THE DEFECT. `loadFromDb` destructured `const { data } = await supabase...` and
 * discarded the error. A failing PostgREST select resolves as
 * `{ data: null, error }` rather than throwing, so `data ?? []` rendered a failed
 * read identically to "this thread has no reviews" — and every `dismissed` /
 * `wrong` artifact silently read as unreviewed.
 *
 * Worse than the backend twin fixed in #498: the cache was cleared (`c.states = {}`)
 * BEFORE the loop repopulated it, so a failed RE-load destroyed verdicts that had
 * previously loaded correctly. State went from accurate to empty.
 *
 * The interpretation is extracted as a pure function so the decision — "is this
 * response trustworthy?" — is directly testable, and so the caller has one
 * unambiguous thing to branch on. Same shape as #498's pure renderer.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { interpretReviewRows } from "@/lib/review";

describe("interpretReviewRows: a failed read is not an empty one", () => {
  it("treats a PostgREST error as UNAVAILABLE, never as zero reviews", () => {
    const out = interpretReviewRows(null, { message: "boom" });
    expect(out.available).toBe(false);
  });

  it("a well-formed array WITH an error is still not a successful read", () => {
    // Isolates the error check from the shape check. Passing `null` data alongside
    // an error does not test this — `!Array.isArray(null)` catches that case on its
    // own, so the error branch could be deleted and the test would still pass.
    // A partial payload delivered alongside an error is not a complete verdict set.
    const out = interpretReviewRows(
      [{ artifact_id: "a1", state: "dismissed", note: null }],
      { message: "statement timeout" },
    );
    expect(out.available).toBe(false);
  });

  it("treats a null payload with no error as unavailable too", () => {
    // Defensive: a successful select returns [], never null. A null here means
    // something we do not understand happened, and guessing "none" is the
    // dangerous direction.
    expect(interpretReviewRows(null, null).available).toBe(false);
  });

  it("treats a non-array payload as unavailable", () => {
    for (const bad of [undefined, {}, "rows", 42, true]) {
      expect(interpretReviewRows(bad, null).available).toBe(false);
    }
  });

  it("a genuinely empty thread IS available, with no states", () => {
    const out = interpretReviewRows([], null);
    expect(out.available).toBe(true);
    if (out.available) expect(out.states).toEqual({});
  });

  it("maps rows to states and keeps only non-empty notes", () => {
    const out = interpretReviewRows(
      [
        { artifact_id: "a1", state: "dismissed", note: null },
        { artifact_id: "a2", state: "confirmed", note: "checked the registry" },
        { artifact_id: "a3", state: "wrong", note: "" },
      ],
      null,
    );
    expect(out.available).toBe(true);
    if (!out.available) return;
    expect(out.states).toEqual({ a1: "dismissed", a2: "confirmed", a3: "wrong" });
    expect(out.notes).toEqual({ a2: "checked the registry" });
  });

  it("ignores malformed rows without failing the whole read", () => {
    // One bad row must not discard an analyst's other verdicts.
    const out = interpretReviewRows(
      [null, 42, { artifact_id: "a1" }, { state: "wrong" }, { artifact_id: "a2", state: "dismissed" }],
      null,
    );
    expect(out.available).toBe(true);
    if (out.available) expect(out.states).toEqual({ a2: "dismissed" });
  });
});

describe("the loader applies that outcome without destroying good state", () => {
  const SRC = readFileSync(resolve(process.cwd(), "src/lib/review.ts"), "utf8");
  const loadFromDb = SRC.slice(SRC.indexOf("async function loadFromDb"), SRC.indexOf("export function useReviewStates"));

  it("captures the query error instead of discarding it", () => {
    expect(loadFromDb).toContain("error");
    expect(loadFromDb).toContain("interpretReviewRows");
  });

  it("never clears cached verdicts before a successful read", () => {
    // THE regression that made a transient failure destructive. Assignments to
    // the cache must sit inside the available branch, not above it.
    const clears = loadFromDb.split("\n").filter((l) => /c\.(states|notes)\s*=\s*\{\s*\}/.test(l));
    expect(clears).toEqual([]);
  });

  it("records unavailability so consumers can fail closed", () => {
    // Precise on purpose: /available|unavailable/ would have been satisfied by the
    // word "available" in `outcome.available`, which is not the property at issue.
    // Both non-reading paths (no session, failed read) must mark unavailable, and
    // only a successful read may mark ok.
    const unavailable = loadFromDb.match(/c\.availability\s*=\s*"unavailable"/g) ?? [];
    const ok = loadFromDb.match(/c\.availability\s*=\s*"ok"/g) ?? [];
    expect(unavailable.length).toBe(2);
    expect(ok.length).toBe(1);
  });

  it("keeps the cached verdicts on the unavailable path", () => {
    // The assignments to c.states/c.notes must come AFTER the early return, so a
    // failed re-load cannot overwrite verdicts that loaded correctly.
    const bail = loadFromDb.indexOf("if (!outcome.available)");
    const assign = loadFromDb.indexOf("c.states = outcome.states");
    expect(bail).toBeGreaterThan(-1);
    expect(assign).toBeGreaterThan(bail);
  });
});
