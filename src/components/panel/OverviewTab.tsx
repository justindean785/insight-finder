import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { labelForArtifact, adjustedConfidence, groupForKind, GROUP_LABEL } from "@/lib/intel";
import { useReviewStates } from "@/lib/review";
import { detectSeed } from "@/lib/seed";
import { captureError } from "@/lib/telemetry";
import { Activity, AlertTriangle, Database, ShieldAlert, Sparkles, Clock, Eye } from "lucide-react";
import { InvestigationControls } from "./InvestigationControls";
import { KeyFindings } from "./KeyFindings";

type Thread = {
  id: string;
  seed_value: string | null;
  seed_type: string | null;
  updated_at: string;
};

export function OverviewTab({ threadId, artifacts }: { threadId: string; artifacts: Artifact[] }) {
  const [thread, setThread] = useState<Thread | null>(null);
  const review = useReviewStates(threadId);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const { data, error } = await supabase
        .from("threads")
        .select("id,seed_value,seed_type,updated_at")
        .eq("id", threadId)
        .maybeSingle();
      if (error) { captureError(error, "OverviewTab.threadFetch", { threadId }); return; }
      if (alive) setThread(data as Thread | null);
    };
    load();
    const ch = supabase
      .channel(`overview-${threadId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "threads", filter: `id=eq.${threadId}` }, load)
      .subscribe();
    return () => { alive = false; supabase.removeChannel(ch); };
  }, [threadId]);

  const total = artifacts.length;
  let highConf = 0, unverified = 0, failed = 0, breaches = 0;
  const groupCounts = new Map<string, number>();
  for (const a of artifacts) {
    const r = review.get(a.id);
    const l = labelForArtifact(a, r);
    const score = adjustedConfidence(a, r);
    // "High confidence" = analyst-attested CONFIRMED, agent-derived CONFIRMED/INFERRED,
    // OR any artifact whose (review-adjusted) raw score is ≥ 80.
    if (l === "CONFIRMED" || l === "INFERRED" || score >= 70) highConf++;
    else if (l === "VERIFY" || l === "LOW") unverified++;
    else if (l === "FAILED") failed++;
    if (a.kind.toLowerCase() === "breach") breaches++;
    const g = groupForKind(a.kind);
    groupCounts.set(g, (groupCounts.get(g) ?? 0) + 1);
  }

  // Prioritise high-signal kinds (concrete pivots) over narrative "other" rows.
  const KIND_PRIORITY: Record<string, number> = {
    email: 0, domain: 1, phone: 2, name: 3, ip: 4, wallet: 5,
    username: 6, social: 7, breach: 8, url: 9, other: 99,
  };
  const strongest = [...artifacts]
    .filter((a) => {
      const r = review.get(a.id);
      const l = labelForArtifact(a, r);
      return l === "CONFIRMED" || l === "INFERRED" || adjustedConfidence(a, r) >= 70;
    })
    .sort((a, b) => {
      const pa = KIND_PRIORITY[a.kind.toLowerCase()] ?? 50;
      const pb = KIND_PRIORITY[b.kind.toLowerCase()] ?? 50;
      if (pa !== pb) return pa - pb;
      return (b.confidence ?? 0) - (a.confidence ?? 0);
    })
    .slice(0, 5);

  const status: "idle" | "active" | "complete" =
    total === 0 ? "idle" : highConf >= 3 ? "complete" : "active";

  const weakAreas: string[] = [];
  const expected = ["identity", "contact", "social", "infrastructure"] as const;
  for (const g of expected) if (!groupCounts.get(g)) weakAreas.push(GROUP_LABEL[g]);

  const lastUpdated = artifacts.length
    ? new Date(artifacts[artifacts.length - 1].created_at)
    : thread?.updated_at
    ? new Date(thread.updated_at)
    : null;

  return (
    <div className="p-3 space-y-4 text-xs">
      <InvestigationControls threadId={threadId} artifacts={artifacts} />

      <KeyFindings threadId={threadId} artifacts={artifacts} />

      <section className="rounded-lg border border-border-subtle bg-surface-2 p-4 space-y-2">
        <div className="flex items-center justify-between">
          <div className="uppercase tracking-[0.08em] text-eyebrow text-muted-foreground">Case</div>
          <span className={
            "px-2 py-0.5 rounded-full border font-mono uppercase tracking-wider text-eyebrow " +
            (status === "complete"
              ? "text-success border-success/50 bg-success/10"
              : status === "active"
              ? "text-primary border-primary/50 bg-primary/10"
              : "text-muted-foreground border-border bg-surface-3")
          }>{status}</span>
        </div>
        <div className="font-mono text-base text-foreground break-all">{thread?.seed_value || "—"}</div>
        <div className="flex items-center gap-2">
          <span className="px-1.5 py-0.5 rounded border border-border text-eyebrow font-mono uppercase tracking-wider text-muted-foreground">
            {thread?.seed_type
              || (thread?.seed_value ? detectSeed(thread.seed_value)?.kind : null)
              || "no seed"}
          </span>
          {lastUpdated && (
            <span className="text-data text-muted-foreground">
              updated {lastUpdated.toLocaleDateString()}
            </span>
          )}
        </div>
      </section>

      <section className="grid grid-cols-2 gap-3">
        <Stat icon={Database} label="Artifacts" value={total} accent="neutral" />
        <Stat icon={Sparkles} label="High conf." value={highConf} accent="high" />
        <Stat icon={AlertTriangle} label="Unverified" value={unverified} accent={unverified ? "warning" : "muted"} />
        <Stat icon={ShieldAlert} label="Breaches" value={breaches} accent={breaches ? "danger" : "muted"} />
      </section>

      <section className="rounded-lg border border-border-subtle bg-surface-2 p-3">
        <div className="flex items-center gap-2 text-eyebrow uppercase tracking-wider text-muted-foreground mb-2">
          <Activity className="w-3 h-3" /> Coverage
        </div>
        <div className="space-y-1.5">
          {Array.from(groupCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([g, n]) => (
              <div key={g} className="flex items-center justify-between">
                <span className="text-foreground">{GROUP_LABEL[g as keyof typeof GROUP_LABEL] ?? g}</span>
                <span className="font-mono text-muted-foreground">{n}</span>
              </div>
            ))}
          {groupCounts.size === 0 && (
            <div className="text-muted-foreground">
              No artifacts yet. Submit a seed in the chat to start populating coverage.
            </div>
          )}
        </div>
      </section>

      <section className="rounded-lg border border-border-subtle bg-surface-2 p-3">
        <div className="text-eyebrow uppercase tracking-wider text-muted-foreground mb-2">Strongest leads</div>
        {strongest.length === 0 ? (
          <div className="text-muted-foreground">
            No confirmed findings yet. Mark a strong artifact as <span className="text-foreground">important</span> or run more pivots.
          </div>
        ) : (
          <ul className="space-y-1">
            {strongest.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-2">
                <span className="font-mono truncate text-foreground" title={a.value}>{a.value}</span>
                <span className="text-eyebrow uppercase tracking-wider text-muted-foreground shrink-0">{a.kind}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-border-subtle bg-surface-2 p-3">
        <div className="text-eyebrow uppercase tracking-wider text-muted-foreground mb-2">Weak areas</div>
        {weakAreas.length === 0 ? (
          <div className="text-muted-foreground">Core surfaces covered. Consider pivoting deeper.</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {weakAreas.map((w) => (
              <span key={w} className="px-1.5 py-0.5 rounded border border-border text-muted-foreground">
                missing: {w}
              </span>
            ))}
          </div>
        )}
        {failed > 0 && (
          <div className="mt-2 text-muted-foreground">
            <span className="text-destructive font-mono">{failed}</span> marked false positive
          </div>
        )}
      </section>

      <AnalystSummary
        seedValue={thread?.seed_value ?? null}
        total={total}
        highConf={highConf}
        unverified={unverified}
        failed={failed}
        breaches={breaches}
        groupCounts={groupCounts}
        weakAreas={weakAreas}
      />

      <div className="flex items-center gap-1 text-muted-foreground">
        <Clock className="w-3 h-3" />
        {lastUpdated ? `Updated ${lastUpdated.toLocaleString()}` : "—"}
      </div>
    </div>
  );
}

function Stat({
  icon: Icon, label, value, accent,
}: { icon: React.ComponentType<{ className?: string }>; label: string; value: number; accent?: "neutral" | "high" | "warning" | "danger" | "muted" }) {
  // One meaning per color: counts are neutral; only status-bearing metrics get color.
  const valueColor =
    accent === "high" ? "text-highconf" :
    accent === "warning" ? "text-warning" :
    accent === "danger" ? "text-danger" :
    accent === "muted" ? "text-muted-foreground" :
    "text-foreground";
  const iconColor =
    accent === "high" ? "text-highconf" :
    accent === "warning" ? "text-warning" :
    accent === "danger" ? "text-danger" :
    "text-muted-foreground";
  // Subtle left bar only when the metric is actively flagging something
  const rail =
    accent === "warning" ? "bg-warning" :
    accent === "danger" ? "bg-danger" :
    "bg-transparent";
  return (
    <div className="relative overflow-hidden rounded-lg border border-border-subtle bg-surface-2 p-4 transition-colors hover:bg-surface-3">
      <div className={`absolute left-0 top-0 bottom-0 w-[3px] ${rail}`} />
      <div className="flex items-center gap-1.5 text-eyebrow uppercase tracking-[0.08em] text-muted-foreground">
        <Icon className={`w-3 h-3 ${iconColor}`} /> {label}
      </div>
      <div className={`mt-1.5 text-3xl font-display font-semibold tabular-nums leading-none ${valueColor}`}>
        {value}
      </div>
    </div>
  );
}

/* ---------- AI Summary cards ----------
   Auto-generated, deterministic narrative + caveats derived from the current
   evidence frame. No model call: this is a "presentation pattern" that turns
   the metric grid into analyst-ready prose with explicit blind spots. */
function AnalystSummary({
  seedValue, total, highConf, unverified, failed, breaches, groupCounts, weakAreas,
}: {
  seedValue: string | null;
  total: number; highConf: number; unverified: number;
  failed: number; breaches: number;
  groupCounts: Map<string, number>;
  weakAreas: string[];
}) {
  if (total === 0) return null;

  const subject = seedValue ? `\`${seedValue}\`` : "the seed";
  const coverage = Array.from(groupCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([g]) => g);

  const narrative: string[] = [];
  narrative.push(`Investigation on ${subject} surfaced ${total} artifact${total === 1 ? "" : "s"}, of which ${highConf} carr${highConf === 1 ? "ies" : "y"} high confidence.`);
  if (coverage.length) {
    narrative.push(`Strongest surfaces: ${coverage.join(", ")}.`);
  }
  if (breaches > 0) {
    narrative.push(`${breaches} breach exposure${breaches === 1 ? "" : "s"} confirmed against external sources.`);
  }
  if (highConf >= 3 && unverified === 0 && failed === 0) {
    narrative.push("Findings are mutually consistent — no contradictions or unverified leads remaining.");
  }

  const caveats: string[] = [];
  if (unverified > 0) {
    caveats.push(`${unverified} artifact${unverified === 1 ? "" : "s"} still require analyst verification.`);
  }
  if (failed > 0) {
    caveats.push(`${failed} entr${failed === 1 ? "y" : "ies"} flagged as false positive — exclude from conclusions.`);
  }
  if (weakAreas.length) {
    caveats.push(`Coverage gaps: ${weakAreas.join(", ")}. Pivots in these areas may surface new evidence.`);
  }
  if (highConf === 0 && total > 0) {
    caveats.push("No artifacts have crossed the high-confidence threshold. Treat all conclusions as provisional.");
  }
  if (caveats.length === 0) caveats.push("No material blind spots detected for the current scope.");

  return (
    <div className="grid grid-cols-1 gap-3">
      <section className="rounded-lg border border-primary/25 bg-gradient-to-br from-primary/[0.06] to-transparent p-3">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-1.5 text-eyebrow uppercase tracking-[0.12em] text-primary">
            <Sparkles className="w-3 h-3" /> Analyst-ready summary
          </div>
          <span className="text-[10px] font-mono uppercase tracking-wider text-muted-foreground">auto · derived</span>
        </div>
        <p className="text-data leading-relaxed text-foreground/90">
          {narrative.join(" ")}
        </p>
      </section>

      <section className="rounded-lg border border-warning/25 bg-gradient-to-br from-warning/[0.06] to-transparent p-3">
        <div className="flex items-center gap-1.5 text-eyebrow uppercase tracking-[0.12em] text-warning mb-2">
          <Eye className="w-3 h-3" /> Caveats &amp; blind spots
        </div>
        <ul className="space-y-1 text-data leading-relaxed text-foreground/85">
          {caveats.map((c, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-warning/80 mt-1.5 w-1 h-1 rounded-full bg-warning shrink-0" />
              <span>{c}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}