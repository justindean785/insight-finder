import { useRef, useState } from "react";
import { ChevronDown, MessagesSquare, Database, FileText, Share2, Activity, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type WorkspaceTab = "chat" | "evidence" | "report" | "graph" | "tools";

const TABS: { key: WorkspaceTab; label: string; icon: LucideIcon }[] = [
  { key: "chat", label: "Chat", icon: MessagesSquare },
  { key: "evidence", label: "Evidence", icon: Database },
  { key: "tools", label: "Tools", icon: Activity },
  { key: "graph", label: "Graph", icon: Share2 },
  { key: "report", label: "Report", icon: FileText },
];

const COMPACT_PRIMARY = TABS.filter((t) => t.key === "chat" || t.key === "evidence" || t.key === "report");
const COMPACT_MORE = TABS.filter((t) => t.key === "tools" || t.key === "graph");

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
  variant = "bar",
}: {
  active: WorkspaceTab;
  onChange: (t: WorkspaceTab) => void;
  counts?: Partial<Record<WorkspaceTab, { value: number; tone?: "default" | "danger" }>>;
  variant?: "bar" | "inline";
}) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);

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

  if (variant === "inline") {
    const moreActive = COMPACT_MORE.some((t) => t.key === active);
    const activeMore = COMPACT_MORE.find((t) => t.key === active);
    const ActiveMoreIcon = activeMore?.icon;

    return (
      <div className="relative min-w-0 flex-1">
        <div
          role="tablist"
          aria-label="Investigation workspace"
          className="flex min-w-0 items-center gap-1 rounded-xl border border-white/10 bg-white/[0.035] p-1"
        >
          {COMPACT_PRIMARY.map((t) => {
            const Icon = t.icon;
            const isActive = active === t.key;
            const count = counts?.[t.key];
            return (
              <button
                key={t.key}
                id={`workspace-tab-${t.key}`}
                role="tab"
                aria-selected={isActive}
                aria-controls={`workspace-tabpanel-${t.key}`}
                tabIndex={isActive ? 0 : -1}
                onClick={() => { setMoreOpen(false); onChange(t.key); }}
                className={cn(
                  "relative min-w-0 flex-1 inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-2 text-[12px] font-medium transition-all duration-200 ease-premium active:scale-[0.98]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                  isActive ? "bg-white text-black shadow-sm" : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
                <span className="truncate">{t.label}</span>
                {count && count.value > 0 && (
                  <span
                    className={cn(
                      "absolute -right-1 -top-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-mono",
                      count.tone === "danger" ? "bg-destructive text-destructive-foreground" : "bg-surface-4 text-foreground",
                    )}
                  >
                    {count.value > 99 ? "99+" : count.value}
                  </span>
                )}
              </button>
            );
          })}
          <button
            type="button"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
            className={cn(
              "inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-lg px-2 text-[12px] font-medium transition-all duration-200 ease-premium active:scale-[0.98]",
              moreActive ? "bg-[hsl(var(--info-muted))] text-[hsl(var(--info))]" : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground",
            )}
          >
            {activeMore && ActiveMoreIcon ? (
              <>
                <ActiveMoreIcon className="h-3.5 w-3.5" strokeWidth={1.8} />
                <span className="hidden min-[460px]:inline">{activeMore.label}</span>
              </>
            ) : (
              <span>More</span>
            )}
            <ChevronDown className="h-3 w-3" />
          </button>
        </div>

        {moreOpen && (
          <div className="absolute right-0 top-[calc(100%+0.35rem)] z-50 w-40 overflow-hidden rounded-xl border border-white/10 bg-[hsl(var(--popover))] p-1 shadow-[0_24px_80px_-34px_rgba(0,0,0,0.95)]">
            {COMPACT_MORE.map((t) => {
              const Icon = t.icon;
              const count = counts?.[t.key];
              return (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => { setMoreOpen(false); onChange(t.key); }}
                  className={cn(
                    "flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm transition-all duration-200 ease-premium",
                    active === t.key ? "bg-surface-2 text-foreground" : "text-muted-foreground hover:bg-surface-1 hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" strokeWidth={1.8} />
                  <span className="min-w-0 flex-1 truncate">{t.label}</span>
                  {count && count.value > 0 && (
                    <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                      {count.value > 99 ? "99+" : count.value}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      role="tablist"
      aria-label="Investigation workspace"
      className="grid grid-cols-5 items-end gap-0.5 px-2 sm:flex sm:gap-0.5 sm:px-3 border-b border-border-subtle bg-background overflow-hidden sm:overflow-x-auto scrollbar-none snap-x snap-mandatory [scrollbar-width:none]"
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
              "group relative min-w-0 snap-start inline-flex flex-col sm:flex-row items-center justify-center gap-0.5 sm:gap-2 h-14 sm:h-11 px-1 sm:px-4 text-[10px] sm:text-meta font-medium transition-[color,background-color] duration-200 ease-premium rounded-md sm:rounded-b-none",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
              // Active mode reads as a lifted segment connected to the content
              // below (calm surface tint + accent underline), not just brighter text.
              isActive
                ? "text-foreground sm:bg-foreground/[0.045]"
                : "text-muted-foreground hover:text-foreground sm:hover:bg-foreground/[0.025]",
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
                "absolute left-2 right-2 sm:left-3 sm:right-3 -bottom-px h-[2px] rounded-full transition-all duration-200 ease-premium",
                isActive ? "bg-primary opacity-100" : "bg-transparent opacity-0",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}
