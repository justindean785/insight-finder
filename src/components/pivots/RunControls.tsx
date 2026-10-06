import { FileText, MoreHorizontal, Repeat } from "lucide-react";
import { cn } from "@/lib/utils";
import { AUTO_RUN_MAX_CYCLES } from "@/lib/run-controls";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Run controls — the secondary run actions, living INSIDE the composer.
 *
 * Continue is no longer here: it is the composer's own primary button while
 * the box is empty (see lib/composer-primary.ts), so a finished case shows ONE
 * primary action instead of a white Continue above a white Start investigation.
 * What remains are the two secondary actions:
 *
 *   Auto-run — keep cycling while each cycle still records new evidence
 *              (stop rules in lib/run-controls.ts)
 *   Write report — ask for the closing dossier
 *
 * Desktop gets them as quiet chips in the composer's action row; a phone gets
 * them behind one ⋯ button so the composer stays a single line. Nothing here
 * composes prompts or talks to the transport; ChatWindow owns both.
 */
type RunActionsProps = {
  busy: boolean;
  autoRunEnabled: boolean;
  autoRunCyclesRun: number;
  autoRunMaxCycles?: number;
  onToggleAutoRun: (enabled: boolean) => void;
  onWriteReport: () => void;
  className?: string;
};

const chip =
  "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-data font-medium transition-colors duration-fast " +
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

export function RunChips({
  busy, autoRunEnabled, autoRunCyclesRun, autoRunMaxCycles = AUTO_RUN_MAX_CYCLES, onToggleAutoRun, onWriteReport, className,
}: RunActionsProps) {
  return (
    <div role="group" aria-label="Investigation controls" data-testid="run-controls" className={cn("flex items-center gap-1", className)}>
      <button
        type="button"
        role="switch"
        aria-checked={autoRunEnabled}
        onClick={() => onToggleAutoRun(!autoRunEnabled)}
        disabled={busy && !autoRunEnabled}
        data-testid="run-auto"
        title="Keep running cycles while each one still finds new evidence"
        className={cn(
          chip,
          autoRunEnabled
            ? "bg-surface-4 text-foreground shadow-[inset_0_0_0_1px_hsl(var(--brand)/0.5)]"
            : "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground",
        )}
      >
        <Repeat className={cn("h-3.5 w-3.5", autoRunEnabled && busy && "animate-spin motion-reduce:animate-none")} aria-hidden />
        {autoRunEnabled ? (
          <>
            Auto-run
            <span className="font-mono tabular-nums text-muted-foreground">
              {Math.min(autoRunCyclesRun, autoRunMaxCycles)}/{autoRunMaxCycles}
            </span>
          </>
        ) : (
          <>Auto-run ×{autoRunMaxCycles}</>
        )}
      </button>
      <button
        type="button"
        onClick={onWriteReport}
        disabled={busy}
        data-testid="run-report"
        className={cn(chip, "text-muted-foreground hover:bg-white/[0.05] hover:text-foreground")}
      >
        <FileText className="h-3.5 w-3.5" aria-hidden />
        Write report
      </button>
    </div>
  );
}

export function RunMenu({
  busy, autoRunEnabled, autoRunCyclesRun, autoRunMaxCycles = AUTO_RUN_MAX_CYCLES, onToggleAutoRun, onWriteReport, className,
}: RunActionsProps) {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={autoRunEnabled
            ? `Run options, Auto-run on (${Math.min(autoRunCyclesRun, autoRunMaxCycles)} of ${autoRunMaxCycles})`
            : "Run options"}
          className={cn(
            "relative grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors duration-fast hover:bg-white/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            className,
          )}
        >
          <MoreHorizontal className="h-5 w-5" aria-hidden />
          {autoRunEnabled && (
            <span aria-hidden className="absolute right-2 top-2 h-1.5 w-1.5 rounded-full bg-[hsl(var(--brand))]" />
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="end" sideOffset={6} className="w-64 rounded-xl border-border bg-[hsl(var(--popover))] p-1 shadow-overlay">
        <DropdownMenuCheckboxItem
          checked={autoRunEnabled}
          disabled={busy && !autoRunEnabled}
          onCheckedChange={(v) => onToggleAutoRun(Boolean(v))}
          className="min-h-12 rounded-lg text-[14.5px]"
        >
          <span className="flex flex-col">
            <span>Auto-run ×{autoRunMaxCycles}</span>
            <span className="text-micro text-muted-foreground">Keep cycling while new evidence appears</span>
          </span>
        </DropdownMenuCheckboxItem>
        <DropdownMenuItem disabled={busy} onSelect={onWriteReport} className="min-h-12 gap-2.5 rounded-lg pl-8 text-[14.5px]">
          <FileText className="h-4 w-4" aria-hidden />
          Write report
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
