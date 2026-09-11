import { useEffect, useId, useRef, useState } from "react";
import { AlertTriangle, Play, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PivotEligibility, RunnablePivot } from "@/lib/pivot-schema";

const TYPE_LABEL: Record<RunnablePivot["targetType"], string> = {
  email: "email", username: "username", domain: "domain", url: "URL",
  ip: "IP address", name: "name", wallet: "wallet", phone: "phone",
};

/**
 * The in-app preview every pivot Run opens. Nothing starts until the analyst
 * presses "Start this pivot" here: a Run button that silently started a billed
 * agent run was how a report footer became an investigation.
 *
 * States the target and its type, the reason, the evidence basis, the scope,
 * and the cost estimate — honestly "unavailable", because the backend publishes
 * no per-pivot estimate. A target tools already ran against needs an explicit
 * rerun confirmation.
 */
export function PivotPreview({
  pivot,
  eligibility,
  onStart,
  onCancel,
  busy = false,
}: {
  pivot: RunnablePivot;
  eligibility: PivotEligibility;
  onStart: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  const [rerunOk, setRerunOk] = useState(false);
  const startRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useId();
  const rerunId = useId();

  useEffect(() => { startRef.current?.focus(); }, []);

  const canStart = eligibility.runnable && (!eligibility.rerun || rerunOk) && !busy;

  return (
    <div
      role="group"
      aria-labelledby={titleId}
      className="ws-panel-enter mt-2 rounded-lg border border-white/[0.09] bg-surface-2/70 p-3"
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onCancel(); } }}
    >
      <div id={titleId} className="text-data font-semibold text-foreground">Before this pivot runs</div>
      <dl className="mt-2 grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-[13px] leading-snug">
        <dt className="text-muted-foreground">Target</dt>
        <dd className="min-w-0 break-words">
          <span className="font-mono text-foreground">{pivot.target}</span>
          <span className="ml-1.5 text-muted-foreground">({TYPE_LABEL[pivot.targetType]})</span>
        </dd>
        <dt className="text-muted-foreground">Why</dt>
        <dd className="min-w-0 text-foreground/90">{pivot.reason}</dd>
        <dt className="text-muted-foreground">Basis</dt>
        <dd className="min-w-0 text-foreground/90">
          {pivot.basis}
          <span className="text-muted-foreground"> · linkage {eligibility.linkage === "linked" ? "proven by a recorded row" : eligibility.linkage === "report" ? "not recorded" : "unproven"}</span>
        </dd>
        <dt className="text-muted-foreground">Scope</dt>
        <dd className="min-w-0 text-foreground/90">One agent run on this target using public sources. The server caps paid calls per run.</dd>
        <dt className="text-muted-foreground">Estimate</dt>
        <dd className="min-w-0 text-muted-foreground">Unavailable — the backend does not publish per-pivot estimates.</dd>
      </dl>

      {(eligibility.blockers.length > 0 || eligibility.warnings.length > 0) && (
        <ul className="mt-2.5 space-y-1 text-[13px]">
          {eligibility.blockers.map((b) => (
            <li key={b} className="flex items-start gap-1.5 text-[hsl(var(--danger))]">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {b}
            </li>
          ))}
          {eligibility.warnings.map((w) => (
            <li key={w} className="flex items-start gap-1.5 text-[hsl(var(--warning))]">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {w}
            </li>
          ))}
        </ul>
      )}

      {eligibility.rerun && eligibility.runnable && (
        <label htmlFor={rerunId} className="mt-2.5 flex cursor-pointer items-start gap-2 text-[13px] text-foreground/90">
          <input
            id={rerunId}
            type="checkbox"
            checked={rerunOk}
            onChange={(e) => setRerunOk(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[hsl(var(--brand))]"
          />
          Run it again anyway — I want a fresh pass on this target.
        </label>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          ref={startRef}
          type="button"
          onClick={onStart}
          disabled={!canStart}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-lg px-3 text-data font-semibold transition-colors duration-fast [@media(pointer:coarse)]:h-11",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
            canStart ? "bg-white text-black hover:bg-white/90" : "cursor-not-allowed bg-white/[0.06] text-muted-foreground",
          )}
        >
          <Play className="h-3.5 w-3.5" aria-hidden />
          {busy ? "Starting…" : "Start this pivot"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="inline-flex h-8 items-center rounded-lg px-3 text-data font-medium text-muted-foreground transition-colors duration-fast hover:bg-white/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * A generated suggestion that failed validation. Kept visible — deleting it
 * would hide that the generator produced something malformed — but inert.
 */
export function RepairNotice({ action, target, problems }: { action: string; target: string; problems: string[] }) {
  return (
    <div className="min-w-0 flex-1" data-suggestion-state="needs-repair">
      <div className="flex min-w-0 items-center gap-2">
        <Wrench className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-[14px] font-medium text-foreground/85">Suggestion needs repair</span>
        <span className="truncate text-[13px] text-muted-foreground">· {action}</span>
      </div>
      {target && (
        <p className="mt-0.5 truncate font-mono text-[12px] text-muted-foreground" title={target}>{target}</p>
      )}
      <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground">
        Not runnable: {problems.join("; ")}.
      </p>
    </div>
  );
}
