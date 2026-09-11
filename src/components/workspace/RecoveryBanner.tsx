import { useEffect, useId, useMemo, useState } from "react";
import { AlertTriangle, ChevronDown, Copy, ListX, Plus, Square, Ban, PlayCircle } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { CaseSnapshot } from "@/hooks/useCaseSnapshot";
import {
  buildRecoveryDiagnostic,
  classifyRecovery,
  recoveryPrimaryAction,
  type ResumeContract,
} from "@/lib/run-recovery";
import { humanizeStage } from "@/lib/tool-display";

const STORAGE_PREFIX = "if:recovery-collapsed:";

function readCollapsed(key: string): boolean {
  try { return sessionStorage.getItem(STORAGE_PREFIX + key) === "1"; } catch { return false; }
}
function writeCollapsed(key: string, collapsed: boolean) {
  try { sessionStorage.setItem(STORAGE_PREFIX + key, collapsed ? "1" : "0"); } catch { /* storage unavailable */ }
}

/**
 * Interrupted / stopped run — what happened, what survived, what is safe to do.
 *
 * Sits directly under the tab strip on every tab, because an interruption
 * changes how every tab should be read. It offers exactly ONE primary action,
 * and today that action is "Recovery unavailable" with its reason: the backend
 * has no resumable run ID or idempotency key, so anything labelled Resume or
 * Retry would start a separate, billed run. The secondary actions are read-only
 * or start a NEW case — none of them re-sends anything.
 *
 * Collapsible, with the choice remembered per case and per interruption, so an
 * analyst working through the evidence is told once, clearly, and can then fold
 * it to a single line.
 */
