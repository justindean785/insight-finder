import {
  effectiveTier,
  type ClusterAudit,
  type ConfidenceFinding,
} from "@/lib/audit/confidence-linter";
import {
  computeEffectiveSourceCount,
  type IndependenceFinding,
  type Source,
} from "@/lib/audit/source-independence";
import { ConfidenceMeter, FindingPill, SectionLabel, Stat, TierBadge } from "./primitives";

export interface Hypothesis {
  id: string;
  label: string;
  evidence: string;
  confidence: number;
  distinguishingEvidence: string;
}

export interface ReportCardV2Props {
  seed: { value: string; type: string };
  clusters: ClusterAudit[];
  confidenceFindings: ConfidenceFinding[];
  independenceFindings: IndependenceFinding[];
  sources: Source[];
  hypotheses: Hypothesis[];
  cost: number;
  status: "running" | "complete" | "blocked";
  caseId?: string;
  analyst?: string;
  generatedAt?: string;
}

export function ReportCardV2(props: ReportCardV2Props) {
  const errors =
    props.confidenceFindings.filter((f) => f.severity === "error").length +
    props.independenceFindings.filter((f) => f.severity === "error").length;
  const warns =
    props.confidenceFindings.filter((f) => f.severity === "warn").length +
    props.independenceFindings.filter((f) => f.severity === "warn").length;

  const declared = props.sources.length;
  const effective = computeEffectiveSourceCount(props.sources);
  const collapsed = declared - effective;

  const verdict =
    errors > 0 ? { label: "BLOCKED", tone: "err" as const } :
    warns > 0 ? { label: "ADVISORY", tone: "warn" as const } :
    { label: "CLEAN", tone: "ok" as const };

  return (
    <div className="overflow-hidden rounded-md border border-border-subtle bg-surface-1 shadow-[0_24px_64px_rgba(0,0,0,0.45),inset_0_1px_0_hsl(0_0%_100%/0.04)]">
      <Hero
        status={props.status}
        cost={props.cost}
        caseId={props.caseId}
        analyst={props.analyst}
        generatedAt={props.generatedAt}
        verdict={verdict}
        declared={declared}
        effective={effective}
        collapsed={collapsed}
        errors={errors}
        warns={warns}
      />
      <Seed seed={props.seed} />
      <Clusters clusters={props.clusters} findings={props.confidenceFindings} />
      <Hypotheses items={props.hypotheses} />
      <Independence
        sources={props.sources}
        findings={props.independenceFindings}
        declared={declared}
        effective={effective}
      />
      <AuditFooter errors={errors} warns={warns} verdict={verdict} />
    </div>
  );
}

/* ── Hero ──────────────────────────────────────────────────────────── */

function Hero({
  status, cost, caseId, analyst, generatedAt,
  verdict, declared, effective, collapsed, errors, warns,
}: {
  status: ReportCardV2Props["status"];
  cost: number;
  caseId?: string;
  analyst?: string;
  generatedAt?: string;
  verdict: { label: string; tone: "ok" | "warn" | "err" };
  declared: number;
  effective: number;
  collapsed: number;
  errors: number;
  warns: number;
}) {
  const vc = toneToken(verdict.tone);
  return (
    <div className="border-b border-border-subtle px-6 py-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <StatusPip status={status} />
          <span className="font-mono text-eyebrow uppercase tracking-[0.24em] text-muted-foreground">
            OSINT · Investigation
          </span>
          <div className="h-3 w-px bg-border-strong/60" />
          <span className="font-mono text-data tabular-nums text-muted-foreground/60">{caseId ?? "—"}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="font-mono text-micro tracking-normal text-muted-foreground/60">Verdict</span>
          <span
            className="rounded-[3px] px-2 py-0.5 font-mono text-eyebrow uppercase tracking-[0.16em]"
            style={{ color: `hsl(${vc})`, background: `hsl(${vc} / 0.1)`, border: `1px solid hsl(${vc} / 0.3)` }}
          >
            {verdict.label}
          </span>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-x-8 gap-y-4 md:grid-cols-5">
        <Stat label="Sources / Declared" value={declared} />
        <Stat
          label="Sources / Effective"
          value={effective}
          tone={collapsed > 0 ? "warn" : "neutral"}
          delta={collapsed > 0 ? `−${collapsed}` : undefined}
        />
        <Stat label="Errors" value={errors} tone={errors > 0 ? "err" : "neutral"} />
        <Stat label="Warnings" value={warns} tone={warns > 0 ? "warn" : "neutral"} />
        <Stat label="Cost (USD)" value={`$${cost.toFixed(4)}`} />
      </div>

      <div className="mt-4 flex items-center gap-4 font-mono text-data text-muted-foreground/60">
        <span>ANALYST <span className="text-muted-foreground">{analyst ?? "—"}</span></span>
        <div className="h-2 w-px bg-border-strong/60" />
        <span>GENERATED <span className="text-muted-foreground">{generatedAt ?? "—"}</span></span>
      </div>
    </div>
  );
}

