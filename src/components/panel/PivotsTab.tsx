import { useEffect, useMemo, useState } from "react";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { buildPivots, type Pivot } from "@/lib/intel";
import { useReviewStates, REVIEW_CLASS, REVIEW_SHORT } from "@/lib/review";
import { supabase } from "@/integrations/supabase/client";
import { Copy, EyeOff, ArrowRight, Sparkles, CheckSquare, Square, Play, Wallet, GitCompare, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

const SKIP_KEY = (threadId: string) => `proximity:pivot-skip:${threadId}`;

export function PivotsTab({ threadId, artifacts }: { threadId: string; artifacts: Artifact[] }) {
  const [seedValue, setSeedValue] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [costMicro, setCostMicro] = useState<number>(0);
  const review = useReviewStates(threadId);

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
    try {
      const raw = localStorage.getItem(SKIP_KEY(threadId));
      if (raw) setSkipped(new Set(JSON.parse(raw)));
    } catch { /* ignore */ }
  }, [threadId]);

  const pivots = useMemo(() => buildPivots(artifacts, seedValue), [artifacts, seedValue]);
  const visible = pivots.filter((p) => !skipped.has(pivotKey(p)));

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
    // count kinds with conflicting unique values for identity-like signals
    for (const k of ["dob", "city", "employer", "location"]) {
      const s = byKind.get(k);
      if (s && s.size > 1) n += s.size - 1;
    }
    return n;
  }, [artifacts]);

  const costUsd = costMicro / 1_000_000;
  const fmtCost = costUsd <= 0 ? "$0" : costUsd < 0.01 ? `$${costUsd.toFixed(4)}` : `$${costUsd.toFixed(3)}`;

  const toggleSelect = (p: Pivot) => {
    const k = pivotKey(p);
    const next = new Set(selected);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setSelected(next);
  };
  const allSelected = visible.length > 0 && visible.every((p) => selected.has(pivotKey(p)));
  const toggleAll = () => {
    if (allSelected) { setSelected(new Set()); return; }
    setSelected(new Set(visible.map(pivotKey)));
  };
  const selectedPivots = visible.filter((p) => selected.has(pivotKey(p)));
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
    for (const p of selectedPivots) next.add(pivotKey(p));
    setSkipped(next);
    setSelected(new Set());
    localStorage.setItem(SKIP_KEY(threadId), JSON.stringify(Array.from(next)));
    toast.success(`Skipped ${selectedPivots.length} pivots`);
  };

  const skip = (p: Pivot) => {
    const next = new Set(skipped);
    next.add(pivotKey(p));
    setSkipped(next);
    localStorage.setItem(SKIP_KEY(threadId), JSON.stringify(Array.from(next)));
  };

  const copy = (text: string) =>
    navigator.clipboard.writeText(text).then(() => toast.success("Pivot copied"), () => toast.error("Copy failed"));

  const runPivot = (p: Pivot) => {
    window.dispatchEvent(new CustomEvent("proximity:run-pivot", {
      detail: { threadId, value: p.value, type: p.type },
    }));
    // Auto-skip so it doesn't keep appearing as "new"
    skip(p);
    toast.success(`Running pivot: ${p.value}`);
  };

  const queueAll = () => {
    if (visible.length === 0) return;
    visible.forEach((p, i) => {
      setTimeout(() => runPivot(p), i * 250);
    });
    toast.success(`Queued ${visible.length} pivots`);
  };

  return (
    <div className="p-3 space-y-3 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Sparkles className="w-3.5 h-3.5 text-primary animate-pulse" />
          <span>Suggested next leads.</span>
        </div>
        {visible.length > 0 && (
          <Button
            size="sm"
            onClick={queueAll}
            className="h-7 gap-1 text-[11px] bg-primary text-primary-foreground hover:bg-primary/90"
          >
            <Zap className="w-3 h-3" /> Queue all pivots
          </Button>
        )}
      </div>
      {/* Run-meta pills: cost + contradictions */}
      <div className="flex flex-wrap gap-1.5">
        <span
          className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full border border-border-subtle bg-surface-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
          title="Estimated API cost so far"
        >
          <Wallet className="w-3 h-3 text-[hsl(var(--info))]" />
          API cost <span className="text-foreground">{fmtCost}</span>
        </span>
        <button
          type="button"
          onClick={() => {
            window.dispatchEvent(new CustomEvent("proximity:open-tab", { detail: { tab: "matrix" } }));
          }}
          className={
            "inline-flex items-center gap-1.5 px-2 py-1 rounded-full border font-mono text-[10px] uppercase tracking-wider transition-colors " +
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
          <button onClick={toggleAll} className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground hover:text-foreground">
            {allSelected ? <CheckSquare className="w-3.5 h-3.5 text-primary" /> : <Square className="w-3.5 h-3.5" />}
            {selected.size > 0 ? `${selected.size} selected` : "Select all"}
          </button>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" disabled={selected.size === 0} className="h-6 px-2 gap-1 text-[10px] hover:text-primary disabled:opacity-40" onClick={copySelected}>
              <Copy className="w-3 h-3" /> Copy
            </Button>
            <Button size="sm" variant="ghost" disabled={selected.size === 0} className="h-6 px-2 gap-1 text-[10px] disabled:opacity-40" onClick={skipSelected}>
              <EyeOff className="w-3 h-3" /> Skip
            </Button>
          </div>
        </div>
      )}
      {visible.length === 0 ? (
        <div className="text-muted-foreground p-2 space-y-1">
          <div>No pivots available yet.</div>
          <div className="text-[10px]">Pivots appear automatically as the agent records emails, usernames, domains, IPs, or wallets.</div>
        </div>
      ) : (
        <ul className="space-y-2">
          {visible.map((p, i) => (
            <li
              key={pivotKey(p)}
              className="group relative overflow-hidden rounded-lg glass p-2.5 space-y-1.5 animate-pivot-in transition-all duration-300 hover:border-primary/60 hover:-translate-y-0.5 hover:ring-glow"
              style={{ animationDelay: `${Math.min(i * 40, 320)}ms` }}
            >
              <div className="pointer-events-none absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-500 bg-gradient-to-br from-primary/5 via-transparent to-accent/5" />
              {p.status === "new" && (
                <span className="absolute -left-px top-3 bottom-3 w-0.5 rounded-full bg-gradient-to-b from-primary to-accent animate-pulse-ring" />
              )}
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex items-start gap-2">
                  <button
                    onClick={() => toggleSelect(p)}
                    aria-label="Select pivot"
                    className="mt-0.5 shrink-0 text-muted-foreground hover:text-primary"
                  >
                    {selected.has(pivotKey(p))
                      ? <CheckSquare className="w-3.5 h-3.5 text-primary" />
                      : <Square className="w-3.5 h-3.5" />}
                  </button>
                  <div className="min-w-0">
                  <div className="font-mono text-foreground break-all group-hover:text-primary transition-colors">{p.value}</div>
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-0.5">
                    {p.type} · source: {p.source}
                  </div>
                  </div>
                </div>
                <div className="shrink-0 flex flex-col items-end gap-1">
                  <span className={
                    "px-1.5 py-0.5 rounded border font-mono text-[10px] uppercase tracking-wider " +
                    (p.status === "new"
                      ? "text-primary border-primary/40 bg-primary/10 shadow-[0_0_12px_-4px_hsl(var(--primary)/0.6)]"
                      : "text-muted-foreground border-border bg-secondary/40")
                  }>{p.status}</span>
                  {(() => {
                    const r = review.get(p.sourceArtifactId);
                    if (r === "new") return null;
                    return (
                      <span className={"px-1.5 py-0.5 rounded border font-mono text-[10px] uppercase tracking-wider " + REVIEW_CLASS[r]}>
                        {REVIEW_SHORT[r]}
                      </span>
                    );
                  })()}
                </div>
              </div>
              <div className="text-muted-foreground">{p.why}</div>
              <div className="text-[10px] text-muted-foreground flex items-center gap-1">
                <ArrowRight className="w-3 h-3 text-primary/70 transition-transform group-hover:translate-x-0.5" />
                Fan-out: <span className="text-foreground">{p.fanout}</span>
              </div>
              <div className="flex items-center justify-between gap-1">
                <Button
                  size="sm"
                  onClick={() => runPivot(p)}
                  className="h-7 px-2.5 gap-1 text-[11px] bg-primary text-primary-foreground hover:bg-primary/90"
                >
                  <Play className="w-3 h-3 fill-current" /> Run pivot <ArrowRight className="w-3 h-3" />
                </Button>
                <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" className="h-6 px-2 gap-1 text-[10px] hover:text-primary" onClick={() => copy(p.value)}>
                  <Copy className="w-3 h-3" /> Copy
                </Button>
                <Button size="sm" variant="ghost" className="h-6 px-2 gap-1 text-[10px]" onClick={() => skip(p)}>
                  <EyeOff className="w-3 h-3" /> Skip
                </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function pivotKey(p: Pivot) {
  return `${p.type}:${p.value.toLowerCase()}`;
}