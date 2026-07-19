import { useEffect, useMemo, useState } from "react";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { buildToolAudit, inferToolGaps } from "@/lib/intel";
import { toolDisplayName, toolActionLabel } from "@/lib/tool-display";
import { Wrench, AlertTriangle, RotateCcw, Compass, Lightbulb, Wallet, Pencil, Check } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { EmptyState } from "./EmptyState";
import { cn } from "@/lib/utils";

const CAP_KEY = (threadId: string) => `proximity:case-cap:${threadId}`;

// Per-case spend TRACKER default (USD). This budget bar is informational only —
// it is localStorage-backed and never gates or stops a run (see the copy below).
// Defaulted well above a typical deep investigation so it doesn't false-alarm at
// ~$1; the analyst can still edit it per case.
const DEFAULT_CASE_CAP_USD = 25;

function fmtUsd(micro: number) {
  const usd = micro / 1_000_000;
  if (usd <= 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function AuditTab({ threadId, artifacts }: { threadId?: string; artifacts: Artifact[] }) {
  const audit = useMemo(() => buildToolAudit(artifacts), [artifacts]);
  const gaps = useMemo(() => inferToolGaps(audit), [audit]);
  const [spentMicro, setSpentMicro] = useState<number>(0);
  const [capUsd, setCapUsd] = useState<number>(DEFAULT_CASE_CAP_USD);
  const [editingCap, setEditingCap] = useState(false);
  const [capDraft, setCapDraft] = useState<string>(DEFAULT_CASE_CAP_USD.toFixed(2));
  const [capError, setCapError] = useState<string | null>(null);

  useEffect(() => {
    if (!threadId) return;
    try {
      const raw = localStorage.getItem(CAP_KEY(threadId));
      const v = raw ? Number(raw) : NaN;
      if (Number.isFinite(v) && v > 0) { setCapUsd(v); setCapDraft(v.toFixed(2)); }
    } catch { /* ignore */ }
    supabase
      .from("threads")
      .select("cost_micro_usd")
      .eq("id", threadId)
      .maybeSingle()
      .then(({ data }) => setSpentMicro(Number((data as { cost_micro_usd: number | null } | null)?.cost_micro_usd ?? 0)));
    const ch = supabase
      .channel(`audit-spend-${threadId}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "threads", filter: `id=eq.${threadId}` }, (p) => {
        setSpentMicro(Number((p.new as { cost_micro_usd: number | null }).cost_micro_usd ?? 0));
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [threadId]);

  const saveCap = () => {
    const v = Number(capDraft);
    if (!Number.isFinite(v) || v <= 0) {
      // Don't silently no-op on bad input — that reads as a broken field.
      setCapError("Enter a positive dollar amount.");
      return;
    }
    setCapError(null);
    setCapUsd(v);
    if (threadId) localStorage.setItem(CAP_KEY(threadId), String(v));
    setEditingCap(false);
  };

  const spentUsd = spentMicro / 1_000_000;
  const pct = Math.min(100, Math.round((spentUsd / capUsd) * 100));
  const overCap = spentUsd > capUsd;
  const warn = pct >= 80;

  if (artifacts.length === 0) {
    return <EmptyState icon={Wrench} title="No tool activity yet" hint="Once tools run, costs, retries, and gaps will surface here." />;
  }

  const failedTools = audit.tools.filter((t) => t.failed > 0);
  const cachedTools = audit.tools.filter((t) => t.cached > 0);

  return (
    <div className="p-3 space-y-4 text-xs">
      {threadId && (
        <Section icon={Wallet} title="Budget" count={undefined}>
          <div className="space-y-2">
            <div className="flex items-center justify-between text-data">
              <div className="text-muted-foreground">
                Spent <span className="font-mono text-foreground">{fmtUsd(spentMicro)}</span>
                <span className="mx-1.5 opacity-40">/</span>
                {editingCap ? (
                  <span className="inline-flex items-center gap-1">
                    <span className="opacity-60">$</span>
                    <input
                      autoFocus
                      inputMode="decimal"
                      aria-label="Budget cap in dollars"
                      aria-invalid={!!capError}
                      value={capDraft}
                      onChange={(e) => { setCapDraft(e.target.value); if (capError) setCapError(null); }}
                      onKeyDown={(e) => { if (e.key === "Enter") saveCap(); if (e.key === "Escape") { setEditingCap(false); setCapError(null); } }}
                      className={cn(
                        "w-14 bg-secondary/60 border rounded px-1 font-mono text-foreground outline-none focus:border-primary/60",
                        capError ? "border-destructive" : "border-border",
                      )}
                    />
                    <button onClick={saveCap} className="text-primary hover:opacity-80"><Check className="w-3 h-3" /></button>
                  </span>
                ) : (
                  <button onClick={() => { setCapDraft(capUsd.toFixed(2)); setCapError(null); setEditingCap(true); }}
                    className="font-mono text-foreground hover:text-primary inline-flex items-center gap-1">
                    cap ${capUsd.toFixed(2)}
                    <Pencil className="w-2.5 h-2.5 opacity-60" />
                  </button>
                )}
              </div>
              <span className={
                "font-mono " +
                (overCap ? "text-destructive" : warn ? "text-[hsl(var(--confidence-mid))]" : "text-muted-foreground")
              }>{pct}%</span>
            </div>
            {editingCap && capError && (
              <div className="text-data text-destructive" role="alert">{capError}</div>
            )}
            <div className="h-1.5 rounded-full bg-secondary/60 overflow-hidden">
              <div
                className={
                  "h-full transition-all " +
                  (overCap
                    ? "bg-destructive"
                    : warn
                      ? "bg-[hsl(var(--confidence-mid))]"
                      : "bg-primary")
                }
                style={{ width: `${Math.max(2, pct)}%` }}
              />
            </div>
            {warn && (
              <div className={"text-data " + (overCap ? "text-destructive" : "text-[hsl(var(--confidence-mid))]")}>
                {overCap
                  ? `Over your $${capUsd.toFixed(2)} spend tracker by ${fmtUsd(spentMicro - capUsd * 1_000_000)} — informational only; the run is not stopped. Raise it to hide this.`
                  : "Nearing your spend tracker — informational only, not a hard limit."}
              </div>
            )}
          </div>
        </Section>
      )}

      <Section icon={Wrench} title="Tools Run" count={audit.tools.length}>
        {audit.tools.length === 0 ? (
          <Empty text="No tools observed." />
        ) : (
          <ul className="space-y-1.5">
            {audit.tools.map((t) => (
              <li key={t.tool} className="rounded-md border border-border bg-card/40 p-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-foreground truncate" title={t.tool}>{toolDisplayName(t.tool)}</span>
                  <span className="text-data font-mono text-muted-foreground">{t.totalResults} results</span>
                </div>
                <div className="flex flex-wrap gap-1.5 mt-1 text-data font-mono">
                  {t.highConf > 0 && (
                    <span className="px-1.5 py-0.5 rounded border border-[hsl(var(--confidence-high))]/40 bg-[hsl(var(--confidence-high))]/10 text-[hsl(var(--confidence-high))]">
                      {t.highConf} high
                    </span>
                  )}
                  {t.lowConf > 0 && (
                    <span className="px-1.5 py-0.5 rounded border border-[hsl(var(--confidence-mid))]/40 bg-[hsl(var(--confidence-mid))]/10 text-[hsl(var(--confidence-mid))]">
                      {t.lowConf} verify
                    </span>
                  )}
                  {t.cached > 0 && (
                    <span className="px-1.5 py-0.5 rounded border border-border bg-secondary/40 text-muted-foreground">
                      {t.cached} cached
                    </span>
                  )}
                  {t.failed > 0 && (
                    <span className="px-1.5 py-0.5 rounded border border-destructive/40 bg-destructive/10 text-destructive">
                      {t.failed} failed
                    </span>
                  )}
                  {t.kinds.length > 0 && (
                    <span className="px-1.5 py-0.5 rounded border border-border text-muted-foreground">
                      kinds: {t.kinds.join(", ")}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section icon={AlertTriangle} title="Skipped / Failed" count={failedTools.length}>
        {failedTools.length === 0 ? (
          <Empty text="No failed or skipped tools detected from artifact metadata." />
        ) : (
          <ul className="space-y-1">
            {failedTools.map((t) => (
              <li key={t.tool} className="flex items-center justify-between font-mono">
                <span className="text-foreground">{t.tool}</span>
                <span className="text-destructive">{t.failed} failed</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section icon={RotateCcw} title="Cache Usage" count={audit.cachedCount}>
        {cachedTools.length === 0 ? (
          <Empty text="No cache replays observed in artifact metadata." />
        ) : (
          <ul className="space-y-1">
            {cachedTools.map((t) => (
              <li key={t.tool} className="flex items-center justify-between font-mono">
                <span className="text-foreground">{t.tool}</span>
                <span className="text-muted-foreground">{t.cached} cached</span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section icon={Compass} title="Coverage Audit" count={undefined}>
        {(() => {
          // Build a coverage heatmap grid: each artifact kind is a cell;
          // status = done (any high-conf hit), partial (only low-conf), missing (gap).
          const kindStats = new Map<string, { high: number; low: number; total: number }>();
          for (const t of audit.tools) {
            for (const k of t.kinds) {
              const cur = kindStats.get(k) ?? { high: 0, low: 0, total: 0 };
              cur.high += t.highConf;
              cur.low += t.lowConf;
              cur.total += t.totalResults;
              kindStats.set(k, cur);
            }
          }
          const gapKinds = new Set(gaps.map((g) => g.kind));
          const rows: Array<{ kind: string; status: "done" | "partial" | "missing"; note: string }> = [];
          for (const [kind, s] of kindStats) {
            const status: "done" | "partial" | "missing" =
              s.high > 0 && !gapKinds.has(kind) ? "done"
              : s.high > 0 || s.low > 0 ? "partial"
              : "missing";
            const note = s.high > 0
              ? `${s.high} confirmed · ${s.total} hits`
              : s.low > 0 ? `${s.low} low-conf · needs verify`
              : "no hits";
            rows.push({ kind, status, note });
          }
          for (const g of gaps) {
            if (!kindStats.has(g.kind)) {
              rows.push({ kind: g.kind, status: "missing", note: `try: ${g.suggested.slice(0, 2).map((t) => toolActionLabel(t)).join(", ")}` });
            }
          }
          rows.sort((a, b) =>
            (a.status === "missing" ? 0 : a.status === "partial" ? 1 : 2)
            - (b.status === "missing" ? 0 : b.status === "partial" ? 1 : 2)
          );
          if (rows.length === 0) return <Empty text="No coverage signal yet." />;
          const palette: Record<string, string> = {
            done: "text-[hsl(var(--confidence-high))]",
            partial: "text-[hsl(var(--confidence-mid))]",
            missing: "text-[hsl(var(--danger))]",
          };
          const labels: Record<string, string> = { done: "Done", partial: "Partial", missing: "Missing" };
          return (
            <div className="space-y-2">
              <div className="flex items-center gap-3 text-micro tracking-normal text-muted-foreground">
                {(["done","partial","missing"] as const).map((s) => (
                  <span key={s} className="inline-flex items-center gap-1.5">
                    <span className={cn("coverage-cell__dot", palette[s])} />
                    {labels[s]}
                  </span>
                ))}
              </div>
              <div className="coverage-grid">
                {rows.map((r) => (
                  <div key={r.kind} className="coverage-cell" data-status={r.status}>
                    <div className="flex items-center justify-between text-eyebrow tracking-normal">
                      <span className="text-foreground/90 truncate">
                        <span className={cn("coverage-cell__dot", palette[r.status])} />
                        {r.kind}
                      </span>
                      <span className={cn("font-mono", palette[r.status])}>{labels[r.status]}</span>
                    </div>
                    <div className="mt-1 text-data text-muted-foreground font-mono truncate">{r.note}</div>
                  </div>
                ))}
              </div>
            </div>
          );
        })()}
      </Section>

      <Section icon={Lightbulb} title="Suggested Next Tool Groups" count={gaps.length}>
        {gaps.length === 0 ? (
          <Empty text="Tool fan-out looks reasonably complete." />
        ) : (
          <ul className="space-y-1 text-muted-foreground">
            {gaps.map((g) => (
              <li key={g.kind}>
                Found <span className="font-mono text-foreground">{g.kind}</span> — consider{" "}
                <span className="text-foreground">{g.suggested.map((t) => toolActionLabel(t)).join(", ")}</span>.
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

function Section({
  icon: Icon, title, count, children,
}: { icon: React.ComponentType<{ className?: string }>; title: string; count?: number; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card/30 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-micro font-semibold tracking-normal text-muted-foreground">
          <Icon className="w-3 h-3" /> {title}
        </div>
        {count != null && <span className="text-data font-mono text-muted-foreground">{count}</span>}
      </div>
      {children}
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="text-muted-foreground">{text}</div>;
}