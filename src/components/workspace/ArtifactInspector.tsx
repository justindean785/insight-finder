import { useEffect, useMemo, useState } from "react";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { supabase } from "@/integrations/supabase/client";
import {
  Copy, CheckCircle2, XCircle, Star, ShieldQuestion, X, FileText, ArrowUpRight, ArrowDownRight, AlertTriangle, ShieldAlert,
  Mail, Phone, Globe, User, Link2, Hash, MapPin, FileSearch, ChevronDown,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Chip } from "@/components/ui/chip";
import { toast } from "sonner";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { displayConfidence } from "@/lib/display-confidence";
import { extractSourceInfo } from "@/lib/intel";
import { classLabel } from "@/lib/evidence-status";
import { humanizeArtifactMetadata } from "@/lib/artifact-metadata";
import { authorityFor } from "@/lib/authority";
import {
  canReleaseLinkage, releasePatch,
  RELEASE_ACTION_LABEL, RELEASE_CONFIRM_BODY, RELEASE_CONFIRM_TITLE,
} from "@/lib/quarantine-release";
import { AuthorityChip, AuthorityCaveat, UnderlyingStrength } from "@/components/ui/authority";
import {
  useReviewStates, REVIEW_CLASS, REVIEW_LABEL, startRecheck,
  type ReviewState, type ReviewWriteResult,
} from "@/lib/review";
import { CACHE_LAYER_LABEL } from "@/lib/intel";
import { ArtifactPivotAction } from "@/components/pivots/ArtifactPivotAction";
import { useWorkspaceUIState } from "@/hooks/useWorkspaceUIState";
import { useAgentAssessment } from "@/hooks/useAgentAssessment";
import { formatDelta, LINKAGE_ATTENTION_BELOW, type AgentAssessment, type AssessmentDelta } from "@/lib/agent-assessment";
import { cn } from "@/lib/utils";

/**
 * The Finding panel — the right-hand inspector for one selected artifact,
 * laid out to JD's Case-desk prototype (R3, 2026-11-02). Mounted inside the
 * Workbench's Finding tab when `selectedArtifactId != null` (see Workbench.tsx).
 *
 * Top to bottom: the selected value with its kind; two metric bars, "Finding
 * support" and "Subject linkage" (amber below 70, "Unresolved" when the engine
 * has no linkage); why confidence changed (the delta since the previous
 * assessment, then the engine's reasons); supporting records; limits and
 * opposing evidence; then the analyst's call — Confirm (white) / False match /
 * Add note — with Key, Recheck, Dismiss and Reset one row down.
 *
 * Every figure is the R2 assessment's (`useAgentAssessment`): `findingSupport`
 * is `displayConfidence(a).effective` and `subjectLinkage` is the identity-
 * cluster engine's score. The analyst's verdict is shown as its own chip and
 * overrides the assessment on every surface; it never changes the numbers
 * ("Your review is separate from the AI assessment. Confirming does not add an
 * independent source."). The quarantine disclosure, the release flow, the note
 * draft (hoisted to WorkspaceUIStateProvider), the pivot action and the Close
 * button that restores focus to its opener all carry over from the previous
 * inspector unchanged.
 */
export interface ArtifactInspectorProps {
  artifact: Artifact;
  onClose: () => void;
  onChanged: (a: Artifact) => void;
  reviewGet: (id: string) => ReviewState;
  reviewSet: (id: string, s: ReviewState | null, ctx?: { value?: string; kind?: string; confidence?: number; source?: string }) => Promise<ReviewWriteResult>;
  threadId: string;
  allArtifacts: Artifact[];
}

const KIND_ICON: Record<string, typeof Mail> = {
  email: Mail, phone: Phone, domain: Globe, url: Link2, social_profile: Link2, username: User, handle: User,
  name: User, person: User, crypto: Hash, crypto_wallet: Hash, wallet: Hash, address: MapPin, location: MapPin, ip: Globe, ip_address: Globe,
};

