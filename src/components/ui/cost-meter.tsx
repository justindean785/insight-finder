import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

function formatRounded(usd: number): string {
  if (usd <= 0) return "$0.00";
  if (usd < 0.01) return "<$0.01";
  if (usd < 1) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(2)}`;
}

function formatPrecise(usd: number): string {
  return `$${usd.toFixed(5)}`;
}

/**
 * CostMeter — compact total-spend display for the sidebar footer.
 * Tabular-mono, rounded headline, full 5-decimal precision in tooltip.
 */
export function CostMeter({
  microUsd,
  label = "Total spend",
  className,
  threadCount,
}: {
  microUsd: number;
  label?: string;
  threadCount?: number;
  className?: string;
}) {
  const usd = Number(microUsd ?? 0) / 1_000_000;
  const headline = formatRounded(usd);
  const precise = formatPrecise(usd);

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={cn(
              "flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md",
              "border border-border-subtle bg-surface-1/80",
              "transition-colors hover:border-border",
              className,
            )}
          >
            <div className="flex items-center gap-1.5 min-w-0">
              <span className="w-1.5 h-1.5 rounded-full bg-evidence/70 shrink-0" />
              <span className="text-[10px] uppercase tracking-[0.08em] text-muted-foreground truncate">
                {label}
              </span>
            </div>
            <span className="font-mono text-[12px] tabular-nums text-foreground">{headline}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" className="font-mono text-[11px]">
          <div className="space-y-0.5">
            <div>{precise}</div>
            {threadCount != null && (
              <div className="text-muted-foreground">{threadCount} investigation{threadCount === 1 ? "" : "s"}</div>
            )}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}