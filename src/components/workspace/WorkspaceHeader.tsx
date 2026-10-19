import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useCaseSnapshot, type CaseSnapshot } from "@/hooks/useCaseSnapshot";
import { Lock, ShieldAlert, Plus, Copy, Link2, Mail, Phone, Globe, Network, User, Hash, FileSearch, MapPin } from "lucide-react";
import { cn } from "@/lib/utils";
import { verifiedHint, verifiedLabel } from "@/lib/authority";
import { toast } from "sonner";
import { extractDisplaySeed, type SeedKind } from "@/lib/seed";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CaseStatusPill, CaseSyncStatus } from "@/components/workspace/CaseStatus";

const KIND_ICON: Record<SeedKind, typeof Globe> = {
  email: Mail,
  username: User,
  phone: Phone,
  ip: Network,
  domain: Globe,
  url: Link2,
  crypto: Hash,
  address: MapPin,
  other: FileSearch,
};

const KIND_LABEL: Record<SeedKind, string> = {
  email: "Email",
  username: "Username",
  phone: "Phone",
  ip: "IP address",
  domain: "Domain",
  url: "URL",
  crypto: "Wallet",
  address: "Address",
  other: "Selector",
};

/** One figure in the case line. Number + word, never colour alone. */
function Figure({ value, label, tone, hint }: { value: ReactNode; label: string; tone?: string; hint?: string }) {
  const body = (
    <span className={cn("inline-flex items-baseline gap-1 whitespace-nowrap", hint && "cursor-help")}>
      {/* Ink 3 and ink 4. These used to sit at 90% foreground, a hair under the
          selector above them, so the case line competed with the thing it was
          describing. A toned figure keeps its authority hue: an adverse count
          is the one figure here that should stop the eye. */}
      <span className={cn("font-mono tabular-nums", tone ?? "text-subtle-foreground")}>{value}</span>
      <span className="text-faint-foreground">{label}</span>
    </span>
  );
  if (!hint) return body;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="rounded outline-none focus-visible:ring-2 focus-visible:ring-ring">{body}</span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[280px] text-xs leading-relaxed">{hint}</TooltipContent>
    </Tooltip>
  );
}

function Sep() {
  return <span aria-hidden className="text-muted-foreground/40">·</span>;
}

/** Placeholder for a figure that has not been read yet — never a false "0". */
function FigureSkeleton({ width = "w-14" }: { width?: string }) {
  return <span aria-hidden className={cn("inline-block h-3 rounded-sm bg-white/[0.07] animate-pulse motion-reduce:animate-none", width)} />;
}

/**
 * Custody, stated with its basis.
 *
 * The old header printed a bare "100%" beside a lock. That number was the share
 * of evidence-log entries whose hash links to the previous one — a statement
 * about the LOG not having been altered. It says nothing about whether sources
 * were preserved: a case with 47 linked entries and zero hard-preserved sources
 * read "100%", which an analyst reasonably takes as full custody. The chip now
 * says what it measured ("47/47 linked") and the tooltip says what it did not.
 */
