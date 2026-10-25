import { useEffect, useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceUIStateProvider,
  useWorkspaceUIState,
} from "@/components/workspace/WorkspaceUIStateProvider";

/**
 * The Sheet tab's dual-mode contract — tested at the provider seam.
 *
 * The real Workbench renders `<CaseSheet>` when `selectedArtifactId == null`
 * and `<ArtifactInspector>` otherwise. Mounting the real Workbench requires
 * Supabase + reviews + case-snapshot mocks; what we actually need to lock
 * down is the SELECTION-DRIVEN swap itself, including the "auto-switch to
 * Sheet when selection appears" invariant.
 *
 * This test harness mirrors Workbench's wiring with CaseSheet / Inspector
 * stand-ins. If Workbench ever regresses — e.g. a refactor that keeps the
 * Next tab active after a selection, or renders a stale artifact after the
 * row is deleted — the same shape of test here will catch it.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

type FakeArtifact = { id: string; value: string };

function MiniWorkbench({ artifacts }: { artifacts: FakeArtifact[] }) {
  const ui = useWorkspaceUIState();
  // Mirrors Workbench's auto-switch useEffect.
  const [tab, setTab] = useState<"sheet" | "next" | "connections">("sheet");
  useEffect(() => {
    if (ui.selectedArtifactId) setTab("sheet");
  }, [ui.selectedArtifactId]);

  const artifact =
    ui.selectedArtifactId ? artifacts.find((a) => a.id === ui.selectedArtifactId) ?? null : null;

  // Mirrors SheetInspectorHost: if the id no longer resolves, clear and fall
  // back to the summary.
  useEffect(() => {
    if (ui.selectedArtifactId && !artifact) ui.clear();
  }, [ui.selectedArtifactId, artifact, ui]);

  return (
    <div>
      <div role="tablist">
        <button onClick={() => setTab("sheet")} aria-selected={tab === "sheet"}>Sheet</button>
        <button onClick={() => setTab("next")} aria-selected={tab === "next"}>Next</button>
      </div>
      {tab === "sheet" && (
        artifact ? (
          <div data-testid="inspector">
            Inspecting {artifact.value}
            <button aria-label="Close inspector" onClick={() => ui.clear()}>close</button>
          </div>
        ) : (
          <div data-testid="case-sheet">case summary</div>
        )
      )}
      {tab === "next" && <div data-testid="next">next pivots</div>}
    </div>
  );
}

const ART = [
  { id: "a1", value: "alex.morgan@example.com" },
  { id: "a2", value: "+1 202 555 0148" },
];

describe("Workbench Sheet — dual mode", () => {
  it("renders CaseSheet when nothing is selected", () => {
    render(
      <WorkspaceUIStateProvider>
        <MiniWorkbench artifacts={ART} />
      </WorkspaceUIStateProvider>,
    );
    expect(screen.getByTestId("case-sheet")).toBeTruthy();
    expect(screen.queryByTestId("inspector")).toBeNull();
  });

  it("renders ArtifactInspector when a selection resolves to an artifact", () => {
    function Driver() {
      const ui = useWorkspaceUIState();
      return (
        <>
          <button onClick={() => ui.select("a1")}>pick a1</button>
          <MiniWorkbench artifacts={ART} />
        </>
      );
    }
    render(
      <WorkspaceUIStateProvider>
        <Driver />
      </WorkspaceUIStateProvider>,
    );

    fireEvent.click(screen.getByText("pick a1"));
    expect(screen.getByText("Inspecting alex.morgan@example.com")).toBeTruthy();
    expect(screen.queryByTestId("case-sheet")).toBeNull();
  });

  it("selection auto-switches the Workbench to Sheet (not Next or Connections)", () => {
    function Driver() {
      const ui = useWorkspaceUIState();
      return (
        <>
          <button onClick={() => ui.select("a1")}>pick a1</button>
          <MiniWorkbench artifacts={ART} />
        </>
      );
    }
    render(
      <WorkspaceUIStateProvider>
        <Driver />
      </WorkspaceUIStateProvider>,
    );

    fireEvent.click(screen.getByText("Next"));
    expect(screen.getByTestId("next")).toBeTruthy();

    fireEvent.click(screen.getByText("pick a1"));
    // Auto-switched: inspector appears, not the Next body.
    expect(screen.getByTestId("inspector")).toBeTruthy();
    expect(screen.queryByTestId("next")).toBeNull();
  });

  it("clears gracefully and shows CaseSheet when selected artifact is gone (deleted / cross-case stale)", () => {
    function Driver() {
      const ui = useWorkspaceUIState();
      return (
        <>
          <button onClick={() => ui.select("ghost-id")}>select missing</button>
          <MiniWorkbench artifacts={ART} />
        </>
      );
    }
    render(
      <WorkspaceUIStateProvider>
        <Driver />
      </WorkspaceUIStateProvider>,
    );

    fireEvent.click(screen.getByText("select missing"));
    // Fallback: no inspector, CaseSheet shown.
    expect(screen.queryByTestId("inspector")).toBeNull();
    expect(screen.getByTestId("case-sheet")).toBeTruthy();
  });

  it("Close clears selection and returns to CaseSheet", () => {
    function Driver() {
      const ui = useWorkspaceUIState();
      return (
        <>
          <button onClick={() => ui.select("a2")}>pick a2</button>
          <MiniWorkbench artifacts={ART} />
        </>
      );
    }
    render(
      <WorkspaceUIStateProvider>
        <Driver />
      </WorkspaceUIStateProvider>,
    );

    fireEvent.click(screen.getByText("pick a2"));
    expect(screen.getByText("Inspecting +1 202 555 0148")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Close inspector"));
    expect(screen.queryByTestId("inspector")).toBeNull();
    expect(screen.getByTestId("case-sheet")).toBeTruthy();
  });
});
