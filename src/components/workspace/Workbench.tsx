import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { ArtifactInspector } from "@/components/workspace/ArtifactInspector";
import { CaseSheet } from "@/components/workspace/CaseSheet";
import { WorkbenchConnections } from "@/components/workspace/WorkbenchConnections";
import { WorkbenchNext } from "@/components/workspace/WorkbenchNext";
import { useOptionalWorkspaceUIState, useWorkspaceUIState } from "@/hooks/useWorkspaceUIState";
import { useCaseSnapshot } from "@/hooks/useCaseSnapshot";
import { useThreadArtifacts } from "@/hooks/useThreadArtifacts";
import { useReviewStates } from "@/lib/review";
import { useWorkbenchPivots } from "@/hooks/useWorkbenchPivots";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { ClipboardList, Network, Sparkles, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { DecisionChip } from "@/components/workspace/WorkspaceTabs";
import { tabButtonClass, tabIconClass } from "@/components/workspace/tab-recipe";
import { useCaseSheetModel } from "@/hooks/useCaseSheetModel";
import { buildWorkspaceTabCounts } from "@/lib/workspace-tab-counts";
import { normalizeWorkbenchTab, type WorkbenchTab } from "@/lib/workbench-tab";

/**
 * The right-hand column of the case desk — JD's prototype's ONE inspector
 * (R3, 2026-11-02), with three tabs:
 *
 *  - **Finding**: the selected artifact's assessment (ArtifactInspector); with
 *    nothing selected, the case sheet (subject, evidence distribution, the
 *    "Needs your call" queue). A selection in Evidence or the Graph switches
 *    here, so a click surfaces its detail without a second tab click. Exactly
 *    one detail surface, never two.
 *  - **Next pivots**: the ranked queue from `useWorkbenchPivots`, every Run
 *    behind its Preview. The tab carries the runnable count.
 *  - **Connections**: the selected entity's relationships, from the same graph
 *    the Graph tab draws; "Open graph" reaches the 4th workspace tab.
 *
 * The old Live / Sheet / Next keys are still accepted on the
 * `swarmbot:workbench-tab` event and the `request` prop (ChatWindow's "Open Next
 * pivots" sends `next`), so no caller had to change on the same day.
 * Nothing here is a new authority or a new path to a run.
 */
export type { WorkbenchTab };
const TABS: ReadonlyArray<{ key: WorkbenchTab; label: string; icon: LucideIcon }> = [
  { key: "finding", label: "Finding", icon: ClipboardList },
  { key: "pivots", label: "Next pivots", icon: Sparkles },
  { key: "connections", label: "Connections", icon: Network },
];

export function Workbench({ threadId, request = null, onRequestConsumed }: {
  threadId: string;
  /** A tab (and optionally a pivot to open) requested while the rail was folded, so
   *  the request is not lost to a Workbench that was not mounted yet. */
  request?: { tab: WorkbenchTab | string; open?: string; n: number } | null;
  /** Called once the request is applied, so a later remount does not replay it. */
  onRequestConsumed?: () => void;
}) {
  const initial = normalizeWorkbenchTab(request?.tab) ?? "finding";
  const [tab, setTab] = useState<WorkbenchTab>(initial);
  // Panels stay mounted once visited, so a half-read list, an open Preview and a selection survive a tab switch.
  const [visited, setVisited] = useState<ReadonlySet<WorkbenchTab>>(() => new Set<WorkbenchTab>([initial]));
  const [openRequest, setOpenRequest] = useState<{ key: string; n: number } | null>(
    request?.open ? { key: request.open, n: request.n } : null,
  );
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

  // The Finding tab's open calls, from the SAME selector as the Evidence tab's badge
  // and the sheet's "Needs your call" (`queueTotal`), so the figure cannot differ.
  const { model, hydrated } = useCaseSheetModel(threadId);
  const sheetCalls = buildWorkspaceTabCounts(0, hydrated ? model.queueTotal : null).evidence;

  // One pivot queue for the tab badge and the panel: the hook is called once here
  // and handed down, so the number on the tab and the list behind it are the same version.
  const pivots = useWorkbenchPivots(threadId);
  const runnable = useMemo(
    () => pivots.items.filter((it) => it.kind === "pivot" && it.validation.status === "valid").length,
    [pivots.items],
  );
  const pivotsReady = Boolean(pivots.snapshot?.hydrated) && pivots.review.availability === "ok";

  // Optional: standalone renders (CaseViewPage read-only, tests) have no
  // provider — the Workbench then degrades to the case sheet with no selection path.
  const ui = useOptionalWorkspaceUIState();
  const selectedArtifactId = ui?.selectedArtifactId ?? null;
  const clear = ui?.clear ?? (() => {});
  // A selection surfaces its detail: switch to Finding. The analyst's tab choice is kept when selection returns to null.
  useEffect(() => {
    if (selectedArtifactId) select("finding");
  }, [selectedArtifactId]);

  useEffect(() => {
    if (!request) return;
    const target = normalizeWorkbenchTab(request.tab);
    if (target) select(target);
    if (request.open) setOpenRequest({ key: request.open, n: request.n });
    // One-shot: the owner clears it, so returning to this tab later (a remount with a
    // selected Evidence row) does not jump back to Next pivots and hide the inspector.
    onRequestConsumed?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request]);

  // The transcript's compact "Open Next pivots" affordance dispatches this
  // event so the single actionable queue on the right-hand Workbench gets the
  // focus without duplicating Run buttons in the chat. See ChatWindow.tsx.
  useEffect(() => {
    const onJump = (e: Event) => {
      const detail = (e as CustomEvent<{ tab?: string; open?: string }>).detail;
      const target = normalizeWorkbenchTab(detail?.tab);
      if (!target) return;
      select(target);
      if (target === "pivots" && typeof detail?.open === "string") setOpenRequest({ key: detail.open, n: Date.now() });
      // Hand keyboard focus to the newly-selected tab button so the next
      // ArrowLeft/ArrowRight keystroke lands in the right place.
      queueMicrotask(() => refs.current[target]?.focus());
    };
    window.addEventListener("swarmbot:workbench-tab", onJump as EventListener);
    return () => window.removeEventListener("swarmbot:workbench-tab", onJump as EventListener);
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col" data-workbench>
      {/* 58px tab row (prototype `.panel-tabs`). Right padding leaves room for the sheet's own fold button. */}
      <div role="tablist" aria-label="Workbench" className="flex h-[52px] shrink-0 items-stretch gap-4 border-b border-border-subtle bg-surface-0 pl-5 pr-12">
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
            className={cn(tabButtonClass(tab === t.key, "secondary"), "h-full px-0.5")}
          >
            <t.icon className={cn(tabIconClass(tab === t.key), "hidden 2xl:block")} strokeWidth={1.8} aria-hidden />
            <span className="leading-none">{t.label}</span>
            {t.key === "finding" && sheetCalls.kind === "decision" && <DecisionChip count={sheetCalls} compact />}
            {t.key === "pivots" && pivotsReady && runnable > 0 && (
              <span className="ml-1 rounded-[3px] bg-[hsl(var(--brand)/0.14)] px-1 py-px font-mono text-[11px] leading-none text-[hsl(var(--brand))]" aria-label={`${runnable} runnable`}>{runnable}</span>
            )}
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
            {t.key === "finding" && (
              selectedArtifactId
                ? <FindingHost threadId={threadId} selectedArtifactId={selectedArtifactId} onClose={clear} />
                : <CaseSheet threadId={threadId} />
            )}
            {t.key === "pivots" && <WorkbenchNext threadId={threadId} openRequest={openRequest} pivots={pivots} />}
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
function FindingHost({
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
