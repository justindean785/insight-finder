import { useEffect, useRef } from "react";
import { ChevronDown, MessagesSquare, Database, FileText, Share2, Activity, LayoutDashboard, Check, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type WorkspaceTab = "overview" | "chat" | "evidence" | "report" | "graph" | "tools";

/** Per-tab badge data. `value` is the section count (how many items live in the
 * tab); `alert` is the number that NEEDS ATTENTION (failed tool calls, breaches)
 * and renders as a dot — never as a count, so a tab number always means the
 * same thing as the word next to it. */
export type TabCount = { value: number; alert?: number };

const TABS: { key: WorkspaceTab; label: string; icon: LucideIcon }[] = [
  // Overview leads: it is the only tab that answers "what is the state of this
  // case", so it is where an analyst returning to a case should land first.
  { key: "overview", label: "Overview", icon: LayoutDashboard },
  { key: "chat", label: "Investigate", icon: MessagesSquare },
  { key: "evidence", label: "Evidence", icon: Database },
  { key: "tools", label: "Tools", icon: Activity },
  { key: "graph", label: "Graph", icon: Share2 },
  { key: "report", label: "Report", icon: FileText },
];

const COMPACT_PRIMARY = TABS.filter((t) => t.key === "overview" || t.key === "chat" || t.key === "evidence");
const COMPACT_MORE = TABS.filter((t) => t.key === "tools" || t.key === "graph" || t.key === "report");

function countText(value: number): string {
  return value > 999 ? "999+" : String(value);
}

/** "Needs attention" dot. Carries a label so it is not colour-only. */
function AlertDot({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  const label = `${count} need${count === 1 ? "s" : ""} attention`;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn("inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-[hsl(var(--danger))]", className)}
    />
  );
}

/**
 * Primary workspace navigation — the six case sections.
 *
 * Desktop: one centred, stable strip of labelled tabs. The active tab is marked
 * by a 2px signal underline and a faintly lifted ground — no white pill, no
 * per-tab count bubbles, no boxed container. Centring uses `safe center`, which
 * falls back to start alignment the moment the strip overflows, so the first
 * tab can never be pushed into negative scroll space (#525).
 *
 * Mobile: Overview, Investigate and Evidence as labelled tabs, and Tools, Graph
 * and Report behind a More menu. The More trigger ALWAYS carries a name — "More"
 * or, when one of its sections is active, "More, current section: Graph" — so
 * primary navigation is never an unlabelled icon.
 */
export function WorkspaceTabs({
  active,
  onChange,
  counts,
  loading = false,
  variant = "bar",
}: {
  active: WorkspaceTab;
  onChange: (t: WorkspaceTab) => void;
  counts?: Partial<Record<WorkspaceTab, TabCount>>;
  /** Counts are not known yet: show a placeholder, never a false 0. */
  loading?: boolean;
  variant?: "bar" | "inline";
}) {
  if (variant === "inline") {
    return <CompactNav active={active} onChange={onChange} counts={counts} loading={loading} />;
  }
  return <TabBar active={active} onChange={onChange} counts={counts} loading={loading} />;
}

function TabCountBadge({ count, loading, active }: { count?: TabCount; loading: boolean; active: boolean }) {
  if (!count) return null;
  if (loading) return <span aria-hidden className="h-2.5 w-4 rounded-sm bg-white/[0.08]" />;
  return (
    <>
      {count.value > 0 && (
        <span className={cn("font-mono text-data tabular-nums leading-none", active ? "text-foreground/70" : "text-muted-foreground")}>
          {countText(count.value)}
        </span>
      )}
      {count.alert ? <AlertDot count={count.alert} /> : null}
    </>
  );
}

