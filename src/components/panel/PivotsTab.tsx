import { useEffect, useMemo, useState } from "react";
import { effectiveConfidence } from "@/lib/display-confidence";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { supabase } from "@/integrations/supabase/client";
import { useOptionalCaseSnapshot } from "@/hooks/useCaseSnapshot";
import { Copy, EyeOff, GitCompare, Ban } from "lucide-react";
import { toast } from "sonner";
import { Checkbox } from "@/components/ui/checkbox";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { normalizeTarget } from "@/lib/next-step-cards";
import { computePivots, canonicalKey, type DisplayPivot } from "@/lib/pivot-engine";
import { pivotSkipStorageKey, type RecommendedPivot } from "@/lib/recommended-pivots";
import {
  BULK_QUEUE_UNAVAILABLE,
  pivotEligibility,
  pivotSuggestionInput,
  validatePivotSuggestion,
  type RunnablePivot,
} from "@/lib/pivot-schema";
import { hasPivotRunner } from "@/lib/pivot-runner";
import { formatUsd } from "@/lib/case-snapshot";
import { useThreadQueriedTargets } from "@/hooks/useThreadQueriedTargets";
import { useThreadPivotAttempts } from "@/hooks/useThreadPivotAttempts";
import { useReviewStates } from "@/lib/review";
import { PivotCard } from "@/components/pivots/PivotCard";

/**
 * Pivots surface (Evidence → Pivots). Shares ONE engine with the chat "Next
 * steps" rail (computePivots) so the two never disagree, and NEVER reads a
 * frozen report cache: report recommendations arrive live via the
 * `swarmbot:report-pivots` event.
 *
 * Every pivot is validated (`pivot-schema.ts`) before it may run, and every
 * Run opens an inline preview. There is no bulk queue: the backend has no
 * idempotency contract, and the old "Queue all" sent the first pivot, silently
 * dropped the rest and marked them all skipped.
 */
