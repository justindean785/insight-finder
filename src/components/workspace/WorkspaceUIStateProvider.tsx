import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import {
  WorkspaceUIStateContext,
  type WorkspaceUIState,
} from "@/hooks/useWorkspaceUIState";

/**
 * Thread-scoped UI state for the workspace. The ONE place that holds
 * "which artifact is selected" and "what is the analyst half-way through
 * typing" — selection and in-flight note drafts.
 *
 * Mounts as an immediate child of `CaseSnapshotProvider`, which is keyed
 * by `threadId` ({@link ChatPage}). That `key={threadId}` boundary unmounts
 * this provider on every case switch, which is how cross-case leaks are
 * prevented without any explicit clearing logic here. The invariant to
 * preserve: a note drafted in case A must never surface in case B.
 *
 * Nothing is persisted to localStorage. Drafts are a WIP buffer; saved
 * notes go through `useReviewStates.setNote` (durable, server-backed).
 * Selection is a session-only pointer; a reload is a fresh view.
 *
 * The hooks and the context live in `@/hooks/useWorkspaceUIState` so this
 * file exports a component only — Fast-Refresh requires that.
 */

export function WorkspaceUIStateProvider({ children }: { children: ReactNode }) {
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null);
  // Draft text is kept in a plain state object keyed by artifactId so that
  // every change re-renders consumers (a `Map` in a `useRef` would not).
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // Opener id lives in a ref: it is only read when `clear()` runs and must
  // not trigger a render when set.
  const openerRef = useRef<string | null>(null);

  const select = useCallback((artifactId: string) => {
    setSelectedArtifactId(artifactId);
  }, []);

  const clear = useCallback(() => {
    setSelectedArtifactId(null);
    const openerId = openerRef.current;
    if (openerId) {
      // Defer focus restoration one tick so React has flushed the inspector
      // teardown — focus()-ing a node that is about to disappear in the same
      // microtask drops the focus back to <body>.
      queueMicrotask(() => {
        const el = typeof document !== "undefined" ? document.getElementById(openerId) : null;
        if (el instanceof HTMLElement) el.focus();
      });
    }
  }, []);

  const getDraft = useCallback(
    (artifactId: string): string => drafts[artifactId] ?? "",
    [drafts],
  );

  const setDraft = useCallback((artifactId: string, text: string) => {
    setDrafts((prev) => {
      if ((prev[artifactId] ?? "") === text) return prev;
      // Empty string clears the entry so the object does not grow forever
      // across a long session with many touched artifacts.
      if (text === "") {
        if (!(artifactId in prev)) return prev;
        const { [artifactId]: _, ...rest } = prev;
        return rest;
      }
      return { ...prev, [artifactId]: text };
    });
  }, []);

  const clearDraft = useCallback((artifactId: string) => {
    setDrafts((prev) => {
      if (!(artifactId in prev)) return prev;
      const { [artifactId]: _, ...rest } = prev;
      return rest;
    });
  }, []);

  const rememberOpener = useCallback((elementId: string | null) => {
    openerRef.current = elementId;
  }, []);

  const api = useMemo<WorkspaceUIState>(
    () => ({
      selectedArtifactId,
      select,
      clear,
      getDraft,
      setDraft,
      clearDraft,
      rememberOpener,
    }),
    [selectedArtifactId, select, clear, getDraft, setDraft, clearDraft, rememberOpener],
  );

  return (
    <WorkspaceUIStateContext.Provider value={api}>
      {children}
    </WorkspaceUIStateContext.Provider>
  );
}
