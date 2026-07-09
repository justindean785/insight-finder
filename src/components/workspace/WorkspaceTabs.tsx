import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, MessagesSquare, Database, FileText, Share2, Activity, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type WorkspaceTab = "chat" | "evidence" | "report" | "graph" | "tools";

/** Per-tab badge data. `value` is the section count (how many items live in the
 * tab); `alert` is the number that NEEDS ATTENTION (failed tool calls, breaches)
 * and renders as a red dot — never as a count, so a tab number always means the
 * same thing as the word next to it. */
export type TabCount = { value: number; alert?: number };

const TABS: { key: WorkspaceTab; label: string; icon: LucideIcon }[] = [
  { key: "chat", label: "Chat", icon: MessagesSquare },
  { key: "evidence", label: "Evidence", icon: Database },
  { key: "tools", label: "Tools", icon: Activity },
  { key: "graph", label: "Graph", icon: Share2 },
  { key: "report", label: "Report", icon: FileText },
];

const COMPACT_PRIMARY = TABS.filter((t) => t.key === "chat" || t.key === "evidence" || t.key === "report");
const COMPACT_MORE = TABS.filter((t) => t.key === "tools" || t.key === "graph");

/** Small red "needs attention" dot. Carries a label so it is not color-only. */
function AlertDot({ count, className }: { count: number; className?: string }) {
  if (count <= 0) return null;
  const label = `${count} need${count === 1 ? "s" : ""} attention`;
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-destructive shadow-[0_0_6px_hsl(var(--destructive)/0.85)]",
        className,
      )}
    />
  );
}

/** Count pill that recolours for the raised (white) active tab vs the dim rest.
 * The slot is reserved even at zero so an async count loading in never reflows
 * the tab bar. */
function CountPill({ value, active }: { value: number; active: boolean }) {
  return (
    <span
      aria-hidden={value === 0}
      className={cn(
        "inline-flex h-[17px] min-w-[17px] items-center justify-center rounded-full px-1 font-mono text-eyebrow tabular-nums leading-none transition-colors",
        value === 0
          ? "opacity-0"
          : active
            ? "bg-[hsl(var(--intel-blue)/0.22)] text-[hsl(var(--intel-blue))]"
            : "bg-surface-3 text-muted-foreground",
      )}
    >
      {value > 999 ? "999+" : value}
    </span>
  );
}

/**
 * Primary workspace navigation — the five major investigation modes. These are
 * top-level app sections (not nested panel tabs): a single active mode fills the
 * main workspace. Rendered as a real segmented control — the active tab is a
 * raised surface, not just tinted text — so it unmistakably reads as a tab you
 * switch between. Tab badges OWN the section counts (Evidence = artifacts,
 * Tools = tool calls); a red dot flags items needing attention.
 */
