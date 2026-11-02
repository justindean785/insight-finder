import { ChevronDown, Play } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { NextStepItem } from "@/components/pivots/NextSteps";

/** Rows the strip shows before "All steps" takes over. */
export const PIVOT_STRIP_ROWS = 3;

/**
 * The transcript's pivot summary on narrow screens (below the Workbench breakpoint).
 *
 * The full `NextSteps` panel (best pivot, rationale, queue, connections, run status)
 * rendered straight into the transcript and filled a phone screen after every
 * report (JD, 2026-11-02). The strip shows one compact row per runnable pivot —
 * type, target, action — and keeps the full panel one tap away.
 *
 * Nothing runs from the strip. Every Run still goes through `NextSteps`' inline
 * preview: tapping a row's Preview expands the panel with that row opened.
 */
export function PivotStrip({
  items,
  expanded,
  onExpandedChange,
  onPreview,
  children,
}: {
  items: NextStepItem[];
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  /** Open this pivot's preview inside the full panel. */
  onPreview: (key: string) => void;
  /** The full `NextSteps` panel, rendered only while expanded. */
  children: ReactNode;
}) {
  const runnable = items.filter(
    (it): it is Extract<NextStepItem, { kind: "pivot" }> & { validation: { status: "valid" } } =>
      it.kind === "pivot" && it.validation.status === "valid",
  );
  const rows = runnable.slice(0, PIVOT_STRIP_ROWS);
  if (rows.length === 0 && !expanded) {
    // No runnable pivot: one quiet line instead of a panel of generic filler.
    return (
      <div className="flex items-center justify-between rounded-lg border border-border-subtle bg-surface-2/60 px-3 py-2">
        <span className="text-[13px] text-muted-foreground">No new pivots to run.</span>
        <button
          type="button"
          onClick={() => onExpandedChange(true)}
          className="inline-flex h-8 items-center rounded-md px-2 text-[13px] text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
        >
          Details
        </button>
      </div>
    );
  }
  return (
    <section aria-label="Next pivots" data-pivot-strip className="rounded-lg border border-border-subtle bg-surface-2/60">
      <header className="flex items-center justify-between gap-2 px-3 pt-2.5 pb-1">
        <span className="text-[12px] font-medium uppercase tracking-wider text-muted-foreground">
          Next pivots{runnable.length > 0 ? ` · ${runnable.length}` : ""}
        </span>
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => onExpandedChange(!expanded)}
          className="inline-flex h-8 items-center gap-1 rounded-md px-2 text-[13px] text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
        >
          {expanded ? "Hide details" : "All steps"}
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", expanded && "rotate-180")} aria-hidden />
        </button>
      </header>
      {!expanded && (
        <ul className="divide-y divide-white/[0.05]">
          {rows.map((it) => {
            const p = it.validation.pivot;
            return (
              <li key={it.key} className="flex min-w-0 items-center gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  {/* Full width for the selector: it wraps, never truncates (DESIGN.md). */}
                  <div className="min-w-0 font-mono text-[13.5px] leading-snug text-foreground [overflow-wrap:anywhere]">{p.target}</div>
                  <div className="truncate text-[12.5px] text-muted-foreground">
                    <span className="text-faint-foreground">{p.targetType}</span>
                    <span className="mx-1.5 text-faint-foreground">·</span>
                    {p.action}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onPreview(it.key)}
                  aria-label={`Preview pivot: ${p.action} ${p.target}`}
                  className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md border border-border-subtle bg-surface-3 px-3 text-[13px] font-medium text-foreground hover:bg-surface-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Play className="h-3.5 w-3.5" aria-hidden />
                  Preview
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {expanded && <div className="px-1 pb-1">{children}</div>}
    </section>
  );
}
