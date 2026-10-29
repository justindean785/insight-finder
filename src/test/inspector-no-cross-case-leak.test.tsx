import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceUIStateProvider } from "@/components/workspace/WorkspaceUIStateProvider";
import { useWorkspaceUIState } from "@/hooks/useWorkspaceUIState";

/**
 * Cross-case isolation.
 *
 * `WorkspaceUIStateProvider` mounts INSIDE `CaseSnapshotProvider`, which is
 * keyed by `threadId` in `ChatPage`. The `key={threadId}` boundary unmounts
 * the whole subtree on case switch, so selection and drafts for case A can
 * never surface in case B — not because any code clears them, but because
 * the state itself ceases to exist.
 *
 * This test reproduces the key boundary by remounting the provider with a
 * new key. If a future refactor hoists state above the key, this test fails
 * and the invariant is defended by regression rather than custom.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

afterEach(() => {
  document.body.innerHTML = "";
});

function Probe({ onReady }: { onReady: (api: ReturnType<typeof useWorkspaceUIState>) => void }) {
  const api = useWorkspaceUIState();
  // Expose current snapshot to the test on first render.
  onReady(api);
  return (
    <div>
      <span data-testid="selected">{api.selectedArtifactId ?? ""}</span>
      <span data-testid="draft">{api.getDraft("art-1")}</span>
    </div>
  );
}

describe("cross-case isolation — key={threadId} unmount clears UI state", () => {
  it("remounting the provider with a new key drops selection and drafts entirely", () => {
    let apiRef: ReturnType<typeof useWorkspaceUIState> | null = null;
    const capture = (api: ReturnType<typeof useWorkspaceUIState>) => {
      apiRef = api;
    };

    const { rerender } = render(
      <WorkspaceUIStateProvider key="thread-A">
        <Probe onReady={capture} />
      </WorkspaceUIStateProvider>,
    );

    // Populate case A's selection and draft.
    act(() => {
      apiRef!.select("art-1");
      apiRef!.setDraft("art-1", "case A thinking");
    });
    expect(screen.getByTestId("selected").textContent).toBe("art-1");
    expect(screen.getByTestId("draft").textContent).toBe("case A thinking");

    // Switch cases: a new key unmounts the subtree, state should be gone.
    rerender(
      <WorkspaceUIStateProvider key="thread-B">
        <Probe onReady={capture} />
      </WorkspaceUIStateProvider>,
    );

    expect(screen.getByTestId("selected").textContent).toBe("");
    expect(screen.getByTestId("draft").textContent).toBe("");
  });

  it("the same key keeps state across re-renders (control case — mounting is key-driven)", () => {
    let apiRef: ReturnType<typeof useWorkspaceUIState> | null = null;
    const capture = (api: ReturnType<typeof useWorkspaceUIState>) => {
      apiRef = api;
    };

    const { rerender } = render(
      <WorkspaceUIStateProvider key="thread-A">
        <Probe onReady={capture} />
      </WorkspaceUIStateProvider>,
    );

    act(() => {
      apiRef!.select("art-7");
      apiRef!.setDraft("art-1", "kept");
    });
    expect(screen.getByTestId("selected").textContent).toBe("art-7");

    // Re-render WITHOUT changing the key — state must survive.
    rerender(
      <WorkspaceUIStateProvider key="thread-A">
        <Probe onReady={capture} />
      </WorkspaceUIStateProvider>,
    );

    expect(screen.getByTestId("selected").textContent).toBe("art-7");
    expect(screen.getByTestId("draft").textContent).toBe("kept");
  });
});
