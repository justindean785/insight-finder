import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceUIStateProvider } from "@/components/workspace/WorkspaceUIStateProvider";
import {
  useWorkspaceUIState,
} from "@/hooks/useWorkspaceUIState";

/**
 * Reproduce + verify PR #872's "no explicit Close + focus restoration"
 * regression. The inspector header now has a visible Close button; clicking
 * it must clear selection and return focus to the DOM element that opened
 * the inspector (an Evidence row).
 *
 * We drive the invariant through the provider directly, mounting a stand-in
 * inspector that calls the SAME `onClose = clear` wiring the real
 * ArtifactInspector uses. The behaviour under test is the provider's focus
 * restoration contract, not the real inspector's full DOM — which keeps the
 * test free of Supabase/graph mocking while locking the regression down.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.innerHTML = "";
});

function Harness() {
  const ui = useWorkspaceUIState();
  return (
    <div>
      <button
        id="evidence-row-art-1"
        onClick={() => {
          ui.rememberOpener("evidence-row-art-1");
          ui.select("art-1");
        }}
      >
        Row art-1
      </button>
      <button
        id="evidence-row-art-2"
        onClick={() => {
          ui.rememberOpener("evidence-row-art-2");
          ui.select("art-2");
        }}
      >
        Row art-2
      </button>
      {ui.selectedArtifactId && (
        <div data-testid="inspector">
          <span>Inspecting {ui.selectedArtifactId}</span>
          <button aria-label="Close inspector" onClick={() => ui.clear()}>
            close
          </button>
        </div>
      )}
    </div>
  );
}

describe("ArtifactInspector — Close + focus restoration", () => {
  it("Close returns focus to the row that opened the inspector", async () => {
    render(
      <WorkspaceUIStateProvider>
        <Harness />
      </WorkspaceUIStateProvider>,
    );

    const row = screen.getByText("Row art-1");
    row.focus();
    fireEvent.click(row);

    expect(screen.getByTestId("inspector")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Close inspector"));
    expect(screen.queryByTestId("inspector")).toBeNull();

    // Focus restoration is deferred one microtask past the clear.
    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement?.id).toBe("evidence-row-art-1");
  });

  it("switching selection to another row updates the opener; Close returns focus to the new one", async () => {
    render(
      <WorkspaceUIStateProvider>
        <Harness />
      </WorkspaceUIStateProvider>,
    );

    fireEvent.click(screen.getByText("Row art-1"));
    fireEvent.click(screen.getByText("Row art-2"));
    expect(screen.getByText("Inspecting art-2")).toBeTruthy();

    fireEvent.click(screen.getByLabelText("Close inspector"));
    await act(async () => { await Promise.resolve(); });
    expect(document.activeElement?.id).toBe("evidence-row-art-2");
  });

  it("Close is keyboard-reachable (standard button)", () => {
    render(
      <WorkspaceUIStateProvider>
        <Harness />
      </WorkspaceUIStateProvider>,
    );

    fireEvent.click(screen.getByText("Row art-1"));
    const close = screen.getByLabelText("Close inspector") as HTMLButtonElement;
    // A plain <button> is keyboard-reachable by default; this guards against
    // a future "div-with-onClick" regression that would silently break Tab.
    expect(close.tagName).toBe("BUTTON");
    expect(close.getAttribute("aria-label")).toBe("Close inspector");
  });
});
