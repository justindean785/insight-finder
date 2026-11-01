import {
  FAILURE_CLASS_LABEL,
  FAILURE_CLASS_ORDER,
  OBSERVATION_RECENT_DAYS,
  OBSERVATION_WINDOW_DAYS,
  describeAttention,
  type FailureClass,
  type ToolObservation,
} from "@/lib/tool-observation-classes";
import { OBSERVATION_ROW_LIMIT, type ToolObservationsState } from "@/hooks/useToolObservations";

// Kinds are told apart by TEXT first (every bar segment is listed in words beside it), colour second.
const CLASS_COLOR: Record<FailureClass, string> = {
  credential_plan: "hsl(var(--primary))",
  transport: "hsl(var(--brain-status-warn))",
  rate_limited: "hsl(var(--muted-foreground))",
  input_rejected: "hsl(var(--brain-status-bad))",
  other: "hsl(var(--muted-foreground) / 0.5)",
};
const OK_COLOR = "hsl(var(--brain-status-ok))";

/** Tools listed before the rest fold behind a disclosure; one account measured 87 tools. */
export const OBS_VISIBLE_ROWS = 12;

function kindList(o: ToolObservation): string {
  const parts = [`${o.ok} succeeded`];
  for (const k of FAILURE_CLASS_ORDER) if (o.classes[k] > 0) parts.push(`${o.classes[k]} ${FAILURE_CLASS_LABEL[k].toLowerCase()}`);
  if (o.skipped) parts.push(`${o.skipped} skipped (not counted)`);
  if (o.empty) parts.push(`${o.empty} no-record (not counted)`);
  return parts.join(" · ");
}

function StackedBar({ o }: { o: ToolObservation }) {
  const total = o.attempts;
  if (total === 0) return <div className="h-1.5 rounded-full bg-white/5" />;
  const seg = (n: number, color: string, key: string) =>
    n > 0 ? <div key={key} style={{ width: `${(n / total) * 100}%`, background: color }} /> : null;
  return (
    <div role="img" aria-label={kindList(o)} className="flex h-1.5 w-full overflow-hidden rounded-full bg-white/5">
      {seg(o.ok, OK_COLOR, "ok")}
      {FAILURE_CLASS_ORDER.map((k) => seg(o.classes[k], CLASS_COLOR[k], k))}
    </div>
  );
}

function Count({ testId, label, value }: { testId: string; label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border-subtle bg-surface-1/60 px-2.5 py-1.5" data-testid={testId}>
      <div className="text-eyebrow uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className="font-mono text-data tabular-nums text-foreground">{value.toLocaleString()}</div>
    </div>
  );
}

function ToolRow({ o }: { o: ToolObservation }) {
  return (
    <li data-testid="obs-row" data-tool={o.tool} className="px-3 py-2.5 space-y-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-xs text-foreground truncate min-w-0">{o.tool}</span>
        <span className="font-mono text-data tabular-nums text-muted-foreground shrink-0">
          {o.reliability === null ? "no real attempts" : `${o.reliability}% of ${o.attempts}`}
        </span>
      </div>
      <StackedBar o={o} />
      <div className="text-xs text-muted-foreground leading-snug">{kindList(o)}</div>
    </li>
  );
}

