import { describe, it, expect } from "vitest";
import { fetchAllPages, type PageResult } from "@/lib/fetch-all-pages";

/** A fake table of `n` rows, served by inclusive [from, to] ranges, recording each request. */
function table(n: number) {
  const all = Array.from({ length: n }, (_, i) => ({ i }));
  const calls: Array<[number, number]> = [];
  const fetchPage = async (from: number, to: number): Promise<PageResult<{ i: number }>> => {
    calls.push([from, to]);
    return { data: all.slice(from, to + 1), error: null };
  };
  return { fetchPage, calls };
}

describe("fetchAllPages", () => {
  it("concatenates pages until a short page and reports nothing truncated", async () => {
    const t = table(7);
    const r = await fetchAllPages(t.fetchPage, { pageSize: 3, maxRows: 100 });
    expect(r.rows.map((x) => x.i)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(r.truncated).toBe(false);
    expect(r.error).toBeNull();
    expect(t.calls).toEqual([[0, 2], [3, 5], [6, 8]]);
  });

  it("ends cleanly when the last full page is followed by an empty one", async () => {
    const t = table(6);
    const r = await fetchAllPages(t.fetchPage, { pageSize: 3, maxRows: 100 });
    expect(r.rows).toHaveLength(6);
    expect(r.truncated).toBe(false);
    expect(t.calls).toHaveLength(3);
  });

  it("stops at maxRows and says it was cut off", async () => {
    const t = table(10);
    const r = await fetchAllPages(t.fetchPage, { pageSize: 3, maxRows: 6 });
    expect(r.rows).toHaveLength(6);
    expect(r.truncated).toBe(true);
    // It asked for one row past the cap, to know there was more; it never asked for the rest.
    expect(t.calls).toEqual([[0, 2], [3, 5], [6, 6]]);
  });

  it("does not claim truncation when the table holds exactly maxRows", async () => {
    const t = table(6);
    const r = await fetchAllPages(t.fetchPage, { pageSize: 3, maxRows: 6 });
    expect(r.rows).toHaveLength(6);
    expect(r.truncated).toBe(false);
  });

  it("returns the error and no rows when any page fails, so a partial read is never shown as complete", async () => {
    let n = 0;
    const r = await fetchAllPages<{ i: number }>(
      async () => (++n === 2 ? { data: null, error: { message: "boom" } } : { data: [{ i: n }, { i: n }, { i: n }], error: null }),
      { pageSize: 3, maxRows: 100 },
    );
    expect(r.error).toBe("boom");
    expect(r.rows).toEqual([]);
    expect(r.truncated).toBe(false);
  });

  it("treats a page with no data and no error as a failure, not as an empty table", async () => {
    const r = await fetchAllPages<{ i: number }>(async () => ({ data: null, error: null }), { pageSize: 3, maxRows: 100 });
    expect(r.error).toMatch(/no data/i);
    expect(r.rows).toEqual([]);
  });
});
