import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  WorkspaceUIStateProvider,
  useWorkspaceUIState,
  useOptionalWorkspaceUIState,
} from "@/components/workspace/WorkspaceUIStateProvider";

/**
 * Unit tests for the per-thread workspace UI state. The invariants under
 * test here are the ones the Workbench and the Evidence row selection depend
 * on structurally — if any of them regress, the inspector would show a stale
 * artifact, lose a note draft, or leave focus stranded.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <WorkspaceUIStateProvider>{children}</WorkspaceUIStateProvider>
);

afterEach(() => {
  document.body.innerHTML = "";
});

describe("WorkspaceUIStateProvider", () => {
  it("select publishes an artifactId; clear nulls it", () => {
    const { result } = renderHook(() => useWorkspaceUIState(), { wrapper });

    expect(result.current.selectedArtifactId).toBeNull();

    act(() => result.current.select("art-1"));
    expect(result.current.selectedArtifactId).toBe("art-1");

    act(() => result.current.clear());
    expect(result.current.selectedArtifactId).toBeNull();
  });

  it("drafts are keyed by artifactId; one artifact's draft never leaks into another", () => {
    const { result } = renderHook(() => useWorkspaceUIState(), { wrapper });

    act(() => result.current.setDraft("art-A", "note for A"));
    act(() => result.current.setDraft("art-B", "note for B"));

    expect(result.current.getDraft("art-A")).toBe("note for A");
    expect(result.current.getDraft("art-B")).toBe("note for B");
    expect(result.current.getDraft("art-C")).toBe("");
  });

  it("setDraft('') clears the entry so the store does not grow forever", () => {
    const { result } = renderHook(() => useWorkspaceUIState(), { wrapper });

    act(() => result.current.setDraft("art-A", "something"));
    expect(result.current.getDraft("art-A")).toBe("something");

    act(() => result.current.setDraft("art-A", ""));
    expect(result.current.getDraft("art-A")).toBe("");
  });

  it("clearDraft removes exactly one artifact's draft", () => {
    const { result } = renderHook(() => useWorkspaceUIState(), { wrapper });

    act(() => result.current.setDraft("art-A", "x"));
    act(() => result.current.setDraft("art-B", "y"));
    act(() => result.current.clearDraft("art-A"));

    expect(result.current.getDraft("art-A")).toBe("");
    expect(result.current.getDraft("art-B")).toBe("y");
  });

  it("clear() restores focus to the remembered opener element", async () => {
    // Mount a dummy opener in the DOM so document.getElementById can find it.
    const opener = document.createElement("button");
    opener.id = "evidence-row-xyz";
    opener.textContent = "opener";
    document.body.appendChild(opener);

    const { result } = renderHook(() => useWorkspaceUIState(), { wrapper });

    act(() => {
      result.current.rememberOpener("evidence-row-xyz");
      result.current.select("xyz");
    });

    act(() => result.current.clear());

    // queueMicrotask is used to defer focus one tick past the state flush;
    // flush that queue by awaiting a resolved promise.
    await act(async () => { await Promise.resolve(); });

    expect(document.activeElement).toBe(opener);
  });

  it("clear() with no remembered opener is a no-op for focus", async () => {
    const { result } = renderHook(() => useWorkspaceUIState(), { wrapper });

    act(() => result.current.select("xyz"));
    act(() => result.current.clear());

    await act(async () => { await Promise.resolve(); });

    // Should NOT throw and should NOT move focus to anything specific.
    expect(result.current.selectedArtifactId).toBeNull();
  });

  it("useWorkspaceUIState throws when rendered outside the provider", () => {
    // Suppress React's error boundary noise in the test output.
    const err = console.error;
    console.error = () => {};
    try {
      expect(() => renderHook(() => useWorkspaceUIState())).toThrow(/inside <WorkspaceUIStateProvider>/);
    } finally {
      console.error = err;
    }
  });

  it("useOptionalWorkspaceUIState returns null outside the provider", () => {
    const { result } = renderHook(() => useOptionalWorkspaceUIState());
    expect(result.current).toBeNull();
  });

  it("a textarea bound to the draft survives unmount+remount in the same provider", async () => {
    // Simulates the Workbench tab-switch pattern: the inspector unmounts and
    // remounts, but the provider stays. The draft must still be there.
    function Inspector({ id }: { id: string }) {
      const ui = useWorkspaceUIState();
      return (
        <textarea
          data-testid="draft"
          value={ui.getDraft(id)}
          onChange={(e) => ui.setDraft(id, e.target.value)}
        />
      );
    }
    function Harness() {
      const ui = useWorkspaceUIState();
      return (
        <>
          <button onClick={() => ui.select("art-1")}>select</button>
          <button onClick={() => ui.clear()}>clear</button>
          {ui.selectedArtifactId && <Inspector id={ui.selectedArtifactId} />}
        </>
      );
    }

    render(
      <WorkspaceUIStateProvider>
        <Harness />
      </WorkspaceUIStateProvider>,
    );

    fireEvent.click(screen.getByText("select"));
    const draft = screen.getByTestId("draft") as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "hello" } });
    expect(draft.value).toBe("hello");

    // Unmount the inspector.
    fireEvent.click(screen.getByText("clear"));
    expect(screen.queryByTestId("draft")).toBeNull();

    // Remount — draft text should be restored from the provider.
    fireEvent.click(screen.getByText("select"));
    const draft2 = screen.getByTestId("draft") as HTMLTextAreaElement;
    expect(draft2.value).toBe("hello");
  });
});
