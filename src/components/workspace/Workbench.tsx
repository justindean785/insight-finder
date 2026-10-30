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
import { ClipboardList, Network, Sparkles, type LucideIcon } from "lucide-react";
import { DecisionChip } from "@/components/workspace/WorkspaceTabs";
import { tabButtonClass, tabIconClass } from "@/components/workspace/tab-recipe";
import { useCaseSheetModel } from "@/hooks/useCaseSheetModel";
import { buildWorkspaceTabCounts } from "@/lib/workspace-tab-counts";

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
const TABS: ReadonlyArray<{ key: WorkbenchTab; label: string; icon: LucideIcon }> = [
  { key: "sheet", label: "Sheet", icon: ClipboardList },
  { key: "next", label: "Next", icon: Sparkles },
  { key: "connections", label: "Connections", icon: Network },
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
  // The Sheet's open calls, from the SAME selector as the Evidence tab's badge
  // and the sheet's "Needs your call" (`queueTotal`), so the figure cannot differ.
  const { model, hydrated } = useCaseSheetModel(threadId);
  const sheetCalls = buildWorkspaceTabCounts(0, hydrated ? model.queueTotal : null).evidence;

  const ui = useOptionalWorkspaceUIState();
  const selectedArtifactId = ui?.selectedArtifactId ?? null;
  const clear = ui?.clear ?? (() => {});
  // Auto-switch to Sheet when a selection appears, so Evidence row click
  // doesn't leave the detail hiding behind the Next or Connections tab.
  // Preserve the user's tab choice when selection returns to null.
  useEffect(() => {
    if (selectedArtifactId) select("sheet");
  }, [selectedArtifactId]);

  // The transcript's compact "Open Next pivots" affordance dispatches this
  // event so the single actionable queue on the right-hand Workbench gets the
  // focus without duplicating Run buttons in the chat. See ChatWindow.tsx and
  // register item 1 ("single Next-steps queue").
  useEffect(() => {
    const onJump = (e: Event) => {
      const detail = (e as CustomEvent<{ tab?: WorkbenchTab }>).detail;
      const target = detail?.tab;
      if (target === "sheet" || target === "next" || target === "connections") {
        select(target);
        // Hand keyboard focus to the newly-selected tab button so the next
        // ArrowLeft/ArrowRight keystroke lands in the right place.
        queueMicrotask(() => refs.current[target]?.focus());
      }
    };
    window.addEventListener("swarmbot:workbench-tab", onJump as EventListener);
    return () => window.removeEventListener("swarmbot:workbench-tab", onJump as EventListener);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col" data-workbench>
      {/* Right padding leaves room for the sheet's own fold button. */}
      <div role="tablist" aria-label="Workbench" className="flex shrink-0 items-stretch gap-1 border-b border-white/[0.07] bg-surface-0 pl-2 pr-12">
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
            className={tabButtonClass(tab === t.key, "secondary")}
          >
            <t.icon className={tabIconClass(tab === t.key)} strokeWidth={1.8} aria-hidden />
            <span className="leading-none">{t.label}</span>
            {t.key === "sheet" && sheetCalls.kind === "decision" && <DecisionChip count={sheetCalls} compact />}
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
