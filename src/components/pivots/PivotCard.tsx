import { useId } from "react";
import type { DisplayPivot } from "@/lib/pivot-engine";
import type { PivotEligibility, PivotValidation, RunnablePivot } from "@/lib/pivot-schema";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { ArrowRight, Copy, EyeOff } from "lucide-react";
import { PivotPreview, RepairNotice } from "@/components/pivots/PivotPreview";

export type PivotCardProps = {
  pivot: DisplayPivot;
  validation: PivotValidation;
  eligibility: PivotEligibility | null;
  /** Whether a run can be dispatched from this page at all. */
  canRun: boolean;
  open: boolean;
  onToggleOpen: () => void;
  onStart: (pivot: RunnablePivot) => void;
  onCopy?: () => void;
  onSkip?: () => void;
  onSelect?: (checked: boolean) => void;
  selected?: boolean;
  busy?: boolean;
};

/**
 * One pivot in the Evidence › Pivots grid.
 *
 * A real checkbox for selection (it was a button drawing a square icon, with no
 * checked state for assistive tech), no priority side-stripe, and a Run that
 * opens the inline preview instead of starting work. A suggestion that failed
 * validation renders as "needs repair" and has no Run at all.
 */
export function PivotCard({
  pivot,
  validation,
  eligibility,
  canRun,
  open,
  onToggleOpen,
  onStart,
  onCopy,
  onSkip,
  onSelect,
  selected,
  busy,
}: PivotCardProps) {
  const checkboxId = useId();
  const searched = pivot.status === "searched";

  if (validation.status === "invalid") {
    return (
      <div className="rounded-xl border border-dashed border-white/[0.1] bg-surface-1/60 p-3">
        <RepairNotice action={validation.action} target={validation.target} problems={validation.problems} />
        {onSkip && (
          <div className="mt-2 flex justify-end">
            <button type="button" onClick={onSkip} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-data text-muted-foreground hover:bg-white/[0.04] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <EyeOff className="h-3.5 w-3.5" aria-hidden /> Hide
            </button>
          </div>
        )}
      </div>
    );
  }

  const blocked = eligibility ? !eligibility.runnable : false;

  return (
    <div
      className={cn(
        "rounded-xl border bg-surface-1 p-3 transition-[border-color,background-color] duration-fast ease-standard",
        open ? "border-[hsl(var(--brand)/0.4)]" : "border-white/[0.08] hover:border-border-strong",
      )}
    >
      <div className="flex items-center gap-2">
        {onSelect && (
          <Checkbox
            id={checkboxId}
            checked={Boolean(selected)}
            onCheckedChange={(v) => onSelect(v === true)}
            aria-label={`Select pivot ${pivot.value}`}
          />
        )}
        <span className={`pivot-priority pivot-priority--${pivot.priority}`}>{pivot.priority}</span>
        <span className="min-w-0 truncate text-micro text-muted-foreground">{pivot.type} · {pivot.source}</span>
        <span
          className={cn(
            "ml-auto shrink-0 rounded border px-1.5 text-micro",
            searched ? "border-white/10 text-muted-foreground" : "border-[hsl(var(--brand)/0.35)] text-[hsl(var(--intel-blue))]",
          )}
        >
          {searched ? "searched" : "new"}
        </span>
      </div>

      <div className="mt-2 text-[14px] font-medium leading-snug text-foreground">{pivot.actionLabel}</div>
      <div className="mt-0.5 break-all font-mono text-[13px] text-foreground/85">{pivot.value}</div>
      {pivot.reason && <p className="mt-1 line-clamp-3 text-[13px] leading-snug text-muted-foreground">{pivot.reason}</p>}
      {blocked && eligibility && (
        <p className="mt-1 text-[13px] leading-snug text-[hsl(var(--danger))]">{eligibility.blockers.join(" ")}</p>
      )}

      <div className="mt-2.5 flex items-center justify-between gap-1">
        <button
          type="button"
          onClick={onToggleOpen}
          disabled={blocked || !canRun}
          aria-expanded={open}
          title={!canRun ? "Open this case in Investigate to run pivots" : undefined}
          className={cn(
            "inline-flex h-8 items-center gap-1 rounded-md border px-2.5 text-data font-medium transition-colors duration-fast [@media(pointer:coarse)]:h-11",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            blocked || !canRun
              ? "cursor-not-allowed border-white/[0.06] text-muted-foreground/60"
              : open
                ? "border-[hsl(var(--brand)/0.5)] bg-white/[0.06] text-foreground"
                : "border-white/12 bg-white/[0.04] text-foreground/90 hover:bg-white/[0.08]",
          )}
        >
          {open ? "Close" : searched ? "Run again" : "Run"}
          {!open && <ArrowRight className="h-3.5 w-3.5 opacity-70" aria-hidden />}
        </button>
        <div className="flex items-center gap-0.5">
          {onCopy && (
            <button type="button" onClick={onCopy} aria-label={`Copy ${pivot.value}`} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-data text-muted-foreground transition-colors duration-fast hover:bg-white/[0.04] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11">
              <Copy className="h-3.5 w-3.5" aria-hidden /> Copy
            </button>
          )}
          {onSkip && (
            <button type="button" onClick={onSkip} aria-label={`Skip ${pivot.value}`} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-data text-muted-foreground transition-colors duration-fast hover:bg-white/[0.04] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11">
              <EyeOff className="h-3.5 w-3.5" aria-hidden /> Skip
            </button>
          )}
        </div>
      </div>

      {open && eligibility && (
        <PivotPreview
          pivot={validation.pivot}
          eligibility={eligibility}
          busy={busy}
          onCancel={onToggleOpen}
          onStart={() => onStart(validation.pivot)}
        />
      )}
    </div>
  );
}
