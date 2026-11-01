import { timeAgo } from "@/lib/time";
import {
  endingLabel,
  formatDuration,
  formatTokens,
  formatUsd,
  splitRunTime,
  type EndingTone,
  type InvocationRow,
} from "@/lib/run-economics";
import type { RunEconomicsState } from "@/hooks/useRunEconomics";
import { RECENT_RUN_LIMIT, RUN_ROW_LIMIT, RUN_WINDOW_DAYS } from "@/hooks/useRunEconomics";

const TONE_COLOR: Record<EndingTone, string> = {
  ok: "hsl(var(--brain-status-ok))",
  info: "hsl(var(--muted-foreground))",
  warn: "hsl(var(--brain-status-warn))",
  bad: "hsl(var(--brain-status-bad))",
};

const pct = (share: number | null) => (share == null ? "—" : `${Math.round(share * 100)}%`);
const usdFromMicro = (m: number | null) => formatUsd(m == null ? null : m / 1_000_000);

function Tile({ testId, label, value, sub }: { testId: string; label: string; value: string; sub: string }) {
  return (
    <div className="rounded-xl p-4 bg-brain-card border border-brain-border" data-testid={testId}>
      <div className="text-eyebrow uppercase tracking-wider font-mono text-muted-foreground">{label}</div>
      <div className="stat-figure font-display text-2xl font-semibold mt-1.5">{value}</div>
      <div className="text-xs text-muted-foreground mt-1 leading-snug">{sub}</div>
    </div>
  );
}

function EndingBadge({ stopReason }: { stopReason: string | null }) {
  const e = endingLabel(stopReason);
  return (
    <span
      className="px-1.5 py-px rounded border font-mono text-micro uppercase tracking-wider"
      style={{ color: TONE_COLOR[e.tone], borderColor: `color-mix(in srgb, ${TONE_COLOR[e.tone]} 40%, transparent)` }}
    >
      {e.label}
    </span>
  );
}

/** Where the run's wall time went, as a bar plus the same numbers as text. */
function TimeSplit({ run }: { run: InvocationRow }) {
  const split = splitRunTime(run);
  if (!split) {
    return <div className="text-xs text-muted-foreground/80">Time split not recorded for this run.</div>;
  }
  const total = split.totalMs;
  const w = (ms: number) => (total > 0 ? `${(ms / total) * 100}%` : "0%");
  const legend = `loop ${formatDuration(split.loopMs)} · report salvage ${formatDuration(split.salvageMs)} · other ${formatDuration(split.persistOtherMs)}`;
  return (
    <div>
      <div role="img" aria-label={legend} className="flex h-1.5 w-full overflow-hidden rounded bg-white/5">
        <div style={{ width: w(split.loopMs), backgroundColor: "hsl(var(--primary) / 0.55)" }} />
        <div style={{ width: w(split.salvageMs), backgroundColor: "hsl(var(--brain-status-warn))" }} />
        <div style={{ width: w(split.persistOtherMs), backgroundColor: "hsl(var(--muted-foreground) / 0.6)" }} />
      </div>
      <div className="text-xs text-muted-foreground mt-1 tabular-nums">{legend}</div>
    </div>
  );
}

