import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useThreadQueriedTargetState } from "@/hooks/useThreadQueriedTargets";
import { pivotSkipStorageKey, type RecommendedPivot } from "@/lib/recommended-pivots";
import { normalizeTarget } from "@/lib/next-step-cards";
import { renderHook } from "@testing-library/react";
import { CaseSnapshotContext } from "@/hooks/useCaseSnapshot";
import { CasePivotQueueProvider } from "@/components/workspace/CasePivotQueueProvider";
import { useCasePivotQueue } from "@/hooks/useCasePivotQueue";

const h = vi.hoisted(() => ({ reads: 0, error: false, queried: false, reviews: {} as Record<string, string>, availability: "available", delay: false, pending: [] as Array<(v: { data: unknown[]; error: null }) => void>, callback: null as null | (() => void), subscribed: null as null | ((s: string) => void) }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {
  from: () => ({ select: () => ({ eq: async () => { h.reads++; if (h.delay) return new Promise<{ data: unknown[]; error: null }>(resolve => h.pending.push(resolve)); return { data: h.queried ? [{ input_json: { runtime: { selector: "fresh@example.test" } } }] : [], error: h.error ? { message: "offline" } : null }; } }) }),
  channel: () => { const c = { on: (_: unknown, __: unknown, cb: () => void) => { h.callback = cb; return c; }, subscribe: (cb: (s: string) => void) => { h.subscribed = cb; return c; } }; return c; },
  removeChannel: vi.fn(),
} }));
vi.mock("@/lib/review", async (orig) => ({ ...await orig<typeof import("@/lib/review")>(), useReviewStates: () => ({ map: h.reviews, availability: h.availability }) }));
const snapshot = { hydrated: true, syncing: false, version: 1, seed: { value: "seed@example.test", type: "email" }, items: [{ id: "a", kind: "email", value: "fresh@example.test", source: "hunter", confidence: 60, created_at: "2026-01-01", metadata: {} }] };
function Consumer({ id }: { id: string }) { const q = useCasePivotQueue()!; return <div data-testid={id}>{q.status}:{q.count}:{q.items.filter(i => i.kind === "pivot" && i.validation.status === "valid" && i.eligibility?.runnable).length}</div>; }
function Tree({ late = false, threadId = "t1", version = 1 }) { return <CaseSnapshotContext.Provider value={{ snapshot: { ...snapshot, version } as never, refresh: async () => {} }}><CasePivotQueueProvider key={threadId} threadId={threadId}><Consumer id="chat" />{late && <Consumer id="next" />}</CasePivotQueueProvider></CaseSnapshotContext.Provider>; }
afterEach(() => { cleanup(); localStorage.clear(); h.reads = 0; h.error = false; h.queried = false; h.reviews = {}; h.availability = "available"; h.delay = false; h.pending = []; });
describe("one case queue for mounted chat and late Workbench", () => {
  it("late mounting reads the exact published queue without another tool-log query", async () => {
    const view = render(<Tree />); await waitFor(() => expect(screen.getByTestId("chat").textContent).toMatch(/^ready:[1-9]/));
    const reads = h.reads; view.rerender(<Tree late />);
    expect(screen.getByTestId("next").textContent).toBe(screen.getByTestId("chat").textContent); expect(h.reads).toBe(reads);
    act(() => { h.queried = true; h.callback?.(); });
    await waitFor(() => expect(screen.getByTestId("next").textContent).toBe("ready:0:0"));
    expect(screen.getByTestId("chat").textContent).toBe("ready:0:0");
  });
  it("completion and reconnection refresh without needing realtime row events", async () => {
    render(<Tree late />); await waitFor(() => expect(screen.getByTestId("chat").textContent).toMatch(/^ready:/));
    h.queried = true;
    act(() => { window.dispatchEvent(new CustomEvent("proximity:run-state", { detail: { threadId: "t1", running: false } })); });
    await waitFor(() => expect(screen.getByTestId("chat").textContent).toBe("ready:0:0"));
    h.queried = false; act(() => h.subscribed?.("SUBSCRIBED"));
    await waitFor(() => expect(screen.getByTestId("chat").textContent).toMatch(/^ready:[1-9]/));
  });
  it("failed reads withhold candidates; a case switch cannot reuse old targets", async () => {
    h.error = true; const view = render(<Tree late />);
    await waitFor(() => expect(screen.getByTestId("chat").textContent).toBe("error:0:0"));
    h.error = false; view.rerender(<Tree late threadId="t2" />);
    await waitFor(() => expect(screen.getByTestId("chat").textContent).toMatch(/^ready:[1-9]/));
    expect(screen.getByTestId("next").textContent).toBe(screen.getByTestId("chat").textContent);
  });
});


