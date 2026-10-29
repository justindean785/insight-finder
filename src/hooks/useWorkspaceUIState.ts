import { createContext, useContext } from "react";

/**
 * The shape of the thread-scoped workspace UI state and the hooks that read
 * it. The provider lives in `WorkspaceUIStateProvider.tsx`; the context +
 * hooks live here so that file can export the component alone and keep its
 * Fast-Refresh contract clean.
 *
 * See `WorkspaceUIStateProvider` for the lifetime and clearing rules.
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

export const WorkspaceUIStateContext = createContext<WorkspaceUIState | null>(null);

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
