import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Sources tab, DRIVEN: the real component against a stubbed client. The two
 * things that went wrong in production were (1) the query read the `ok` boolean
 * (skips and empties counted as successes) and (2) it was unordered and
 * unwindowed under a 5000-row cap. Both are asserted on what the tab sends and
 * what the analyst reads.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const m = vi.hoisted(() => ({
  logs: [] as Record<string, unknown>[],
  // `q` numbers each .from() chain, so a test can look at ONE query: the tab now makes two reads of tool_usage_log.
  calls: [] as { table: string; op: string; args: unknown[]; q: number }[],
  nextQuery: 0,
  // Stable identity: the tab's effect depends on `user`, so a fresh object per render would re-run it forever.
  auth: { user: { id: "u1" }, loading: false },
}));

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => m.auth }));
vi.mock("@/integrations/supabase/client", () => {
  const chain = (table: string) => {
    const q = ++m.nextQuery;
    const node: Record<string, unknown> = {};
    for (const op of ["select", "eq", "gte", "in", "order", "limit", "range"]) {
      node[op] = (...args: unknown[]) => { m.calls.push({ table, op, args, q }); return node; };
    }
    node.then = (resolve: (v: unknown) => void) =>
      resolve({ data: table === "tool_usage_log" ? m.logs : [], error: null });
    return node;
  };
  return { supabase: { from: (t: string) => chain(t) } };
});

import { SourcesTab } from "@/pages/BrainGlobalPage";

const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 24 * 3600 * 1000).toISOString();
const log = (tool: string, outcome: string, daysAgo = 1) =>
  ({ tool_name: tool, outcome, cached: false, created_at: iso(daysAgo) });

beforeEach(() => { m.logs = []; m.calls = []; m.nextQuery = 0; });

describe("SourcesTab", () => {
  it("queries outcome, live calls, a 30-day window, newest first", async () => {
    render(<SourcesTab />);
    await waitFor(() => expect(m.calls.some((c) => c.table === "tool_usage_log" && c.op === "limit")).toBe(true));
    // The original source-reliability read is the tool_usage_log query that ends in .limit().
    const sourceQuery = m.calls.find((c) => c.table === "tool_usage_log" && c.op === "limit")!.q;
    const q = m.calls.filter((c) => c.table === "tool_usage_log" && c.q === sourceQuery);
    const sel = q.find((c) => c.op === "select")!.args[0] as string;
    expect(sel).toContain("outcome");
    expect(sel).not.toMatch(/\bok\b/);
    expect(q.find((c) => c.op === "eq" && c.args[0] === "cached")?.args[1]).toBe(false);
    const gte = q.find((c) => c.op === "gte")!;
    expect(gte.args[0]).toBe("created_at");
    const ageDays = (Date.now() - Date.parse(gte.args[1] as string)) / 86400000;
    expect(ageDays).toBeGreaterThan(29.9);
    expect(ageDays).toBeLessThan(30.1);
    expect(q.find((c) => c.op === "order")?.args).toEqual(["created_at", { ascending: false }]);
  });

  it("a tool with only skips shows no percentage, not 100%", async () => {
    m.logs = Array.from({ length: 40 }, () => log("username_sweep", "skipped"));
    render(<SourcesTab />);
    expect((await screen.findAllByText("username_sweep")).length).toBeGreaterThan(0); // listed in both the new panel and SOURCE WEIGHTS
    expect(screen.getByText("no attempts")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/100%/);
  });

  it("failures are visible: 7 ok + 3 failed reads 70% on 10 attempts, with skips not counted", async () => {
    m.logs = [
      ...Array.from({ length: 7 }, () => log("leakcheck_lookup", "ok")),
      ...Array.from({ length: 3 }, () => log("leakcheck_lookup", "failed")),
      ...Array.from({ length: 20 }, () => log("leakcheck_lookup", "skipped")),
    ];
    render(<SourcesTab />);
    expect((await screen.findAllByText("leakcheck_lookup")).length).toBeGreaterThan(0);
    expect(screen.getByText("70%")).toBeTruthy();
    expect(screen.getByText("10 attempts")).toBeTruthy();
    expect(screen.queryByText(/30 runs|runs/)).toBeNull();
  });

  it("the explanation names the definition", async () => {
    render(<SourcesTab />);
    await waitFor(() => expect(document.body.textContent).toMatch(/real attempts/));
    expect(document.body.textContent).toMatch(/Skipped and no-record calls are not counted/);
  });
});
