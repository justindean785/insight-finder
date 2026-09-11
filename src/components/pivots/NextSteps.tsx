import { useState } from "react";
import { ArrowRight, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PivotEligibility, PivotValidation, RunnablePivot } from "@/lib/pivot-schema";
import { PivotPreview, RepairNotice } from "@/components/pivots/PivotPreview";

export type NextStepItem =
  | {
    kind: "pivot";
    key: string;
    validation: PivotValidation;
    /** Null when the suggestion failed validation (it cannot run at all). */
    eligibility: PivotEligibility | null;
  }
  | {
    kind: "action";
    key: string;
    title: string;
    detail: string;
    prompt: string;
  };

/**
 * Next steps — compact action rows under the latest report.
 *
 * One column, full-size type: the old two-column grid of 11px rationales cut
 * the reason mid-sentence at exactly the width where it stopped being a reason.
 * Every Run opens an inline preview first; nothing starts from the row itself.
 */
export function NextSteps({
  items,
  onRunPivot,
  onRunAction,
  busy = false,
  openKey,
  onOpenChange,
}: {
  items: NextStepItem[];
  onRunPivot: (pivot: RunnablePivot) => void;
  onRunAction: (prompt: string) => void;
  busy?: boolean;
  /** Controlled open preview. The transcript re-adopts its messages after load,
   *  which can remount this list; holding the open row above it keeps a preview
   *  the analyst opened from vanishing under them. */
  openKey?: string | null;
  onOpenChange?: (key: string | null) => void;
}) {
  const [localOpen, setLocalOpen] = useState<string | null>(null);
  const open = openKey !== undefined ? openKey : localOpen;
  const setOpen = (k: string | null) => { if (onOpenChange) onOpenChange(k); else setLocalOpen(k); };
  if (items.length === 0) return null;

  return (
    <section aria-label="Next steps" className="ws-panel-enter w-full overflow-hidden rounded-xl border border-white/[0.08] bg-surface-1">
      <header className="flex h-10 items-center gap-2 border-b border-white/[0.06] px-4 text-data font-medium text-muted-foreground">
        <Sparkles className="h-3.5 w-3.5" aria-hidden />
        Next steps
        <span className="ml-auto font-mono tabular-nums">{items.length}</span>
      </header>
      <ul className="divide-y divide-white/[0.06]">
        {items.map((item) => {
          const isOpen = open === item.key;
          if (item.kind === "pivot" && item.validation.status === "invalid") {
            return (
              <li key={item.key} className="flex items-start gap-3 px-4 py-3 opacity-90">
                <RepairNotice action={item.validation.action} target={item.validation.target} problems={item.validation.problems} />
              </li>
            );
          }
          const pivot = item.kind === "pivot" && item.validation.status === "valid" ? item.validation.pivot : null;
          const title = pivot ? pivot.action : item.kind === "action" ? item.title : "";
          const detail = pivot ? pivot.reason : item.kind === "action" ? item.detail : "";
          const blocked = item.kind === "pivot" && item.eligibility !== null && !item.eligibility.runnable;
          return (
            <li key={item.key} className="px-4 py-3">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                    {pivot && <span className={`pivot-priority pivot-priority--${pivot.priority} shrink-0`}>{pivot.priority}</span>}
                    <span className="text-[14px] font-medium leading-snug text-foreground">{title}</span>
                    {pivot && (
                      <span className="min-w-0 max-w-full truncate font-mono text-[13px] text-foreground/80" title={pivot.target}>
                        {pivot.target}
                      </span>
                    )}
                    {pivot?.status === "searched" && (
                      <span className="rounded border border-white/10 px-1.5 text-micro text-muted-foreground">already searched</span>
                    )}
                  </div>
                  {detail && <p className="mt-1 text-[13px] leading-snug text-muted-foreground">{detail}</p>}
                  {blocked && item.kind === "pivot" && item.eligibility && (
                    <p className="mt-1 text-[13px] leading-snug text-[hsl(var(--danger))]">{item.eligibility.blockers.join(" ")}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : item.key)}
                  disabled={blocked}
                  aria-expanded={isOpen}
                  aria-label={`${isOpen ? "Close preview for" : "Run"} ${title}${pivot ? ` on ${pivot.target}` : ""}`}
                  className={cn(
                    "inline-flex h-8 shrink-0 items-center gap-1 rounded-md border px-2.5 text-data font-medium transition-colors duration-fast [@media(pointer:coarse)]:h-11",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    blocked
                      ? "cursor-not-allowed border-white/[0.06] text-muted-foreground/60"
                      : isOpen
                        ? "border-[hsl(var(--brand)/0.5)] bg-white/[0.06] text-foreground"
                        : "border-white/12 bg-white/[0.04] text-foreground/90 hover:border-white/20 hover:bg-white/[0.08]",
                  )}
                >
                  {isOpen ? "Close" : "Run"}
                  {!isOpen && <ArrowRight className="h-3.5 w-3.5 opacity-70" aria-hidden />}
                </button>
              </div>
              {isOpen && pivot && item.kind === "pivot" && item.eligibility && (
                <PivotPreview
                  pivot={pivot}
                  eligibility={item.eligibility}
                  busy={busy}
                  onCancel={() => setOpen(null)}
                  onStart={() => { setOpen(null); onRunPivot(pivot); }}
                />
              )}
              {isOpen && item.kind === "action" && (
                <div className="ws-panel-enter mt-2 rounded-lg border border-white/[0.09] bg-surface-2/70 p-3">
                  <div className="text-data font-semibold text-foreground">This starts a new agent run on the case</div>
                  <p className="mt-1.5 text-[13px] leading-snug text-muted-foreground">
                    It sends: <span className="text-foreground/90">“{item.prompt}”</span>
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => { setOpen(null); onRunAction(item.prompt); }}
                      className="inline-flex h-8 items-center rounded-lg bg-white px-3 text-data font-semibold text-black transition-colors duration-fast hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 [@media(pointer:coarse)]:h-11"
                    >
                      Send
                    </button>
                    <button
                      type="button"
                      onClick={() => setOpen(null)}
                      className="inline-flex h-8 items-center rounded-lg px-3 text-data font-medium text-muted-foreground hover:bg-white/[0.05] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
