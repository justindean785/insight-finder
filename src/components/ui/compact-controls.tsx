import { useRef, type ReactNode } from "react";
import { Check, ChevronDown, SlidersHorizontal, type LucideIcon } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Compact workspace controls — the quiet second tier under the case tabs.
 *
 * WHY. Each workspace tab had grown its own row of pill buttons: seven evidence
 * filters, a three-way sort, a five-way view switcher, four export buttons and
 * three "coming soon" chips. At a 600px panel the Evidence toolbar alone wrapped
 * to three rows (131px) before a single finding was visible. These controls keep
 * every option one or two clicks away while showing only what an analyst
 * actually switches between, and they share one visual vocabulary so the same
 * kind of choice looks the same on every tab.
 */

export type CompactTone = "ok" | "warn" | "danger";

export interface CompactOption<T extends string> {
  key: T;
  label: string;
  count?: number;
  tone?: CompactTone;
  icon?: LucideIcon;
  /** Shown in the menu row under the label. */
  hint?: string;
}

const TONE_TEXT: Record<CompactTone, string> = {
  ok: "text-[hsl(var(--confidence-high))]",
  warn: "text-[hsl(var(--warning))]",
  danger: "text-[hsl(var(--danger))]",
};

function countText(n: number): string {
  return n > 999 ? "999+" : String(n);
}

/**
 * A filter with its common options visible and the rest behind "More".
 *
 * The visible options are toggle buttons (`aria-pressed`) in a labelled group —
 * the same semantics as the other in-place view switches in the workspace. When
 * the active option lives in the overflow, the More trigger takes its label and
 * count, so the current filter is ALWAYS readable without opening anything.
 */
export function CompactFilter<T extends string>({
  label,
  options,
  primary,
  active,
  onChange,
  className,
}: {
  /** Accessible name for the group, e.g. "Filter evidence". */
  label: string;
  options: CompactOption<T>[];
  /** Keys shown inline; everything else goes to the overflow menu. */
  primary: T[];
  active: T;
  onChange: (key: T) => void;
  className?: string;
}) {
  const inline = options.filter((o) => primary.includes(o.key));
  const overflow = options.filter((o) => !primary.includes(o.key));
  const activeOverflow = overflow.find((o) => o.key === active);
  const groupRef = useRef<HTMLDivElement | null>(null);

  // Left/Right move between the visible buttons, like any segmented control.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const buttons = Array.from(groupRef.current?.querySelectorAll<HTMLButtonElement>("[data-compact-item]") ?? []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    const next = e.key === "ArrowRight" ? (i + 1) % buttons.length : (i - 1 + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <div
      ref={groupRef}
      role="group"
      aria-label={label}
      onKeyDown={onKeyDown}
      className={cn("inline-flex min-w-0 items-center gap-0.5 rounded-lg bg-white/[0.025] p-0.5", className)}
    >
      {inline.map((o) => {
        const on = o.key === active;
        return (
          <button
            key={o.key}
            type="button"
            data-compact-item
            aria-pressed={on}
            onClick={() => onChange(o.key)}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-data font-medium transition-colors duration-fast [@media(pointer:coarse)]:h-11",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              on ? "bg-surface-3 text-foreground shadow-e1" : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
            )}
          >
            <span>{o.label}</span>
            {o.count !== undefined && (
              <span className={cn("font-mono tabular-nums", on ? "text-foreground/70" : o.tone ? TONE_TEXT[o.tone] : "text-muted-foreground/80")}>
                {countText(o.count)}
              </span>
            )}
          </button>
        );
      })}
      {overflow.length > 0 && (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-compact-item
              aria-label={activeOverflow ? `${label}: ${activeOverflow.label}. More options` : `More ${label.toLowerCase()} options`}
              className={cn(
                "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-data font-medium transition-colors duration-fast [@media(pointer:coarse)]:h-11",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                activeOverflow ? "bg-surface-3 text-foreground shadow-e1" : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
              )}
            >
              <span>{activeOverflow ? activeOverflow.label : "More"}</span>
              {activeOverflow?.count !== undefined && (
                <span className="font-mono tabular-nums text-foreground/70">{countText(activeOverflow.count)}</span>
              )}
              <ChevronDown className="h-3 w-3" aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <MenuBody label={label} options={overflow} active={active} onChange={onChange} />
        </DropdownMenu>
      )}
    </div>
  );
}

/**
 * A labelled single-choice menu: "Sort: Strength ▾", "View: Board ▾".
 * The trigger always states the current choice in words.
 */
export function MenuSelect<T extends string>({
  label,
  options,
  active,
  onChange,
  showLabel = true,
  className,
  align = "end",
}: {
  label: string;
  options: CompactOption<T>[];
  active: T;
  onChange: (key: T) => void;
  /** Print "Label:" before the value in the trigger. */
  showLabel?: boolean;
  className?: string;
  align?: "start" | "end";
}) {
  const current = options.find((o) => o.key === active) ?? options[0];
  const Icon = current?.icon;
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`${label}: ${current?.label ?? ""}. Change ${label.toLowerCase()}`}
          className={cn(
            "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.025] px-2.5 text-data font-medium text-foreground/90 [@media(pointer:coarse)]:h-11",
            "transition-colors duration-fast hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            "data-[state=open]:border-[hsl(var(--brand)/0.45)]",
            className,
          )}
        >
          {Icon && <Icon className="h-3.5 w-3.5 text-muted-foreground" strokeWidth={1.8} aria-hidden />}
          {showLabel && <span className="text-muted-foreground">{label}</span>}
          <span>{current?.label}</span>
          <ChevronDown className="h-3 w-3 text-muted-foreground" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <MenuBody label={label} options={options} active={active} onChange={onChange} align={align} />
    </DropdownMenu>
  );
}

