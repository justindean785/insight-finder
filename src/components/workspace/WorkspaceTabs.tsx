import { useRef } from "react";
import { MessagesSquare, Database, FileText, Share2, Activity, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type WorkspaceTab = "chat" | "evidence" | "report" | "graph" | "tools";

const TABS: { key: WorkspaceTab; label: string; icon: LucideIcon }[] = [
  { key: "chat", label: "Chat", icon: MessagesSquare },
  { key: "evidence", label: "Evidence", icon: Database },
  { key: "tools", label: "Tools", icon: Activity },
  { key: "graph", label: "Graph", icon: Share2 },
  { key: "report", label: "Report", icon: FileText },
];

/**
 * Primary workspace navigation — the five major investigation modes. These are
 * top-level app sections (not nested panel tabs): a single active mode fills the
 * main workspace. Active state is unmistakable (lit label + accent underline);
 * the bar scrolls horizontally on narrow viewports rather than wrapping.
 */
export function WorkspaceTabs({
  active,
  onChange,
  counts,
}: {
  active: WorkspaceTab;
  onChange: (t: WorkspaceTab) => void;
  counts?: Partial<Record<WorkspaceTab, { value: number; tone?: "default" | "danger" }>>;
}) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Roving arrow-key navigation across the tab bar (WAI-ARIA tabs pattern).
  const onKeyDown = (e: React.KeyboardEvent, idx: number) => {
    let next = idx;
    if (e.key === "ArrowRight") next = (idx + 1) % TABS.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + TABS.length) % TABS.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = TABS.length - 1;
    else return;
    e.preventDefault();
    onChange(TABS[next].key);
    tabRefs.current[next]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Investigation workspace"
      className="grid grid-cols-5 items-stretch gap-0.5 px-2 sm:flex sm:gap-1 sm:px-4 border-b border-border-subtle bg-background overflow-hidden sm:overflow-x-auto scrollbar-none snap-x snap-mandatory [scrollbar-width:none]"
    >
      {TABS.map((t, idx) => {
        const Icon = t.icon;
        const isActive = active === t.key;
        const count = counts?.[t.key];
        return (
          <button
            key={t.key}
            ref={(el) => { tabRefs.current[idx] = el; }}
            id={`workspace-tab-${t.key}`}
            role="tab"
            aria-selected={isActive}
            aria-controls={`workspace-tabpanel-${t.key}`}
            tabIndex={isActive ? 0 : -1}
            onKeyDown={(e) => onKeyDown(e, idx)}
            onClick={() => onChange(t.key)}
            className={cn(
              "group relative min-w-0 snap-start inline-flex flex-col sm:flex-row items-center justify-center gap-0.5 sm:gap-2 h-14 sm:h-11 px-1 sm:px-4 text-[10px] sm:text-meta font-medium transition-colors rounded-md",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              isActive ? "text-foreground" : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon
              className={cn(
                "w-4 h-4 shrink-0 transition-colors",
                isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground",
              )}
              strokeWidth={1.75}
            />
            <span className="max-w-full truncate tracking-tight leading-none">{t.label}</span>
            {/* Reserve the badge slot whenever this tab tracks a count, even at
                zero, so the badge doesn't pop in and reflow the tab bar once the
                async artifact/activity counts load. */}
            {count && (
              <span
                className={cn(
                  "absolute right-1 top-1 sm:static sm:ml-0.5 inline-flex items-center justify-center min-w-[16px] sm:min-w-[18px] h-4 sm:h-[18px] px-1 rounded-full text-[9px] sm:text-[10px] font-mono tabular-nums tracking-normal",
                  count.value > 0
                    ? count.tone === "danger"
                      ? "bg-destructive/15 text-destructive border border-destructive/30"
                      : "bg-surface-2 text-muted-foreground border border-border-subtle"
                    : "opacity-0",
                )}
                aria-hidden={count.value === 0}
              >
                {count.value > 99 ? "99+" : count.value}
              </span>
            )}
            {/* Active underline indicator */}
            <span
              aria-hidden
              className={cn(
                "absolute left-2 right-2 -bottom-px h-[2px] rounded-full transition-all",
                isActive ? "bg-primary opacity-100" : "bg-transparent opacity-0",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