function CustodyChip({ snapshot }: { snapshot: CaseSnapshot }) {
  const integ = snapshot.integrity;
  if (!integ || integ.total === 0) return null;
  const linked = integ.ok ? integ.total : Math.max(0, Number(integ.firstBreak ?? 1) - 1);
  const text = `${linked}/${integ.total}`;
  const hint = integ.ok
    ? `Hash chain valid: all ${integ.total} evidence-log entries link to the one before, so the log has not been altered. This does not mean the underlying sources were preserved — see Tools › Custody for hard vs soft entries.`
    : `Chain break at entry #${integ.firstBreak}. Entries after the break cannot be shown to be unaltered.`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          aria-label={integ.ok ? `Hash chain valid, ${text} entries linked` : `Hash chain broken at entry ${integ.firstBreak}, ${text} entries linked`}
          className={cn(
            "inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1 outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-help",
            integ.ok ? "text-muted-foreground" : "text-[hsl(var(--danger))]",
          )}
        >
          {integ.ok ? <Lock className="h-3 w-3" aria-hidden /> : <ShieldAlert className="h-3 w-3" aria-hidden />}
          <span className="font-mono tabular-nums">{text}</span>
          <span className="hidden 2xl:inline">linked</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[300px] text-xs leading-relaxed">{hint}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The case line: every figure from ONE snapshot version, or a skeleton while the
 * case is still being read. Shared by the desktop case bar and the mobile strip.
 */
export function CaseFigures({
  snapshot, dense = false, spendClassName,
}: { snapshot: CaseSnapshot | null; dense?: boolean; /** Lets the desktop bar move spend to its right cluster at wide widths. */ spendClassName?: string }) {
  if (!snapshot || !snapshot.hydrated) {
    return (
      <span className="inline-flex items-center gap-2" aria-label="Case figures loading">
        <FigureSkeleton /> <FigureSkeleton width="w-10" /> {!dense && <FigureSkeleton width="w-12" />}
      </span>
    );
  }
  const { evidence, tools, authority, spend } = snapshot;
  const toolHint = tools.available
    ? `${tools.total} tool calls across all runs of this case (cached, skipped and failed included) — ${tools.failed} failed, ${tools.degraded} degraded, ${tools.skipped + tools.gated} skipped. A run group shows one message\u2019s calls only.`
    : "The tool-call ledger could not be read. Refresh to try again.";
  // Each separator travels WITH the figure after it (one unbreakable unit), so a
  // figure that does not fit moves as a whole — never a trailing "·" and never
  // half a word. In the dense (phone) strip the line is one row tall and wraps:
  // whatever does not fit wraps onto a clipped second row and drops out
  // entirely, lowest priority (spend, last) first. It used to be `flex-nowrap
  // overflow-hidden`, which hard-clipped the last figure mid-word ("15 verifie").
  const unit = "inline-flex items-center gap-x-2 whitespace-nowrap";
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-x-2 text-data",
        dense ? "h-5 max-w-full flex-wrap overflow-hidden leading-5" : "flex-wrap gap-y-0.5",
      )}
      data-case-figures={dense ? "dense" : undefined}
    >
      <Figure value={evidence.available ? evidence.text.replace(/ evidence$/, "") : "—"} label={evidence.text.endsWith(" evidence") ? "evidence" : ""} hint={evidence.hint} />
      <span className={unit}>
        <Sep />
        <Figure value={tools.available ? tools.total : "—"} label={tools.total === 1 ? "tool" : "tools"} hint={toolHint} />
      </span>
      {authority.verified > 0 && (
        <span className={unit}>
          <Sep />
          <Figure
            value={authority.verified}
            label={verifiedLabel(authority.verified, snapshot.verifiedByAnalyst, dense)}
            tone="text-[hsl(var(--authority-verified))]"
            hint={verifiedHint(authority.verified, snapshot.verifiedByAnalyst)}
          />
        </span>
      )}
      {!dense && authority.conflict > 0 && (
        <span className={unit}>
          <Sep />
          <Figure
            value={authority.conflict}
            label="conflict"
            tone="text-[hsl(var(--authority-conflict))]"
            hint={`${authority.conflict} artifact${authority.conflict === 1 ? "" : "s"} marked as contradicting the seed or another identity cluster (the Conflict authority state).`}
          />
        </span>
      )}
      {!dense && authority.quarantined > 0 && (
        <span className={unit}>
          <Sep />
          <Figure
            value={authority.quarantined}
            label="quarantined"
            tone="text-[hsl(var(--authority-quarantine))]"
            hint={`${authority.quarantined} recorded and disclosed, but withheld from identity — linkage to the subject is unproven, or the row is a flagged name collision.`}
          />
        </span>
      )}
      {(spend.microUsd ?? 0) > 0 && (
        <span className={cn(unit, spendClassName)}>
          <Sep />
          <Figure
            value={spend.text}
            label={dense ? "" : "spend"}
            hint="Model and tool spend recorded for this case. Saved in checkpoints during a run, so it can trail live activity by a few calls."
          />
        </span>
      )}
    </span>
  );
}

/**
 * Case bar — the one band of chrome above the workspace tabs.
 *
 * It replaces three stacked bands (a decorative classification strip, a
 * three-zone command bar with the seed centred, and a second count line) that
 * together spent ~130px of height and printed the tool count twice. Identity
 * leads on the left where the eye starts; the case line beneath it carries every
 * figure from one snapshot version; sync provenance and the one primary action
 * sit on the right.
 */
