import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceUIStateProvider } from "@/components/workspace/WorkspaceUIStateProvider";
import {
  useWorkspaceUIState,
} from "@/hooks/useWorkspaceUIState";

/**
 * Reproduce + verify PR #872's "notes lost on resize / selection change" regression.
 *
 * In #872 the drawer's note draft lived in a local useState(review.getNote(id)).
 * On any subtree swap (viewport flip across 1280px / xl, selection change, Workbench
 * tab switch) the drawer remounted and the draft reset to the saved note, so
 * every half-finished reasoning was dropped.
 *
 * The fix hoists the draft to WorkspaceUIStateProvider keyed by artifactId.
 * These tests drive the provider through a textarea harness that behaves the
 * same way as the real ArtifactInspector's Note field.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.innerHTML = "";
});

function Harness({ wrapperKey }: { wrapperKey?: number }) {
  const ui = useWorkspaceUIState();
  return (
    <div key={wrapperKey}>
      <button onClick={() => ui.select("art-A")}>Select A</button>
      <button onClick={() => ui.select("art-B")}>Select B</button>
      <button onClick={() => ui.clear()}>Clear</button>
      {ui.selectedArtifactId && (
        <textarea
          data-testid="draft"
          value={ui.getDraft(ui.selectedArtifactId)}
          onChange={(e) => ui.setDraft(ui.selectedArtifactId!, e.target.value)}
        />
      )}
    </div>
  );
}

describe("Inspector note draft — survives subtree swaps", () => {
  it("draft survives switching to another artifact and back", () => {
    render(
      <WorkspaceUIStateProvider>
        <Harness />
      </WorkspaceUIStateProvider>,
    );

    fireEvent.click(screen.getByText("Select A"));
    fireEvent.change(screen.getByTestId("draft"), { target: { value: "note for A" } });

    fireEvent.click(screen.getByText("Select B"));
    const draftB = screen.getByTestId("draft") as HTMLTextAreaElement;
    expect(draftB.value).toBe(""); // B has no draft yet
    fireEvent.change(draftB, { target: { value: "note for B" } });

    // Back to A — original draft must still be there.
    fireEvent.click(screen.getByText("Select A"));
    const draftA = screen.getByTestId("draft") as HTMLTextAreaElement;
    expect(draftA.value).toBe("note for A");

    // And B still has its draft when we switch back.
    fireEvent.click(screen.getByText("Select B"));
    expect((screen.getByTestId("draft") as HTMLTextAreaElement).value).toBe("note for B");
  });

  it("draft survives inspector unmount+remount (Workbench tab switch pattern)", () => {
    render(
      <WorkspaceUIStateProvider>
        <Harness />
      </WorkspaceUIStateProvider>,
    );

    fireEvent.click(screen.getByText("Select A"));
    fireEvent.change(screen.getByTestId("draft"), { target: { value: "half-finished reasoning" } });

    // Switch Workbench to another tab (clear hides the inspector), then back.
    fireEvent.click(screen.getByText("Clear"));
    expect(screen.queryByTestId("draft")).toBeNull();

    fireEvent.click(screen.getByText("Select A"));
    expect((screen.getByTestId("draft") as HTMLTextAreaElement).value).toBe("half-finished reasoning");
  });

  it("draft survives a viewport resize across the 1280px (xl) breakpoint (subtree remount under same provider)", () => {
    // Simulate a resize: parent re-renders with a different `key`, forcing the
    // inner Harness to remount. The provider stays put, so drafts survive.
    function App({ bp }: { bp: "sm" | "lg" }) {
      return <Harness wrapperKey={bp === "sm" ? 1 : 2} />;
    }

    const { rerender } = render(
      <WorkspaceUIStateProvider>
        <App bp="sm" />
      </WorkspaceUIStateProvider>,
    );

    fireEvent.click(screen.getByText("Select A"));
    fireEvent.change(screen.getByTestId("draft"), { target: { value: "across breakpoint" } });

    rerender(
      <WorkspaceUIStateProvider>
        <App bp="lg" />
      </WorkspaceUIStateProvider>,
    );

    // After the subtree remount, the selection is still art-A and the draft
    // text is still there — because both live in the (unchanged) provider.
    fireEvent.click(screen.getByText("Select A"));
    expect((screen.getByTestId("draft") as HTMLTextAreaElement).value).toBe("across breakpoint");
  });
});