export function RecoveryBanner({
  snapshot,
  resumeContract = null,
  onViewFailedTools,
  onStartNew,
  onResume,
}: {
  snapshot: CaseSnapshot | null;
  /** Server-issued resume binding. Always null until the backend ships one. */
  resumeContract?: ResumeContract | null;
  onViewFailedTools: () => void;
  onStartNew: () => void;
  onResume?: (contract: ResumeContract) => void;
}) {
  const titleId = useId();
  const reasonId = useId();

  const classification = useMemo(
    () => (snapshot && snapshot.hydrated
      ? classifyRecovery({
        runState: snapshot.run.state,
        recoveryReason: snapshot.run.recoveryReason,
        recoveredAt: snapshot.run.recoveredAt,
      })
      : null),
    [snapshot],
  );

  const collapseKey = snapshot && classification ? `${snapshot.threadId}:${classification.code}:${snapshot.run.recoveredAt ?? snapshot.run.startedAt ?? ""}` : "";
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { if (collapseKey) setCollapsed(readCollapsed(collapseKey)); }, [collapseKey]);

  if (!snapshot || !classification) return null;

  const action = recoveryPrimaryAction(resumeContract);
  const { tools } = snapshot;
  const failedTools = tools.events
    .filter((e) => e.status === "failed")
    .map((e) => ({ name: e.displayName || e.toolName, reason: e.reason }));
  const stage = tools.lastStage ? humanizeStage(tools.lastStage) : null;
  const warning = classification.tone === "warning";

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    writeCollapsed(collapseKey, next);
  };

  const copyDiagnostic = () => {
    const text = buildRecoveryDiagnostic({
      threadId: snapshot.threadId,
      classification,
      runStateLabel: snapshot.run.label,
      recoveryReason: snapshot.run.recoveryReason,
      startedAt: snapshot.run.startedAt,
      heartbeatAt: snapshot.run.heartbeatAt,
      recoveredAt: snapshot.run.recoveredAt,
      artifacts: snapshot.evidence.artifacts,
      toolTotal: tools.total,
      toolFailed: tools.failed,
      toolDegraded: tools.degraded,
      spendText: snapshot.spend.text,
      lastStage: stage,
      failedTools,
      capturedAt: new Date().toISOString(),
    });
    navigator.clipboard.writeText(text).then(
      () => toast.success("Diagnostic copied"),
      () => toast.error("Copy failed"),
    );
  };

  const Icon = warning ? AlertTriangle : Square;

  return (
    <section
      aria-labelledby={titleId}
      data-recovery-code={classification.code}
      className={cn(
        "shrink-0 border-b px-4 sm:px-6",
        warning
          ? "border-[hsl(var(--warning)/0.28)] bg-[linear-gradient(180deg,hsl(var(--warning-muted)/0.7),hsl(var(--warning-muted)/0.35))]"
          : "border-white/[0.07] bg-surface-1/80",
      )}
    >
      {/* Summary line — always visible, and the collapse control. */}
      <div className="flex min-h-10 items-center gap-2.5 py-1.5">
        <Icon
          className={cn("h-4 w-4 shrink-0", warning ? "text-[hsl(var(--warning))]" : "h-3 w-3 fill-current text-foreground/70")}
          aria-hidden
        />
        <h2 id={titleId} className={cn("min-w-0 truncate text-meta font-semibold", warning ? "text-[hsl(var(--warning))]" : "text-foreground")}>
          {classification.title}
        </h2>
        <span className="hidden shrink-0 rounded border border-white/10 bg-black/20 px-1.5 py-px font-mono text-eyebrow tracking-wide text-muted-foreground sm:inline">
          {classification.code}
        </span>
        {collapsed && (
          <span className="hidden min-w-0 truncate text-micro text-muted-foreground md:inline">
            {snapshot.evidence.artifacts} artifacts and {tools.total} tool calls kept · {action.kind === "resume" ? "Resume available" : "Recovery unavailable"}
          </span>
        )}
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          className="ml-auto inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-micro font-medium text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {collapsed ? "Details" : "Hide details"}
          <ChevronDown className={cn("h-3.5 w-3.5 transition-transform duration-200", !collapsed && "rotate-180")} aria-hidden />
        </button>
      </div>

      {!collapsed && (
        <div className="pb-3">
          <p className="max-w-[72ch] text-meta leading-relaxed text-foreground/90">
            {classification.message}
            {classification.detail && <span className="text-muted-foreground"> {classification.detail}</span>}
          </p>

          <dl className="mt-2.5 grid grid-cols-2 gap-x-6 gap-y-2 text-micro sm:grid-cols-4 sm:max-w-3xl">
            <div className="min-w-0">
              <dt className="text-muted-foreground">Last stage with tool activity</dt>
              <dd className="mt-0.5 truncate font-medium text-foreground">{stage ?? "Not recorded"}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-muted-foreground">Kept</dt>
              <dd className="mt-0.5 font-mono tabular-nums text-foreground">
                {snapshot.evidence.artifacts} artifacts · {tools.total} calls
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-muted-foreground">Tool problems</dt>
              <dd className="mt-0.5 font-mono tabular-nums text-foreground">
                {tools.failed} failed · {tools.degraded} degraded
              </dd>
            </div>
            <div className="min-w-0">
              <dt className="text-muted-foreground">Spend so far</dt>
              <dd className="mt-0.5 font-mono tabular-nums text-foreground">{snapshot.spend.text}</dd>
            </div>
          </dl>

          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
            {action.kind === "resume" ? (
              <button
                type="button"
                onClick={() => onResume?.(action.contract)}
                disabled={!onResume}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-white px-3 text-micro font-semibold text-black transition-colors hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
              >
                <PlayCircle className="h-3.5 w-3.5" aria-hidden />
                {action.label}
              </button>
            ) : (
              <>
                <button
                  type="button"
                  aria-disabled="true"
                  aria-describedby={reasonId}
                  onClick={(e) => e.preventDefault()}
                  className="inline-flex h-8 cursor-not-allowed items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 text-micro font-semibold text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Ban className="h-3.5 w-3.5" aria-hidden />
                  {action.label}
                </button>
                <p id={reasonId} className="min-w-0 flex-1 basis-64 text-micro leading-relaxed text-muted-foreground">
                  {action.reason}
                </p>
              </>
            )}
          </div>

          <div className="mt-2.5 flex flex-wrap items-center gap-1" role="group" aria-label="Recovery actions">
            <button
              type="button"
              onClick={onViewFailedTools}
              className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-micro font-medium text-foreground/85 transition-colors hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ListX className="h-3.5 w-3.5" aria-hidden />
              View failed tools{tools.failed > 0 ? ` (${tools.failed})` : ""}
            </button>
            <button
              type="button"
              onClick={copyDiagnostic}
              className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-micro font-medium text-foreground/85 transition-colors hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Copy className="h-3.5 w-3.5" aria-hidden />
              Copy diagnostic
            </button>
            <button
              type="button"
              onClick={onStartNew}
              className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-micro font-medium text-foreground/85 transition-colors hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              Start new investigation
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
