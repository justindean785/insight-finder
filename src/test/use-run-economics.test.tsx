import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * useRunEconomics, DRIVEN against a stubbed client.
 *
 * Three defects found after #935 merged, each pinned here:
 *  1. Figures outlived the account they were read for. On a switch of user — and on a
 *     sign-out, where the hook stays mounted with no userId — the previous user's spend and
 *     run list stayed on screen.
 *  2. The token read asked for 2,000 rows. PostgREST answers at most its 1,000-row cap and
 *     says nothing was cut, so token totals could be under-counted and printed as exact.
 *  3. A read that THREW (rather than returning an error) left the tab loading forever.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

type Page = { data: unknown[] | null; error: { message: string } | null };

const m = vi.hoisted(() => ({
  pages: {} as Record<string, Array<Page | "throw" | "pending">>,
  calls: [] as { table: string; op: string; args: unknown[] }[],
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const node: Record<string, unknown> = {};
      for (const op of ["select", "eq", "gte", "in", "order"]) {
        node[op] = (...args: unknown[]) => { m.calls.push({ table, op, args }); return node; };
      }
      node.range = (...args: unknown[]) => {
        m.calls.push({ table, op: "range", args });
        const next = m.pages[table]?.shift() ?? { data: [], error: null };
        if (next === "throw") return { then: () => { throw new Error("network down"); } };
        if (next === "pending") return new Promise<Page>(() => {}); // never settles
        return Promise.resolve(next);
      };
      return node;
    },
  },
}));

import { STEP_PAGE_SIZE, STEP_ROW_LIMIT, useRunEconomics } from "@/hooks/useRunEconomics";

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();
const inv = (id: string, cost: number | null): Record<string, unknown> => ({
  id, thread_id: "t1", started_at: hoursAgo(2), duration_ms: 100_000, step_count: 8,
  tool_call_count: 12, stop_reason: "natural_stop", credits_micro_usd: cost, model_id: "glm-5.2",
  persist_ms: 2_000, salvage_ms: null, salvage_outcome: "none", unfinished_steps: 0,
});
const step = (invocation_id: string) => ({ invocation_id, input_tokens: 10, output_tokens: 1 });

const INV = "orchestrator_invocations";
const STEPS = "orchestrator_step_metrics";

beforeEach(() => { m.pages = {}; m.calls = []; });

describe("useRunEconomics — figures never outlive the account they were read for", () => {
  it("drops the previous user's runs the moment the user changes, before the new read lands", async () => {
    m.pages = { [INV]: [{ data: [inv("a", 150_000)], error: null }], [STEPS]: [{ data: [step("a")], error: null }] };
    const { result, rerender } = renderHook(({ u }: { u: string | undefined }) => useRunEconomics(u), {
      initialProps: { u: "u1" as string | undefined },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.recent).toHaveLength(1);
    expect(result.current.summary.spend30Usd).toBeCloseTo(0.15, 5);

    // u2's read never settles. Whatever is on screen now is what a user switch exposes.
    m.pages = { [INV]: ["pending"] };
    rerender({ u: "u2" });

    expect(result.current.recent).toEqual([]);
    expect(result.current.summary.spend30Usd).toBe(0);
    expect(result.current.loading).toBe(true);
  });

  it("clears the figures on sign-out, when the hook stays mounted with no user", async () => {
    m.pages = { [INV]: [{ data: [inv("a", 150_000)], error: null }], [STEPS]: [{ data: [step("a")], error: null }] };
    const { result, rerender } = renderHook(({ u }: { u: string | undefined }) => useRunEconomics(u), {
      initialProps: { u: "u1" as string | undefined },
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.recent).toHaveLength(1);

    const before = m.calls.length;
    rerender({ u: undefined });

    expect(result.current.recent).toEqual([]);
    expect(result.current.summary.spend30Usd).toBe(0);
    expect(m.calls.length).toBe(before); // signed out: nothing is read
  });
});

describe("useRunEconomics — the token read is paged, not a bare limit", () => {
  it("reads steps in pages under the 1,000-row cap, scoped to the listed runs", async () => {
    m.pages = { [INV]: [{ data: [inv("a", 150_000)], error: null }], [STEPS]: [{ data: [step("a")], error: null }] };
    const { result } = renderHook(() => useRunEconomics("u1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const stepCalls = m.calls.filter((c) => c.table === STEPS);
    const sent = stepCalls.map((c) => `${c.op}:${JSON.stringify(c.args)}`);
    expect(sent).toContain(`range:[0,${STEP_PAGE_SIZE - 1}]`);
    expect(sent).toContain('in:["invocation_id",["a"]]');
    expect(sent).toContain('eq:["user_id","u1"]');
    expect(sent).toContain('order:["id",{"ascending":true}]');
    // The defect was a single `.limit(2000)` read. No limit call may remain.
    expect(stepCalls.some((c) => c.op === "limit")).toBe(false);
    expect(STEP_PAGE_SIZE).toBeLessThanOrEqual(1000);
    expect(result.current.tokens.get("a")).toMatchObject({ input: 10, output: 1, partial: false });
  });

  it("marks token totals as a floor when the step read is capped, instead of under-counting silently", async () => {
    const full = () => ({ data: Array.from({ length: STEP_PAGE_SIZE }, () => step("a")), error: null });
    const pages: Page[] = Array.from({ length: Math.ceil((STEP_ROW_LIMIT + 1) / STEP_PAGE_SIZE) }, full);
    m.pages = { [INV]: [{ data: [inv("a", 150_000)], error: null }], [STEPS]: pages };

    const { result } = renderHook(() => useRunEconomics("u1"));
    await waitFor(() => expect(result.current.loading).toBe(false));

    const t = result.current.tokens.get("a");
    expect(t?.partial).toBe(true); // "131.0k+", never a total presented as exact
    expect(t?.input).toBe(STEP_ROW_LIMIT * 10);
  });
});

describe("useRunEconomics — failures end the loading state", () => {
  it("reports a THROWN read as an error instead of loading forever", async () => {
    m.pages = { [INV]: ["throw"] };
    const { result } = renderHook(() => useRunEconomics("u1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toMatch(/network down/);
    expect(result.current.recent).toEqual([]);
  });

  it("reports an error result as an error, with no runs listed", async () => {
    m.pages = { [INV]: [{ data: null, error: { message: "permission denied" } }] };
    const { result } = renderHook(() => useRunEconomics("u1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe("permission denied");
    expect(result.current.recent).toEqual([]);
  });

  it("keeps the cost figures when only the token read fails", async () => {
    m.pages = { [INV]: [{ data: [inv("a", 150_000)], error: null }], [STEPS]: [{ data: null, error: { message: "nope" } }] };
    const { result } = renderHook(() => useRunEconomics("u1"));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBeNull();
    expect(result.current.recent).toHaveLength(1);
    expect(result.current.tokens.size).toBe(0);
  });
});
