import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { UNATTRIBUTED_CLUSTER_LABEL, buildIdentityClusters, groupForKind, type IdentityCluster } from "@/lib/intel";
import { useReviewStates } from "@/lib/review";
import { isSharedInfrastructure } from "@/lib/evidence-status";
import { captureError } from "@/lib/telemetry";
import { AlertTriangle, MapPin, Mail, Phone, User as UserIcon, Network, Tag, ShieldCheck, ShieldQuestion, Server } from "lucide-react";
import { EmptyState } from "./EmptyState";
import { ConfidenceTag } from "@/components/ui/confidence";
import { AuthoritySpine } from "@/components/ui/authority";
import type { AuthorityState } from "@/lib/authority";
import { clusterDisplayId } from "@/lib/report-hygiene";
import { cn } from "@/lib/utils";

export function ClustersTab({ threadId, artifacts }: { threadId: string; artifacts: Artifact[] }) {
  const [seedValue, setSeedValue] = useState<string | null>(null);

  useEffect(() => {
    // Guard against a thread-switch race (see TimelineTab): a late seed fetch for
    // the previous thread must not overwrite the current thread's seed and
    // mislabel cluster "seed match".
    let alive = true;
    supabase
      .from("threads")
      .select("seed_value")
      .eq("id", threadId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!alive) return;
        if (error) { captureError(error, "ClustersTab.seedFetch", { threadId }); return; }
        setSeedValue((data as { seed_value: string | null } | null)?.seed_value ?? null);
      });
    return () => { alive = false; };
  }, [threadId]);

  // Analyst verdicts must reach clustering too — not just the Evidence list and
  // Report. An artifact marked False ("dismissed"/"wrong") is excluded from
  // cluster formation and confidence, so a dismissed identity can no longer read
  // as a CONFIRMED cluster in this graph.
  const review = useReviewStates(threadId);
  const reviews = useMemo(() => {
    const m: Record<string, ReturnType<typeof review.get>> = {};
    for (const a of artifacts) {
      const r = review.get(a.id);
      if (r !== "new") m[a.id] = r;
    }
    return m;
  }, [artifacts, review]);

  const report = useMemo(() => buildIdentityClusters(artifacts, seedValue, reviews), [artifacts, seedValue, reviews]);

  if (artifacts.length === 0) {
    return <EmptyState icon={Network} title="No clusters yet" hint="Identity clusters appear once tools return emails, usernames, or phones." />;
  }

  return (
    <div className="p-3 space-y-3">
      <p className="text-micro leading-snug text-muted-foreground">
        Identities the run merged from shared selectors. A cluster is a
        hypothesis about who these observations belong to — quarantined and
        collision rows are excluded from cluster formation and are listed on the
        Evidence board instead.
      </p>
      {report.warnings.length > 0 && (
        <div className="panel relative overflow-hidden border-[hsl(var(--authority-conflict))]/40 bg-[hsl(var(--authority-conflict))]/8 p-3 pl-4 space-y-1.5">
          <AuthoritySpine state="conflict" />
          <div className="flex items-center gap-1.5 text-micro font-semibold text-destructive tracking-normal">
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
  // Matches the unattributed sentinel exported by intel.ts (#485). "unknown"
  // is kept so a label built before that rename still relabels correctly.
  const title = infraOnly
    ? c.label.replace(
        new RegExp(`—\\s*(?:${UNATTRIBUTED_CLUSTER_LABEL}|unknown)\\s*$`, "i"),
        "— infrastructure",
      )
    : c.label;
  // Spine state, read off the cluster's EXISTING verdicts — no new scoring.
  // A cluster that carries a misattribution warning or an out-of-area seed
  // mismatch is the thing an analyst must not scroll past, so it gets the
  // conflict spine; infra-only clusters read as infrastructure, never identity.
  const spineState: AuthorityState =
    c.warnings.length > 0 || matches === false ? "conflict"
    : infraOnly ? "infrastructure"
    : matches === true ? "verified"
    : "review";
  return (
    <div
      className={cn(
        // One material (.panel) plus a spine, like every other authority
        // surface — the cluster card used to be the only place that encoded
        // state as a coloured BORDER + ring, which read as a selection state
        // rather than as a verdict.
        "panel panel-raised relative overflow-hidden p-3 pl-4 space-y-2",
        !infraOnly && matches === false && "border-[hsl(var(--authority-conflict))]/35",
      )}
    >
      <AuthoritySpine state={spineState} />
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-eyebrow font-mono uppercase tracking-[0.14em] text-muted-foreground/70">
            {clusterDisplayId(index)}
          </div>
          {/* `c.label` already reads "Cluster C001 — jharker88"; the ID now has
              its own mono eyebrow above, so strip the redundant prefix rather
              than printing the identifier twice on every card. */}
          <div className="mt-0.5 text-meta font-semibold leading-tight">
            {title.replace(/^\s*Cluster\s+C\d+\s*—\s*/i, "")}
          </div>
        </div>
        {infraOnly ? (
          <div className="text-micro font-mono px-1.5 py-0.5 rounded border shrink-0 text-muted-foreground border-border bg-secondary/40">
            <span className="flex items-center gap-1"><Server className="w-2.5 h-2.5" />{shared ? "shared infra" : "infrastructure"}</span>
          </div>
        ) : (
          <div className={cn(
            "text-micro font-mono px-1.5 py-0.5 rounded border shrink-0",
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
        <div className="text-eyebrow text-muted-foreground/90 flex items-center gap-1">
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

      <div className="flex items-center justify-between text-micro text-muted-foreground border-t border-border/40 pt-1.5">
        <span className="flex items-center gap-1">
          <Tag className="w-2.5 h-2.5" />
          {c.artifacts.length} artifact{c.artifacts.length === 1 ? "" : "s"} · {c.sources.length} tool{c.sources.length === 1 ? "" : "s"}
        </span>
        <ConfidenceTag score={c.confidence} />
      </div>

      {c.mergeReasons.length > 0 && (
        <div className="text-micro text-muted-foreground/90 flex flex-wrap gap-1 leading-snug">
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
      <div className="text-muted-foreground flex items-center gap-1 text-micro tracking-normal">
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