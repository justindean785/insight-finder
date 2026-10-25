import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArtifactInspector } from "@/components/workspace/ArtifactInspector";
import { CaseSheet } from "@/components/workspace/CaseSheet";
import { WorkbenchConnections } from "@/components/workspace/WorkbenchConnections";
import { WorkbenchNext } from "@/components/workspace/WorkbenchNext";
import { useOptionalWorkspaceUIState, useWorkspaceUIState } from "@/hooks/useWorkspaceUIState";
import { useCaseSnapshot } from "@/hooks/useCaseSnapshot";
import { useThreadArtifacts } from "@/hooks/useThreadArtifacts";
import { useReviewStates } from "@/lib/review";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { cn } from "@/lib/utils";

/**
 * The right-hand column of the case desk, as a small workbench: the case sheet
 * (default), the ranked next pivots, and the connections of one entity.
 * Nothing here is a new authority or a new path to a run.
 *
 * The Sheet tab is dual-mode. When nothing is selected, it shows the
 * case-level summary (subject, evidence distribution, "Needs your call"
 * queue). When an Evidence row is selected via the shared
 * {@link WorkspaceUIStateProvider}, the same tab becomes a selected-finding
 * inspector — exactly ONE right-hand surface, never two.
 *
 * A selection also auto-switches the Workbench to the Sheet tab, so a click
 * in Evidence surfaces its detail without a second tab click.
 */
export type WorkbenchTab = "sheet" | "next" | "connections";
const TABS: ReadonlyArray<{ key: WorkbenchTab; label: string }> = [
  { key: "sheet", label: "Sheet" },
  { key: "next", label: "Next" },
  { key: "connections", label: "Connections" },
];

export function Workbench({ threadId }: { threadId: string }) {
  const [tab, setTab] = useState<WorkbenchTab>("sheet");
  // Panels stay mounted once visited, so a half-read list, an open Preview and a selection survive a tab switch.
  const [visited, setVisited] = useState<ReadonlySet<WorkbenchTab>>(() => new Set<WorkbenchTab>(["sheet"]));
  const refs = useRef<Record<string, HTMLButtonElement | null>>({});

  const select = (key: WorkbenchTab) => {
    setTab(key);
    setVisited((prev) => (prev.has(key) ? prev : new Set(prev).add(key)));
  };
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const next = e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : (i + step + TABS.length) % TABS.length;
    select(TABS[next].key);
    refs.current[TABS[next].key]?.focus();
  };

  // Optional: standalone renders (CaseViewPage read-only, tests) have no
  // provider — the Workbench then degrades to its pre-change single-mode
  // behaviour (CaseSheet only, no selection path), which is exactly what
  // those callers used to get.
  const ui = useOptionalWorkspaceUIState();
  const selectedArtifactId = ui?.selectedArtifactId ?? null;
  const clear = ui?.clear ?? (() => {});
  // Auto-switch to Sheet when a selection appears, so Evidence row click
  // doesn't leave the detail hiding behind the Next or Connections tab.
  // Preserve the user's tab choice when selection returns to null.
  useEffect(() => {
    if (selectedArtifactId) select("sheet");
  }, [selectedArtifactId]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-workbench>
      {/* Right padding leaves room for the sheet's own fold button. */}
      <div role="tablist" aria-label="Workbench" className="flex shrink-0 items-center gap-1 border-b border-border-subtle py-2 pl-3 pr-12">
        {TABS.map((t, i) => (
          <button
            key={t.key}
            ref={(el) => { refs.current[t.key] = el; }}
            role="tab"
            id={`workbench-tab-${t.key}`}
            aria-selected={tab === t.key}
            aria-controls={`workbench-panel-${t.key}`}
            tabIndex={tab === t.key ? 0 : -1}
            onClick={() => select(t.key)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "inline-flex h-8 items-center rounded-md px-2.5 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11",
              tab === t.key ? "bg-surface-3 text-foreground" : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {TABS.map((t) => visited.has(t.key) && (
        <div
          key={t.key}
          role="tabpanel"
          id={`workbench-panel-${t.key}`}
          aria-labelledby={`workbench-tab-${t.key}`}
          hidden={tab !== t.key}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <ErrorBoundary>
            {t.key === "sheet" && (
              selectedArtifactId
                ? <SheetInspectorHost threadId={threadId} selectedArtifactId={selectedArtifactId} onClose={clear} />
                : <CaseSheet threadId={threadId} />
            )}
            {t.key === "next" && <WorkbenchNext threadId={threadId} />}
            {t.key === "connections" && <WorkbenchConnections threadId={threadId} />}
          </ErrorBoundary>
        </div>
      ))}
    </div>
  );
}

/**
 * Resolves the selected id to a live artifact from the case snapshot. If the
 * row has disappeared (deleted, cross-case stale), it clears the selection
 * and renders the case summary — never a stale row.
 *
 * `useCaseSnapshot()` is the one place every surface reads from, so the
 * inspector cannot show counts from a different read than the Evidence tab.
 */
function SheetInspectorHost({
  threadId,
  selectedArtifactId,
  onClose,
}: {
  threadId: string;
  selectedArtifactId: string;
  onClose: () => void;
}) {
  const { snapshot } = useCaseSnapshot();
  const artifacts = snapshot?.items ?? [];
  const artifact = artifacts.find((a) => a.id === selectedArtifactId) ?? null;
  const review = useReviewStates(threadId);
  const { updateLocal } = useThreadArtifacts(threadId);
  const { clear } = useWorkspaceUIState();

  // If the id no longer resolves (deleted / cross-case stale), clear and
  // render the case summary. Do NOT render a placeholder artifact.
  useEffect(() => {
    if (snapshot?.hydrated && !artifact) clear();
  }, [snapshot?.hydrated, artifact, clear]);

  if (!artifact) return <CaseSheet threadId={threadId} />;

  return (
    <ArtifactInspector
      artifact={artifact}
      onClose={onClose}
      onChanged={(a) => updateLocal(a)}
      reviewGet={review.get}
      reviewSet={review.set}
      threadId={threadId}
      allArtifacts={artifacts}
    />
  );
}
