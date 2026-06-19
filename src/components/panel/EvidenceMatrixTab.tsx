import { useMemo, useState } from "react";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import {
  CONF_LABEL_CLASS, CONF_LABEL_HELP, labelForArtifact, adjustedConfidence, type ConfLabel,
  extractSourceInfo, displayKind,
} from "@/lib/intel";
import {
  useReviewStates, REVIEW_CLASS, REVIEW_SHORT, REVIEW_STATES, REVIEW_HELP,
  REVIEW_CONFIDENCE_DELTA, type ReviewState,
} from "@/lib/review";
import { Copy, CheckCircle2, Star, ShieldQuestion, EyeOff, RotateCcw, Info, XCircle, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { ConfidenceExplain } from "@/components/ConfidenceExplain";
import { SourceBadge } from "@/components/SourceBadge";
import { explainConfidence, BADGE_TONE_CLASS } from "@/lib/confidence";
import { sanitizeValueForLabel } from "@/lib/report-hygiene";

// Primary segmented controls — 5 visible options each, anything else goes into the overflow.
const STATUS_PRIMARY: (ConfLabel | "ALL")[] = ["ALL", "CONFIRMED", "INFERRED", "VERIFY", "LOW"];
const REVIEW_PRIMARY: (ReviewState | "ANY")[] = ["ANY", "new", "confirmed", "key", "recheck"];

export function EvidenceMatrixTab({
  artifacts, onLocalUpdate, threadId,
}: { artifacts: Artifact[]; onLocalUpdate: (a: Artifact) => void; threadId: string }) {
  const [filter, setFilter] = useState<ConfLabel | "ALL">("ALL");
  const [reviewFilter, setReviewFilter] = useState<ReviewState | "ANY">("ANY");
  const review = useReviewStates(threadId);

  const rows = useMemo(() => {
    const labelled = artifacts.map((a) => {
      const r = review.get(a.id);
      return {
        a,
        review: r,
        label: labelForArtifact(a, r),
        score: adjustedConfidence(a, r),
      };
    });
    return labelled.filter((r) => {
      if (filter !== "ALL" && r.label !== filter) return false;
      if (reviewFilter !== "ANY" && r.review !== reviewFilter) return false;
      return true;
    });
  }, [artifacts, filter, reviewFilter, review]);

  const copy = (text: string, label: string) =>
    navigator.clipboard.writeText(text).then(() => toast.success(label), () => toast.error("Copy failed"));

  // keep the DB-level "reviewed" upgrade path intact, but unused here — the
  // analyst surface uses the local review states for fast iteration.
  void supabase; void onLocalUpdate;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="text-xs">
        <div className="sticky top-0 z-10 bg-card/95 backdrop-blur border-b border-border p-3 space-y-2">
        <div className="flex items-start gap-2 rounded-md border border-border bg-secondary/30 px-2.5 py-2 text-data text-muted-foreground">
          <Info className="w-3.5 h-3.5 mt-0.5 shrink-0 text-primary" />
          <div className="leading-relaxed">
            <span className="text-foreground font-medium">How review affects scoring:</span>{" "}
            <span className="text-[hsl(var(--confidence-high))]">Confirm</span> +20,{" "}
            <span className="text-primary">Key</span> +25 (both upgrade to CONFIRMED),{" "}
            <span className="text-[hsl(var(--confidence-mid))]">Recheck</span> −20 (downgrades toward VERIFY/LOW),{" "}
            <span className="text-destructive">Dismiss</span> marks as FAILED and hides it from clusters.
          </div>
        </div>

        {/* Status segmented control */}
        <div className="flex items-center gap-1 flex-wrap">
          <span className="chip-group-label">Status</span>
          {STATUS_PRIMARY.map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              data-active={filter === f}
              className="forensic-chip"
            >
              {f}
            </button>
          ))}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                data-active={filter === "FAILED"}
                className="forensic-chip"
                title="More status filters"
              >
                <MoreHorizontal className="w-3 h-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="text-xs">
              <DropdownMenuItem onClick={() => setFilter("FAILED")}>
                FAILED — marked false / dismissed
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* Review state segmented control */}
        <div className="flex items-center gap-1 flex-wrap">
          <span className="chip-group-label">Review</span>
          {REVIEW_PRIMARY.map((f) => (
            <Tooltip key={f}>
              <TooltipTrigger asChild>
                <button
                  onClick={() => setReviewFilter(f)}
                  data-active={reviewFilter === f}
                  className="forensic-chip"
                >
                  {f === "ANY" ? "ANY" : REVIEW_SHORT[f as ReviewState]}
                </button>
              </TooltipTrigger>
              {f !== "ANY" && (
                <TooltipContent side="bottom" className="max-w-[240px] text-xs">
                  {REVIEW_HELP[f as ReviewState]}
                </TooltipContent>
              )}
            </Tooltip>
          ))}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="forensic-chip" title="More review filters">
                <MoreHorizontal className="w-3 h-3" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="text-xs">
              <DropdownMenuItem onClick={() => setReviewFilter("wrong")}>
                FALSE — marked wrong
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setReviewFilter("dismissed")}>
                DISMISSED — hidden from clusters
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <span className="ml-auto flex items-center gap-2">
            <span className="font-mono text-data text-muted-foreground tabular-nums">
              {rows.length} / {artifacts.length}
            </span>
            <button
              onClick={() => { setReviewFilter("ANY"); setFilter("ALL"); }}
              className="text-eyebrow font-mono uppercase tracking-wider text-muted-foreground/70 hover:text-foreground transition-colors"
              title="Reset all filters"
            >
              reset
            </button>
          </span>
        </div>
        </div>

        <div className="p-3 space-y-3">

        {rows.length === 0 ? (
          <div className="text-muted-foreground p-2 space-y-1">
            <div>No evidence matches the current filters.</div>
            <div className="text-data">Try clearing filters or running more tools against the seed.</div>
          </div>
        ) : (
          <ul className="space-y-2">
            {rows.map(({ a, label, review: rState, score }) => {
              const meta = (a.metadata ?? {}) as Record<string, unknown>;
              const preview = Object.keys(meta).slice(0, 3).map((k) => `${k}=${shorten(String(meta[k]))}`).join(" · ");
              const delta = REVIEW_CONFIDENCE_DELTA[rState] ?? 0;
              const base = a.confidence ?? 0;
              // Score bar: base score (neutral) + review delta (green/amber overlay)
              const basePct = Math.max(0, Math.min(100, base));
              const deltaPct = Math.max(0, Math.min(100 - basePct, Math.abs(delta)));
              const deltaColor = delta > 0 ? "hsl(var(--confidence-high))" : "hsl(var(--confidence-mid))";
              const scoreColor =
                score >= 80 ? "hsl(var(--confidence-high))" :
                score >= 50 ? "hsl(var(--confidence-mid))" :
                "hsl(var(--confidence-low))";
              return (
                <li
                  key={a.id}
                  data-density-card
                  className={
                    "evidence-tile " +
                    (rState === "dismissed" ? "opacity-60" : "")
                  }
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className={"font-mono text-foreground break-all " + (rState === "dismissed" ? "line-through" : "")}>
                        {sanitizeValueForLabel(a.value, label === "CONFIRMED")}
                      </div>
                      <div className="text-eyebrow uppercase tracking-wider text-muted-foreground mt-0.5 flex items-center gap-1.5 flex-wrap">
                        <span>{displayKind(a)}</span>
                        <span>·</span>
                        <SourceAttribution artifact={a} threadId={threadId} />
                        <span>·</span>
                        <span>{new Date(a.created_at).toLocaleString()}</span>
                      </div>
                      {preview && (
                        <div className="text-data font-mono text-muted-foreground mt-1 break-all">{preview}</div>
                      )}
                      {/* Trust badges — multi-source / single-source / stale-breach / analyst */}
                      <TrustBadgesRow artifact={a} review={rState} />
                    </div>
                    <div className="shrink-0 flex flex-col items-end gap-1">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className={"px-1.5 py-0.5 rounded border font-mono text-eyebrow uppercase tracking-wider " + CONF_LABEL_CLASS[label]}>
                            {label}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="left" className="max-w-[220px] text-xs">
                          {CONF_LABEL_HELP[label]}
                        </TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className={"px-1.5 py-0.5 rounded border font-mono text-eyebrow uppercase tracking-wider " + REVIEW_CLASS[rState]}>
                            {REVIEW_SHORT[rState]}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="left" className="max-w-[240px] text-xs">
                          {REVIEW_HELP[rState]}
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>

                  {/* Score bar — replaces "score 55 (40+20)" */}
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <div className="mt-2.5 flex items-center gap-2 cursor-help">
                        <div className="relative flex-1 h-1.5 rounded-full overflow-hidden bg-surface-3">
                          <div
                            className="absolute inset-y-0 left-0 rounded-full transition-all"
                            style={{ width: `${basePct}%`, background: "hsl(var(--muted-foreground) / 0.5)" }}
                          />
                          {delta !== 0 && (
                            <div
                              className="absolute inset-y-0 rounded-full transition-all"
                              style={{
                                left: delta > 0 ? `${basePct}%` : `${Math.max(0, basePct - deltaPct)}%`,
                                width: `${deltaPct}%`,
                                background: deltaColor,
                                opacity: delta > 0 ? 0.9 : 0.55,
                              }}
                            />
                          )}
                        </div>
                        <span className="font-mono tabular-nums text-data" style={{ color: scoreColor }}>
                          {score}
                        </span>
                        <span className="font-mono text-data text-muted-foreground tabular-nums">/100</span>
                        <ConfidenceExplain artifact={a} review={rState} />
                      </div>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="max-w-[240px] text-xs">
                      <div className="space-y-0.5">
                        <div><span className="text-foreground font-medium">Score {score}/100</span></div>
                        <div className="text-muted-foreground">
                          Base {base}{delta !== 0 && <> · Review <span style={{ color: deltaColor }}>{delta > 0 ? "+" : ""}{delta}</span></>}
                        </div>
                        <div className="text-muted-foreground text-data mt-1">
                          Base = tool-reported confidence. Review delta from your Confirm/Key/Recheck decisions.
                        </div>
                      </div>
                    </TooltipContent>
                  </Tooltip>

                  {/* Hierarchical actions: primary (Confirm/Key) · secondary (Recheck/Dismiss) · overflow */}
                  <div className="mt-3 flex items-center justify-between gap-2">
                    <Button size="sm" variant="ghost" className="h-7 px-2 gap-1 text-data text-muted-foreground hover:text-foreground"
                      onClick={() => copy(a.value, "Copied value")}>
                      <Copy className="w-3 h-3" /> Copy
                    </Button>
                    <div className="flex items-center gap-1">
                      <PrimaryAction icon={CheckCircle2} label="Confirm" tip={REVIEW_HELP.confirmed}
                        active={rState === "confirmed"} tone="high"
                        onClick={() => review.set(a.id, "confirmed")} />
                      <PrimaryAction icon={Star} label="Key" tip={REVIEW_HELP.key}
                        active={rState === "key"} tone="brand"
                        onClick={() => review.set(a.id, "key")} />
                      <SecondaryAction icon={ShieldQuestion} label="Recheck" tip={REVIEW_HELP.recheck}
                        active={rState === "recheck"} tone="warn"
                        onClick={() => review.set(a.id, "recheck")} />
                      <SecondaryAction icon={EyeOff} label="Dismiss" tip={REVIEW_HELP.dismissed}
                        active={rState === "dismissed"} tone="danger"
                        onClick={() => review.set(a.id, "dismissed")} />
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="sm" variant="ghost" className="h-7 w-7 p-0">
                            <MoreHorizontal className="w-3.5 h-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="text-xs">
                          <DropdownMenuItem
                            className="text-destructive focus:text-destructive"
                            onClick={() => review.set(a.id, "wrong", { value: a.value, kind: a.kind })}
                          >
                            <XCircle className="w-3 h-3 mr-2" /> Mark as false
                          </DropdownMenuItem>
                          {rState !== "new" && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onClick={() => review.set(a.id, null)}>
                                <RotateCcw className="w-3 h-3 mr-2" /> Reset review
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        </div>
      </div>
    </TooltipProvider>
  );
}

function shorten(v: string) {
  return v.length > 30 ? v.slice(0, 27) + "…" : v;
}

/* Source attribution row — shows all sources (1..N) as clickable pills. */
function SourceAttribution({ artifact, threadId }: { artifact: Artifact; threadId: string }) {
  const src = extractSourceInfo(artifact);
  const sources = src.all.length ? src.all : (src.primary ? [src.primary] : []);
  if (sources.length === 0) return <span className="text-muted-foreground/70">—</span>;
  return (
    <span className="inline-flex items-center gap-1 flex-wrap normal-case">
      {sources.map((s) => (
        <SourceBadge key={s} source={s} threadId={threadId} size="xs" />
      ))}
    </span>
  );
}

/* Trust badges row — Multi-source / Single-source / Stale breach / Analyst. */
function TrustBadgesRow({ artifact, review }: { artifact: Artifact; review: ReviewState }) {
  const exp = explainConfidence(artifact, review);
  if (exp.badges.length === 0) return null;
  return (
    <div className="mt-1.5 flex items-center gap-1 flex-wrap">
      {exp.badges.map((b) => (
        <Tooltip key={b.key}>
          <TooltipTrigger asChild>
            <span
              className={
                "inline-flex items-center gap-1 h-5 px-1.5 rounded-full border text-data font-medium normal-case " +
                BADGE_TONE_CLASS[b.tone]
              }
            >
              {b.label}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-[240px] text-xs">{b.hint}</TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

type ActionTone = "high" | "brand" | "warn" | "danger";

function toneClasses(tone: ActionTone, active: boolean): string {
  if (active) {
    switch (tone) {
      case "high":   return "bg-[hsl(var(--confidence-high))]/15 text-[hsl(var(--confidence-high))] ring-1 ring-[hsl(var(--confidence-high))]/45";
      case "brand":  return "bg-primary/15 text-primary ring-1 ring-primary/45";
      case "warn":   return "bg-warning-muted text-warning ring-1 ring-warning/40";
      case "danger": return "bg-danger-muted text-danger ring-1 ring-danger/40";
    }
  }
  switch (tone) {
    case "high":   return "text-[hsl(var(--confidence-high))]/85 hover:bg-[hsl(var(--confidence-high))]/10";
    case "brand":  return "text-primary/85 hover:bg-primary/10";
    case "warn":   return "text-muted-foreground hover:text-warning hover:bg-warning-muted/60";
    case "danger": return "text-muted-foreground hover:text-danger hover:bg-danger-muted/60";
  }
}

function PrimaryAction({
  icon: Icon, label, tip, active, tone, onClick,
}: { icon: React.ComponentType<{ className?: string }>; label: string; tip: string; active: boolean; tone: ActionTone; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="sm" variant="ghost"
          className={"h-7 px-2.5 gap-1 text-eyebrow font-medium uppercase tracking-wider " + toneClasses(tone, active)}
          onClick={onClick}>
          <Icon className="w-3 h-3" /> {label}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[240px] text-xs">{tip}</TooltipContent>
    </Tooltip>
  );
}

function SecondaryAction({
  icon: Icon, label, tip, active, tone, onClick,
}: { icon: React.ComponentType<{ className?: string }>; label: string; tip: string; active: boolean; tone: ActionTone; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="sm" variant="ghost"
          className={"h-7 w-7 p-0 " + toneClasses(tone, active)}
          aria-label={label}
          onClick={onClick}>
          <Icon className="w-3.5 h-3.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[240px] text-xs">{label} — {tip}</TooltipContent>
    </Tooltip>
  );
}