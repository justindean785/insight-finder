import { useEffect, useMemo, useState } from "react";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { supabase } from "@/integrations/supabase/client";
import { Copy, EyeOff, CheckSquare, Square, Sparkles, Wallet, GitCompare, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { normalizeTarget } from "@/lib/next-step-cards";
import { computePivots, canonicalKey, type DisplayPivot } from "@/lib/pivot-engine";
import { pivotSkipStorageKey, type RecommendedPivot } from "@/lib/recommended-pivots";
import { PivotCard } from "@/components/pivots/PivotCard";

/**
 * Pivots surface (Evidence → Pivots). Shares ONE engine with the chat "Next
 * steps" rail (computePivots) so the two never disagree, and NEVER reads a
 * frozen report cache: report recommendations arrive live via the
 * `swarmbot:report-pivots` event, so on reload the tab shows artifact-derived
 * pivots until the next assistant turn re-emits report pivots.
 */
export function PivotsTab({ threadId, artifacts }: { threadId: string; artifacts: Artifact[] }) {
  const [seedValue, setSeedValue] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [costMicro, setCostMicro] = useState<number>(0);
  const [reportPivots, setReportPivots] = useState<RecommendedPivot[]>([]);
  const [statusMsg, setStatusMsg] = useState("");

  useEffect(() => {
    supabase
      .from("threads")
      .select("seed_value,cost_micro_usd")
      .eq("id", threadId)
      .maybeSingle()
      .then(({ data }) => {
        const d = data as { seed_value: string | null; cost_micro_usd: number | null } | null;
        setSeedValue(d?.seed_value ?? null);
        setCostMicro(Number(d?.cost_micro_usd ?? 0));
      });
    // Skip set only — report pivots are NEVER cached (no more frozen list).
    try {
      const raw = localStorage.getItem(pivotSkipStorageKey(threadId));
      setSkipped(new Set(raw ? (JSON.parse(raw) as string[]) : []));
    } catch { /* ignore */ }
    setReportPivots([]);
  }, [threadId]);

  useEffect(() => {
    const onReportPivots = (event: Event) => {
      const detail = (event as CustomEvent<{ threadId: string; pivots: RecommendedPivot[] }>).detail;
      if (detail?.threadId === threadId) setReportPivots(detail.pivots);
    };
    window.addEventListener("swarmbot:report-pivots", onReportPivots as EventListener);
    // Ask ChatWindow to replay the current report pivots now that we're listening,
    // so opening this tab on a settled thread shows report-only leads immediately
    // instead of waiting for the next assistant turn.
    window.dispatchEvent(new CustomEvent("swarmbot:request-report-pivots", { detail: { threadId } }));
    return () => window.removeEventListener("swarmbot:report-pivots", onReportPivots as EventListener);
  }, [threadId]);

  // Live pivots: recomputed whenever artifacts stream in, a new report turn
  // lands, or the skip set changes. computePivots already hard-hides skipped
  // targets, so this list IS the visible list.
  const visible = useMemo(
    () => computePivots({ artifacts, seedValue, reportPivots, skipSet: skipped }),
    [artifacts, seedValue, reportPivots, skipped],
  );

  const recommendationByKey = useMemo(() => {
    const map = new Map<string, RecommendedPivot>();
    for (const recommendation of reportPivots) {
      map.set(`${recommendation.type}:${normalizeTarget(recommendation.value)}`, recommendation);
    }
    return map;
  }, [reportPivots]);

  // Heuristic: contradictions ≈ artifacts flagged as low-confidence or with conflicting kinds
  const contradictions = useMemo(() => {
    let n = 0;
    const byKind = new Map<string, Set<string>>();
    for (const a of artifacts) {
      if ((a.confidence ?? 100) < 50) n++;
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

  const costUsd = costMicro / 1_000_000;
  const fmtCost = costUsd <= 0 ? "$0" : costUsd < 0.01 ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(3)}`;

  const persistSkip = (next: Set<string>) => {
    setSkipped(next);
    try {
      localStorage.setItem(pivotSkipStorageKey(threadId), JSON.stringify(Array.from(next)));
    } catch { /* ignore */ }
    // Sync the chat rail so a skipped lead never reappears there either.
    window.dispatchEvent(new CustomEvent("swarmbot:pivot-skip-changed", { detail: { threadId } }));
  };

  const toggleSelect = (p: DisplayPivot) => {
    const k = canonicalKey(p);
    const next = new Set(selected);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setSelected(next);
  };
  const allSelected = visible.length > 0 && visible.every((p) => selected.has(canonicalKey(p)));
  const toggleAll = () => {
    if (allSelected) { setSelected(new Set()); return; }
    setSelected(new Set(visible.map(canonicalKey)));
  };
  const selectedPivots = visible.filter((p) => selected.has(canonicalKey(p)));
  const copySelected = () => {
    if (selectedPivots.length === 0) return;
    const text = selectedPivots.map((p) => p.value).join("\n");
    navigator.clipboard.writeText(text).then(
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
    toast.success(`Skipped ${selectedPivots.length} pivots`);
    setStatusMsg(`Skipped ${selectedPivots.length} pivots`);
  };

  const skip = (p: DisplayPivot) => {
    const next = new Set(skipped);
    next.add(normalizeTarget(p.value));
    persistSkip(next);
    setStatusMsg(`Pivot ${p.value} skipped`);
  };

  const copy = (text: string) =>
    navigator.clipboard.writeText(text).then(() => toast.success("Pivot copied"), () => toast.error("Copy failed"));

  const runPivot = (p: DisplayPivot) => {
    const recommendation = recommendationByKey.get(`${p.type}:${normalizeTarget(p.value)}`);
    window.dispatchEvent(new CustomEvent("proximity:run-pivot", {
      detail: { threadId, value: p.value, type: p.type, prompt: recommendation?.prompt ?? p.prompt },
    }));
    // Auto-skip so it doesn't keep appearing as "new"
    skip(p);
    setStatusMsg(`Running pivot: ${p.value}`);
    toast.success(`Running pivot: ${p.value}`);
  };

  const queueAll = () => {
    if (visible.length === 0) return;
    visible.forEach((p, i) => {
      setTimeout(() => runPivot(p), i * 250);
    });
    toast.success(`Queued ${visible.length} pivots`);
    setStatusMsg(`Queued ${visible.length} pivots`);
  };

  return (
    <div className="p-3 space-y-3 text-xs">
      {/* Announces run/queue/skip actions for screen readers — the card itself
          disappears on action, so a visual-only toast isn't enough. */}
      <div role="status" aria-live="polite" className="sr-only">{statusMsg}</div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Sparkles className="w-3.5 h-3.5 text-primary animate-pulse" />
          <span>Suggested next leads.</span>
        </div>
        {visible.length > 0 && (
          <Button
            size="sm"
            onClick={queueAll}
            className="h-7 gap-1 text-data bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Zap className="w-3 h-3" /> Queue all pivots
          </Button>
        )}
      </div>
      {/* Run-meta pills: cost + contradictions */}
      <div className="flex flex-wrap gap-1.5">
        <span
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full border border-border-subtle bg-surface-1 font-mono text-eyebrow tracking-normal text-muted-foreground"
          title="Estimated API cost so far"
        >
          <Wallet className="w-3 h-3 text-[hsl(var(--info))]" />
          API cost <span className="text-foreground">{fmtCost}</span>
        </span>
        <button
          type="button"
          onClick={() => {
            // Route through the real nav bus (ChatPage listens for swarmbot:navigate);
            // the old "proximity:open-tab" event had no listener — the pill was dead.
            window.dispatchEvent(new CustomEvent("swarmbot:navigate", { detail: { section: "evidence", tab: "matrix" } }));
          }}
          className={
            "inline-flex items-center gap-1.5 px-2 py-1 rounded-full border font-mono text-eyebrow tracking-normal transition-colors " +
            (contradictions > 0
              ? "border-[hsl(var(--confidence-mid))]/40 bg-[hsl(var(--warning-muted))] text-[hsl(var(--confidence-mid))] hover:bg-[hsl(var(--warning-muted))]/80"
              : "border-border-subtle bg-surface-1 text-muted-foreground")
          }
          title={contradictions > 0 ? "Open Matrix to triage" : "No contradictions detected"}
        >
          <GitCompare className="w-3 h-3" />
          {contradictions} contradiction{contradictions === 1 ? "" : "s"}
        </button>
      </div>
      {visible.length > 0 && (
        <div className="flex items-center justify-between rounded-md border border-border bg-card/40 px-2 py-1.5">
          <button onClick={toggleAll} className="flex items-center gap-1.5 text-micro tracking-normal text-muted-foreground hover:text-foreground">
            {allSelected ? <CheckSquare className="w-3.5 h-3.5 text-primary" /> : <Square className="w-3.5 h-3.5" />}
            {selected.size > 0 ? `${selected.size} selected` : "Select all"}
          </button>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" disabled={selected.size === 0} className="h-6 px-2 gap-1 text-data hover:text-primary disabled:opacity-40" onClick={copySelected}>
              <Copy className="w-3 h-3" /> Copy
            </Button>
            <Button size="sm" variant="ghost" disabled={selected.size === 0} className="h-6 px-2 gap-1 text-data disabled:opacity-40" onClick={skipSelected}>
              <EyeOff className="w-3 h-3" /> Skip
            </Button>
          </div>
        </div>
      )}
      {visible.length === 0 ? (
        <div className="text-muted-foreground p-2 space-y-1">
          <div>No pivots available yet.</div>
          <div className="text-data">Pivots appear automatically as the agent records emails, usernames, domains, IPs, or wallets.</div>
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((p, i) => (
            <PivotCard
              key={canonicalKey(p)}
              pivot={p}
              index={i}
              selected={selected.has(canonicalKey(p))}
              onSelect={() => toggleSelect(p)}
              onRun={() => runPivot(p)}
              onCopy={() => copy(p.value)}
              onSkip={() => skip(p)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