export function RunEconomicsPanel({
  state,
  titles,
  onOpenCase,
}: {
  state: RunEconomicsState;
  titles: Map<string, string>;
  onOpenCase: (threadId: string) => void;
}) {
  const { loading, error, summary, recent, tokens, truncated } = state;
  // A capped read must not wear the full window's label.
  const windowLabel = truncated ? `newest ${RUN_ROW_LIMIT.toLocaleString()} runs` : `last ${RUN_WINDOW_DAYS} days`;

  return (
    <section aria-labelledby="run-economics-title" data-testid="run-economics" className="space-y-3">
      <h2 id="run-economics-title" className="text-eyebrow uppercase tracking-wider text-muted-foreground">
        Run economics · {windowLabel}
      </h2>
      <p className="text-xs text-muted-foreground leading-relaxed">
        Cost is the app&apos;s internal meter: model tokens at flat rates plus tool charges. It is not a provider
        invoice. Only runs that finished are recorded; a run that stopped before finishing leaves no row, so these
        figures cover finished runs only.
      </p>

      {loading ? (
        <div className="rounded-xl bg-brain-card border border-brain-border p-6 text-sm text-muted-foreground">Loading…</div>
      ) : error ? (
        <div role="alert" data-testid="run-econ-error" className="rounded-xl bg-brain-card border border-brain-border p-6 text-sm text-muted-foreground">
          Run data could not be read ({error}). Nothing is shown rather than a figure that might be wrong.
        </div>
      ) : summary.runs === 0 ? (
        <div data-testid="run-econ-empty" className="rounded-xl bg-brain-card border border-brain-border p-6 text-sm text-muted-foreground">
          No finished runs in the last {RUN_WINDOW_DAYS} days.
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Tile
              testId="run-econ-spend30"
              label={`Spend · ${truncated ? windowLabel : `${RUN_WINDOW_DAYS} days`}`}
              value={formatUsd(summary.spend30Usd)}
              sub={`${formatUsd(summary.spend14Usd)} in the last 14 days${
                summary.costUnknownRuns > 0
                  ? `. ${summary.costUnknownRuns} run${summary.costUnknownRuns === 1 ? "" : "s"} had no recorded cost and ${summary.costUnknownRuns === 1 ? "is" : "are"} left out.`
                  : ""
              }`}
            />
            <Tile
              testId="run-econ-avg"
              label="Average per run"
              value={formatUsd(summary.avgRunUsd)}
              sub={`${summary.runs - summary.costUnknownRuns} of ${summary.runs} runs have a recorded cost`}
            />
            <Tile
              testId="run-econ-forced"
              label="Ended at the time limit"
              value={pct(summary.forcedShare)}
              sub="of runs with a recorded ending. The report is then forced; the run did not fail."
            />
            <Tile
              testId="run-econ-salvage"
              label="Report salvage time"
              value={pct(summary.salvageShareOfTime)}
              sub={`of run time, over ${summary.timedRuns} timed run${summary.timedRuns === 1 ? "" : "s"}: a second call that writes the report afterwards`}
            />
          </div>

          <div className="rounded-xl bg-brain-card border border-brain-border overflow-hidden">
            <div className="px-5 py-3 border-b border-brain-border text-eyebrow uppercase tracking-wider font-mono text-muted-foreground">
              Recent runs
            </div>
            <ul>
              {recent.map((r) => {
                const t = tokens.get(r.id);
                return (
                  <li key={r.id} data-testid="run-row" className="px-5 py-3 border-t border-brain-border/60 first:border-t-0 space-y-1.5">
                    <div className="flex items-baseline justify-between gap-3">
                      <button
                        onClick={() => onOpenCase(r.thread_id)}
                        className="text-foreground hover:text-primary text-left truncate min-w-0"
                      >
                        {titles.get(r.thread_id) ?? "Untitled case"}
                      </button>
                      <span className="font-mono tabular-nums text-foreground shrink-0">
                        {r.credits_micro_usd == null ? (
                          <span className="text-xs text-muted-foreground">cost not recorded</span>
                        ) : (
                          usdFromMicro(r.credits_micro_usd)
                        )}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground tabular-nums">
                      <span>{timeAgo(r.started_at)}</span>
                      <span>{formatDuration(r.duration_ms)}</span>
                      <span>
                        {r.step_count ?? "—"} steps · {r.tool_call_count ?? "—"} tools
                      </span>
                      <span>
                        {t
                          ? `${formatTokens(t.input)}${t.partial ? "+" : ""} in · ${formatTokens(t.output)}${t.partial ? "+" : ""} out${t.partial ? " (some steps had no usage)" : ""}`
                          : "tokens —"}
                      </span>
                      {r.model_id && <span className="font-mono">{r.model_id}</span>}
                      <EndingBadge stopReason={r.stop_reason} />
                    </div>
                    <TimeSplit run={r} />
                  </li>
                );
              })}
            </ul>
          </div>
          {(truncated || summary.runs > RECENT_RUN_LIMIT) && (
            <p className="text-xs text-muted-foreground">
              Listing the {Math.min(recent.length, RECENT_RUN_LIMIT)} most recent of {summary.runs.toLocaleString()} runs
              {truncated ? `. The read stopped at ${RUN_ROW_LIMIT.toLocaleString()} runs, so every figure above covers only the newest ${RUN_ROW_LIMIT.toLocaleString()}` : " in the window"}.
            </p>
          )}
        </>
      )}
    </section>
  );
}
