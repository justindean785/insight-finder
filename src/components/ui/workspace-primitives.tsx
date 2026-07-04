import { useState, useRef, type ReactNode } from "react";
import {
  Copy, Check, CheckCircle2, XCircle, MinusCircle, Loader2, ChevronRight,
  ShieldCheck, ShieldQuestion, Search, Server, AlertTriangle, Circle, Ban,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Info } from "lucide-react";
import { EVIDENCE_STATUS_LEGEND, type EvidenceDisplayStatus, type EvidenceStatusTone } from "@/lib/evidence-status";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * Shared workspace UI primitives — small, typed, reusable building blocks used
 * across the investigation tabs (Tools, Graph, Evidence). Status is always
 * conveyed by icon + text, never color alone, and every icon-only control
 * carries an accessible label.
 */

/* ── TabHeader (per-tab section identity) ───────────────────────────── */

/**
 * Section header that gives each top-level workspace tab its own identity — an
 * icon + a semantic <h2> title, an optional context subtitle, and an optional
 * slot for controls on the right (view switchers, exports, zoom). Shared so
 * every tab reads as the same calm, segmented workspace rather than the same
 * panel with swapped content. Wraps gracefully: on narrow widths the controls
 * drop below the title instead of overflowing.
 */
export function TabHeader({
  icon: Icon,
  title,
  subtitle,
  children,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  /** Concise local context — counts, review state, a one-line descriptor. */
  subtitle?: ReactNode;
  /** Right-aligned controls: view switchers, export actions, zoom. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        // Opaque semantic surface token. The previous `bg-[hsl(var(--surface-0))/0.98]`
        // compiled to invalid CSS (`hsl(0 0% 3%)/0.98`) → no background at all, so the
        // sticky Report header let scrolling content show through (#110). Use the
        // `bg-surface-0` utility (matches bg-surface-1/2/3 used across the app; can't
        // be malformed like an arbitrary value).
        "shrink-0 flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 sm:px-4 py-2 border-b border-border-subtle bg-surface-0",
        className,
      )}
    >
      <div className="flex min-w-0 items-center gap-2.5">
        {Icon && <Icon className="w-4 h-4 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden />}
        <div className="min-w-0">
          <h2 className="text-[13px] font-semibold leading-tight tracking-tight text-foreground">{title}</h2>
          {subtitle != null && (
            <div className="mt-0.5 text-[11px] leading-tight text-muted-foreground">{subtitle}</div>
          )}
        </div>
      </div>
      {children ? <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}

/* ── CopyButton ─────────────────────────────────────────────────────── */

export function CopyButton({
  value,
  label = "Copy",
  className,
  size = "sm",
}: {
  value: string;
  /** Accessible label, e.g. "Copy email". */
  label?: string;
  className?: string;
  size?: "sm" | "md";
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const onCopy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1400);
    });
  };
  const dim = size === "md" ? "w-8 h-8" : "w-7 h-7";
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      className={cn(
        "shrink-0 grid place-items-center rounded-md border border-border-subtle text-muted-foreground transition-colors",
        "hover:text-foreground hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0",
        dim,
        className,
      )}
    >
      {copied ? (
        <Check className="w-3.5 h-3.5 text-[hsl(var(--confidence-high))]" aria-hidden="true" />
      ) : (
        <Copy className="w-3.5 h-3.5" aria-hidden="true" />
      )}
      <span className="sr-only" role="status" aria-live="polite">{copied ? "Copied" : ""}</span>
    </button>
  );
}

/* ── MetricCard ─────────────────────────────────────────────────────── */

export type MetricTone = "neutral" | "ok" | "danger" | "warn";

const METRIC_TONE: Record<MetricTone, string> = {
  neutral: "text-foreground",
  ok: "text-[hsl(var(--confidence-high))]",
  danger: "text-destructive",
  warn: "text-[hsl(var(--confidence-mid))]",
};

