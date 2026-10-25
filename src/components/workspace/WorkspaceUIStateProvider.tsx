import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

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
 */

export interface WorkspaceUIState {
  /** The currently inspected artifact, or `null` when the Sheet shows the
   *  case summary. Setting this to a non-null value asks the Workbench to
   *  surface the inspector; setting it to `null` returns to the case summary. */
  readonly selectedArtifactId: string | null;
  /** Open the inspector on this artifact. */
  select: (artifactId: string) => void;
  /** Close the inspector and return to the case summary. Also calls
   *  `.focus()` on the previously-remembered opener element, if any. */
  clear: () => void;
  /** Note draft text for an artifact. Returns `""` when no draft exists. */
  getDraft: (artifactId: string) => string;
  /** Update the in-flight note draft for an artifact. Empty string clears it. */
  setDraft: (artifactId: string, text: string) => void;
  /** Drop one draft (after it has been saved durably). */
  clearDraft: (artifactId: string) => void;
  /** Record the DOM element id of the control that opened the inspector,
   *  so Close can restore focus to it. */
  rememberOpener: (elementId: string | null) => void;
}

const WorkspaceUIStateContext = createContext<WorkspaceUIState | null>(null);

/** The thread-scoped workspace UI state. Must be rendered inside
 *  `WorkspaceUIStateProvider`. */
export function useWorkspaceUIState(): WorkspaceUIState {
  const api = useContext(WorkspaceUIStateContext);
  if (!api) {
    throw new Error("useWorkspaceUIState must be used inside <WorkspaceUIStateProvider>");
  }
  return api;
}

/** Same as `useWorkspaceUIState`, but returns `null` when no provider is
 *  mounted — for components that also render standalone (tests, read-only
 *  surfaces). A caller that gets `null` must not rely on shared selection. */
export function useOptionalWorkspaceUIState(): WorkspaceUIState | null {
  return useContext(WorkspaceUIStateContext);
}

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