export function PivotsTab({ threadId, artifacts }: { threadId: string; artifacts: Artifact[] }) {
  const caseApi = useOptionalCaseSnapshot();
  const snapshot = caseApi?.snapshot ?? null;
  const [fallback, setFallback] = useState<{ seed: string | null; cost: number }>({ seed: null, cost: 0 });
  const seedValue = snapshot ? snapshot.seed.value : fallback.seed;
  const costMicro = snapshot ? snapshot.spend.microUsd ?? 0 : fallback.cost;
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [reportPivots, setReportPivots] = useState<RecommendedPivot[]>([]);
  const [statusMsg, setStatusMsg] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    if (!snapshot) {
      supabase
        .from("threads")
        .select("seed_value,cost_micro_usd")
        .eq("id", threadId)
        .maybeSingle()
        .then(({ data }) => {
          setFallback({ seed: data?.seed_value ?? null, cost: Number(data?.cost_micro_usd ?? 0) });
        });
    }
    // Skip set only — report pivots are NEVER cached (no more frozen list).
    try {
      const raw = localStorage.getItem(pivotSkipStorageKey(threadId));
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      setSkipped(new Set(Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : []));
    } catch { /* ignore */ }
    setReportPivots([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  useEffect(() => {
    const onReportPivots = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId: string; pivots: RecommendedPivot[] }>).detail;
      if (detail?.threadId === threadId && Array.isArray(detail.pivots)) setReportPivots(detail.pivots);
    };
    window.addEventListener("swarmbot:report-pivots", onReportPivots as EventListener);
    // Ask ChatWindow to replay the current report pivots now that we're listening.
    window.dispatchEvent(new CustomEvent("swarmbot:request-report-pivots", { detail: { threadId } }));
    return () => window.removeEventListener("swarmbot:report-pivots", onReportPivots as EventListener);
  }, [threadId]);

  const queriedTargets = useThreadQueriedTargets(threadId);
  const attempts = useThreadPivotAttempts(threadId);
  const review = useReviewStates(threadId);

  // Live pivots — same engine and inputs as the chat rail.
  const visible = useMemo(
    () => computePivots({ artifacts, seedValue, reportPivots, skipSet: skipped, queriedSet: queriedTargets, reviews: review.map, attempts }),
    [artifacts, seedValue, reportPivots, skipped, queriedTargets, review.map, attempts],
  );

  // Validation + eligibility, once per render of the list.
  const checked = useMemo(() => {
    const byId = new Map(artifacts.map((a) => [a.id, a] as const));
    const reviewOf = (id: string) => review.map[id] ?? "new";
    return visible.map((p) => {
      const validation = validatePivotSuggestion(pivotSuggestionInput(p));
      return {
        pivot: p,
        key: canonicalKey(p),
        validation,
        eligibility: validation.status === "valid" ? pivotEligibility(validation.pivot, { artifactsById: byId, review: reviewOf }) : null,
      };
    });
  }, [visible, artifacts, review.map]);

  const counts = useMemo(() => {
    let runnable = 0, repair = 0, blocked = 0;
    for (const c of checked) {
      if (c.validation.status === "invalid") repair++;
      else if (c.eligibility && !c.eligibility.runnable) blocked++;
      else runnable++;
    }
    return { runnable, repair, blocked };
  }, [checked]);

  /**
   * NOT the Conflict authority state, and labelled so. This counts rows below
   * confidence 50 plus extra distinct values for date of birth, city, employer
   * or location — a signal worth triaging in the Table view, but a different
   * measure from the case bar's "conflict" (rows marked as contradicting the
   * case). It was labelled "contradictions", which is how one case read
   * "Conflict 0" in the Overview and "22 contradictions" here.
   */
  const weakOrInconsistent = useMemo(() => {
    let n = 0;
    const byKind = new Map<string, Set<string>>();
    for (const a of artifacts) {
      if ((effectiveConfidence(a) ?? 100) < 50) n++;
      const k = a.kind.toLowerCase();
      const set = byKind.get(k) ?? new Set();
      set.add(String(a.value));
      byKind.set(k, set);
    }
    for (const k of ["dob", "city", "employer", "location"]) {
      const s = byKind.get(k);
      if (s && s.size > 1) n += s.size - 1;
    }
    return n;
  }, [artifacts]);

  const canRun = hasPivotRunner(threadId);

  const persistSkip = (next: Set<string>) => {
    setSkipped(next);
    try {
      localStorage.setItem(pivotSkipStorageKey(threadId), JSON.stringify(Array.from(next)));
    } catch { /* ignore */ }
    // Sync the chat rail so a skipped lead never reappears there either.
    window.dispatchEvent(new CustomEvent("swarmbot:pivot-skip-changed", { detail: { threadId } }));
  };

  const setSelectedFor = (p: DisplayPivot, on: boolean) => {
    const k = canonicalKey(p);
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(k); else next.delete(k);
      return next;
    });
  };
  const allSelected = visible.length > 0 && visible.every((p) => selected.has(canonicalKey(p)));
  const someSelected = selected.size > 0 && !allSelected;
  const selectedPivots = visible.filter((p) => selected.has(canonicalKey(p)));

  const copySelected = () => {
    if (selectedPivots.length === 0) return;
    navigator.clipboard.writeText(selectedPivots.map((p) => p.value).join("\n")).then(
      () => toast.success(`${selectedPivots.length} pivots copied`),
      () => toast.error("Copy failed"),
    );
  };
  const skipSelected = () => {
    if (selectedPivots.length === 0) return;
    const next = new Set(skipped);
    for (const p of selectedPivots) next.add(normalizeTarget(p.value));
    persistSkip(next);
    setSelected(new Set());
    setStatusMsg(`Skipped ${selectedPivots.length} pivots`);
    toast.success(`Skipped ${selectedPivots.length} pivots`);
  };
  const skip = (p: DisplayPivot) => {
    const next = new Set(skipped);
    next.add(normalizeTarget(p.value));
    persistSkip(next);
    setStatusMsg(`Pivot ${p.value} skipped`);
  };
  const copy = (text: string) =>
    navigator.clipboard.writeText(text).then(() => toast.success("Pivot copied"), () => toast.error("Copy failed"));

  /**
   * Start ONE pivot, after its preview. Deliberately does NOT mark it skipped:
   * the dispatch can still be refused (an analyst-rejected selector) or held
   * (a run already in progress), and hiding a lead that never ran is how leads
   * went missing. It becomes "searched" once tools actually run against it.
   */
  const start = (p: RunnablePivot) => {
    window.dispatchEvent(new CustomEvent("proximity:run-pivot", {
      detail: { threadId, value: p.target, type: p.targetType, prompt: p.prompt },
    }));
    setOpen(null);
    setStatusMsg(`Pivot on ${p.target} sent to the agent`);
  };

  const spendText = formatUsd(costMicro);

  return (
    <div className="space-y-3 p-3 text-xs">
      {/* Announces run/skip actions for screen readers. */}
      <div role="status" aria-live="polite" className="sr-only">{statusMsg}</div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-data text-muted-foreground">
        <span className="text-foreground/90">
          {counts.runnable} runnable
          {counts.blocked > 0 && <span className="text-muted-foreground"> · {counts.blocked} blocked</span>}
          {counts.repair > 0 && <span className="text-muted-foreground"> · {counts.repair} need repair</span>}
        </span>
        <span aria-hidden className="text-muted-foreground/40">·</span>
        <span>Case spend <span className="font-mono tabular-nums text-foreground/90">{spendText}</span></span>
        {weakOrInconsistent > 0 && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={() => window.dispatchEvent(new CustomEvent("swarmbot:navigate", { detail: { section: "evidence", tab: "matrix" } }))}
                className="inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-[hsl(var(--warning))] transition-colors duration-fast hover:bg-white/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <GitCompare className="h-3.5 w-3.5" aria-hidden />
                {weakOrInconsistent} weak or inconsistent value{weakOrInconsistent === 1 ? "" : "s"}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[300px] text-xs leading-relaxed">
              Rows below confidence 50, plus extra distinct values for date of birth, city, employer or location. Not the
              Conflict state shown in the case bar. Opens the Table view to triage.
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {!canRun && visible.length > 0 && (
        <p className="rounded-md border border-white/[0.08] bg-surface-1 px-3 py-2 text-[13px] text-muted-foreground">
          Pivots run from the Investigate tab. Open this case in the workspace to start one.
        </p>
      )}

      {visible.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-white/[0.07] bg-surface-1 px-2.5 py-1.5">
          <label className="flex cursor-pointer items-center gap-2 text-data text-muted-foreground">
            <Checkbox
              checked={allSelected ? true : someSelected ? "indeterminate" : false}
              onCheckedChange={(v) => setSelected(v === true ? new Set(visible.map(canonicalKey)) : new Set())}
              aria-label="Select all pivots"
            />
            {selected.size > 0 ? `${selected.size} selected` : "Select all"}
          </label>
          {selected.size > 0 && (
            <div className="ml-auto flex flex-wrap items-center gap-1">
              <button type="button" onClick={copySelected} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-data text-muted-foreground transition-colors duration-fast hover:bg-white/[0.04] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <Copy className="h-3.5 w-3.5" aria-hidden /> Copy
              </button>
              <button type="button" onClick={skipSelected} className="inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-data text-muted-foreground transition-colors duration-fast hover:bg-white/[0.04] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <EyeOff className="h-3.5 w-3.5" aria-hidden /> Skip
              </button>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-disabled="true"
                    aria-label={`Queue selected pivots — unavailable. ${BULK_QUEUE_UNAVAILABLE}`}
                    onClick={(e) => e.preventDefault()}
                    className="inline-flex h-8 cursor-not-allowed items-center gap-1.5 rounded-md px-2 text-data text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Ban className="h-3.5 w-3.5" aria-hidden /> Queue
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" className="max-w-[300px] text-xs leading-relaxed">{BULK_QUEUE_UNAVAILABLE}</TooltipContent>
              </Tooltip>
            </div>
          )}
        </div>
      )}

      {visible.length === 0 ? (
        <div className="space-y-1 p-2 text-muted-foreground">
          <div className="text-[13px]">No pivots available yet.</div>
          <div className="text-data">Pivots appear as the agent records emails, usernames, domains, IPs or wallets.</div>
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {checked.map((c) => (
            <PivotCard
              key={c.key}
              pivot={c.pivot}
              validation={c.validation}
              eligibility={c.eligibility}
              canRun={canRun}
              open={open === c.key}
              onToggleOpen={() => setOpen(open === c.key ? null : c.key)}
              onStart={start}
              selected={selected.has(c.key)}
              onSelect={(on) => setSelectedFor(c.pivot, on)}
              onCopy={() => copy(c.pivot.value)}
              onSkip={() => skip(c.pivot)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
