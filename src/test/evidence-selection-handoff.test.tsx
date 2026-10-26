import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceUIStateProvider } from "@/components/workspace/WorkspaceUIStateProvider";
import {
  useOptionalWorkspaceUIState,
  useWorkspaceUIState,
} from "@/hooks/useWorkspaceUIState";

/**
 * Evidence row click publishes to the shared Workspace UI state.
 *
 * The real wiring in ResourcesPanel.tsx wraps `setSelected` with a
 * `handleSelect` that calls `ui.select(id)` and `ui.rememberOpener(elId)`.
 * This test asserts the public contract that handoff relies on: setting a
 * selection in one subtree surfaces it in a sibling subtree that reads the
 * same provider — the Workbench and the Evidence lenses are siblings under
 * ChatPage, so this is the exact shape of the live handoff.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.innerHTML = "";
});

function EvidenceSibling() {
  const ui = useWorkspaceUIState();
  return (
    <button
      id="evidence-row-art-X"
      onClick={() => {
        ui.rememberOpener("evidence-row-art-X");
        ui.select("art-X");
      }}
    >
      Row art-X
    </button>
  );
}

function WorkbenchSibling() {
  const ui = useWorkspaceUIState();
  return (
    <div data-testid="workbench">
      {ui.selectedArtifactId
        ? <span>Workbench showing {ui.selectedArtifactId}</span>
        : <span>Workbench summary</span>}
    </div>
  );
}

describe("Evidence selection handoff", () => {
  it("clicking an Evidence row updates the sibling Workbench via the shared provider", () => {
    render(
      <WorkspaceUIStateProvider>
        <EvidenceSibling />
        <WorkbenchSibling />
      </WorkspaceUIStateProvider>,
    );

    expect(screen.getByText("Workbench summary")).toBeTruthy();

    fireEvent.click(screen.getByText("Row art-X"));

    expect(screen.getByText("Workbench showing art-X")).toBeTruthy();
    expect(screen.queryByText("Workbench summary")).toBeNull();
  });

  it("the opener element id is remembered on click (for Close focus restoration)", async () => {
    // Readback test: use a Spy harness that exposes the current remembered
    // opener. We can't read it from the public API without a probe, so the
    // behavioural check is: Close returns focus to the row.
    function Spy() {
      const ui = useWorkspaceUIState();
      return (
        <>
          <EvidenceSibling />
          {ui.selectedArtifactId && (
            <button aria-label="Close inspector" onClick={() => ui.clear()}>
              close
            </button>
          )}
        </>
      );
    }

    render(
      <WorkspaceUIStateProvider>
        <Spy />
      </WorkspaceUIStateProvider>,
    );

    fireEvent.click(screen.getByText("Row art-X"));
    fireEvent.click(screen.getByLabelText("Close inspector"));

    // Microtask flush for the deferred focus restoration.
    await new Promise((r) => queueMicrotask(() => r(null)));

    expect(document.activeElement?.id).toBe("evidence-row-art-X");
  });

  it("standalone render without the provider is a no-op — ResourcesPanel still works", () => {
    // Simulates the standalone path: ResourcesPanel uses useOptionalWorkspaceUIState,
    // which returns null outside the provider; the row click still invokes its
    // local setSelected (the drawer path), and the ui side-effect simply does
    // nothing. The invariant: no throw.
    function StandaloneRow() {
      const ui = useOptionalWorkspaceUIState();
      return (
        <button
          onClick={() => {
            if (ui) {
              ui.rememberOpener("evidence-row-y");
              ui.select("y");
            }
            // else: fall through to local-only behaviour, as the real
            // ResourcesPanel does.
          }}
        >
          Row y
        </button>
      );
    }

    expect(() => render(<StandaloneRow />)).not.toThrow();
    fireEvent.click(screen.getByText("Row y"));
    // Still here — no throw.
    expect(screen.getByText("Row y")).toBeTruthy();
  });
});
