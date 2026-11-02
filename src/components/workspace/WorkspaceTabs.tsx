import { useEffect, useRef } from "react";
import { MoreHorizontal, MessagesSquare, Database, FileText, Share2, Activity, LayoutDashboard, Check, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { tabButtonClass, tabIconClass } from "@/components/workspace/tab-recipe";
import type { WorkspaceTab } from "@/lib/workspace-sections";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type { WorkspaceTab };

/** Per-tab badge data. `value` is what the tab SHOWS — not the size of the
 * corpus behind it. Those differ on Evidence, whose board has defaulted to
 * "Analyst view" since #543: the badge counts rows that need a decision, while
 * the case header still reports every persisted row. `hint` carries that
 * reconciliation so the gap is explained rather than left to be puzzled over.
 * `alert` is the number that NEEDS ATTENTION (failed tool calls, breaches)
 * and renders as a dot — never as a count, so a tab number always means the
 * same thing as the word next to it. */
export type TabCount = {
  value: number;
  alert?: number;
  hint?: string;
  /** Screen-reader-only noun after the number. */
  unit?: string;
  /** "decision": the number is open calls, not items, so it renders as an attention chip with a "to decide" label. */
  kind?: "decision";
};

const TABS: { key: WorkspaceTab; label: string; icon: LucideIcon }[] = [
  // Case-desk order (JD's prototype, 2026-11-02): the live investigation leads,
  // then the summary, the evidence, the graph, what ran, and the deliverable.
  // "Tools" reads "Activity": outcomes first, raw calls one step away. The key
  // stays `tools`, so every deep link and navigate event keeps working.
  { key: "chat", label: "Investigate", icon: MessagesSquare },
  { key: "overview", label: "Overview", icon: LayoutDashboard },
  { key: "evidence", label: "Evidence", icon: Database },
  { key: "graph", label: "Graph", icon: Share2 },
  { key: "tools", label: "Activity", icon: Activity },
  { key: "report", label: "Report", icon: FileText },
];

// Mobile: the three places an analyst goes on a phone — the conversation, the
// evidence, and the report they will hand on — are one thumb-tap away. Report
// used to sit behind More while Overview took a primary slot; on a phone the
// report is the deliverable and Overview is a summary of the other two.
const COMPACT_PRIMARY_KEYS: ReadonlySet<WorkspaceTab> = new Set(["chat", "evidence", "report"]);

type TabDef = (typeof TABS)[number];

function sectionTabs(sections?: readonly WorkspaceTab[]): TabDef[] {
  if (!sections) return TABS;
  return sections.map((k) => TABS.find((t) => t.key === k)).filter((t): t is TabDef => Boolean(t));
}

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
 * Desktop: one stable strip of labelled tabs, LEFT-aligned so the first tab's
 * icon sits on the case bar's left edge, under the case mark — the eye reads
 * down the title's column into the sections instead of jumping to a centred
 * island. The active tab is marked by a 2px signal underline and a faintly
 * lifted ground — no white pill, no boxed container. Start alignment also
 * keeps the first tab out of negative scroll space when the strip overflows
 * (#525), which centring needed `safe center` for.
 *
 * Mobile: a BOTTOM tab bar, where the thumb is — Investigate, Evidence and
 * Report as labelled tabs (icon over label), and Overview, Tools and Graph
 * behind More.
 *
 * `sections` narrows the strip to a subset in a fixed order — the case viewer
 * uses `CASE_VIEW_SECTIONS` from `@/lib/workspace-sections` — so both case screens share one tab
 * component, one keyboard model and one count badge. The More trigger ALWAYS carries a name — "More sections: …" or,
 * when one of its sections is active, "More, current section: Graph" — so
 * primary navigation is never an unlabelled icon. The bar pads itself by the
 * device's bottom safe-area inset so the home indicator never sits on a tab.
 */
export function WorkspaceTabs({
  active,
  onChange,
  counts,
  loading = false,
  variant = "bar",
  sections,
  label = "Investigation workspace",
}: {
  active: WorkspaceTab;
  onChange: (t: WorkspaceTab) => void;
  counts?: Partial<Record<WorkspaceTab, TabCount>>;
  /** Counts are not known yet: show a placeholder, never a false 0. */
  loading?: boolean;
  variant?: "bar" | "inline";
  /** Show only these sections, in this order. Default: all six. */
  sections?: readonly WorkspaceTab[];
  /** Accessible name of the tablist. */
  label?: string;
}) {
  const tabs = sectionTabs(sections);
  if (variant === "inline") {
    return <CompactNav tabs={tabs} label={label} active={active} onChange={onChange} counts={counts} loading={loading} />;
  }
  return <TabBar tabs={tabs} label={label} active={active} onChange={onChange} counts={counts} loading={loading} />;
}

/**
 * Open decisions, styled like the folded case sheet's count so "Evidence 10"
 * is not read as ten evidence items beside the header's "55 evidence logged".
 */
export function DecisionChip({ count, compact = false }: { count: TabCount; compact?: boolean }) {
  if (count.value <= 0) return null;
  return (
    <span
      title={count.hint}
      className="inline-flex items-center gap-1 rounded-full border border-warning/40 bg-warning/10 px-1.5 text-micro leading-[18px] text-warning"
    >
      <span className="font-mono tabular-nums">{countText(count.value)}</span>
      {!compact && <span aria-hidden className="hidden lg:inline">to decide</span>}
      {count.unit && <span className="sr-only"> {count.unit}</span>}
    </span>
  );
}

function TabCountBadge({ count, loading, active }: { count?: TabCount; loading: boolean; active: boolean }) {
  if (!count) return null;
  if (loading) return <span aria-hidden className="h-2.5 w-4 rounded-sm bg-white/[0.08]" />;
  if (count.kind === "decision") return <DecisionChip count={count} />;
  return (
    <>
      {count.value > 0 && (
        <span className={cn("font-mono text-data tabular-nums leading-none", active ? "text-foreground/70" : "text-muted-foreground")} title={count.hint}>
          {countText(count.value)}
          {count.unit && <span className="sr-only"> {count.unit}</span>}
        </span>
      )}
      {count.alert ? <AlertDot count={count.alert} /> : null}
    </>
  );
}

function TabBar({
  tabs, label, active, onChange, counts, loading,
}: {
  tabs: TabDef[];
  label: string;
  active: WorkspaceTab;
  onChange: (t: WorkspaceTab) => void;
  counts?: Partial<Record<WorkspaceTab, TabCount>>;
  loading: boolean;
}) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Keep the active tab in view when it changes from outside (command palette,
  // "View failed tools").
  useEffect(() => {
    const idx = tabs.findIndex((t) => t.key === active);
    tabRefs.current[idx]?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [active, tabs]);

  // Roving arrow-key navigation (WAI-ARIA tabs, automatic activation).
  const onKeyDown = (e: React.KeyboardEvent, idx: number) => {
    let next = idx;
    if (e.key === "ArrowRight") next = (idx + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else return;
    e.preventDefault();
    onChange(tabs[next].key);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="relative border-b border-white/[0.07] bg-surface-0">
      <div className="flex overflow-x-auto px-4 sm:px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {/* Case desk: text-only tabs, wide spacing, aligned with the case title. */}
        <div role="tablist" aria-label={label} className="flex w-max shrink-0 items-stretch gap-6">
          {tabs.map((t, idx) => {
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
                className={tabButtonClass(isActive, "primary")}
              >
                <Icon className={cn(tabIconClass(isActive), "hidden")} strokeWidth={1.8} aria-hidden />
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
  tabs, label, active, onChange, counts, loading,
}: {
  tabs: TabDef[];
  label: string;
  active: WorkspaceTab;
  onChange: (t: WorkspaceTab) => void;
  counts?: Partial<Record<WorkspaceTab, TabCount>>;
  loading: boolean;
}) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const primary = tabs.filter((t) => COMPACT_PRIMARY_KEYS.has(t.key));
  const more = tabs.filter((t) => !COMPACT_PRIMARY_KEYS.has(t.key));
  const moreLabel = `More sections: ${more.map((t) => t.label).join(", ")}`;
  const activeMore = more.find((t) => t.key === active);
  const moreAlert = more.reduce((sum, t) => (t.key === active ? sum : sum + (counts?.[t.key]?.alert ?? 0)), 0);

  // Roving focus across the three labelled tabs.
  const onKeyDown = (e: React.KeyboardEvent, idx: number) => {
    let next = idx;
    if (e.key === "ArrowRight") next = (idx + 1) % primary.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + primary.length) % primary.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = primary.length - 1;
    else return;
    e.preventDefault();
    onChange(primary[next].key);
    tabRefs.current[next]?.focus();
  };

  const item = "relative flex min-w-0 flex-1 flex-col items-center justify-center gap-1 pb-1.5 pt-2 text-data font-medium leading-none transition-colors duration-fast ease-standard focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring";
  return (
    <nav
      aria-label="Workspace sections"
      className="flex items-stretch border-t border-border-subtle bg-card pb-[env(safe-area-inset-bottom)]"
    >
      <div role="tablist" aria-label={label} className="flex min-w-0 flex-[3] items-stretch">
        {primary.map((t, idx) => {
          const Icon = t.icon;
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
              className={cn(item, "min-h-14", isActive ? "text-foreground" : "text-subtle-foreground")}
            >
              <span className="relative">
                <Icon className={cn("h-5 w-5", isActive && "text-[hsl(var(--brand))]")} strokeWidth={isActive ? 2 : 1.7} aria-hidden />
                {!loading && count?.alert ? <AlertDot count={count.alert} className="absolute -right-1.5 -top-0.5" /> : null}
              </span>
              <span className="whitespace-nowrap">{t.label}</span>
            </button>
          );
        })}
      </div>
      {more.length > 0 && (
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            // When a More section is active, this trigger is the element that
            // labels its panel (`aria-labelledby="workspace-tab-<key>"`).
            id={activeMore ? `workspace-tab-${activeMore.key}` : undefined}
            aria-label={activeMore ? `More, current section: ${activeMore.label}` : moreLabel}
            className={cn(item, "min-h-14", activeMore ? "text-foreground" : "text-subtle-foreground data-[state=open]:text-foreground")}
          >
            <span className="relative">
              {activeMore
                ? <activeMore.icon className="h-5 w-5 text-[hsl(var(--brand))]" strokeWidth={2} aria-hidden />
                : <MoreHorizontal className="h-5 w-5" strokeWidth={1.7} aria-hidden />}
              {!loading && moreAlert > 0 && <AlertDot count={moreAlert} className="absolute -right-1.5 -top-0.5" />}
            </span>
            <span className="whitespace-nowrap">{activeMore ? activeMore.label : "More"}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side="top"
          align="end"
          sideOffset={6}
          className="mr-2 w-60 rounded-xl border-border bg-[hsl(var(--popover))] p-1 shadow-overlay"
        >
          <DropdownMenuLabel className="px-2.5 pb-1 pt-1.5 text-data font-medium text-muted-foreground">More sections</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={activeMore?.key ?? ""} onValueChange={(v) => onChange(v as WorkspaceTab)}>
            {more.map((t) => {
              const Icon = t.icon;
              const count = counts?.[t.key];
              const selected = t.key === active;
              return (
                <DropdownMenuRadioItem
                  key={t.key}
                  value={t.key}
                  className={cn(
                    "flex min-h-12 items-center gap-2.5 rounded-lg py-2 pl-2.5 pr-2.5 text-[14.5px] [&>span:first-child]:hidden",
                    selected ? "bg-surface-3 text-foreground" : "text-muted-foreground focus:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" strokeWidth={1.8} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{t.label}</span>
                  {!loading && count?.alert ? <AlertDot count={count.alert} /> : null}
                  {!loading && count && count.value > 0 && (
                    <span className="font-mono text-data tabular-nums text-muted-foreground">
                      {countText(count.value)}
                      {count.unit && <span className="sr-only"> {count.unit}</span>}
                    </span>
                  )}
                  {selected && <Check className="h-3.5 w-3.5 text-[hsl(var(--brand))]" aria-hidden />}
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      )}
    </nav>
  );
}
