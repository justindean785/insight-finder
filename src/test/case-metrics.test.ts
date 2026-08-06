/**
 * case-metrics.test.ts — the cases list must not under-report evidence.
 *
 * THE BUG (live production, 2026-08-06). CasesPage fetched every artifact row
 * and every tool_usage_log row for the user with `.limit(10000)` and tallied
 * them client-side. That account holds 11,610 artifacts and 17,783 tool rows,
 * so 1,610 and 7,783 rows fell outside the window and the threads owning them
 * rendered as "0 artifacts · 0 tool calls".
 *
 * Measured, list-showed -> actual: "James JJ mcgovern" 0/0 -> 108/265,
 * "luis rincon" 0/0 -> 37/146, "147.185.221.31:55641" 0/1 -> 23/61. That last
 * partial count is the signature: neither query had an ORDER BY, so which rows
 * survived was planner-dependent. It under-reported by an ARBITRARY SUBSET.
 *
 * The fake client below deliberately implements BOTH access paths — a capped
 * `.from()` and an exact `.rpc()` — so these tests run unchanged against the
 * old row-fetch implementation and the new aggregate. Against the old one the
 * first two fail, which is how we know they reproduce the defect rather than
 * merely passing.
 */
import { describe, it, expect } from "vitest";
import { loadCaseMetrics } from "@/lib/case-metrics";

const ROW_CAP = 10000;

/**
 * Mimics PostgREST: `.from()` truncates at the cap, `.rpc()` aggregates over
 * everything. `lateThreadRows` sit PAST the cap, like the older cases whose
 * rows lost the race in production.
 */
function fakeClient(opts: { earlyRows: number; lateThreadRows: number }) {
  const artifacts: { thread_id: string }[] = [
    ...Array.from({ length: opts.earlyRows }, () => ({ thread_id: "t-early" })),
    ...Array.from({ length: opts.lateThreadRows }, () => ({ thread_id: "t-late" })),
  ];
  const tools: { thread_id: string }[] = [
    ...Array.from({ length: opts.earlyRows }, () => ({ thread_id: "t-early" })),
    ...Array.from({ length: opts.lateThreadRows }, () => ({ thread_id: "t-late" })),
  ];
  const tally = (rows: { thread_id: string }[]) => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r.thread_id, (m.get(r.thread_id) ?? 0) + 1);
    return m;
  };
  return {
    calls: [] as string[],
    from(table: string) {
      this.calls.push(`from:${table}`);
      const rows = table === "artifacts" ? artifacts : tools;
      const q = {
        select: () => q,
        eq: () => q,
        limit: (n: number) => Promise.resolve({ data: rows.slice(0, n), error: null }),
      };
      return q;
    },
    rpc(fn: string) {
      this.calls.push(`rpc:${fn}`);
      const a = tally(artifacts);
      const l = tally(tools);
      const ids = new Set([...a.keys(), ...l.keys()]);
      return Promise.resolve({
        data: Array.from(ids, (id) => ({
          thread_id: id,
          artifacts: a.get(id) ?? 0,
          tool_calls: l.get(id) ?? 0,
        })),
        error: null,
      });
    },
  };
}

describe("loadCaseMetrics — counts survive past the old 10k window", () => {
  it("reports the true count for a case whose rows sit beyond the cap", async () => {
    // t-late's rows are entirely past ROW_CAP — exactly the production case
    // that rendered "0 artifacts · 0 tool calls" while holding 108 of them.
    const client = fakeClient({ earlyRows: ROW_CAP, lateThreadRows: 108 });
    const m = await loadCaseMetrics(client);
    expect(m.get("t-late")?.artifacts).toBe(108);
  });

  it("does not silently truncate tool calls either (44% were being dropped)", async () => {
    const client = fakeClient({ earlyRows: ROW_CAP, lateThreadRows: 265 });
    const m = await loadCaseMetrics(client);
    expect(m.get("t-late")?.toolCalls).toBe(265);
  });

  it("still counts cases that fall inside the window", async () => {
    const client = fakeClient({ earlyRows: 5, lateThreadRows: 3 });
    const m = await loadCaseMetrics(client);
    expect(m.get("t-early")).toEqual({ artifacts: 5, toolCalls: 5 });
    expect(m.get("t-late")).toEqual({ artifacts: 3, toolCalls: 3 });
  });

  it("aggregates server-side instead of shipping every row to the browser", async () => {
    const client = fakeClient({ earlyRows: 20, lateThreadRows: 5 });
    await loadCaseMetrics(client);
    expect(client.calls).toContain("rpc:get_case_metrics");
    expect(client.calls.some((c) => c.startsWith("from:"))).toBe(false);
  });
});

describe("loadCaseMetrics — degenerate inputs", () => {
  it("returns an empty map when the account has no cases", async () => {
    const client = fakeClient({ earlyRows: 0, lateThreadRows: 0 });
    expect((await loadCaseMetrics(client)).size).toBe(0);
  });

  it("surfaces an RPC error rather than reporting every case as empty", async () => {
    const failing = {
      rpc: () => Promise.resolve({ data: null, error: { message: "boom" } }),
    };
    await expect(loadCaseMetrics(failing)).rejects.toThrow();
  });
});
