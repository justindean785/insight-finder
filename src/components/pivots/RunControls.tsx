import { FileText, Play, Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AUTO_RUN_MAX_CYCLES } from "@/lib/run-controls";

/**
 * Run controls — one row above the composer once a turn has finished.
 *
 *   [▶ Continue]  [⟳ Auto-run · 2/3]  [▤ Write report]
 *
 * Continue sends the next-cycle prompt. Auto-run keeps sending it while each
 * cycle still records new evidence (see lib/run-controls.ts for the stop
 * rules). Write report asks for the closing dossier — the one time the full
 * report is wanted. Nothing here composes prompts or talks to the transport;
 * ChatWindow owns both.
 */
export function RunControls({
  busy,
  autoRunEnabled,
  autoRunCyclesRun,
  autoRunMaxCycles = AUTO_RUN_MAX_CYCLES,
  onContinue,
  onToggleAutoRun,
  onWriteReport,
}: {
  busy: boolean;
  autoRunEnabled: boolean;
  autoRunCyclesRun: number;
  autoRunMaxCycles?: number;
  onContinue: () => void;
  onToggleAutoRun: (enabled: boolean) => void;
  onWriteReport: () => void;
}) {
  return (
    <section
      aria-label="Investigation controls"
      data-testid="run-controls"
      className="ws-panel-enter mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-white/[0.08] bg-surface-1 px-3 py-2"
    >
      <Button
        type="button"
        size="sm"
        onClick={onContinue}
        disabled={busy}
        data-testid="run-continue"
        className="gap-1.5"
      >
        <Play className="h-3.5 w-3.5" aria-hidden />
        Continue
      </Button>
      <Button
        type="button"
        size="sm"
        variant={autoRunEnabled ? "secondary" : "outline"}
        role="switch"
        aria-checked={autoRunEnabled}
        onClick={() => onToggleAutoRun(!autoRunEnabled)}
        disabled={busy && !autoRunEnabled}
        data-testid="run-auto"
        className={cn("gap-1.5", autoRunEnabled && "ring-1 ring-primary/50")}
      >
        <Repeat className={cn("h-3.5 w-3.5", autoRunEnabled && busy && "animate-spin")} aria-hidden />
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
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={onWriteReport}
        disabled={busy}
        data-testid="run-report"
        className="gap-1.5"
      >
        <FileText className="h-3.5 w-3.5" aria-hidden />
        Write report
      </Button>
      <span className="ml-auto hidden text-micro text-muted-foreground sm:inline">
        Each cycle runs the next best pivots and reports only what is new.
      </span>
    </section>
  );
}
