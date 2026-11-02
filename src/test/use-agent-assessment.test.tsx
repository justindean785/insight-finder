import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { Artifact } from "@/hooks/useThreadArtifacts";

/**
 * R3: the hook behind the Finding panel. Its one piece of state is the
 * per-thread baseline — the assessment as it stood when the latest run started
 * — which is what "+12 linkage since the previous assessment" is measured
 * against. Before a run has been observed there is no baseline and every delta
 * is null; the panel then says why confidence "is limited", never a change.
 */

const SEED = "j.harker@northgate-logistics.com";
const T = "t-assess";
const art = (over: Partial<Artifact> & { id: string; kind: string; value: string }): Artifact => ({
  confidence: 60, source: "exa_search", created_at: "2026-10-20T09:51:00Z", metadata: {}, ...over,
});
const seedRow = art({ id: "seed", kind: "email", value: SEED, confidence: 88 });
const loosePhone = art({ id: "phone", kind: "phone", value: "+1 415 555 0142", confidence: 55 });
const joiner = art({ id: "rec", kind: "person", value: "James Harker", metadata: { email: SEED, phone: "+1 415 555 0142" } });

const state = vi.hoisted(() => ({
  items: [] as Artifact[],
  running: false,
  reviews: {} as Record<string, string>,
}));
vi.mock("@/hooks/useCaseSnapshot", () => {
  const api = () => ({
    refresh: async () => {},
    snapshot: { hydrated: true, items: state.items, seed: { value: SEED, type: "email", caseTitle: null }, run: { state: state.running ? "running" : "completed" } },
  });
  return { useCaseSnapshot: api, useOptionalCaseSnapshot: api };
});
vi.mock("@/lib/review", () => ({
  useReviewStates: () => ({ map: state.reviews, availability: "ok", get: (id: string) => state.reviews[id] ?? "new" }),
}));

const { useAgentAssessment } = await import("@/hooks/useAgentAssessment");

beforeEach(() => { localStorage.clear(); state.items = [seedRow, loosePhone]; state.running = false; state.reviews = {}; });
afterEach(() => { localStorage.clear(); });

describe("useAgentAssessment", () => {
  it("assesses the case and reports null deltas while no baseline exists", () => {
    const { result } = renderHook(() => useAgentAssessment(T));
    expect(result.current.hasBaseline).toBe(false);
    expect(result.current.get("seed")?.subjectLinkage).toBe(100);
    expect(result.current.get("phone")?.subjectLinkage).toBeNull();
    expect(result.current.delta("seed")).toEqual({ linkage: null, support: null, from: null, to: "supported" });
  });

  it("a run starting stores the baseline; the next reading is compared against it", () => {
    const { result, rerender } = renderHook(() => useAgentAssessment(T));
    act(() => { state.running = true; });
    rerender();
    expect(result.current.hasBaseline).toBe(true);
    // The run links the phone through a record that carries both selectors.
    act(() => { state.items = [seedRow, loosePhone, joiner]; state.running = false; });
    rerender();
    const d = result.current.delta("phone")!;
    expect(d.from).toBe("unresolved");
    expect(result.current.get("phone")?.subjectLinkage).not.toBeNull();
    // Unresolved → a figure is a null delta, never a fabricated "+N".
    expect(d.linkage).toBeNull();
    expect(result.current.delta("seed")?.linkage).toBe(0);
    // A row the run added has no baseline of its own.
    expect(result.current.delta("rec")).toEqual({ linkage: null, support: null, from: null, to: result.current.get("rec")!.group });
  });

  it("the baseline survives a remount through localStorage and is per thread", () => {
    const first = renderHook(() => useAgentAssessment(T));
    act(() => { state.running = true; });
    first.rerender();
    first.unmount();
    state.running = false;
    const again = renderHook(() => useAgentAssessment(T));
    expect(again.result.current.hasBaseline).toBe(true);
    const other = renderHook(() => useAgentAssessment("t-other"));
    expect(other.result.current.hasBaseline).toBe(false);
  });

  it("a baseline is written once per run start, not on every render while running", () => {
    const { rerender } = renderHook(() => useAgentAssessment(T));
    act(() => { state.running = true; });
    rerender();
    const stored = localStorage.getItem(`swarmbot:assessment-baseline:${T}`);
    act(() => { state.items = [seedRow, loosePhone, joiner]; });
    rerender();
    expect(localStorage.getItem(`swarmbot:assessment-baseline:${T}`)).toBe(stored);
  });
});