function StatusPip({ status }: { status: "running" | "complete" | "blocked" }) {
  const c =
    status === "running" ? "var(--confidence-mid)" :
    status === "complete" ? "var(--confidence-high)" :
    "var(--danger)";
  return (
    <span className="relative inline-flex h-2 w-2">
      {status === "running" && (
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-40" style={{ background: `hsl(${c})` }} />
      )}
      <span className="relative inline-flex h-2 w-2 rounded-full" style={{ background: `hsl(${c})`, boxShadow: `0 0 8px hsl(${c})` }} />
    </span>
  );
}

/* ── Seed ──────────────────────────────────────────────────────────── */

function Seed({ seed }: { seed: { value: string; type: string } }) {
  return (
    <div className="grid grid-cols-[140px_1fr_auto] items-center gap-6 border-b border-border-subtle px-6 py-4">
      <span className="font-mono text-micro tracking-normal text-muted-foreground/60">
        Seed · {seed.type.toUpperCase()}
      </span>
      {/* Seed value uses the primary accent (the one place it's spent). */}
      <span className="font-mono text-body tracking-tight text-primary">{seed.value}</span>
      <button
        onClick={() => navigator.clipboard?.writeText(seed.value)}
        className="font-mono text-micro tracking-normal text-muted-foreground/60 transition-colors hover:text-foreground"
      >
        Copy →
      </button>
    </div>
  );
}

/* ── Clusters ──────────────────────────────────────────────────────── */