export function WorkspaceHeader({ threadId }: { threadId: string }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { snapshot } = useCaseSnapshot();
  const [creating, setCreating] = useState(false);

  const display = snapshot?.seed.value
    ? extractDisplaySeed(snapshot.seed.value, snapshot.seed.type)
    : { selector: "", kind: "other" as SeedKind, title: snapshot?.hydrated ? "New investigation" : "" };
  const KindIcon = KIND_ICON[display.kind] ?? FileSearch;

  const createInvestigation = async () => {
    if (!user || creating) return;
    setCreating(true);
    const { data, error } = await supabase.from("threads").insert({ user_id: user.id }).select("id").single();
    setCreating(false);
    if (error || !data) { toast.error(error?.message ?? "Could not create investigation"); return; }
    navigate(`/chat/${data.id}`);
  };

  const copySeed = () => {
    const value = snapshot?.seed.value;
    if (!value) return;
    navigator.clipboard.writeText(value).then(
      () => toast.success("Selector copied"), () => toast.error("Copy failed"),
    );
  };

  return (
    // A <header> inside <main> is not a landmark, so the case bar names itself
    // as a region: screen-reader users can jump straight to the case summary.
    <header
      role="region"
      aria-label="Case summary"
      data-thread-id={threadId}
      className="case-bar relative border-b border-white/[0.07]"
    >
      <div className="flex min-h-[3.5rem] items-center gap-3 px-4 py-2 sm:px-6">
        {/* Identity */}
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span
            className="case-mark grid h-9 w-9 shrink-0 place-items-center rounded-[10px]"
            title={KIND_LABEL[display.kind]}
          >
            <KindIcon className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            <span className="sr-only">{KIND_LABEL[display.kind]}</span>
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              {display.title ? (
                // The case's name is the page heading; the copy control sits inside it.
                <h1 className="flex min-w-0">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={copySeed}
                      disabled={!snapshot?.seed.value}
                      aria-label={snapshot?.seed.value ? `${display.title} — copy selector` : display.title}
                      className="group flex min-w-0 items-center gap-1.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
                    >
                      <span className="truncate font-mono text-[16px] font-medium tracking-[-0.015em] text-foreground">
                        {display.title}
                      </span>
                      {snapshot?.seed.value && (
                        <Copy className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden />
                      )}
                    </button>
                  </TooltipTrigger>
                  {snapshot?.seed.value && <TooltipContent side="bottom" className="text-xs">Copy selector</TooltipContent>}
                </Tooltip>
                </h1>
              ) : (
                <FigureSkeleton width="w-40" />
              )}
              <CaseStatusPill snapshot={snapshot} />
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-2">
              <CaseFigures snapshot={snapshot} spendClassName="lg:hidden" />
            </div>
          </div>
        </div>

        {/* Custody, spend, provenance, and the one primary action */}
        <div className="flex shrink-0 items-center gap-3">
          {snapshot?.hydrated && (
            <div className="hidden items-center gap-3 border-r border-white/[0.07] pr-3 text-data lg:flex">
              <CustodyChip snapshot={snapshot} />
              {(snapshot.spend.microUsd ?? 0) > 0 && (
                <Figure
                  value={snapshot.spend.text}
                  label="spend"
                  hint="Model and tool spend recorded for this case. Saved in checkpoints during a run, so it can trail live activity by a few calls."
                />
              )}
            </div>
          )}
          <CaseSyncStatus className="hidden md:flex" />
          <button
            onClick={createInvestigation}
            disabled={creating}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-white px-2.5 text-meta font-semibold text-black shadow-cta transition-colors hover:bg-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:opacity-50"
            aria-label="Start a new investigation"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden />
            <span className="hidden xl:inline">{creating ? "Creating…" : "New"}</span>
          </button>
        </div>
      </div>
    </header>
  );
}

/**
 * Mobile case strip — sits under the mobile section tabs and carries the case
 * bar's job below 768px: identity, run state, the case line, Refresh and New.
 * Mobile previously showed NO run state at all, so an interrupted run was
 * invisible on a phone. Same snapshot, same figures as desktop.
 */
export function MobileCaseStrip() {
  const { snapshot } = useCaseSnapshot();
  const display = snapshot?.seed.value
    ? extractDisplaySeed(snapshot.seed.value, snapshot.seed.type)
    : { selector: "", kind: "other" as SeedKind, title: snapshot?.hydrated ? "New investigation" : "" };
  return (
    <div className="flex min-h-14 min-w-0 flex-1 items-center gap-2 py-1.5 pr-1.5">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          {display.title
            ? <h1 className="min-w-0 truncate font-mono text-[14px] font-medium text-foreground">{display.title}</h1>
            : <FigureSkeleton width="w-32" />}
          <CaseStatusPill snapshot={snapshot} />
        </div>
        {/* Not `truncate`: CaseFigures drops whole figures that do not fit,
            and an ellipsis clip here would cut the last one mid-word again. */}
        <div className="mt-0.5 flex min-w-0">
          <CaseFigures snapshot={snapshot} dense />
        </div>
      </div>
      <CaseSyncStatus compact className="shrink-0 [&>span:first-child]:hidden min-[420px]:[&>span:first-child]:inline-flex" />
    </div>
  );
}