export function MetricCard({
  icon: Icon,
  label,
  value,
  tone = "neutral",
  hint,
  className,
}: {
  icon?: LucideIcon;
  label: string;
  value: ReactNode;
  tone?: MetricTone;
  /** Tooltip explaining the metric. */
  hint?: string;
  className?: string;
}) {
  const color = METRIC_TONE[tone];
  return (
    <div
      className={cn("rounded-lg border border-border-subtle bg-surface-1 px-3 py-2.5", className)}
      title={hint}
    >
      <div className="flex items-center gap-1.5 text-eyebrow uppercase tracking-[0.1em] text-muted-foreground">
        {Icon && <Icon className={cn("w-3 h-3", tone !== "neutral" && color)} />}
        <span className="truncate">{label}</span>
      </div>
      <div className={cn("mt-1 text-2xl font-display font-semibold tabular-nums leading-none", color)}>
        {value}
      </div>
    </div>
  );
}

/* ── FilterChips (accessible segmented filter) ──────────────────────── */

export type FilterChip<T extends string> = {
  key: T;
  label: string;
  count?: number;
  tone?: MetricTone;
};

export function FilterChips<T extends string>({
  options,
  active,
  onChange,
  ariaLabel,
  className,
}: {
  options: FilterChip<T>[];
  active: T;
  onChange: (key: T) => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className={cn("flex flex-wrap items-center gap-1.5", className)}>
      {options.map((o) => {
        const isActive = o.key === active;
        const toneCls =
          o.tone === "danger" ? "text-destructive" :
          o.tone === "ok" ? "text-[hsl(var(--confidence-high))]" :
          o.tone === "warn" ? "text-[hsl(var(--confidence-mid))]" : "";
        return (
          <button
            key={o.key}
            role="radio"
            aria-checked={isActive}
            onClick={() => onChange(o.key)}
            className={cn(
              "inline-flex items-center gap-1.5 h-8 px-3 rounded-lg text-meta font-medium transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isActive
                ? "bg-surface-2 text-foreground border border-white/10"
                : "text-muted-foreground hover:text-foreground hover:bg-surface-1 border border-transparent",
            )}
          >
            <span className={cn(!isActive && toneCls)}>{o.label}</span>
            {o.count !== undefined && (
              <span
                className={cn(
                  "inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-mono tabular-nums",
                  isActive ? "bg-background/60 text-foreground" : "bg-surface-2 text-muted-foreground",
                  toneCls,
                )}
              >
                {o.count > 99 ? "99+" : o.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ── ToolStatusBadge ────────────────────────────────────────────────── */

export type ToolRunStatus = "succeeded" | "failed" | "skipped" | "gated" | "degraded" | "pending";

const TOOL_STATUS_META: Record<ToolRunStatus, { label: string; icon: LucideIcon; classes: string; spin?: boolean }> = {
  succeeded: { label: "Succeeded", icon: CheckCircle2, classes: "text-[hsl(var(--confidence-high))] border-[hsl(var(--confidence-high))]/30 bg-[hsl(var(--confidence-high))]/10" },
  failed:    { label: "Failed",    icon: XCircle,      classes: "text-destructive border-destructive/30 bg-destructive/10" },
  skipped:   { label: "Skipped",   icon: MinusCircle,  classes: "text-muted-foreground border-border-subtle bg-surface-2/60" },
  gated:     { label: "Gated",     icon: Ban,          classes: "text-[hsl(var(--confidence-mid))] border-[hsl(var(--confidence-mid))]/30 bg-[hsl(var(--confidence-mid))]/10" },
  degraded:  { label: "Degraded",  icon: AlertTriangle, classes: "text-[hsl(var(--confidence-mid))] border-[hsl(var(--confidence-mid))]/30 bg-[hsl(var(--confidence-mid))]/10" },
  pending:   { label: "Running",   icon: Loader2,      classes: "text-primary border-primary/30 bg-primary/10", spin: true },
};

export function ToolStatusBadge({
  status,
  size = "sm",
  className,
}: {
  status: ToolRunStatus;
  size?: "sm" | "md";
  className?: string;
}) {
  const meta = TOOL_STATUS_META[status];
  const Icon = meta.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border font-mono uppercase tracking-[0.08em]",
        size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-[11px]",
        meta.classes,
        className,
      )}
    >
      <Icon className={cn("w-3 h-3", meta.spin && "animate-spin")} />
      {meta.label}
    </span>
  );
}

/* ── EvidenceStatusBadge ────────────────────────────────────────────── */

const EVIDENCE_TONE_CLASS: Record<EvidenceStatusTone, string> = {
  ok: "text-[hsl(var(--confidence-high))] border-[hsl(var(--confidence-high))]/30 bg-[hsl(var(--confidence-high))]/10",
  probable: "text-primary border-primary/30 bg-primary/10",
  warn: "text-[hsl(var(--confidence-mid))] border-[hsl(var(--confidence-mid))]/30 bg-[hsl(var(--confidence-mid))]/10",
  muted: "text-muted-foreground border-border-subtle bg-surface-2/60",
  danger: "text-destructive border-destructive/30 bg-destructive/10",
};

const EVIDENCE_STATUS_ICON: Record<EvidenceDisplayStatus, LucideIcon> = {
  verified: ShieldCheck,
  verified_infrastructure: Server,
  probable: CheckCircle2,
  needs_corroboration: ShieldQuestion,
  manual_review: Search,
  lead: Circle,
  shared_infrastructure: Server,
  contradicted: AlertTriangle,
  rejected: XCircle,
};

/**
 * Analyst evidence-strength chip. Always renders icon + text (never color
 * alone), so single-source/weak findings read as restrained and strong
 * findings read as clear without being overstated.
 */
export function EvidenceStatusBadge({
  status,
  label,
  tone,
  hint,
  size = "sm",
  className,
}: {
  status: EvidenceDisplayStatus;
  label: string;
  tone: EvidenceStatusTone;
  hint?: string;
  size?: "sm" | "md";
  className?: string;
}) {
  const Icon = EVIDENCE_STATUS_ICON[status];
  return (
    <span
      title={hint}
      className={cn(
        "inline-flex items-center gap-1 rounded-full border font-medium tracking-tight whitespace-nowrap",
        size === "sm" ? "px-2 py-0.5 text-[10px]" : "px-2.5 py-1 text-[11px]",
        EVIDENCE_TONE_CLASS[tone],
        className,
      )}
    >
      <Icon className="w-3 h-3 shrink-0" strokeWidth={2} />
      {label}
    </span>
  );
}

/* ── StatusLegend ───────────────────────────────────────────────────── */

/**
 * One shared status/confidence legend, rendered from the single canonical
 * `EVIDENCE_STATUS_LEGEND` vocabulary. Dropped into the findings table, the
 * evidence board, and the graph so every surface explains the same badges with
 * the same words. Opens in a popover to stay out of the way until asked for.
 */
export function StatusLegend({ className, align = "end" }: { className?: string; align?: "start" | "center" | "end" }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1 rounded-full border border-border-subtle bg-surface-2/50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground transition-colors hover:text-foreground",
            className,
          )}
          aria-label="Show evidence status legend"
        >
          <Info className="h-3 w-3" strokeWidth={2} />
          Legend
        </button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-[min(92vw,340px)] p-3">
        <div className="mb-2 text-eyebrow uppercase tracking-wider text-muted-foreground">Evidence status</div>
        <ul className="space-y-2">
          {EVIDENCE_STATUS_LEGEND.map((entry) => (
            <li key={entry.status} className="flex flex-col gap-0.5">
              <EvidenceStatusBadge status={entry.status} label={entry.label} tone={entry.tone} className="self-start" />
              <span className="text-[11px] leading-snug text-muted-foreground">{entry.hint}</span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/* ── ExpandableRow ──────────────────────────────────────────────────── */

export function ExpandableRow({
  summary,
  children,
  defaultOpen = false,
  className,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          "w-full flex items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-surface-2/50",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        )}
      >
        <ChevronRight
          className={cn("w-3.5 h-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
        />
        <div className="min-w-0 flex-1">{summary}</div>
      </button>
      {open && <div className="px-3 pb-3 pl-9">{children}</div>}
    </div>
  );
}
