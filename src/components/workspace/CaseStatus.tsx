import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCaseSnapshot, type CaseSnapshot } from "@/hooks/useCaseSnapshot";
import { describeCaseChanges, shouldAnnounceChanges, type CaseRunState } from "@/lib/case-snapshot";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Wall-clock for a sync stamp: "04:02". The tooltip carries the full timestamp. */
function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fullStamp(ms: number): string {
  const d = new Date(ms);
  return `${d.toLocaleString()} (${d.toISOString().replace("T", " ").slice(0, 19)} UTC)`;
}

const PILL_TONE: Record<CaseRunState, string> = {
  running: "border-[hsl(var(--info)/0.4)] bg-[hsl(var(--info)/0.1)] text-[hsl(var(--info))]",
  completed: "border-[hsl(var(--confidence-high)/0.3)] bg-[hsl(var(--confidence-high)/0.08)] text-[hsl(var(--confidence-high))]",
  interrupted: "border-[hsl(var(--warning)/0.45)] bg-[hsl(var(--warning)/0.1)] text-[hsl(var(--warning))]",
  stopped: "border-border-strong bg-surface-3 text-foreground/85",
  draft: "border-border bg-surface-2 text-muted-foreground",
};

const DOT_TONE: Record<CaseRunState, string> = {
  running: "bg-[hsl(var(--info))] case-live-dot",
  completed: "bg-[hsl(var(--confidence-high))]",
  interrupted: "bg-[hsl(var(--warning))]",
  stopped: "",
  draft: "bg-muted-foreground/60",
};

/**
 * Elapsed since a UTC-stringified start timestamp — "3s", "47s", "2m", "14m",
 * "1h", "4h". Returns null when `startedAtIso` is unusable; callers omit the
 * sub-label in that case rather than fabricate a number (JD's requirement
 * — audit §5 + the Stage 1b scope).
 */