function TabBar({
  active, onChange, counts, loading,
}: {
  active: WorkspaceTab;
  onChange: (t: WorkspaceTab) => void;
  counts?: Partial<Record<WorkspaceTab, TabCount>>;
  loading: boolean;
}) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Keep the active tab in view when it changes from outside (command palette,
  // "View failed tools").
  useEffect(() => {
    const idx = TABS.findIndex((t) => t.key === active);
    tabRefs.current[idx]?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active]);

  // Roving arrow-key navigation (WAI-ARIA tabs, automatic activation).
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
    <div className="relative border-b border-white/[0.07] bg-surface-0">
      <div className="flex justify-safe-center overflow-x-auto px-3 sm:px-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div role="tablist" aria-label="Investigation workspace" className="flex w-max shrink-0 items-stretch gap-1">
          {TABS.map((t, idx) => {
            const Icon = t.icon;
            const isActive = active === t.key;
            return (
              <button
                key={t.key}
                ref={(el) => { tabRefs.current[idx] = el; }}
                id={`workspace-tab-${t.key}`}
                type="button"
                role="tab"
                aria-selected={isActive}
                aria-controls={`workspace-tabpanel-${t.key}`}
                tabIndex={isActive ? 0 : -1}
                onKeyDown={(e) => onKeyDown(e, idx)}
                onClick={() => onChange(t.key)}
                className={cn(
                  "relative inline-flex h-10 shrink-0 items-center gap-2 rounded-t-md px-3.5 text-[14px] font-medium",
                  "transition-[color,background-color,box-shadow] duration-fast ease-standard",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  isActive
                    ? "bg-surface-2 text-foreground shadow-[inset_0_-2px_0_hsl(var(--brand))]"
                    : "text-muted-foreground hover:bg-white/[0.03] hover:text-foreground",
                )}
              >
                <Icon
                  className={cn("h-4 w-4 shrink-0", isActive ? "text-[hsl(var(--intel-blue))]" : "opacity-75")}
                  strokeWidth={1.8}
                  aria-hidden
                />
                <span className="leading-none">{t.label}</span>
                <TabCountBadge count={counts?.[t.key]} loading={loading} active={isActive} />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function CompactNav({
  active, onChange, counts, loading,
}: {
  active: WorkspaceTab;
  onChange: (t: WorkspaceTab) => void;
  counts?: Partial<Record<WorkspaceTab, TabCount>>;
  loading: boolean;
}) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const activeMore = COMPACT_MORE.find((t) => t.key === active);
  const moreAlert = COMPACT_MORE.reduce((sum, t) => (t.key === active ? sum : sum + (counts?.[t.key]?.alert ?? 0)), 0);

  // Roving focus across the three labelled tabs.
  const onKeyDown = (e: React.KeyboardEvent, idx: number) => {
    let next = idx;
    if (e.key === "ArrowRight") next = (idx + 1) % COMPACT_PRIMARY.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + COMPACT_PRIMARY.length) % COMPACT_PRIMARY.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = COMPACT_PRIMARY.length - 1;
    else return;
    e.preventDefault();
    onChange(COMPACT_PRIMARY[next].key);
    tabRefs.current[next]?.focus();
  };

  return (
    <nav aria-label="Workspace sections" className="flex min-w-0 flex-1 items-stretch gap-1">
      <div role="tablist" aria-label="Investigation workspace" className="flex min-w-0 flex-1 items-stretch gap-0.5">
        {COMPACT_PRIMARY.map((t, idx) => {
          const isActive = active === t.key;
          const count = counts?.[t.key];
          return (
            <button
              key={t.key}
              ref={(el) => { tabRefs.current[idx] = el; }}
              id={`workspace-tab-${t.key}`}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`workspace-tabpanel-${t.key}`}
              tabIndex={isActive || (activeMore && idx === 0) ? 0 : -1}
              onKeyDown={(e) => onKeyDown(e, idx)}
              onClick={() => onChange(t.key)}
              className={cn(
                "relative inline-flex h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-t-md px-2 text-[13.5px] font-medium",
                "transition-[color,background-color,box-shadow] duration-fast ease-standard",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                isActive
                  ? "bg-surface-2 text-foreground shadow-[inset_0_-2px_0_hsl(var(--brand))]"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <span className="whitespace-nowrap">{t.label}</span>
              {!loading && count && count.value > 0 && (
                <span className="font-mono text-data tabular-nums text-muted-foreground max-[479px]:hidden">{countText(count.value)}</span>
              )}
              {!loading && count?.alert ? <AlertDot count={count.alert} /> : null}
            </button>
          );
        })}
      </div>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            // When a More section is active, this trigger is the element that
            // labels its panel (`aria-labelledby="workspace-tab-<key>"`).
            id={activeMore ? `workspace-tab-${activeMore.key}` : undefined}
            aria-label={activeMore ? `More, current section: ${activeMore.label}` : "More sections: Tools, Graph, Report"}
            className={cn(
              "relative inline-flex h-11 shrink-0 items-center gap-1 rounded-t-md px-2.5 text-[13.5px] font-medium",
              "transition-[color,background-color,box-shadow] duration-fast ease-standard",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              activeMore
                ? "bg-surface-2 text-foreground shadow-[inset_0_-2px_0_hsl(var(--brand))]"
                : "text-muted-foreground hover:text-foreground data-[state=open]:text-foreground",
            )}
          >
            <span className="whitespace-nowrap">{activeMore ? activeMore.label : "More"}</span>
            <ChevronDown className="h-3.5 w-3.5" aria-hidden />
            {!loading && moreAlert > 0 && <AlertDot count={moreAlert} className="absolute right-1 top-2" />}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          sideOffset={4}
          className="w-56 rounded-xl border-white/10 bg-[hsl(var(--popover))] p-1 shadow-overlay"
        >
          <DropdownMenuLabel className="px-2.5 pb-1 pt-1.5 text-micro font-medium text-muted-foreground">More sections</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={activeMore?.key ?? ""} onValueChange={(v) => onChange(v as WorkspaceTab)}>
            {COMPACT_MORE.map((t) => {
              const Icon = t.icon;
              const count = counts?.[t.key];
              const selected = t.key === active;
              return (
                <DropdownMenuRadioItem
                  key={t.key}
                  value={t.key}
                  className={cn(
                    "flex min-h-11 items-center gap-2.5 rounded-lg py-2 pl-2.5 pr-2.5 text-[14px] [&>span:first-child]:hidden",
                    selected ? "bg-surface-3 text-foreground" : "text-muted-foreground focus:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" strokeWidth={1.8} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{t.label}</span>
                  {!loading && count?.alert ? <AlertDot count={count.alert} /> : null}
                  {!loading && count && count.value > 0 && (
                    <span className="font-mono text-data tabular-nums text-muted-foreground">{countText(count.value)}</span>
                  )}
                  {selected && <Check className="h-3.5 w-3.5 text-[hsl(var(--intel-blue))]" aria-hidden />}
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </nav>
  );
}