export function ArtifactInspector({
  artifact, onClose, onChanged, reviewGet, reviewSet, threadId, allArtifacts,
}: ArtifactInspectorProps) {
  const meta = (artifact.metadata ?? {}) as Record<string, unknown>;
  const shownArtifact = displayConfidence(artifact);
  const metaRows = humanizeArtifactMetadata(meta);
  const falsePositive = meta.false_positive === true;
  const rState = reviewGet(artifact.id);
  const rctx = { value: artifact.value, kind: artifact.kind, confidence: shownArtifact.effective ?? undefined, source: artifact.source };
  const src = extractSourceInfo(artifact);
  const drawerAuthority = authorityFor(artifact, rState);
  const review = useReviewStates(threadId);
  const ui = useWorkspaceUIState();
  const assessment = useAgentAssessment(threadId);
  const a: AgentAssessment | null = assessment.get(artifact.id);
  const delta: AssessmentDelta | null = assessment.delta(artifact.id);
  const existingDraft = ui.getDraft(artifact.id);
  const savedNote = review.getNote(artifact.id);
  const noteDraft = existingDraft || savedNote;
  const [noteOpen, setNoteOpen] = useState<boolean>(() => Boolean(existingDraft || savedNote));
  const [moreRecords, setMoreRecords] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const KindIcon = KIND_ICON[artifact.kind.toLowerCase()] ?? FileSearch;

  const copy = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(
      () => toast.success(label),
      () => toast.error("Copy failed"),
    );
  };

  const [releasing, setReleasing] = useState(false);
  const releaseLinkage = async () => {
    if (releasing) return;
    const patch = releasePatch(meta);
    if (!patch) return toast.error("Not under linkage quarantine — nothing to release");
    setReleasing(true);
    try {
      const { data, error } = await supabase
        .from("artifacts")
        .update({ metadata: { ...meta, ...patch } as never })
        .eq("id", artifact.id)
        .select("id,kind,value,confidence,source,created_at,metadata,cluster_id")
        .maybeSingle();
      if (error || !data) return toast.error(error?.message ?? "Release failed");
      onChanged(data as Artifact);
      toast.success("Linkage confirmed — quarantine released");
    } finally {
      setReleasing(false);
    }
  };

  const citation = `\`${artifact.value}\` (${artifact.kind}${artifact.source ? `, via ${artifact.source}` : ""}${shownArtifact.effective != null ? `, ${shownArtifact.effective}%` : ""})`;

  // Polite live-region announcement used by assistive tech on inspector open
  // AND after review-state writes.
  const [liveMessage, setLiveMessage] = useState<string>("");
  useEffect(() => {
    const confText = shownArtifact.effective != null
      ? ` Confidence score ${shownArtifact.effective} out of 100, uncalibrated.`
      : "";
    const authText = drawerAuthority.label ? ` ${drawerAuthority.label}.` : "";
    setLiveMessage(`Evidence detail opened: ${artifact.value}. ${artifact.kind}.${confText}${authText}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifact.id]);
  const announceReview = (next: ReviewState | null) => {
    const label = next ? REVIEW_LABEL[next] : REVIEW_LABEL.new;
    setLiveMessage(`Review for ${artifact.value}: ${label}.`);
  };

  // Supporting records: the row's own sources, one line each. The first carries
  // the cache layer the value came through; the rest are the other tools that
  // recorded it. `src.all` already dedupes.
  const records = useMemo(() => src.all.map((s, i) => ({
    name: s,
    note: i === 0 ? `${CACHE_LAYER_LABEL[src.cacheLayer]}${src.parent ? ` · from ${src.parent}` : ""}` : "Separate capture · original retained",
  })), [src]);
  const shownRecords = moreRecords ? records : records.slice(0, 2);

  const linkage = a?.subjectLinkage ?? null;
  const support = a?.findingSupport ?? shownArtifact.effective;
  const linkageAmber = linkage !== null && linkage < LINKAGE_ATTENTION_BELOW;
  const deltaText = delta ? formatDelta(delta.linkage) : null;
  const deltaDown = (delta?.linkage ?? 0) < 0;
  const classes = a?.independentClasses ?? [];

  return (
    <div className="flex h-full flex-col" data-inspector data-artifact-id={artifact.id}>
      <span role="status" aria-live="polite" className="sr-only">{liveMessage}</span>

      <div className="flex-1 overflow-y-auto">
        <div className="px-5 py-5 text-[13px]">
          {/* Label line + Close */}
          <div className="flex items-center justify-between text-[11px] uppercase tracking-[0.09em] text-subtle-foreground">
            <span>Selected finding</span>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => copy(artifact.value, "Value copied")}
                aria-label="Copy selected value"
                className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Copy className="h-3.5 w-3.5" aria-hidden />
              </button>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close inspector"
                className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            </div>
          </div>

          {/* Selected value */}
          <div className="mb-5 mt-3.5 flex items-center gap-3">
            <span className="grid h-[33px] w-[33px] shrink-0 place-items-center rounded-[7px] border border-[hsl(var(--brand)/0.35)] bg-[hsl(var(--brand)/0.12)] text-[hsl(var(--brand))]" aria-hidden>
              <KindIcon className="h-4 w-4" strokeWidth={1.7} />
            </span>
            <div className="min-w-0">
              <b className="block break-words font-mono text-[13px] font-medium [overflow-wrap:anywhere]">{artifact.value}</b>
              <small className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[11px] text-subtle-foreground">
                <span>{artifact.kind}</span>
                <span aria-hidden>·</span>
                <span>AI assessment</span>
                {rState !== "new" && (
                  <Chip tone={REVIEW_CLASS[rState]} className="ml-1" title="Your call, recorded separately from the AI assessment">{REVIEW_LABEL[rState]}</Chip>
                )}
                {falsePositive && <Chip tone="bg-destructive/15 text-destructive border-destructive/40">false positive</Chip>}
              </small>
            </div>
          </div>

          {/* Metric bars */}
          <Metric label="Finding support" value={support} />
          <Metric label="Subject linkage" value={linkage} amber={linkageAmber} unresolvedWord={a?.group === "quarantined" ? "Withheld" : "Unresolved"} />
          <p className="mt-1.5 text-[11px] text-faint-foreground">Scores from the case engines · not calibrated probabilities</p>
          {a && <p className="mt-1 text-[12px] text-muted-foreground">{a.verdict}</p>}

          {/* Authority disclosure (quarantine / collision / caveat) + release */}
          {(drawerAuthority.state === "quarantined" || drawerAuthority.caveat) && (
            <div className="panel-inset mt-4 p-3">
              <div className="cordon mb-2.5 -mx-3 -mt-3 rounded-t-[7px]" aria-hidden />
              <div className="flex flex-wrap items-center gap-2">
                <AuthorityChip view={drawerAuthority} size="md" />
                <UnderlyingStrength view={drawerAuthority} />
              </div>
              <AuthorityCaveat view={drawerAuthority} className="mt-2" />
              {drawerAuthority.state === "quarantined" && (
                <p className="mt-2 text-micro leading-snug text-muted-foreground">
                  Recorded and kept. It does not enter identity clusters, graph identity edges, confidence, or the report until the linkage is confirmed.
                </p>
              )}
              {canReleaseLinkage(meta) && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="sm" disabled={releasing} className="mt-3 h-7 w-full font-mono text-eyebrow uppercase tracking-[0.14em]">
                      {RELEASE_ACTION_LABEL}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{RELEASE_CONFIRM_TITLE}</AlertDialogTitle>
                      <AlertDialogDescription className="whitespace-pre-line text-left">{RELEASE_CONFIRM_BODY}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => void releaseLinkage()}>{RELEASE_ACTION_LABEL}</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>
          )}

          <Divider />

          {/* Why confidence changed / is limited */}
          <h3 className="mb-3 text-[12px] font-medium">Why confidence {deltaText ? "changed" : "is limited"}</h3>
          {deltaText && (
            <div className={cn("my-3 flex items-center gap-2.5", deltaDown ? "text-[hsl(var(--warning))]" : "text-[hsl(var(--confidence-high))]")}>
              {deltaDown ? <ArrowDownRight className="h-6 w-6" aria-hidden /> : <ArrowUpRight className="h-6 w-6" aria-hidden />}
              <div>
                <b className="block text-[22px] font-medium leading-[1.1] tracking-[-0.03em]">{deltaText} linkage</b>
                <small className="mt-1 block text-[11px] text-subtle-foreground">since the previous assessment</small>
              </div>
            </div>
          )}
          {!deltaText && !assessment.hasBaseline && (
            <p className="mb-2 text-[11px] text-faint-foreground">No previous assessment on this device yet. The change line appears after the next run.</p>
          )}
          <ul className="space-y-3">
            {(a?.reasons ?? []).map((r) => (
              <li key={r} className="flex items-start gap-2.5 text-[12px] leading-relaxed text-muted-foreground">
                <i aria-hidden className={cn("mt-[7px] h-[5px] w-[5px] shrink-0 rounded-full", deltaDown ? "bg-[hsl(var(--warning))]" : "bg-[hsl(var(--confidence-high))]")} />
                <span>{r}</span>
              </li>
            ))}
            {!a && <li className="text-[12px] text-muted-foreground">Assessment not available for this row.</li>}
          </ul>
          {classes.length > 0 && (
            <p className="mt-2 text-[11px] text-faint-foreground">Independent classes: {classes.map(classLabel).join(", ")}</p>
          )}

          <Divider />

          {/* Supporting records */}
          <h3 className="mb-3 flex items-center justify-between text-[12px] font-medium">
            <span>Supporting records</span>
            <span className="text-[11px] font-normal text-subtle-foreground">{records.length} retained</span>
          </h3>
          {records.length === 0 ? (
            <p className="text-[12px] text-muted-foreground">No source recorded for this row.</p>
          ) : (
            <ul className="space-y-2">
              {shownRecords.map((r, i) => (
                <li key={`${r.name}-${i}`} className="flex gap-2.5 rounded-md border border-border-subtle bg-surface-1/60 p-2.5">
                  <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0">
                    <b className="block font-mono text-[11px] font-medium [overflow-wrap:anywhere]">{r.name}</b>
                    <small className="mt-0.5 block text-[11px] text-subtle-foreground [overflow-wrap:anywhere]">{r.note}</small>
                    {i === 0 && (
                      <small className="mt-0.5 block text-[11px] text-subtle-foreground">Captured {new Date(artifact.created_at).toLocaleString()} · custody reference</small>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
          {records.length > 2 && (
            <button
              type="button"
              onClick={() => setMoreRecords((v) => !v)}
              aria-expanded={moreRecords}
              className="mt-2 inline-flex items-center gap-1 text-[11px] text-[hsl(var(--brand))] hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {moreRecords ? "Show fewer records" : `Show ${records.length - 2} more record${records.length - 2 === 1 ? "" : "s"}`}
              <ChevronDown className={cn("h-3 w-3 transition-transform", moreRecords && "rotate-180")} aria-hidden />
            </button>
          )}
          {src.rawValue && src.rawValue !== artifact.value && (
            <p className="mt-2 text-[11px] text-subtle-foreground">raw: <span className="break-all font-mono text-foreground">{src.rawValue}</span></p>
          )}

          <Divider />

          {/* Limits and opposing evidence */}
          <h3 className="mb-3 text-[12px] font-medium">{a?.group === "conflict" ? "Opposing evidence" : "Limits and opposing evidence"}</h3>
          {(a?.opposing.length ?? 0) === 0 ? (
            <p className="flex gap-2 text-[12px] leading-relaxed text-muted-foreground">
              <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[hsl(var(--confidence-high))]" aria-hidden />
              <span>No contradiction, cap or linkage limit is recorded against this row{classes.length < 2 ? "; corroboration is still single-class" : ""}.</span>
            </p>
          ) : (
            <ul className="space-y-2">
              {a!.opposing.map((o) => (
                <li key={o} className="flex gap-2 text-[12px] leading-relaxed text-muted-foreground">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[hsl(var(--warning))]" aria-hidden />
                  <span>{o}</span>
                </li>
              ))}
            </ul>
          )}

          {/* The analyst's call */}
          <div className="mt-6 flex gap-1.5" role="group" aria-label="Your review">
            <ReviewBtn
              current={rState}
              target="confirmed"
              primary
              onClick={() => { void reviewSet(artifact.id, "confirmed", rctx); announceReview("confirmed"); }}
            >
              <CheckCircle2 className="h-3 w-3" aria-hidden /> {rState === "confirmed" ? "Confirmed ✓" : "Confirm"}
            </ReviewBtn>
            <ReviewBtn current={rState} target="wrong" onClick={() => { void reviewSet(artifact.id, "wrong", rctx); announceReview("wrong"); }}>
              <XCircle className="h-3 w-3" aria-hidden /> {rState === "wrong" ? "Marked false" : "False match"}
            </ReviewBtn>
            <button
              type="button"
              onClick={() => setNoteOpen((v) => !v)}
              aria-expanded={noteOpen}
              className="flex-1 whitespace-nowrap rounded-[5px] border border-border bg-surface-2 px-2 py-2 text-[11px] font-medium text-foreground hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Add note
            </button>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
            <TextBtn active={rState === "key"} onClick={() => { void reviewSet(artifact.id, "key", rctx); announceReview("key"); }}><Star className="h-3 w-3" aria-hidden /> Key</TextBtn>
            <TextBtn
              active={rState === "recheck"}
              onClick={() => {
                void startRecheck({
                  set: reviewSet,
                  threadId,
                  artifact: { id: artifact.id, value: artifact.value, kind: artifact.kind },
                  ctx: rctx,
                }).then((r) => {
                  if (!r.ok) return;
                  announceReview("recheck");
                  toast.success("Rechecking in chat…");
                  onClose();
                });
              }}
            >
              <ShieldQuestion className="h-3 w-3" aria-hidden /> Recheck
            </TextBtn>
            <TextBtn active={rState === "dismissed"} onClick={() => { void reviewSet(artifact.id, "dismissed", rctx); announceReview("dismissed"); }}><XCircle className="h-3 w-3" aria-hidden /> Dismiss</TextBtn>
            {rState !== "new" && (
              <TextBtn onClick={() => { void reviewSet(artifact.id, null, rctx); announceReview(null); }}>Reset</TextBtn>
            )}
          </div>
          {noteOpen && (
            <div className="mt-3">
              <textarea
                value={noteDraft}
                onChange={(e) => ui.setDraft(artifact.id, e.target.value)}
                aria-label="Note — justification or context for this artifact"
                placeholder="Add your reasoning…"
                rows={3}
                className="w-full resize-y rounded-[5px] border border-border bg-surface-2 p-2 text-[12px] text-foreground outline-none focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring"
              />
              <div className="mt-1 flex justify-end">
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-6 px-2 text-data"
                  onClick={() => {
                    void review.setNote(artifact.id, noteDraft, rctx).then((r) => {
                      if (r.ok) {
                        toast.success("Note saved");
                        ui.clearDraft(artifact.id);
                      }
                    });
                  }}
                >
                  Save note
                </Button>
              </div>
            </div>
          )}
          <p className="mt-4 text-[11px] leading-relaxed text-faint-foreground">
            Your review is separate from the AI assessment. Confirming does not add an independent source.
          </p>

          <Divider />

          <ArtifactPivotAction threadId={threadId} artifact={artifact} artifacts={allArtifacts} />
          <div className="mt-3 grid grid-cols-2 gap-2">
            <Button size="sm" variant="outline" onClick={() => copy(artifact.value, "Value copied")} className="gap-1.5"><Copy className="h-3.5 w-3.5" aria-hidden /> Copy value</Button>
            <Button size="sm" variant="outline" onClick={() => copy(citation, "Citation copied")} className="gap-1.5"><Copy className="h-3.5 w-3.5" aria-hidden /> Copy citation</Button>
          </div>

          {/* Details, folded */}
          <button
            type="button"
            onClick={() => setDetailsOpen((v) => !v)}
            aria-expanded={detailsOpen}
            className="mt-4 inline-flex items-center gap-1 text-[11px] uppercase tracking-[0.09em] text-subtle-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Details <ChevronDown className={cn("h-3 w-3 transition-transform", detailsOpen && "rotate-180")} aria-hidden />
          </button>
          {detailsOpen && (
            <div className="mt-2">
              {metaRows.length === 0 ? (
                <div className="text-xs text-muted-foreground">No additional details recorded.</div>
              ) : (
                <dl className="space-y-1.5 rounded-lg border border-white/[0.08] bg-white/[0.025] p-2.5 text-xs">
                  {metaRows.map((row) => (
                    <div key={row.key} className="flex items-start justify-between gap-3">
                      <dt className="shrink-0 text-eyebrow uppercase tracking-wider text-muted-foreground">{row.label}</dt>
                      <dd className="min-w-0 break-all text-right font-mono text-foreground [overflow-wrap:anywhere]">{row.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {import.meta.env.DEV && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-eyebrow uppercase tracking-wider text-muted-foreground/70">Raw metadata (dev only)</summary>
                  <pre className="code-panel mt-1 max-h-64 overflow-x-auto p-3 font-mono text-data">{JSON.stringify(meta, null, 2)}</pre>
                </details>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** One metric bar: label, figure, 4px track. Null reads as a word, never 0%. */
function Metric({ label, value, amber = false, unresolvedWord = "Unresolved" }: { label: string; value: number | null; amber?: boolean; unresolvedWord?: string }) {
  const pct = value === null ? 0 : Math.max(0, Math.min(100, value));
  return (
    <div className="mb-3">
      <div className="mb-1.5 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{label}</span>
        <b className="font-medium tabular-nums text-[13px] text-foreground">{value === null ? unresolvedWord : `${Math.round(value)}%`}</b>
      </div>
      {/* A meter needs a value: with none, the track is decoration and the word
          above carries the meaning (axe aria-required-attr, found by the R4 e2e). */}
      {value === null ? (
        <div className="h-1 overflow-hidden rounded-full bg-white/[0.08]" aria-hidden />
      ) : (
        <div className="h-1 overflow-hidden rounded-full bg-white/[0.08]" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)} aria-valuetext={`${Math.round(value)} percent`}>
          <i className={cn("block h-full rounded-full", amber ? "bg-[hsl(var(--warning))]" : "bg-[hsl(var(--confidence-high))]")} style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

function Divider() {
  return <div className="my-5 h-px bg-border" aria-hidden />;
}

function ReviewBtn({ current, target, onClick, children, primary = false }: {
  current: ReviewState;
  target: ReviewState;
  onClick: () => void;
  children: React.ReactNode;
  primary?: boolean;
}) {
  const active = current === target;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        "inline-flex flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-[5px] border px-2 py-2 text-[11px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "border-[hsl(var(--confidence-high)/0.5)] bg-[hsl(var(--confidence-high)/0.15)] text-[hsl(var(--confidence-high))]"
          : primary
            ? "border-[#eeeaf5] bg-[#eeeaf5] font-semibold text-[#161219] hover:bg-white"
            : "border-border bg-surface-2 text-foreground hover:bg-surface-3",
      )}
    >
      {children}
    </button>
  );
}

function TextBtn({ onClick, children, active = false }: { onClick: () => void; children: React.ReactNode; active?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn("inline-flex items-center gap-1 rounded px-1 py-0.5 text-[11px] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", active ? "text-foreground underline underline-offset-2" : "text-muted-foreground")}
    >
      {children}
    </button>
  );
}
