import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Activity, AlertTriangle, CheckCircle2, Loader2, Brain } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Clickable source pill. On open, lazy-loads:
 *   • hit / failure / cache stats from tool_usage_log
 *   • false-positive count from artifacts (metadata.false_positive grouped by source)
 *   • patterns from agent_memory that reference this source
 * Use anywhere a source is rendered (artifact rows, pivots, patterns).
 */
export function SourceBadge({
  source, threadId, tone = "neutral", size = "md", className,
}: {
  source: string;
  threadId?: string;
  tone?: "neutral" | "primary" | "muted";
  size?: "xs" | "sm" | "md";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const cls =
    tone === "primary"
      ? "border-primary/40 bg-primary/10 text-primary"
      : tone === "muted"
      ? "border-border-subtle bg-surface-2 text-muted-foreground"
      : "border-border-subtle bg-surface-2 text-foreground/85";
  const sz =
    size === "xs" ? "h-5 px-1.5 text-data"
    : size === "sm" ? "h-5 px-2 text-data"
    : "h-6 px-2 text-data";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border font-mono uppercase tracking-[0.06em] hover:bg-surface-3 transition-colors",
            sz, cls, className,
          )}
          title={`Source: ${source}`}
        >
          <span className="w-1 h-1 rounded-full bg-current opacity-70" />
          {source}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        className="w-80 p-0 overflow-hidden border-border-subtle"
        onClick={(e) => e.stopPropagation()}
      >
        {open && <SourceStats source={source} threadId={threadId} />}
      </PopoverContent>
    </Popover>
  );
}

type Stats = {
  total: number;
  ok: number;
  failed: number;
  cached: number;
  avgMs: number | null;
  costUsd: number;
  falsePositive: number;
  patternMentions: { subject: string; content: string }[];
};

function SourceStats({ source, threadId }: { source: string; threadId?: string }) {
  const [stats, setStats] = useState<Stats | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // 1. tool usage — match by tool_name ILIKE source%
        const usagePromise = supabase
          .from("tool_usage_log")
          .select("tool_name,ok,cached,duration_ms,charged_micro_usd")
          .ilike("tool_name", `${source}%`)
          .limit(500);

        // 2. false-positive artifacts attributed to this source
        const fpPromise = supabase
          .from("artifacts")
          .select("id", { count: "exact", head: true })
          .eq("source", source)
          .contains("metadata", { false_positive: true });

        // 3. agent_memory patterns mentioning this source
        const memPromise = supabase
          .from("agent_memory")
          .select("subject,content")
          .ilike("content", `%${source}%`)
          .limit(5);

        const [usage, fp, mem] = await Promise.all([usagePromise, fpPromise, memPromise]);
        if (!alive) return;

        // costUsd reflects ACTUAL charged credits (charged_micro_usd), not the
        // attributed list price (cost_micro_usd) — so failed calls don't inflate
        // the per-source cost the user sees.
        const rows = (usage.data ?? []) as { ok: boolean; cached: boolean; duration_ms: number | null; charged_micro_usd: number }[];
        let okN = 0, failN = 0, cacheN = 0, dSum = 0, dN = 0, costMicro = 0;
        for (const r of rows) {
          if (r.ok) okN++; else failN++;
          if (r.cached) cacheN++;
          if (typeof r.duration_ms === "number") { dSum += r.duration_ms; dN++; }
          costMicro += r.charged_micro_usd ?? 0;
        }
        setStats({
          total: rows.length,
          ok: okN,
          failed: failN,
          cached: cacheN,
          avgMs: dN ? Math.round(dSum / dN) : null,
          costUsd: costMicro / 1_000_000,
          falsePositive: fp.count ?? 0,
          patternMentions: (mem.data ?? []) as { subject: string; content: string }[],
        });
      } catch (e) {
        if (alive) setErr((e as Error).message);
      }
    })();
    return () => { alive = false; };
  }, [source, threadId]);

  if (err) return <div className="p-3 text-xs text-destructive">{err}</div>;
  if (!stats) {
    return (
      <div className="p-4 text-xs text-muted-foreground flex items-center gap-2">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading source stats…
      </div>
    );
  }

  const successRate = stats.total > 0 ? Math.round((stats.ok / stats.total) * 100) : null;

  return (
    <div className="text-xs">
      <header className="px-3 py-2 border-b border-border-subtle flex items-center justify-between">
        <div className="font-mono uppercase tracking-[0.08em] text-foreground">{source}</div>
        {successRate != null && (
          <span
            className={cn(
              "font-mono tabular-nums text-data",
              successRate >= 90 ? "text-[hsl(var(--confidence-high))]" :
              successRate >= 70 ? "text-[hsl(var(--confidence-mid))]" :
              "text-[hsl(var(--confidence-low))]",
            )}
          >
            {successRate}%
          </span>
        )}
      </header>

      <div className="grid grid-cols-2 gap-px bg-border-subtle">
        <StatCell icon={CheckCircle2} label="Successful" value={stats.ok} tone="high" />
        <StatCell icon={AlertTriangle} label="Failed" value={stats.failed} tone={stats.failed > 0 ? "low" : "muted"} />
        <StatCell icon={Activity} label="Avg latency" value={stats.avgMs != null ? `${stats.avgMs} ms` : "—"} tone="muted" />
        <StatCell icon={Activity} label="Est. spend" value={`$${stats.costUsd.toFixed(4)}`} tone="muted" />
      </div>

      {stats.falsePositive > 0 && (
        <div className="px-3 py-2 border-t border-border-subtle flex items-center gap-2 text-[hsl(var(--confidence-low))]">
          <AlertTriangle className="w-3 h-3" />
          <span className="font-mono tabular-nums">{stats.falsePositive}</span>
          <span>artifact{stats.falsePositive === 1 ? "" : "s"} from this source flagged false-positive</span>
        </div>
      )}

      <div className="px-3 py-2 border-t border-border-subtle">
        <div className="flex items-center gap-1.5 text-eyebrow uppercase tracking-[0.1em] text-muted-foreground mb-1">
          <Brain className="w-3 h-3" /> Mentioned in patterns
        </div>
        {stats.patternMentions.length === 0 ? (
          <div className="text-data text-muted-foreground">No agent-memory patterns reference this source yet.</div>
        ) : (
          <ul className="space-y-1">
            {stats.patternMentions.map((p, i) => (
              <li key={i} className="text-data">
                <span className="font-mono text-foreground">{p.subject}</span>
                <span className="text-muted-foreground"> — {truncate(p.content, 80)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function StatCell({
  icon: Icon, label, value, tone,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  tone: "high" | "low" | "mid" | "muted";
}) {
  const color =
    tone === "high" ? "text-[hsl(var(--confidence-high))]" :
    tone === "low" ? "text-[hsl(var(--confidence-low))]" :
    tone === "mid" ? "text-[hsl(var(--confidence-mid))]" :
    "text-foreground";
  return (
    <div className="bg-popover px-3 py-2">
      <div className="flex items-center gap-1 text-[9px] uppercase tracking-[0.1em] text-muted-foreground">
        <Icon className="w-3 h-3" /> {label}
      </div>
      <div className={cn("mt-0.5 font-mono tabular-nums text-sm", color)}>{value}</div>
    </div>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}