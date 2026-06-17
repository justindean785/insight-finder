import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { buildIdentityClusters, groupForKind, type IdentityCluster } from "@/lib/intel";
import { isSharedInfrastructure } from "@/lib/evidence-status";
import { captureError } from "@/lib/telemetry";
import { AlertTriangle, MapPin, Mail, Phone, User as UserIcon, Network, Tag, ShieldCheck, ShieldQuestion, Server } from "lucide-react";
import { EmptyState } from "./EmptyState";
import { cn } from "@/lib/utils";

export function ClustersTab({ threadId, artifacts }: { threadId: string; artifacts: Artifact[] }) {
  const [seedValue, setSeedValue] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from("threads")
      .select("seed_value")
      .eq("id", threadId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) { captureError(error, "ClustersTab.seedFetch", { threadId }); return; }
        setSeedValue((data as { seed_value: string | null } | null)?.seed_value ?? null);
      });
  }, [threadId]);

  const report = useMemo(() => buildIdentityClusters(artifacts, seedValue), [artifacts, seedValue]);

  if (artifacts.length === 0) {
    return <EmptyState icon={Network} title="No clusters yet" hint="Identity clusters appear once tools return emails, usernames, or phones." />;
  }

  return (
    <div className="p-3 space-y-3">
      {report.warnings.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 space-y-1.5 animate-pivot-in">
          <div className="flex items-center gap-1.5 text-eyebrow font-semibold text-destructive uppercase tracking-wider">
            <AlertTriangle className="w-3.5 h-3.5" /> Misattribution warning
          </div>
          {report.warnings.map((w, i) => (
            <p key={i} className="text-data text-destructive/90 leading-relaxed">{w}</p>
          ))}
        </div>
      )}

      {(report.seedName || report.seedState) && (
        <div className="text-data text-muted-foreground font-mono flex items-center gap-2">
          {report.seedName && <span>subject: <span className="text-foreground">{report.seedName}</span></span>}
          {report.seedState && <span>· target: <span className="text-foreground">{report.seedState}</span></span>}
        </div>
      )}

      {report.clusters.length === 0 ? (
        <div className="text-xs text-muted-foreground p-2">No identifiable clusters yet.</div>
      ) : (
        report.clusters.map((c, i) => <ClusterCard key={c.id} cluster={c} index={i} />)
      )}
    </div>
  );
}

function ClusterCard({ cluster: c, index }: { cluster: IdentityCluster; index: number }) {
  const matches = c.matchesSeedLocation;
  // An infrastructure-only cluster (IPs / domains / nameservers, no identity
  // signals) must not read as a generic "unknown" identity cluster. Detect it
  // and label it as infrastructure — flagging shared/CDN hosts that are not
  // ownership proof.
  const infraOnly = c.artifacts.length > 0 && c.artifacts.every((a) => groupForKind(a.kind) === "infrastructure");
  const shared = infraOnly && c.artifacts.some((a) => isSharedInfrastructure(a));
  const title = infraOnly ? c.label.replace(/—\s*unknown\s*$/i, "— infrastructure") : c.label;
  return (
    <div
      className={cn(
        "glass rounded-lg border p-3 space-y-2 animate-pivot-in",
        !infraOnly && matches === true && "border-[hsl(var(--confidence-high))]/50 ring-1 ring-[hsl(var(--confidence-high))]/30",
        !infraOnly && matches === false && "border-destructive/30",
        (infraOnly || matches === null) && "border-border/60",
      )}
      style={{ animationDelay: `${index * 50}ms` }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-data font-semibold leading-tight">{title}</div>
        {infraOnly ? (
          <div className="text-[9px] font-mono px-1.5 py-0.5 rounded border shrink-0 text-muted-foreground border-border bg-secondary/40">
            <span className="flex items-center gap-1"><Server className="w-2.5 h-2.5" />{shared ? "shared infra" : "infrastructure"}</span>
          </div>
        ) : (
          <div className={cn(
            "text-[9px] font-mono px-1.5 py-0.5 rounded border shrink-0",
            matches === true
              ? "text-[hsl(var(--confidence-high))] border-[hsl(var(--confidence-high))]/40 bg-[hsl(var(--confidence-high))]/10"
              : matches === false
              ? "text-destructive border-destructive/40 bg-destructive/10"
              : "text-muted-foreground border-border bg-secondary/40",
          )}>
            {matches === true ? <span className="flex items-center gap-1"><ShieldCheck className="w-2.5 h-2.5" />seed match</span>
              : matches === false ? <span className="flex items-center gap-1"><AlertTriangle className="w-2.5 h-2.5" />out-of-area</span>
              : <span className="flex items-center gap-1"><ShieldQuestion className="w-2.5 h-2.5" />unknown</span>}
          </div>
        )}
      </div>
      {shared && (
        <div className="text-[10px] text-muted-foreground/90 flex items-center gap-1">
          <Server className="w-2.5 h-2.5 shrink-0" />
          Shared infrastructure · not ownership proof
        </div>
      )}

      <div className="grid grid-cols-2 gap-1.5 text-data font-mono">
        <Field icon={Mail} label="emails" values={c.emails} />
        <Field icon={UserIcon} label="usernames" values={c.usernames} />
        <Field icon={Phone} label="phones" values={c.phones.map((p, i) => c.areaCodes[i] ? `${p} (${c.areaCodes[i]})` : p)} />
        <Field icon={MapPin} label="states" values={c.states} />
        <Field icon={MapPin} label="addresses" values={c.addresses} />
        <Field icon={Network} label="ips" values={c.ips} />
      </div>

      <div className="flex items-center justify-between text-[9px] text-muted-foreground border-t border-border/40 pt-1.5">
        <span className="flex items-center gap-1">
          <Tag className="w-2.5 h-2.5" />
          {c.artifacts.length} artifact{c.artifacts.length === 1 ? "" : "s"} · {c.sources.length} tool{c.sources.length === 1 ? "" : "s"}
        </span>
        <span>conf {c.confidence}</span>
      </div>

      {c.mergeReasons.length > 0 && (
        <div className="text-[9px] text-muted-foreground/90 flex flex-wrap gap-1 leading-snug">
          {c.mergeReasons.map((r, i) => (
            <span key={i} className="font-mono px-1 py-0.5 rounded bg-secondary/40 border border-border/40">{r}</span>
          ))}
        </div>
      )}

      {c.warnings.length > 0 && (
        <div className="text-data text-destructive/90 flex items-start gap-1 leading-snug">
          <AlertTriangle className="w-3 h-3 shrink-0 mt-px" />
          <span>{c.warnings.join(" / ")}</span>
        </div>
      )}
    </div>
  );
}

function Field({
  icon: Icon, label, values,
}: { icon: React.ComponentType<{ className?: string }>; label: string; values: string[] }) {
  if (!values.length) return null;
  return (
    <div className="space-y-0.5 col-span-2">
      <div className="text-muted-foreground flex items-center gap-1 text-[9px] uppercase tracking-wider">
        <Icon className="w-2.5 h-2.5" />
        {label}
      </div>
      <div className="text-foreground break-all">
        {values.slice(0, 5).join(" · ")}
        {values.length > 5 && <span className="text-muted-foreground"> +{values.length - 5}</span>}
      </div>
    </div>
  );
}