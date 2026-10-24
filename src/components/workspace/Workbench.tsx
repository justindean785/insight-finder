import { useRef, useState, type KeyboardEvent } from "react";
import { CaseSheet } from "@/components/workspace/CaseSheet";
import { WorkbenchConnections } from "@/components/workspace/WorkbenchConnections";
import { WorkbenchNext } from "@/components/workspace/WorkbenchNext";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { cn } from "@/lib/utils";

/**
 * The right-hand column of the case desk, as a small workbench: the case sheet (default, unchanged), the ranked next
 * pivots, and the connections of one entity. Nothing here is a new authority or a new path to a run: Next is the
 * compact Next-steps list (same engine, validation, Preview before every Run, no bulk queue) and Connections reads the Graph's
 * own model and pivots through the Evidence drawer's Preview-gated action.
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
            {t.key === "sheet" && <CaseSheet threadId={threadId} />}
            {t.key === "next" && <WorkbenchNext threadId={threadId} />}
            {t.key === "connections" && <WorkbenchConnections threadId={threadId} />}
          </ErrorBoundary>
        </div>
      ))}
    </div>
  );
}