function formatElapsed(nowMs: number, startedAtIso: string | null): string | null {
  if (!startedAtIso) return null;
  const startedMs = Date.parse(startedAtIso);
  if (!Number.isFinite(startedMs)) return null;
  const secs = Math.max(0, Math.floor((nowMs - startedMs) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h`;
}

/**
 * The run's state as one pill: dot (or stop mark) + word. Never colour alone —
 * every state carries its own label, and `stopped` uses a square rather than a
 * dot so it cannot be mistaken for a paused "complete".
 *
 * When state is "running" and `run_started_at` is a parseable timestamp, the
 * label is `Analyzing · Xs|Xm|Xh` where X is the actual elapsed interval. If
 * `run_started_at` is null (the backend hasn't stamped a start yet), the pill
 * renders "Analyzing" with no elapsed — this is the audit's §5 requirement
 * (never fabricate an interval from page-open or first-tool time).
 */
export function CaseStatusPill({ snapshot, className }: { snapshot: CaseSnapshot | null; className?: string }) {
  // Tick every second only while a run is live, so a mounted pill updates its
  // elapsed label without a snapshot refresh. The tick is a no-op outside the
  // running state, so idle pills never schedule intervals.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const isRunning = snapshot?.hydrated && snapshot.run.state === "running";
  useEffect(() => {
    if (!isRunning) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [isRunning]);

  if (!snapshot || !snapshot.hydrated) {
    return (
      <span
        className={cn(
          "inline-flex h-5 items-center gap-1.5 rounded-full border border-border bg-surface-2 px-2 text-data font-medium text-muted-foreground",
          className,
        )}
      >
        <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden />
        Syncing case…
      </span>
    );
  }
  const state = snapshot.run.state;
  // Running pill carries "Analyzing" + the measured elapsed when startedAt is
  // parseable; otherwise falls back to the plain word. Non-running states keep
  // the authoritative label from the snapshot — "Ready", "Complete",
  // "Interrupted", "Stopped" — unchanged.
  const label = state === "running"
    ? (() => {
        // `state` can be "running" from this tab's open stream before the row is
        // re-read; until the row itself says running, `startedAt` is the
        // PREVIOUS run's start and would print a days-long elapsed.
        const elapsed = snapshot.run.rowState === "running" ? formatElapsed(nowMs, snapshot.run.startedAt) : null;
        return elapsed ? `Analyzing · ${elapsed}` : "Analyzing";
      })()
    : snapshot.run.label;
  return (
    <span
      data-run-state={state}
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full border px-2 text-data font-semibold",
        PILL_TONE[state],
        className,
      )}
    >
      {state === "stopped"
        ? <Square className="h-2 w-2 fill-current" aria-hidden />
        : <span aria-hidden className={cn("h-1.5 w-1.5 rounded-full", DOT_TONE[state])} />}
      {label}
    </span>
  );
}

/** How long a fresh update keeps its "Updated" highlight. */
const UPDATE_HIGHLIGHT_MS = 9_000;

/**
 * Sync provenance for the case: when it was last read in full, whether it is
 * reading now, what just changed — and a Refresh that re-reads every source
 * without starting anything.
 *
 * Owns the case's polite live region, so an analyst on a screen reader hears
 * a status transition ("Status Interrupted → Complete") and a reconciliation
 * ("Tools 46 → 48") the moment it lands, without chatter during a live run.
 */
export function CaseSyncStatus({ className, compact = false }: { className?: string; compact?: boolean }) {
  const { snapshot, refresh } = useCaseSnapshot();
  const [busy, setBusy] = useState(false);
  const [highlight, setHighlight] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const lastAt = useRef<number | null>(null);

  const change = snapshot?.lastChange ?? null;
  useEffect(() => {
    if (!change || !snapshot || change.at === lastAt.current) return;
    lastAt.current = change.at;
    setHighlight(true);
    if (shouldAnnounceChanges(change.changes, snapshot)) {
      setAnnouncement(`Case updated at ${clock(change.at)}. ${describeCaseChanges(change.changes)}.`);
    }
    const t = setTimeout(() => setHighlight(false), UPDATE_HIGHLIGHT_MS);
    return () => clearTimeout(t);
  }, [change, snapshot]);

  const onRefresh = async () => {
    if (busy) return;
    setBusy(true);
    try { await refresh(); } finally { setBusy(false); }
  };

  const syncing = busy || Boolean(snapshot?.syncing) || !snapshot?.hydrated;
  const syncedAt = snapshot?.syncedAt ?? null;

  let label: string;
  let detail: string;
  if (!snapshot?.hydrated) {
    label = "Syncing case…";
    detail = "Reading this case from the server. Figures appear once every source has answered.";
  } else if (syncing) {
    label = "Syncing…";
    detail = "Re-reading every source. The figures shown are the last complete version until this finishes.";
  } else if (snapshot.syncError) {
    label = syncedAt ? `Sync failed · ${clock(syncedAt)}` : "Sync failed";
    detail = "The last refresh did not read every source. Each figure shown is from its source's last successful read.";
  } else if (highlight && change) {
    label = `Updated ${clock(change.at)}`;
    detail = `Case updated: ${describeCaseChanges(change.changes)}.`;
  } else {
    // One word for "the figures are current as of": "Updated". A second word
    // ("Synced") for the same fact read as a different state beside it.
    label = syncedAt ? `Updated ${clock(syncedAt)}` : "Up to date";
    detail = syncedAt ? `Last read in full ${fullStamp(syncedAt)}.` : "Read from the server.";
  }

  return (
    <div className={cn("flex min-w-0 items-center gap-1", className)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            tabIndex={0}
            className={cn(
              "inline-flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 font-mono text-micro tabular-nums outline-none",
              "focus-visible:ring-2 focus-visible:ring-ring",
              snapshot?.syncError ? "text-[hsl(var(--warning))]" : highlight ? "text-[hsl(var(--intel-blue))]" : "text-muted-foreground",
            )}
          >
            {highlight && !syncing && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-[hsl(var(--intel-blue))]" />}
            <span className={cn("truncate", compact && "max-w-[8.5rem]")}>{label}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[280px] text-xs leading-relaxed">{detail}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={onRefresh}
            disabled={syncing}
            aria-label="Refresh case data"
            className={cn(
              "grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors coarse:h-11 coarse:w-11",
              "hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              "disabled:cursor-default disabled:opacity-70",
            )}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", syncing && "animate-spin motion-reduce:animate-none")} aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="max-w-[240px] text-xs">Re-read this case from the server. Does not start a run.</TooltipContent>
      </Tooltip>
      {/* The case's one polite live region. Kept mounted and empty-by-default so
          assistive tech registers it before the first announcement. */}
      <span role="status" aria-live="polite" aria-atomic="true" className="sr-only">{announcement}</span>
    </div>
  );
}