function Clusters({ clusters, findings }: { clusters: ClusterAudit[]; findings: ConfidenceFinding[] }) {
  return (
    <section className="border-b border-border-subtle px-6 py-5">
      <SectionLabel count={clusters.length}>Identity Clusters</SectionLabel>
      <div className="mt-4 space-y-4">
        {clusters.map((c) => {
          const issues = findings.filter((f) => f.cluster === c.name);
          const effective = effectiveTier(c);
          const drifted = effective !== c.declaredTier;
          const meanConf = Math.round(
            c.cells.reduce((s, x) => s + x.confidence, 0) / Math.max(c.cells.length, 1),
          );
          return (
            <div key={c.name} className="overflow-hidden rounded-[4px] border border-border-subtle bg-surface-2">
              {/* Header — only border in this whole card body */}
              <div className="flex items-center justify-between border-b border-border-subtle px-4 py-3">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-data tabular-nums text-muted-foreground/60">
                    {c.cells.length.toString().padStart(2, "0")}
                  </span>
                  <h3 className="text-body tracking-tight text-foreground">{c.name}</h3>
                </div>
                <div className="flex items-center gap-3">
                  {drifted ? (
                    <div className="flex items-center gap-2">
                      {/* Declared, muted/struck — violet can never appear here unearned */}
                      <TierBadge tier={c.declaredTier} muted size="sm" />
                      <DriftArrow />
                      <TierBadge tier={effective} />
                    </div>
                  ) : (
                    <TierBadge tier={c.declaredTier} />
                  )}
                  <div className="h-3 w-px bg-border-strong/60" />
                  <ConfidenceMeter value={meanConf} width={64} />
                </div>
              </div>

              {/* Cell table — header divider only, body rows use spacing.
                  Scrolls horizontally below the table's min width so the
                  fixed-px columns never clip on narrow viewports. */}
              <div className="overflow-x-auto">
                <div className="min-w-[560px]">
                <div className="grid grid-cols-[140px_1fr_180px_120px] gap-4 border-b border-border-subtle px-4 py-2">
                  {["Claim", "Value", "Source", "Conf"].map((h) => (
                    <span key={h} className="font-mono text-micro tracking-normal text-muted-foreground/60">
                      {h}
                    </span>
                  ))}
                </div>
                {c.cells.map((cell, i) => (
                  <div key={i} className="grid grid-cols-[140px_1fr_180px_120px] items-center gap-4 px-4 py-2.5">
                    <span className="truncate font-mono text-eyebrow uppercase tracking-[0.12em] text-muted-foreground/70">
                      {cell.claim}
                    </span>
                    <span className="truncate text-meta tracking-tight text-foreground">{String(cell.value)}</span>
                    <span className="truncate font-mono text-data text-muted-foreground">{cell.source}</span>
                    <ConfidenceMeter value={cell.confidence} width={72} />
                  </div>
                ))}
                </div>
              </div>

              {issues.length > 0 && (
                <div className="space-y-1.5 border-t border-border-subtle bg-surface-1 px-4 py-3">
                  {issues.map((f, i) => (
                    <FindingPill key={i} severity={f.severity}>
                      {f.message}
                      {f.suggestion && <span className="text-muted-foreground"> → {f.suggestion}</span>}
                    </FindingPill>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ── Hypotheses ────────────────────────────────────────────────────── */

function Hypotheses({ items }: { items: Hypothesis[] }) {
  if (items.length === 0) return null;
  const total = items.reduce((s, h) => s + h.confidence, 0) || 1;
  return (
    <section className="border-b border-border-subtle px-6 py-5">
      <SectionLabel count={items.length}>Competing Hypotheses</SectionLabel>

      <div className="mt-4 flex h-1.5 overflow-hidden rounded-[1px] bg-surface-2">
        {items.map((h, i) => (
          <div
            key={h.id}
            className="h-full"
            style={{
              width: `${(h.confidence / total) * 100}%`,
              background: i === 0 ? "hsl(var(--primary))" : `hsl(var(--muted-foreground) / ${Math.max(0.2, 1 - i * 0.2)})`,
            }}
            title={`${h.label}: ${h.confidence}`}
          />
        ))}
      </div>

      <div className="mt-4 space-y-2">
        {items.map((h, i) => {
          const isLead = i === 0;
          return (
            <div
              key={h.id}
              className="grid grid-cols-[60px_1fr_120px] items-start gap-4 rounded-[3px] border px-4 py-3"
              style={{
                background: isLead ? "hsl(var(--primary) / 0.04)" : "hsl(var(--surface-2))",
                borderColor: isLead ? "hsl(var(--primary) / 0.18)" : "hsl(var(--border-subtle))",
              }}
            >
              <div className="flex flex-col gap-1">
                <span className="font-mono text-data tracking-[0.16em]" style={{ color: isLead ? "hsl(var(--primary))" : "hsl(var(--muted-foreground))" }}>
                  {h.id}
                </span>
                {isLead && (
                  <span className="font-mono text-micro uppercase tracking-[0.18em] text-primary/80">Lead</span>
                )}
              </div>
              <div className="flex flex-col gap-2">
                <span className="text-meta tracking-tight text-foreground">{h.label}</span>
                <span className="text-data leading-relaxed text-muted-foreground">{h.evidence}</span>
                <div className="mt-1 flex items-start gap-2 rounded-[2px] bg-surface-1 px-2.5 py-1.5">
                  <span className="font-mono text-micro tracking-normal text-muted-foreground/60">Needs</span>
                  <span className="text-data text-muted-foreground">{h.distinguishingEvidence}</span>
                </div>
              </div>
              <div className="flex justify-end">
                <ConfidenceMeter value={h.confidence} width={88} />
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ── Source independence ───────────────────────────────────────────── */

function Independence({
  sources, findings, declared, effective,
}: {
  sources: Source[];
  findings: IndependenceFinding[];
  declared: number;
  effective: number;
}) {
  return (
    <section className="border-b border-border-subtle px-6 py-5">
      <SectionLabel count={sources.length} status={declared !== effective ? "warn" : "ok"}>
        Source Independence
      </SectionLabel>

      <div className="mt-4 grid grid-cols-[1fr_auto_1fr] items-center gap-6">
        <CollapseBlock label="Declared" value={declared} total={sources.length} />
        <div className="flex flex-col items-center gap-1">
          <DriftArrow wide />
          {declared - effective > 0 && (
            <span className="font-mono text-data tabular-nums" style={{ color: "hsl(var(--confidence-mid))" }}>
              −{declared - effective}
            </span>
          )}
        </div>
        <CollapseBlock label="Effective" value={effective} total={sources.length} collapsed />
      </div>

      {/* Source ledger — header divider only. Scrolls horizontally below the
          table's min width instead of clipping the fixed-px columns. */}
      <div className="mt-5 overflow-x-auto rounded-[4px] border border-border-subtle bg-surface-2">
        <div className="min-w-[680px]">
        <div className="grid grid-cols-[40px_70px_1fr_1fr_140px_56px] gap-3 border-b border-border-subtle bg-surface-1 px-4 py-2">
          {["ID", "Type", "Origin", "URL", "Retrieved", "Conf"].map((h) => (
            <span key={h} className="font-mono text-micro tracking-normal text-muted-foreground/60">{h}</span>
          ))}
        </div>
        {sources.map((s) => (
          <div key={s.id} className="grid grid-cols-[40px_70px_1fr_1fr_140px_56px] items-center gap-3 px-4 py-2">
            <span className="font-mono text-data text-primary">{s.id}</span>
            <span className="font-mono text-eyebrow uppercase tracking-[0.1em] text-muted-foreground">{s.type}</span>
            <span className="truncate font-mono text-data text-foreground">{s.origin ?? "—"}</span>
            <span className="truncate font-mono text-data text-muted-foreground/60">{s.url ?? "—"}</span>
            <span className="font-mono text-data tabular-nums text-muted-foreground">
              {s.retrievedAt.slice(0, 19).replace("T", " ")}
            </span>
            <ConfidenceMeter value={s.confidence} width={44} showValue={false} />
          </div>
        ))}
        </div>
      </div>

      {findings.length > 0 && (
        <div className="mt-4 space-y-1.5">
          {findings.map((f, i) => (
            <FindingPill key={i} severity={f.severity}>{f.message}</FindingPill>
          ))}
        </div>
      )}
    </section>
  );
}

function CollapseBlock({
  label, value, total, collapsed = false,
}: {
  label: string;
  value: number;
  total: number;
  collapsed?: boolean;
}) {
  return (
    <div
      className="rounded-[4px] border p-4"
      style={{
        background: collapsed ? "hsl(var(--primary) / 0.04)" : "hsl(var(--surface-2))",
        borderColor: collapsed ? "hsl(var(--primary) / 0.18)" : "hsl(var(--border-subtle))",
      }}
    >
      <span className="font-mono text-micro tracking-normal text-muted-foreground/60">{label}</span>
      <div className="mt-2 flex items-baseline gap-3">
        <span className="font-mono text-display leading-none tabular-nums tracking-tight" style={{ color: collapsed ? "hsl(var(--primary))" : "hsl(var(--foreground))" }}>
          {value.toString().padStart(2, "0")}
        </span>
        <span className="font-mono text-eyebrow tracking-normal text-muted-foreground/60">sources</span>
      </div>
      <div className="mt-3 flex gap-1">
        {Array.from({ length: Math.max(total, 1) }).map((_, i) => (
          <div
            key={i}
            className="h-1 flex-1 rounded-[1px]"
            style={{
              background: collapsed && i >= value ? "hsl(var(--border-strong))" : "hsl(var(--primary))",
              opacity: collapsed && i >= value ? 0.3 : 0.7,
            }}
          />
        ))}
      </div>
    </div>
  );
}

/* ── Audit footer ──────────────────────────────────────────────────── */

function AuditFooter({
  errors, warns, verdict,
}: {
  errors: number;
  warns: number;
  verdict: { label: string; tone: "ok" | "warn" | "err" };
}) {
  const c = toneToken(verdict.tone);
  const msg =
    verdict.tone === "ok" ? "All checks passed. Report ready for finalization." :
    verdict.tone === "warn" ? "Advisory: report may proceed with annotated caveats." :
    "Resolve errors before finalizing.";
  return (
    <div className="flex items-center justify-between px-6 py-4" style={{ background: `hsl(${c} / 0.04)` }}>
      <div className="flex items-center gap-3">
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: `hsl(${c})`, boxShadow: `0 0 8px hsl(${c})` }} />
        <span className="font-mono text-data" style={{ color: `hsl(${c})` }}>{msg}</span>
      </div>
      <div className="flex items-center gap-5 font-mono text-data text-muted-foreground/60">
        <span>ERR <span style={{ color: errors > 0 ? "hsl(var(--danger))" : "hsl(var(--muted-foreground))" }}>{errors.toString().padStart(2, "0")}</span></span>
        <span>WRN <span style={{ color: warns > 0 ? "hsl(var(--confidence-mid))" : "hsl(var(--muted-foreground))" }}>{warns.toString().padStart(2, "0")}</span></span>
      </div>
    </div>
  );
}

/* ── bits ──────────────────────────────────────────────────────────── */

function DriftArrow({ wide = false }: { wide?: boolean }) {
  return wide ? (
    <svg width="32" height="20" viewBox="0 0 32 20" style={{ color: "hsl(var(--confidence-mid))" }}>
      <path d="M2 10 L26 10 M22 5 L27 10 L22 15" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg width="12" height="8" viewBox="0 0 12 8" style={{ color: "hsl(var(--confidence-mid))" }}>
      <path d="M1 4 L10 4 M7 1 L10 4 L7 7" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function toneToken(tone: "ok" | "warn" | "err"): string {
  return tone === "ok" ? "var(--confidence-high)" : tone === "warn" ? "var(--confidence-mid)" : "var(--danger)";
}