function MenuBody<T extends string>({
  label, options, active, onChange, align = "end",
}: {
  label: string;
  options: CompactOption<T>[];
  active: T;
  onChange: (key: T) => void;
  align?: "start" | "end";
}) {
  return (
    <DropdownMenuContent
      align={align}
      sideOffset={6}
      className="min-w-[12rem] rounded-xl border-white/10 bg-[hsl(var(--popover))] p-1 shadow-overlay"
    >
      <DropdownMenuLabel className="px-2.5 pb-1 pt-1.5 text-micro font-medium text-muted-foreground">{label}</DropdownMenuLabel>
      <DropdownMenuRadioGroup value={active} onValueChange={(v) => onChange(v as T)}>
        {options.map((o) => {
          const Icon = o.icon;
          const on = o.key === active;
          return (
            <DropdownMenuRadioItem
              key={o.key}
              value={o.key}
              className={cn(
                "flex min-h-9 items-start gap-2 rounded-lg py-1.5 pl-2.5 pr-2 text-meta [&>span:first-child]:hidden",
                on ? "bg-surface-3 text-foreground" : "text-muted-foreground focus:text-foreground",
              )}
            >
              {Icon && <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.8} aria-hidden />}
              <span className="min-w-0 flex-1">
                <span className={cn("block", !on && o.tone && TONE_TEXT[o.tone])}>{o.label}</span>
                {o.hint && <span className="mt-0.5 block text-micro leading-snug text-muted-foreground">{o.hint}</span>}
              </span>
              {o.count !== undefined && (
                <span className="mt-0.5 font-mono text-micro tabular-nums text-muted-foreground">{countText(o.count)}</span>
              )}
              {on && <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[hsl(var(--intel-blue))]" aria-hidden />}
            </DropdownMenuRadioItem>
          );
        })}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  );
}

/**
 * Quiet text sub-tabs for a tab's own sections ("Activity · Health · Audit ·
 * Custody"). Words, not an icon puzzle; the active one sits on a lifted ground.
 */
export function SubTabs<T extends string>({
  label,
  options,
  active,
  onChange,
  className,
}: {
  label: string;
  options: CompactOption<T>[];
  active: T;
  onChange: (key: T) => void;
  className?: string;
}): ReactNode {
  return (
    <div role="group" aria-label={label} className={cn("flex min-w-0 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden", className)}>
      {options.map((o) => {
        const on = o.key === active;
        const Icon = o.icon;
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.key)}
            className={cn(
              "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-data font-medium transition-colors duration-fast [@media(pointer:coarse)]:h-11",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              on ? "bg-surface-3 text-foreground shadow-e1" : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
            )}
          >
            {Icon && <Icon className={cn("h-3.5 w-3.5", on ? "text-[hsl(var(--intel-blue))]" : "opacity-80")} strokeWidth={1.8} aria-hidden />}
            {o.label}
            {o.count !== undefined && o.count > 0 && (
              <span className="font-mono tabular-nums text-muted-foreground/80">{countText(o.count)}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export interface FilterSection<T extends string> {
  label: string;
  options: CompactOption<T>[];
  active: T;
  onChange: (key: T) => void;
}

/**
 * Phone-width filters: one button that states the active choices ("Analyst
 * view · Strength") and opens every choice in a popover. Keeps a filter row from
 * eating a third of a 390px viewport before the first finding.
 */
export function FilterPopover({
  sections,
  footer,
  className,
}: {
  // Heterogeneous option keys per section; each section carries its own
  // matching onChange, so the element type is erased at this boundary only.
  sections: FilterSection<string>[];
  footer?: ReactNode;
  className?: string;
}) {
  const summary = sections
    .map((s) => s.options.find((o) => o.key === s.active)?.label)
    .filter(Boolean)
    .join(" · ");
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Filters: ${summary}. Change filters`}
          className={cn(
            "inline-flex h-10 min-w-0 items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.025] px-3 text-data font-medium text-foreground/90",
            "transition-colors duration-fast hover:bg-white/[0.05] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
        >
          <SlidersHorizontal className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 truncate">{summary}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={6} className="w-[min(20rem,calc(100vw-1.5rem))] rounded-xl border-white/10 bg-[hsl(var(--popover))] p-2 shadow-overlay">
        {sections.map((section) => (
          <div key={section.label} role="group" aria-label={section.label} className="mb-2 last:mb-0">
            <div className="px-1.5 pb-1 pt-1 text-micro font-medium text-muted-foreground">{section.label}</div>
            <div className="grid gap-0.5">
              {section.options.map((o) => {
                const on = o.key === section.active;
                return (
                  <button
                    key={o.key}
                    type="button"
                    aria-pressed={on}
                    onClick={() => section.onChange(o.key)}
                    className={cn(
                      "flex min-h-11 items-center gap-2 rounded-lg px-2.5 text-left text-[14px] transition-colors duration-fast",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      on ? "bg-surface-3 text-foreground" : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground",
                    )}
                  >
                    <span className={cn("min-w-0 flex-1 truncate", !on && o.tone && TONE_TEXT[o.tone])}>{o.label}</span>
                    {o.count !== undefined && <span className="font-mono text-data tabular-nums text-muted-foreground">{countText(o.count)}</span>}
                    {on && <Check className="h-3.5 w-3.5 text-[hsl(var(--intel-blue))]" aria-hidden />}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
        {footer && <div className="mt-1 border-t border-white/[0.07] px-1.5 pt-2">{footer}</div>}
      </PopoverContent>
    </Popover>
  );
}
