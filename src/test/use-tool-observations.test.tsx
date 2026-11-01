import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * useToolObservations, DRIVEN against a stubbed client. What matters here is the failure path: a read
 * that errors OR THROWS must end the loading state with a visible error, never leave the panel on
 * "Reading tool outcomes…" forever, and never hand the panel an empty, healthy-looking list.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const m = vi.hoisted(() => ({
  pages: [] as Array<{ data: unknown[] | null; error: { message: string } | null } | "throw">,
  calls: [] as { op: string; args: unknown[] }[],
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => {
      const node: Record<string, unknown> = {};
      for (const op of ["select", "eq", "gte", "order"]) {
        node[op] = (...args: unknown[]) => { m.calls.push({ op, args }); return node; };
      }
      node.range = (...args: unknown[]) => {
        m.calls.push({ op: "range", args });
        const next = m.pages.shift() ?? { data: [], error: null };
        return next === "throw"
          ? { then: () => { throw new Error("network down"); } }
          : Promise.resolve(next);
      };
      return node;
    },
  },
}));

import { OBSERVATION_PAGE_SIZE, useToolObservations } from "@/hooks/useToolObservations";

const recent = () => new Date(Date.now() - 86_400_000).toISOString();
const ok = (tool: string) => ({ tool_name: tool, outcome: "ok", cached: false, status_code: null, error_msg: null, thread_id: "t1", created_at: recent() });

beforeEach(() => { m.pages = []; m.calls = []; });

describe("useToolObservations", () => {
  it("reads the signed-in user's live calls newest-first with a stable tiebreak, and summarizes them", async () => {
    m.pages = [{ data: [ok("exa_search"), ok("exa_search")], error: null }];
    const { result } = renderHook(() => useToolObservations("u1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.summary.tools[0]).toMatchObject({ tool: "exa_search", attempts: 2 });
    const sent = m.calls.map((c) => `${c.op}:${JSON.stringify(c.args)}`);
    expect(sent).toContain('eq:["user_id","u1"]');
    expect(sent).toContain('eq:["cached",false]');
    expect(sent).toContain('order:["created_at",{"ascending":false}]');
    expect(sent).toContain('order:["id",{"ascending":false}]');
    expect(sent).toContain(`range:[0,${OBSERVATION_PAGE_SIZE - 1}]`);
  });

  it("reports an error result as an error, with no tools listed", async () => {
    m.pages = [{ data: null, error: { message: "permission denied" } }];
    const { result } = renderHook(() => useToolObservations("u1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("permission denied");
    expect(result.current.summary.tools).toEqual([]);
  });

  it("reports a THROWN read as an error instead of loading forever", async () => {
    m.pages = ["throw"];
    const { result } = renderHook(() => useToolObservations("u1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toMatch(/network down/);
    expect(result.current.summary.tools).toEqual([]);
  });

  it("does nothing until there is a signed-in user", () => {
    const { result } = renderHook(() => useToolObservations(undefined));
    expect(result.current.loading).toBe(true);
    expect(m.calls).toEqual([]);
  });
});