export function WorkspaceTabs({
  active,
  onChange,
  counts,
  variant = "bar",
}: {
  active: WorkspaceTab;
  onChange: (t: WorkspaceTab) => void;
  counts?: Partial<Record<WorkspaceTab, TabCount>>;
  variant?: "bar" | "inline";
}) {
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [moreOpen, setMoreOpen] = useState(false);
  // The "More" trigger lives inside the mobile chrome header, which has
  // `backdrop-blur-xl` — a backdrop-filter creates a NEW stacking context, so an
  // in-flow `z-50` dropdown is trapped *inside* that context and paints behind
  // the later-in-DOM `absolute inset-0` workspace panels (the "More does
  // nothing" bug). Rendering the menu through a portal to <body> with fixed
  // positioning escapes that trap so it lands above the panels.
  const moreBtnRef = useRef<HTMLButtonElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);

  useLayoutEffect(() => {
    if (!moreOpen) return;
    const place = () => {
      const el = moreBtnRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setMenuPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    };
    place();
    // Reposition on scroll/resize so a fixed menu tracks its trigger instead of
    // detaching; `capture` catches scrolls on any ancestor scroll container.
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [moreOpen]);

  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (moreBtnRef.current?.contains(t)) return;
      if (t instanceof Element && t.closest("[data-workspace-more-menu]")) return;
      setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setMoreOpen(false); };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [moreOpen]);

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
    const moreAlert = COMPACT_MORE.reduce((sum, t) => sum + (counts?.[t.key]?.alert ?? 0), 0);

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
            const idx = TABS.indexOf(t);
            return (
              <button
                key={t.key}
                ref={(el) => { tabRefs.current[idx] = el; }}
                id={`workspace-tab-${t.key}`}
                role="tab"
                aria-selected={isActive}
                aria-controls={`workspace-tabpanel-${t.key}`}
                // Below 460px the chip is icon-only (matching the "More" button's
                // label breakpoint), so a narrow bar never renders the useless
                // 1-char truncation "C…"/"E…"/"R…". The label stays in the
                // accessible tree via sr-only (see the span below), so we do NOT
                // set aria-label — that would override the accessible name and drop
                // the count span from the screen-reader announcement (Phase C3).
                title={t.label}
                tabIndex={isActive ? 0 : -1}
                onKeyDown={(e) => onKeyDown(e, idx)}
                onClick={() => { setMoreOpen(false); onChange(t.key); }}
                className={cn(
                  "relative min-w-0 flex-1 inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-2 text-data font-medium transition-all duration-200 ease-premium active:scale-[0.98]",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                  isActive ? "bg-white text-black shadow-sm" : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground",
                )}
              >
                <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={1.8} />
                <span className="truncate max-[459px]:sr-only">{t.label}</span>
                {count && count.value > 0 && (
                  <span
                    className={cn(
                      "inline-flex h-4 min-w-4 items-center justify-center rounded-full px-1 font-mono text-micro tabular-nums leading-none",
                      isActive ? "bg-black/10 text-black/65" : "bg-surface-4 text-foreground",
                    )}
                  >
                    {count.value > 99 ? "99+" : count.value}
                  </span>
                )}
                {count?.alert ? <AlertDot count={count.alert} className="absolute -right-0.5 -top-0.5" /> : null}
              </button>
            );
          })}
          <button
            type="button"
            ref={moreBtnRef}
            // When a "More" tab (Tools/Graph) is the active workspace tab, this
            // trigger stands in as its tab element so the active tabpanel's
            // aria-labelledby={workspace-tab-<key>} resolves to a real node.
            id={moreActive && activeMore ? `workspace-tab-${activeMore.key}` : undefined}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
            className={cn(
              "relative inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-lg px-2 text-data font-medium transition-all duration-200 ease-premium active:scale-[0.98]",
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
            {moreAlert > 0 && !moreActive ? <AlertDot count={moreAlert} className="absolute -right-0.5 -top-0.5" /> : null}
          </button>
        </div>

        {moreOpen && menuPos && typeof document !== "undefined" && createPortal(
          <div
            data-workspace-more-menu
            role="menu"
            style={{ position: "fixed", top: menuPos.top, right: menuPos.right }}
            className="z-[60] w-44 overflow-hidden rounded-xl border border-white/10 bg-[hsl(var(--popover))] p-1 shadow-[0_24px_80px_-34px_rgba(0,0,0,0.95)]"
          >
            {COMPACT_MORE.map((t) => {
              const Icon = t.icon;
              const count = counts?.[t.key];
              return (
                <button
                  key={t.key}
                  type="button"
                  role="menuitem"
                  onClick={() => { setMoreOpen(false); onChange(t.key); }}
                  className={cn(
                    "flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm transition-all duration-200 ease-premium",
                    active === t.key ? "bg-surface-2 text-foreground" : "text-muted-foreground hover:bg-surface-1 hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" strokeWidth={1.8} />
                  <span className="min-w-0 flex-1 truncate">{t.label}</span>
                  {count?.alert ? <AlertDot count={count.alert} /> : null}
                  {count && count.value > 0 && (
                    <span className="font-mono text-eyebrow tabular-nums text-muted-foreground">
                      {count.value > 99 ? "99+" : count.value}
                    </span>
                  )}
                </button>
              );
            })}
          </div>,
          document.body,
        )}
      </div>
    );
  }

  // Desktop: a real segmented control. A contained pill bar gives the raised
  // active tab a surface to sit against, so the bar reads as navigation and
  // separates from the identity header above it.
  return (
    <div className="relative flex justify-center overflow-x-auto border-b border-white/[0.06] bg-[linear-gradient(180deg,hsl(220_22%_6.5%/0.6),hsl(222_20%_4.5%/0.46))] px-3 py-2.5 backdrop-blur-xl [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      <div
        role="tablist"
        aria-label="Investigation workspace"
        className="inline-flex w-max items-center gap-1 rounded-2xl border border-white/[0.08] bg-[hsl(220_26%_9%/0.6)] p-1 shadow-[inset_0_1px_0_hsl(0_0%_100%/0.05),0_10px_34px_-22px_hsl(var(--intel-blue)/0.7)]"
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
                "relative inline-flex h-9 items-center gap-2 rounded-lg px-3.5 text-meta font-medium transition-all duration-200 ease-premium active:scale-[0.98]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                isActive
                  ? "bg-[hsl(var(--intel-blue)/0.16)] text-foreground shadow-[inset_0_0_0_1px_hsl(var(--intel-blue)/0.34),0_0_20px_-7px_hsl(var(--intel-blue)/0.85)]"
                  : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground",
              )}
            >
              <Icon
                className={cn("h-4 w-4 shrink-0 transition-colors", isActive ? "text-[hsl(var(--intel-blue))]" : "text-current")}
                strokeWidth={1.8}
              />
              <span className="leading-none tracking-tight">{t.label}</span>
              {count ? <CountPill value={count.value} active={isActive} /> : null}
              {count?.alert ? <AlertDot count={count.alert} /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
