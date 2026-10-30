// workbench.test.tsx — the right-hand Workbench: Sheet (default) / Next / Connections.
// Synthetic fixtures only. The Supabase client is a stub that answers every read with an empty page.
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { buildEntityGraph } from "@/lib/entity-graph";
import { connectionsView, linksOf } from "@/lib/workbench-connections";
import { publishSelectedEntity, readSelectedEntity } from "@/lib/workbench-selection";
import { registerPivotRunner } from "@/lib/pivot-runner";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("@/integrations/supabase/client", () => {
  const empty = { data: [], error: null, count: 0 };
  const chain: unknown = new Proxy(function () {}, {
    get: (_t, prop) => (prop === "then" ? (res: (v: unknown) => void) => res(empty) : chain),
    apply: () => chain,
  });
  return { supabase: { from: () => chain, channel: () => chain, removeChannel: () => Promise.resolve(), auth: { getUser: async () => ({ data: { user: { id: "u1" } }, error: null }), getSession: async () => ({ data: { session: null }, error: null }) } } };
});

const harness = vi.hoisted(() => ({ availability: null as null | "unknown" | "unavailable", queriedMounts: 0 }));
vi.mock("@/lib/review", async (orig) => {
  const actual = await orig<typeof import("@/lib/review")>();
  return {
    ...actual,
    useReviewStates: (threadId: string) => {
      const real = actual.useReviewStates(threadId);
      return harness.availability ? { ...real, availability: harness.availability } : real;
    },
  };
});
vi.mock("@/hooks/useThreadQueriedTargets", async () => {
  const React = await import("react");
  const stable = new Set<string>();
  const noCalls: never[] = [];
  return {
    useThreadQueriedTargets: () => {
      React.useEffect(() => { harness.queriedMounts += 1; return () => { harness.queriedMounts -= 1; }; }, []);
      return stable;
    },
    useThreadQueriedCalls: () => noCalls,
    queriedTargetSet: () => stable,
  };
});

import { CaseSnapshotContext, type CaseSnapshotApi } from "@/hooks/useCaseSnapshot";
import { Workbench } from "@/components/workspace/Workbench";

const T = "t-workbench";
let n = 0;
const art = (kind: string, value: string, metadata: Record<string, unknown> | null = null, confidence = 60): Artifact => {
  n += 1;
  return { id: `a${n}`, kind, value, confidence, source: "fixture", created_at: `2026-01-01T00:00:${String(n).padStart(2, "0")}Z`, metadata };
};

function snapshotWith(items: Artifact[], seed = "seed@example.test"): CaseSnapshotApi {
  return {
    refresh: async () => {},
    snapshot: {
      hydrated: true, items, seed: { value: seed, type: "email" }, spend: { microUsd: 0 },
      authority: { verified: 0, infrastructure: 0, probable: 0, review: items.length, weak: 0, quarantined: 0, conflict: 0, failed: 0 },
    } as never,
  };
}
const renderWorkbench = (items: Artifact[]) =>
  render(
    <CaseSnapshotContext.Provider value={snapshotWith(items)}>
      <Workbench threadId={T} />
    </CaseSnapshotContext.Provider>,
  );

let unregister: () => void;
beforeEach(() => { n = 0; harness.availability = null; harness.queriedMounts = 0; sessionStorage.clear(); unregister = registerPivotRunner(T); });
afterEach(() => { cleanup(); unregister(); });

describe("connections model", () => {
  const arts = [
    art("email", "mail@example.test", { handle: "shared_one" }),
    art("username", "shared_one"),
    art("phone", "925-813-9324"),
    art("email", "seed@example.test"), // the seed's own record
  ];
  const g = buildEntityGraph(arts, "seed@example.test", "email");

  it("links are real relationships only, strongest first, never the seed-discovery provenance edge", () => {
    const links = linksOf(g, arts[0].id);
    expect(links).toHaveLength(1);
    expect(links[0].other.id).toBe(arts[1].id);
    expect(links[0].edge.type).not.toBe("seed-discovery");
    expect(linksOf(g, arts[2].id)).toEqual([]); // an isolated lead has none
    expect(linksOf(g, arts[3].id)).toEqual([]); // nor does the seed's own record
  });

  it("the view counts leads and seed records on the Graph's own definitions", () => {
    const v = connectionsView(g);
    expect(v.linked.map((x) => x.node.id).sort()).toEqual([arts[0].id, arts[1].id].sort());
    expect(v.isolated.map((x) => x.id)).toEqual([arts[2].id]);
    expect(v.isolatedLeads).toBe(g.stats.isolatedCount);
    expect(v.seedRecords).toBe(1);
    expect(v.realLinks).toBe(g.stats.realEdgeCount);
  });
});