describe("shared queue invalidation", () => {
  it("review rejection, reversal, and failed review reads reach both mounted views", async () => {
    const view = render(<Tree late />);
    await waitFor(() => expect(screen.getByTestId("chat").textContent).toBe("ready:1:1"));
    h.reviews = { a: "dismissed" };
    view.rerender(<Tree late />);
    expect(screen.getByTestId("chat").textContent).toBe("ready:0:0");
    expect(screen.getByTestId("next").textContent).toBe("ready:0:0");
    h.reviews = {};
    view.rerender(<Tree late />);
    expect(screen.getByTestId("next").textContent).toBe("ready:1:1");
    h.availability = "unavailable";
    view.rerender(<Tree late />);
    expect(screen.getByTestId("chat").textContent).toBe("error:0:0");
    expect(screen.getByTestId("next").textContent).toBe("error:0:0");
  });

  it("case reconciliation refreshes missed tool rows without remounting", async () => {
    const view = render(<Tree late />);
    await waitFor(() => expect(screen.getByTestId("chat").textContent).toBe("ready:1:1"));
    h.queried = true;
    view.rerender(<Tree late version={2} />);
    await waitFor(() => expect(screen.getByTestId("chat").textContent).toBe("ready:0:0"));
    expect(screen.getByTestId("next").textContent).toBe("ready:0:0");
  });

  it("skip changes and clearing report recommendations cannot leave a stale consumer", async () => {
    render(<Tree late />);
    await waitFor(() => expect(screen.getByTestId("chat").textContent).toBe("ready:1:1"));
    act(() => {
      localStorage.setItem(pivotSkipStorageKey("t1"), JSON.stringify([normalizeTarget("fresh@example.test")]));
      window.dispatchEvent(new CustomEvent("swarmbot:pivot-skip-changed", { detail: { threadId: "t1" } }));
    });
    expect(screen.getByTestId("chat").textContent).toBe("ready:0:0");
    const pivots: RecommendedPivot[] = [{ label: "Review", actionLabel: "Review email", detail: "Report candidate", reason: "Report", priority: "medium", prompt: "Investigate other@example.test", value: "other@example.test", type: "email" }];
    act(() => window.dispatchEvent(new CustomEvent("swarmbot:report-pivots", { detail: { threadId: "t1", pivots } })));
    expect(screen.getByTestId("chat").textContent).toBe("ready:1:1");
    act(() => window.dispatchEvent(new CustomEvent("swarmbot:report-pivots", { detail: { threadId: "unrelated", pivots: [] } })));
    expect(screen.getByTestId("next").textContent).toBe("ready:1:1");
    act(() => window.dispatchEvent(new CustomEvent("swarmbot:report-pivots", { detail: { threadId: "t1", pivots: [] } })));
    expect(screen.getByTestId("chat").textContent).toBe("ready:0:0");
    expect(screen.getByTestId("next").textContent).toBe("ready:0:0");
  });
});

describe("tool history request ordering", () => {
  it("an old response cannot resurrect a queried target after a newer response", async () => {
    h.delay = true;
    const { result } = renderHook(() => useThreadQueriedTargetState("t1"));
    expect(result.current.status).toBe("loading");
    act(() => { void result.current.refresh(); });
    expect(h.pending).toHaveLength(2);
    await act(async () => h.pending[1]({ data: [{ input_json: { runtime: { selector: "fresh@example.test" } } }], error: null }));
    expect(result.current.status).toBe("ready");
    await act(async () => h.pending[0]({ data: [], error: null }));
    expect([...result.current.targets]).toEqual([normalizeTarget("fresh@example.test")]);
  });

  it("a disconnected channel invalidates pending reads and reconnect recovers", async () => {
    h.delay = true;
    const { result } = renderHook(() => useThreadQueriedTargetState("t1"));
    act(() => h.subscribed?.("CHANNEL_ERROR"));
    await act(async () => h.pending[0]({ data: [], error: null }));
    expect(result.current.status).toBe("error");
    act(() => h.subscribed?.("SUBSCRIBED"));
    expect(result.current.status).toBe("loading");
    await act(async () => h.pending[1]({ data: [], error: null }));
    expect(result.current.status).toBe("ready");
  });

  it("late responses from the previous case cannot populate the new case", async () => {
    h.delay = true;
    const { result, rerender } = renderHook(({ id }) => useThreadQueriedTargetState(id), { initialProps: { id: "t1" } });
    const oldChannel = h.subscribed;
    const oldRowEvent = h.callback;
    rerender({ id: "t2" });
    await act(async () => h.pending[1]({ data: [], error: null }));
    await act(async () => h.pending[0]({ data: [{ input_json: { runtime: { selector: "old@example.test" } } }], error: null }));
    expect(result.current.status).toBe("ready");
    act(() => { oldChannel?.("CLOSED"); oldRowEvent?.(); });
    expect(h.pending).toHaveLength(2);
    expect(result.current.status).toBe("ready");
    expect([...result.current.targets]).toEqual([]);
  });
});