export function ToolObservationsPanel({ state }: { state: ToolObservationsState }) {
  const { loading, error, summary, truncated } = state;
  const flagged = summary.tools.filter((t) => t.attention);
  const refusalFlagged = flagged.some((t) => t.dominantClass === "credential_plan");
  const windowLabel = truncated ? `newest ${OBSERVATION_ROW_LIMIT.toLocaleString()} calls` : `last ${OBSERVATION_WINDOW_DAYS} days`;

  return (
    <section aria-labelledby="tool-obs-title" data-testid="tool-observations" className="space-y-3">
      <h2 id="tool-obs-title" className="text-eyebrow uppercase tracking-wider text-muted-foreground">
        What works, what doesn&apos;t · {windowLabel} · every tool
      </h2>
      <p className="text-xs text-muted-foreground leading-relaxed">
        Built from every live tool call. Reliability is successes ÷ real attempts. Skipped calls and valid
        &ldquo;no record&rdquo; results are shown but never counted for or against a tool, and cache hits are not
        attempts. Failure kinds are read from the status code and the error text, so treat them as a guide.
        A flag is an observation only: it changes nothing and tells no run what to do.
      </p>

      {loading ? (
        <div className="rounded-xl border border-border-subtle bg-surface-1/40 p-6 text-center text-xs text-muted-foreground">Reading tool outcomes…</div>
      ) : error ? (
        <div role="alert" data-testid="obs-error" className="rounded-xl border border-border-subtle bg-surface-1/40 p-6 text-xs text-muted-foreground">
          Tool outcomes could not be read ({error}). Nothing is listed rather than a list that might look healthier than it is.
        </div>
      ) : summary.tools.length === 0 ? (
        <div data-testid="obs-empty" className="rounded-xl border border-border-subtle bg-surface-1/40 p-6 text-center text-xs text-muted-foreground">
          No tool calls in the last {OBSERVATION_WINDOW_DAYS} days.
        </div>
      ) : (
        <>
          <div className="flex gap-2 flex-wrap">
            <Count testId="obs-total-tools" label="Tools used" value={summary.totals.tools} />
            <Count testId="obs-total-attempts" label="Real attempts" value={summary.totals.attempts} />
            <Count testId="obs-total-failed" label="Failed" value={summary.totals.failed} />
            {FAILURE_CLASS_ORDER.filter((k) => summary.totals.classes[k] > 0).map((k) => (
              <Count key={k} testId={`obs-class-${k}`} label={FAILURE_CLASS_LABEL[k]} value={summary.totals.classes[k]} />
            ))}
          </div>

          <div className="rounded-xl border border-border-subtle bg-surface-1/40 overflow-hidden">
            <div className="px-3 py-2 border-b border-border-subtle/60 text-eyebrow font-mono uppercase tracking-wider text-muted-foreground">
              Needs attention · <span data-testid="obs-flagged-count" className="text-foreground tabular-nums">{flagged.length}</span>
            </div>
            {flagged.length === 0 ? (
              <div data-testid="obs-none-flagged" className="p-4 text-xs text-muted-foreground">
                No tool has failed at least 60% of 5 or more real attempts across 2 or more cases in the last {OBSERVATION_RECENT_DAYS} days.
              </div>
            ) : (
              <ul className="divide-y divide-border-subtle/40">
                {flagged.map((t) => (
                  <li key={t.tool} data-testid="obs-flagged" data-tool={t.tool} className="px-3 py-2.5">
                    <div className="font-mono text-xs text-foreground">{t.tool}</div>
                    <div className="text-xs text-muted-foreground mt-0.5">{describeAttention(t)}</div>
                  </li>
                ))}
              </ul>
            )}
            {refusalFlagged && (
              <div data-testid="obs-refusal-note" className="px-3 py-2 border-t border-border-subtle/60 text-xs text-muted-foreground">
                A refusal is not proof a key is dead: it can be a plan limit, a blocked datacenter address or a policy decision.
              </div>
            )}
          </div>

          <div className="rounded-xl border border-border-subtle bg-surface-1/40 overflow-hidden">
            <div className="px-3 py-2 border-b border-border-subtle/60 text-eyebrow font-mono uppercase tracking-wider text-muted-foreground">
              All tools · <span className="text-foreground tabular-nums">{summary.tools.length}</span>
            </div>
            <ul className="divide-y divide-border-subtle/40">
              {summary.tools.slice(0, OBS_VISIBLE_ROWS).map((t) => <ToolRow key={t.tool} o={t} />)}
            </ul>
            {summary.tools.length > OBS_VISIBLE_ROWS && (
              <details className="border-t border-border-subtle/60">
                <summary className="px-3 py-2 cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                  Show the other {summary.tools.length - OBS_VISIBLE_ROWS} tools
                </summary>
                <ul className="divide-y divide-border-subtle/40">
                  {summary.tools.slice(OBS_VISIBLE_ROWS).map((t) => <ToolRow key={t.tool} o={t} />)}
                </ul>
              </details>
            )}
          </div>

          {truncated && (
            <p className="text-xs text-muted-foreground">
              The read stopped at {OBSERVATION_ROW_LIMIT.toLocaleString()} calls, so every figure above covers only the newest {OBSERVATION_ROW_LIMIT.toLocaleString()}.
            </p>
          )}
        </>
      )}
    </section>
  );
}
