import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceUIStateProvider } from "@/components/workspace/WorkspaceUIStateProvider";
import { useWorkspaceUIState } from "@/hooks/useWorkspaceUIState";

/**
 * The save-flow invariant for note drafts.
 *
 * The in-flight draft is a WIP buffer in the provider; the durable save goes
 * through `review.setNote` (persisted). After a save, the shared draft MUST
 * be cleared, otherwise the next keystroke on the same artifact appears to
 * mutate against stale text — the analyst thinks they are editing a saved
 * note when they are actually editing a dead draft that masks any later load.
 *
 * This test proves the provider's own contract (clearDraft returns to "")
 * and that a subsequent new keystroke is honoured, not masked.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <WorkspaceUIStateProvider>{children}</WorkspaceUIStateProvider>
);

afterEach(() => {
  document.body.innerHTML = "";
});

describe("inspector save flow — the draft never masks the next edit", () => {
  it("clearDraft returns getDraft to \"\", and a new setDraft is honoured immediately", () => {
    const { result } = renderHook(() => useWorkspaceUIState(), { wrapper });

    act(() => result.current.setDraft("art-1", "half-written note"));
    expect(result.current.getDraft("art-1")).toBe("half-written note");

    // Simulate a successful save: the inspector calls clearDraft after review.setNote resolves.
    act(() => result.current.clearDraft("art-1"));
    expect(result.current.getDraft("art-1")).toBe("");

    // The next keystroke must not be rejected or masked by a stale draft slot.
    act(() => result.current.setDraft("art-1", "fresh thought"));
    expect(result.current.getDraft("art-1")).toBe("fresh thought");
  });

  it("after clearDraft, two unrelated artifacts' drafts stay independent", () => {
    const { result } = renderHook(() => useWorkspaceUIState(), { wrapper });

    act(() => {
      result.current.setDraft("art-1", "A note");
      result.current.setDraft("art-2", "B note");
    });
    act(() => result.current.clearDraft("art-1"));

    expect(result.current.getDraft("art-1")).toBe("");
    expect(result.current.getDraft("art-2")).toBe("B note");

    // And a new draft on art-1 does not accidentally touch art-2.
    act(() => result.current.setDraft("art-1", "A again"));
    expect(result.current.getDraft("art-2")).toBe("B note");
  });

  it("a UI that reads getDraft re-renders when the draft changes (not stuck on empty)", () => {
    function Reader({ id }: { id: string }) {
      const ui = useWorkspaceUIState();
      return (
        <div>
          <span data-testid="draft">{ui.getDraft(id)}</span>
          <button type="button" onClick={() => ui.setDraft(id, "typed")}>type</button>
          <button type="button" onClick={() => ui.clearDraft(id)}>save</button>
        </div>
      );
    }

    render(
      <WorkspaceUIStateProvider>
        <Reader id="art-x" />
      </WorkspaceUIStateProvider>,
    );

    expect(screen.getByTestId("draft").textContent).toBe("");
    fireEvent.click(screen.getByText("type"));
    expect(screen.getByTestId("draft").textContent).toBe("typed");
    fireEvent.click(screen.getByText("save"));
    expect(screen.getByTestId("draft").textContent).toBe("");
  });
});
