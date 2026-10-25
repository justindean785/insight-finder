import { useEffect, useState } from "react";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { supabase } from "@/integrations/supabase/client";
import {
  Copy, CheckCircle2, XCircle, Star, ShieldQuestion, X,
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
import { extractSourceInfo, independentSourceClasses } from "@/lib/intel";
import { classLabel } from "@/lib/evidence-status";
import { humanizeArtifactMetadata } from "@/lib/artifact-metadata";
import { authorityFor } from "@/lib/authority";
import {
  canReleaseLinkage, releasePatch,
  RELEASE_ACTION_LABEL, RELEASE_CONFIRM_BODY, RELEASE_CONFIRM_TITLE,
} from "@/lib/quarantine-release";
import {
  AuthorityChip, AuthorityCaveat, UnderlyingStrength,
} from "@/components/ui/authority";
import {
  useReviewStates, REVIEW_CLASS, REVIEW_SHORT, REVIEW_LABEL, startRecheck,
  type ReviewState, type ReviewWriteResult,
} from "@/lib/review";
import { CACHE_LAYER_LABEL, CACHE_LAYER_CLASS } from "@/lib/intel";
import { ArtifactPivotAction } from "@/components/pivots/ArtifactPivotAction";
import { useWorkspaceUIState } from "@/hooks/useWorkspaceUIState";

/**
 * The right-hand inspector for one selected artifact. Mounted inside the
 * Workbench's Sheet tab when `selectedArtifactId != null` (see Workbench.tsx).
 *
 * Lifted from PR #872's extraction of `ArtifactDrawer`, with two required
 * differences that fix regressions #872 carried from the Matrix split-pane:
 *
 *   1. The note draft is hoisted to {@link WorkspaceUIStateProvider} and keyed
 *      by `artifactId`, so a draft survives switching between artifacts,
 *      Workbench tab switches, and viewport resizes across the 1280px (xl)
 *      breakpoint. The local `useState(review.getNote(id))` the drawer used
 *      lost drafts on every subtree swap.
 *   2. The header gains a visible, keyboard-reachable Close button that calls
 *      the provider's `clear()`, which also restores focus to the element id
 *      remembered by the opener (an Evidence row).
 *
 * Everything else — the authority/quarantine disclosure, confidence rendering
 * via `displayConfidence(artifact)`, release flow, review controls, pivot
 * action, metadata panel — is preserved exactly as in #872 so the behaviour
 * JD approved for the drawer carries over without divergence.
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
  // Draft lives in the shared provider, keyed by artifactId. Falling back to
  // the durable saved note the first time the inspector opens means the
  // textarea doesn't look empty on a selector that already has a saved note.
  const existingDraft = ui.getDraft(artifact.id);
  const savedNote = review.getNote(artifact.id);
  const noteDraft = existingDraft || savedNote;

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
        .select("id,kind,value,confidence,source,created_at,metadata")
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
  // AND after review-state writes. Audit §7 confirmed this surface was missing
  // the announcement; without it a screen-reader user can't tell when a
  // selection has opened a detail view or when a Confirm/Dismiss took effect.
  const [liveMessage, setLiveMessage] = useState<string>("");
  useEffect(() => {
    const confText = shownArtifact.effective != null
      ? ` Confidence score ${shownArtifact.effective} out of 100, uncalibrated.`
      : "";
    const authText = drawerAuthority.label ? ` ${drawerAuthority.label}.` : "";
    setLiveMessage(
      `Evidence detail opened: ${artifact.value}. ${artifact.kind}.${confText}${authText}`,
    );
    // Keyed on artifact.id so the message re-fires only when the selection
    // actually changes, not on an unrelated prop change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifact.id]);
  const announceReview = (next: ReviewState | null) => {
    const label = next ? REVIEW_LABEL[next] : REVIEW_LABEL.new;
    setLiveMessage(`Review for ${artifact.value}: ${label}.`);
  };

  return (
    <div className="flex flex-col h-full" data-inspector data-artifact-id={artifact.id}>
      <span role="status" aria-live="polite" className="sr-only">
        {liveMessage}
      </span>
      <div className="border-b border-white/[0.08] px-5 py-5">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="font-mono text-eyebrow uppercase tracking-[0.18em] text-muted-foreground">
              Evidence detail
            </div>
            <div className="font-mono text-xl leading-tight break-words [overflow-wrap:anywhere] mt-1">
              {artifact.value}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close inspector"
            className="shrink-0 grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-1">
          <Chip
            tone="border-white/10 bg-white/[0.04] text-muted-foreground"
            mono
          >
            {artifact.kind}
          </Chip>
          {shownArtifact.effective != null && (
            <Chip
              tone="border-[hsl(var(--confidence-mid)/0.35)] bg-[hsl(var(--confidence-mid)/0.1)] text-[hsl(var(--confidence-mid))]"
              mono
              title={`Confidence score ${shownArtifact.effective}/100 — uncalibrated. Evidence caps may apply.`}
            >
              {shownArtifact.effective}/100
            </Chip>
          )}
          <Chip tone={REVIEW_CLASS[rState]} mono>{REVIEW_SHORT[rState]}</Chip>
        </div>
        {shownArtifact.effective != null && (
          <p className="mt-2 text-micro leading-snug text-muted-foreground">
            Confidence score {shownArtifact.effective}/100 — uncalibrated. Evidence caps may apply.
          </p>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="space-y-4 px-5 py-4 text-sm">
          {(drawerAuthority.state === "quarantined" || drawerAuthority.caveat) && (
            <div className="panel-inset p-3">
              <div className="cordon mb-2.5 -mx-3 -mt-3 rounded-t-[7px]" aria-hidden />
              <div className="flex flex-wrap items-center gap-2">
                <AuthorityChip view={drawerAuthority} size="md" />
                <UnderlyingStrength view={drawerAuthority} />
              </div>
              <AuthorityCaveat view={drawerAuthority} className="mt-2" />
              {drawerAuthority.state === "quarantined" && (
                <p className="mt-2 text-micro leading-snug text-muted-foreground">
                  Recorded and kept. It does not enter identity clusters, graph
                  identity edges, confidence, or the report until the linkage is
                  confirmed.
                </p>
              )}
              {canReleaseLinkage(meta) && (
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={releasing}
                      className="mt-3 h-7 w-full font-mono text-eyebrow uppercase tracking-[0.14em]"
                    >
                      {RELEASE_ACTION_LABEL}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{RELEASE_CONFIRM_TITLE}</AlertDialogTitle>
                      <AlertDialogDescription className="whitespace-pre-line text-left">
                        {RELEASE_CONFIRM_BODY}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={() => void releaseLinkage()}>
                        {RELEASE_ACTION_LABEL}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-white/[0.08] bg-white/[0.035] p-3">
              <div className="text-eyebrow uppercase tracking-wider text-muted-foreground">First seen</div>
              <div className="mt-1 font-mono text-sm">{new Date(artifact.created_at).toLocaleString()}</div>
            </div>
          </div>

          <Field label="Source stack">
            <div className="space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono">{src.primary}</span>
                <span className={"px-1.5 py-0.5 rounded border font-mono text-eyebrow uppercase tracking-wider " + CACHE_LAYER_CLASS[src.cacheLayer]}>
                  {CACHE_LAYER_LABEL[src.cacheLayer]}
                </span>
                {src.all.length > 1 && (
                  <span className="text-data text-muted-foreground">+{src.all.length - 1} more</span>
                )}
              </div>
              {src.parent && (
                <div className="text-data text-muted-foreground">
                  Parent: <span className="font-mono text-foreground">{src.parent}</span>
                </div>
              )}
            </div>
          </Field>
          <Field label="Corroboration">
            {!src.hasMetadata ? (
              <div className="text-muted-foreground text-xs">source metadata unavailable</div>
            ) : (
              <div className="space-y-1 rounded-lg border border-white/[0.08] bg-white/[0.025] p-2 text-xs">
                {(() => {
                  const classes = independentSourceClasses(artifact);
                  return classes.length >= 2 ? (
                    <>
                      <div className="text-data text-muted-foreground">{classes.length} independent source classes</div>
                      <ul className="space-y-0.5 font-mono">
                        {classes.map((c) => <li key={c}>{classLabel(c)}</li>)}
                      </ul>
                    </>
                  ) : (
                    <div className="text-data text-muted-foreground">
                      Not independently corroborated — {classes.length === 1 ? `single source class (${classLabel(classes[0])})` : "no source class recorded"}.
                    </div>
                  );
                })()}
                {src.rawValue && src.rawValue !== artifact.value && (
                  <div className="text-data text-muted-foreground">
                    raw: <span className="font-mono text-foreground break-all">{src.rawValue}</span>
                  </div>
                )}
              </div>
            )}
          </Field>
          <Field label="Review">
            <div className="mb-2 flex items-center gap-2 flex-wrap text-xs">
              <Chip tone={REVIEW_CLASS[rState]} mono>{REVIEW_SHORT[rState]}</Chip>
              {falsePositive && <Chip tone="bg-destructive/15 text-destructive border-destructive/40" mono>false positive</Chip>}
            </div>
            <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-white/[0.08] bg-white/[0.025] p-2">
              <ReviewBtn current={rState} target="confirmed" onClick={() => { void reviewSet(artifact.id, "confirmed", rctx); announceReview("confirmed"); }}>
                <CheckCircle2 className="w-3 h-3" /> Confirm
              </ReviewBtn>
              <ReviewBtn
                current={rState}
                target="recheck"
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
                <ShieldQuestion className="w-3 h-3" /> Recheck
              </ReviewBtn>
              <ReviewBtn current={rState} target="dismissed" onClick={() => { void reviewSet(artifact.id, "dismissed", rctx); announceReview("dismissed"); }}>
                <XCircle className="w-3 h-3" /> Dismiss
              </ReviewBtn>
              <ReviewBtn current={rState} target="key" onClick={() => { void reviewSet(artifact.id, "key", rctx); announceReview("key"); }}>
                <Star className="w-3 h-3" /> Key
              </ReviewBtn>
              <Button size="sm" variant="ghost" className="col-span-2 h-7 px-2 gap-1 text-data" onClick={() => { void reviewSet(artifact.id, null, rctx); announceReview(null); }}>
                Reset
              </Button>
            </div>
          </Field>
          <Field label="Note">
            <textarea
              value={noteDraft}
              onChange={(e) => ui.setDraft(artifact.id, e.target.value)}
              aria-label="Note — justification or context for this artifact"
              placeholder="Why is this key? Add justification, link, or context…"
              rows={3}
              className="w-full text-xs font-mono bg-secondary/40 border border-border rounded p-2 outline-none focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring resize-y"
            />
            <div className="flex justify-end mt-1">
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
          </Field>
          <Field label="Details">
            {metaRows.length === 0 ? (
              <div className="text-muted-foreground text-xs">No additional details recorded.</div>
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
                <pre className="code-panel mt-1 max-h-64 overflow-x-auto p-3 text-data font-mono">{JSON.stringify(meta, null, 2)}</pre>
              </details>
            )}
          </Field>

          <ArtifactPivotAction threadId={threadId} artifact={artifact} artifacts={allArtifacts} />
          <div className="grid grid-cols-2 gap-2">
            <Button size="sm" variant="outline" onClick={() => copy(artifact.value, "Value copied")} className="gap-1.5"><Copy className="w-3.5 h-3.5" /> Copy value</Button>
            <Button size="sm" variant="outline" onClick={() => copy(citation, "Citation copied")} className="gap-1.5"><Copy className="w-3.5 h-3.5" /> Copy citation</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReviewBtn({
  current, target, onClick, children,
}: {
  current: ReviewState;
  target: ReviewState;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const active = current === target;
  return (
    <Button
      size="sm"
      variant={active ? "default" : "secondary"}
      onClick={onClick}
      className="h-6 px-2 gap-1 text-data"
    >
      {children}
    </Button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-eyebrow uppercase tracking-wider text-muted-foreground mb-1">{label}</div>
      <div>{children}</div>
    </div>
  );
}