describe("selection hand-off from the Graph", () => {
  it("is stored per thread and announced; storage failure does not throw", () => {
    const heard = vi.fn();
    window.addEventListener("swarmbot:select-entity", heard);
    publishSelectedEntity(T, "x1");
    expect(readSelectedEntity(T)).toBe("x1");
    expect(readSelectedEntity("other")).toBeNull();
    expect(heard).toHaveBeenCalledTimes(1);
    window.removeEventListener("swarmbot:select-entity", heard);
    vi.stubGlobal("sessionStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => {} });
    expect(readSelectedEntity(T)).toBeNull();
    expect(() => publishSelectedEntity(T, "x2")).not.toThrow();
    vi.unstubAllGlobals();
  });
});

describe("Workbench tabs", () => {
  it("opens on the existing case sheet; Next and Connections are not mounted until visited", async () => {
    renderWorkbench([art("email", "a@example.test")]);
    expect(screen.getByRole("tab", { name: "Sheet" }).getAttribute("aria-selected")).toBe("true");
    expect(await screen.findByRole("region", { name: "Subject" })).toBeTruthy();
    expect(document.querySelector("[data-workbench-connections]")).toBeNull();
    expect(document.getElementById("workbench-panel-next")).toBeNull();
  });

  it("switches by click and by arrow keys, keeps visited panels mounted, one tabpanel visible at a time", () => {
    renderWorkbench([art("email", "a@example.test")]);
    fireEvent.click(screen.getByRole("tab", { name: "Connections" }));
    expect(document.querySelector("[data-workbench-connections]")).toBeTruthy();
    expect((document.getElementById("workbench-panel-sheet") as HTMLElement).hidden).toBe(true);
    const connections = screen.getByRole("tab", { name: "Connections" });
    fireEvent.keyDown(connections, { key: "ArrowLeft" });
    expect(screen.getByRole("tab", { name: "Next" }).getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(screen.getByRole("tab", { name: "Next" }), { key: "Home" });
    expect(screen.getByRole("tab", { name: "Sheet" }).getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector("[data-workbench-connections]")).toBeTruthy(); // still mounted, just hidden
    expect(screen.getAllByRole("tabpanel", { hidden: false }).length).toBe(1);
  });

  it("Next is the compact Next-steps list: best pivot, a Preview before any Run, nothing dispatched by viewing", () => {
    const ran = vi.fn();
    window.addEventListener("proximity:run-pivot", ran);
    renderWorkbench([art("username", "lone_handle"), art("email", "a@example.test")]);
    fireEvent.click(screen.getByRole("tab", { name: "Next" }));
    const panel = document.getElementById("workbench-panel-next") as HTMLElement;
    expect(within(panel).getByTestId("best-pivot")).toBeTruthy();
    expect(within(panel).getAllByRole("button", { name: /Preview|Run now|Review and run/ }).length).toBeGreaterThan(0);
    expect(ran).not.toHaveBeenCalled();
    fireEvent.click(within(panel).getByRole("button", { name: /^Review and run: / }));
    expect(ran).not.toHaveBeenCalled(); // opening the Preview starts nothing
    fireEvent.click(within(panel).getByRole("button", { name: "Start this pivot" }));
    expect(ran).toHaveBeenCalledTimes(1);
    window.removeEventListener("proximity:run-pivot", ran);
  });

  it("Next lists a bogus report suggestion under repair, with no Run for it", () => {
    renderWorkbench([art("email", "a@example.test")]);
    fireEvent.click(screen.getByRole("tab", { name: "Next" }));
    act(() => {
      window.dispatchEvent(new CustomEvent("swarmbot:report-pivots", { detail: { threadId: T, pivots: [{
        label: "Link username to real name", actionLabel: "Verify username linkage", detail: "to", reason: "Search public profiles for corroboration",
        priority: "medium", prompt: "x", value: "to", type: "username", ungrounded: true,
      }] } }));
    });
    const panel = document.getElementById("workbench-panel-next") as HTMLElement;
    expect(within(panel).getByRole("button", { name: /couldn't be turned into/ })).toBeTruthy();
    expect(within(panel).queryByRole("button", { name: /on to$/ })).toBeNull();
  });
});

describe("Connections tab", () => {
  const linkedCase = () => [
    art("email", "mail@example.test", { handle: "shared_one" }),
    art("username", "shared_one"),
  ];

  it("shows the selected entity's real links and a Preview-gated pivot on the neighbour; Start dispatches exactly once", () => {
    const items = linkedCase();
    renderWorkbench(items);
    fireEvent.click(screen.getByRole("tab", { name: "Connections" }));
    act(() => { publishSelectedEntity(T, items[0].id); });
    const selected = screen.getByRole("region", { name: "Selected entity" });
    expect(within(selected).getByText("Shared selector")).toBeTruthy();
    expect(within(selected).getByRole("button", { name: /shared_one/ })).toBeTruthy();

    const ran = vi.fn();
    window.addEventListener("proximity:run-pivot", ran);
    const pivotButtons = within(selected).getAllByRole("button", { name: "Pivot on this" });
    fireEvent.click(pivotButtons[pivotButtons.length - 1]); // the neighbour's
    expect(ran).not.toHaveBeenCalled(); // opening a Preview never runs anything
    fireEvent.click(screen.getByRole("button", { name: "Start this pivot" }));
    expect(ran).toHaveBeenCalledTimes(1);
    expect((ran.mock.calls[0][0] as CustomEvent).detail.threadId).toBe(T);
    window.removeEventListener("proximity:run-pivot", ran);
  });

  it("clicking a neighbour selects it, so the analyst walks the graph without leaving the column", () => {
    const items = linkedCase();
    renderWorkbench(items);
    fireEvent.click(screen.getByRole("tab", { name: "Connections" }));
    act(() => { publishSelectedEntity(T, items[0].id); });
    fireEvent.click(within(screen.getByRole("region", { name: "Selected entity" })).getByRole("button", { name: /shared_one/ }));
    expect(screen.getByRole("region", { name: "Selected entity" }).textContent).toMatch(/shared_one/);
  });

  it("a case with no links says so, and still lets the analyst pivot from an isolated lead", () => {
    const items = [art("username", "lone_handle"), art("phone", "925-813-9324")];
    renderWorkbench(items);
    fireEvent.click(screen.getByRole("tab", { name: "Connections" }));
    expect(screen.getByText(/No relationships between distinct entities established/)).toBeTruthy();
    const leads = screen.getByRole("region", { name: "Unlinked candidates" });
    fireEvent.click(within(leads).getByRole("button", { name: /lone_handle/ }));
    const selected = screen.getByRole("region", { name: "Selected entity" });
    expect(within(selected).getByText(/No relationship to another entity has been established/)).toBeTruthy();
    expect(within(selected).getByRole("button", { name: "Pivot on this" })).toBeTruthy();
  });

  it("a zero-hit lookup is disclosed as a clean check, not listed or counted as an unlinked candidate", () => {
    const zero = { ...art("breach_exposure", "NO STEALER LOG HITS", { serus_darkweb_result: "0 hits, 0 breaches, 0 pastes" }), source: "oathnet_stealer_search" };
    renderWorkbench([art("username", "lone_handle"), zero]);
    fireEvent.click(screen.getByRole("tab", { name: "Connections" }));
    const summary = screen.getByRole("region", { name: "Connection summary" });
    expect(summary.textContent).toMatch(/1 unlinked candidate(?!s)/);
    expect(summary.querySelector("[data-clean-checks]")?.textContent).toMatch(/^1 clean check \(coverage, not candidates\)/);
    const leads = screen.getByRole("region", { name: "Unlinked candidates" });
    expect(within(leads).queryByRole("button", { name: /NO STEALER LOG HITS/ })).toBeNull();
    expect(within(leads).getByRole("button", { name: /lone_handle/ })).toBeTruthy();
  });

  it("the seed's own record has no pivot of its own and says why", () => {
    const items = [art("email", "seed@example.test")];
    renderWorkbench(items);
    fireEvent.click(screen.getByRole("tab", { name: "Connections" }));
    act(() => { publishSelectedEntity(T, items[0].id); });
    const selected = screen.getByRole("region", { name: "Selected entity" });
    expect(within(selected).getByText(/only repeats the seed/)).toBeTruthy();
    expect(within(selected).queryByRole("button", { name: "Pivot on this" })).toBeNull();
  });
});

describe("review verdicts gate the Workbench (Codex P2 on #869)", () => {
  it("while verdicts are still being read, neither panel interprets them as 'new'", () => {
    harness.availability = "unknown";
    renderWorkbench([art("username", "lone_handle")]);
    fireEvent.click(screen.getByRole("tab", { name: "Connections" }));
    expect(document.querySelector("[data-workbench-connections]")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Next" }));
    expect(document.querySelector("[data-workbench-next]")).toBeNull();
  });

  it("when the verdicts could not be loaded both panels withhold their results and say why", () => {
    harness.availability = "unavailable";
    renderWorkbench([art("username", "lone_handle")]);
    fireEvent.click(screen.getByRole("tab", { name: "Connections" }));
    expect(screen.getByText(/review decisions couldn't be loaded, so connections are withheld/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Pivot on this" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Next" }));
    expect(screen.getByText(/so pivots are withheld/)).toBeTruthy();
    expect(screen.queryByTestId("best-pivot")).toBeNull();
  });
});

describe("neighbour pivots share one thread-log read (Codex P2 on #869)", () => {
  it("an entity with several neighbours mounts ONE queried-targets reader, not one per pivot button", () => {
    const hub = art("username", "hub_handle", null, 90);
    const items = [
      hub,
      art("email", "one@example.test", { handle: "hub_handle" }),
      art("email", "two@example.test", { handle: "hub_handle" }),
      art("email", "three@example.test", { handle: "hub_handle" }),
    ];
    renderWorkbench(items);
    fireEvent.click(screen.getByRole("tab", { name: "Connections" }));
    act(() => { publishSelectedEntity(T, hub.id); });
    const selected = screen.getByRole("region", { name: "Selected entity" });
    expect(within(selected).getAllByRole("button", { name: "Pivot on this" }).length).toBeGreaterThanOrEqual(4);
    expect(harness.queriedMounts).toBe(1);
  });
});
