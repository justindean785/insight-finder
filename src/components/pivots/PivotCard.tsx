import type { DisplayPivot, PivotPriority } from "@/lib/pivot-engine";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ArrowRight, CheckSquare, Copy, EyeOff, Play, Square } from "lucide-react";

/**
 * Single, shared pivot primitive used by BOTH the chat "Next steps" rail
 * (compact horizontal cards) and the Evidence → Pivots tab (full grid cards).
 *
 * Visuals stay on the matte-glass system. The priority accent uses the working
 * confidence tokens (--confidence-high / --confidence-mid) rather than the
 * collided --primary/--accent gradient so the accent actually reads.
 */

const PRIORITY_BAR: Record<PivotPriority, string> = {
  high: "bg-[hsl(var(--confidence-high))]",
  medium: "bg-[hsl(var(--confidence-mid))]",
  low: "bg-muted",
};

export type PivotCardProps = {
  pivot: DisplayPivot;
  onRun: () => void;
  onCopy?: () => void;
  onSkip?: () => void;
  onSelect?: () => void;
  selected?: boolean;
  index: number;
  compact?: boolean;
};

export function PivotCard({
  pivot,
  onRun,
  onCopy,
  onSkip,
  onSelect,
  selected,
  index,
  compact,
}: PivotCardProps) {
  const searched = pivot.status === "searched";
  return (
    <div
      className={cn(
        "group relative shrink-0 snap-start overflow-hidden rounded-xl glass border border-border-subtle p-3",
        "transition-all duration-300 hover:-translate-y-0.5 hover:border-primary/50 hover:ring-glow animate-pivot-in",
        compact && "w-[260px]",
        searched && "opacity-70",
      )}
      style={{ animationDelay: `${Math.min(index * 40, 320)}ms` }}
    >
      {/* Priority accent bar — confidence tokens, not the flat primary gradient. */}
      <span
        className={cn("absolute left-0 inset-y-2 w-0.5 rounded-full", PRIORITY_BAR[pivot.priority])}
        aria-hidden
      />

      <div className="pl-2 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            {onSelect && (
              <button
                type="button"
                onClick={onSelect}
                aria-label={selected ? "Deselect pivot" : "Select pivot"}
                className="shrink-0 text-muted-foreground hover:text-primary"
              >
                {selected
                  ? <CheckSquare className="w-3.5 h-3.5 text-primary" />
                  : <Square className="w-3.5 h-3.5" />}
              </button>
            )}
            <span className={`pivot-priority pivot-priority--${pivot.priority}`}>{pivot.priority}</span>
            <span className="truncate text-[10px] uppercase tracking-[0.14em] text-muted-foreground font-mono">
              {pivot.type} · {pivot.source}
            </span>
          </div>
          <span
            className={cn(
              "shrink-0 px-1.5 py-0.5 rounded border font-mono text-eyebrow uppercase tracking-wider",
              pivot.status === "new"
                ? "text-primary border-primary/40 bg-primary/10"
                : "text-muted-foreground border-border bg-secondary/40",
            )}
          >
            {pivot.status}
          </span>
        </div>

        <div className="text-sm font-semibold text-foreground leading-snug group-hover:text-primary transition-colors">
          {pivot.actionLabel}
        </div>
        <div className="font-mono text-xs text-foreground/88 break-all">{pivot.value}</div>
        {pivot.reason && (
          <div className="text-xs text-muted-foreground line-clamp-2">{pivot.reason}</div>
        )}

        <div className="flex items-center justify-between gap-1 pt-0.5">
          <Button
            size="sm"
            onClick={onRun}
            className="h-7 px-2.5 gap-1 text-data bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Play className="w-3 h-3 fill-current" /> Run <ArrowRight className="w-3 h-3" />
          </Button>
          <div className="flex items-center gap-1">
            {onCopy && (
              <Button size="sm" variant="ghost" className="h-6 px-2 gap-1 text-data hover:text-primary" onClick={onCopy}>
                <Copy className="w-3 h-3" /> Copy
              </Button>
            )}
            {onSkip && (
              <Button size="sm" variant="ghost" className="h-6 px-2 gap-1 text-data" onClick={onSkip}>
                <EyeOff className="w-3 h-3" /> Skip
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
