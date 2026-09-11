import { createContext, useContext } from "react";
import type { CaseChange, CaseSnapshotCore } from "@/lib/case-snapshot";

/**
 * A published version of the case.
 *
 * Every surface that prints a case figure — header, tab badges, Overview,
 * Tools, Report — reads it from ONE of these, so on any given render they are
 * all reading the same `version`. The provider freezes publication while a
 * reconcile is in flight and publishes the result in one go, which is what
 * "atomic" means here: a status flip and the counts that go with it land on
 * screen in the same frame, never a status from one read beside counts from
 * another.
 */
export interface CaseSnapshot extends CaseSnapshotCore {
  /** Monotonic within a mount. Bumps once per published change. */
  version: number;
  /** Epoch ms this version was published. */
  capturedAt: number;
  /** A reconcile is in flight; the figures shown are the last published version. */
  syncing: boolean;
  /** Epoch ms of the last completed full read of every source. */
  syncedAt: number | null;
  /** The last reconcile failed. The figures shown are the last good version. */
  syncError: boolean;
  /** What moved in the most recent update after hydration, for the "Case updated" notice. */
  lastChange: { changes: CaseChange[]; at: number } | null;
}

export interface CaseSnapshotApi {
  /** Null until the first version is published. Never a placeholder of zeros. */
  snapshot: CaseSnapshot | null;
  /** Re-read every source and publish once. Never starts an investigation. */
  refresh: () => Promise<void>;
}

export const CaseSnapshotContext = createContext<CaseSnapshotApi | null>(null);

/** The case snapshot. Must be rendered inside `CaseSnapshotProvider`. */
export function useCaseSnapshot(): CaseSnapshotApi {
  const api = useContext(CaseSnapshotContext);
  if (!api) throw new Error("useCaseSnapshot must be used inside <CaseSnapshotProvider>");
  return api;
}

/**
 * The case snapshot when a provider is mounted, otherwise null — for components
 * that also render standalone (tests, the read-only case view before it adopts
 * the provider). A caller that gets null must fall back to its own reads and
 * must not mix the two.
 */
export function useOptionalCaseSnapshot(): CaseSnapshotApi | null {
  return useContext(CaseSnapshotContext);
}
