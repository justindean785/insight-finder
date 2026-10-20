import { ToolStatusBadge } from "@/components/ui/workspace-primitives";
import type { ToolEvent } from "@/hooks/useThreadToolActivity";

/** Rows shown at once; a long run keeps its newest calls in view. */
const MAX_ROWS = 40;

function fmtDuration(ms: number | null): string | null {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Shown in the transcript while the server is running this case's investigation
 * but this browser is not receiving it live (see `shouldFollowServer`). It lists
 * the calls the run has recorded so far, from the same case snapshot the header
 * counts come from, so the two never disagree.
 *
 * It does not imitate the agent: the narration is saved only when the run ends,
 * and the panel says so instead of inventing progress text. The caller decides
 * when it shows (`ChatWindow`'s settled `followingServer`).
 */
export function ServerFollowPanel({ active, events }: { active: boolean; events: ToolEvent[] }) {
  if (!active) return null;
  const rows = events.slice(-MAX_ROWS);
  const hidden = events.length - rows.length;
  return (
    <section aria-label="Live from the server" className="chat-card w-full min-w-0">
      <div className="chat-card__header">
        <span aria-hidden className="inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[hsl(var(--brand))] motion-reduce:animate-none" />
        <span>Live view disconnected — still running on the server</span>
        <span className="chat-card__header-time font-mono tabular-nums" aria-live="polite">
          {events.length} call{events.length === 1 ? "" : "s"} recorded
        </span>
      </div>
      <div className="chat-card__body space-y-3">
        <p className="text-meta text-muted-foreground">
          This page isn&apos;t receiving the live stream, but the investigation is still running on the server.
          Its tool calls appear below as they&apos;re recorded; the agent&apos;s write-up appears here when the run finishes.
        </p>
        {rows.length === 0 ? (
          <p className="text-meta text-muted-foreground">Waiting for the first recorded call…</p>
        ) : (
          <ol className="divide-y divide-border-subtle rounded-md border border-border-subtle">
            {hidden > 0 && (
              <li className="px-3 py-2 text-data text-muted-foreground">{hidden} earlier call{hidden === 1 ? "" : "s"} not shown</li>
            )}
            {rows.map((e) => {
              const duration = fmtDuration(e.durationMs);
              return (
                <li key={e.id} className="flex min-w-0 items-center gap-2.5 px-3 py-2">
                  <ToolStatusBadge status={e.status} className="shrink-0" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-meta text-foreground">{e.displayName}</span>
                    <span className="block font-mono text-data text-muted-foreground [overflow-wrap:anywhere]">{e.toolName}</span>
                  </span>
                  {duration && <span className="shrink-0 font-mono text-data tabular-nums text-muted-foreground">{duration}</span>}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </section>
  );
}
