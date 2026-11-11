import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useCaseSnapshot, type CaseSnapshot } from "@/hooks/useCaseSnapshot";
import { ChevronRight, Plus, Copy, Link2, Mail, Phone, Globe, Network, User, Hash, FileSearch, MapPin, Paperclip } from "lucide-react";
import { cn } from "@/lib/utils";
import { verifiedHint, verifiedLabel } from "@/lib/authority";
import { toast } from "sonner";
import { extractDisplaySeed, type DisplaySeedKind } from "@/lib/seed";
import { humanCaseName } from "@/lib/case-name";
import { timeAgo } from "@/lib/time";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CaseStatusPill, CaseSyncStatus } from "@/components/workspace/CaseStatus";

const KIND_ICON: Record<DisplaySeedKind, typeof Globe> = {
  email: Mail,
  username: User,
  phone: Phone,
  ip: Network,
  domain: Globe,
  url: Link2,
  crypto: Hash,
  address: MapPin,
  other: FileSearch,
  attachment: Paperclip,
};

const KIND_LABEL: Record<DisplaySeedKind, string> = {
  email: "Email",
  username: "Username",
  phone: "Phone",
  ip: "IP address",
  domain: "Domain",
  url: "URL",
  crypto: "Wallet",
  address: "Address",
  other: "Selector",
  attachment: "Attachment",
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

/** "tool calls" (desktop) / "calls" (phone strip), singular at 1. */
function toolCallsLabel(total: number, dense: boolean): string {
  const word = total === 1 ? "call" : "calls";
  return dense ? word : `tool ${word}`;
}

/** Placeholder for a figure that has not been read yet — never a false "0". */
function FigureSkeleton({ width = "w-14" }: { width?: string }) {
  return <span aria-hidden className={cn("inline-block h-3 rounded-sm bg-white/[0.07] animate-pulse motion-reduce:animate-none", width)} />;
}

/**
 * The case line: every figure from ONE snapshot version, or a skeleton while the
 * case is still being read. Shared by the desktop case bar and the mobile strip.
 */
export function CaseFigures({
  snapshot, dense = false, oneLine = false, spendClassName,
}: {
  snapshot: CaseSnapshot | null;
  dense?: boolean;
  /** Full labels, but held to one row like the dense strip: what does not fit drops out whole. */
  oneLine?: boolean;
  /** Lets the desktop bar move spend to its right cluster at wide widths. */
  spendClassName?: string;
}) {
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
  const toolsUnit = (
    <span className={unit}>
      <Sep />
      {/* CALLS, not distinct tools: the Report's "N tools with artifacts" is a
          different population, and both used to read "tools". */}
      <Figure value={tools.available ? tools.total : "—"} label={toolCallsLabel(tools.total, dense)} hint={toolHint} />
    </span>
  );
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-x-2 text-data",
        dense || oneLine ? "h-5 max-w-full flex-wrap overflow-hidden leading-5" : "flex-wrap gap-y-0.5",
      )}
      data-case-figures={dense ? "dense" : undefined}
    >
      <Figure value={evidence.available ? evidence.text.replace(/ evidence$/, "") : "—"} label={evidence.available ? (dense ? evidence.shortLabel : evidence.label) : ""} hint={evidence.hint} />
      {!oneLine && toolsUnit}
      {authority.verified > 0 && (
        <span className={unit}>
          <Sep />
          <Figure
            value={authority.verified}
            label={verifiedLabel(authority.verified, snapshot.verifiedByAnalyst, dense || oneLine)}
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
      {/* On the one-line bar the authority counts outrank the call count, which
          the Tools tab badge already shows. */}
      {oneLine && toolsUnit}
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

/** "October 25, 2026" — the assessment line's date. Null when the stamp is unusable. */
function longDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleDateString([], { month: "long", day: "numeric", year: "numeric" });
}

/** "14:32" — wall clock of a stamp. */
function clockOf(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * One labelled stat in the case header's right cluster (Last assessment /
 * Source records / Spend — JD's prototype). Label over value, a hairline on the
 * left of every stat but the first. `small` is the prototype's `.case-stat .small`:
 * a time reads at 12px, a count at 16px.
 */
function CaseStat({ label, value, small = false, hint }: { label: string; value: ReactNode; small?: boolean; hint?: string }) {
  const body = (
    <div className={cn("border-l border-border pl-5 first:border-0 first:pl-0", hint && "cursor-help")}>
      <small className="mb-0.5 block text-[11px] leading-none text-subtle-foreground">{label}</small>
      <b className={cn("block font-medium tabular-nums leading-tight", small ? "text-[12px] text-muted-foreground" : "text-[16px] text-foreground")}>{value}</b>
    </div>
  );
  if (!hint) return body;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div tabIndex={0} className="rounded outline-none focus-visible:ring-2 focus-visible:ring-ring">{body}</div>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[300px] text-xs leading-relaxed">{hint}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Case header — the Case-desk layout (JD's prototype, 2026-11-02).
 *
 * Two bands, top to bottom (compacted 2026-11-10: at 1440x900 the header was
 * 178px and the transcript kept 53% of the viewport):
 *  1. a top line: the crumb "Insight Finder › <case>" on the left; sync
 *     provenance and the one secondary action (New investigation) on the right;
 *  2. the heading: a 22px subject with the assessment line beside it (run
 *     state as a small-caps word with its dot, then the date the case last
 *     changed), "<Kind> seed · selector" and the case line
 *     (every figure from ONE snapshot version) beneath it, and three labelled
 *     stats on the right — Last assessment / Source records / Spend.
 *
 * The text tabs follow directly beneath (WorkspaceTabs); the custody reading
 * moved to the bottom status strip (WorkspaceStatusStrip). Everything the e2e
 * suite reads in the "Case summary" region is still here: the run word
 * ("Complete", "Interrupted", "Stopped", "Analyzing · 4s"), the sync stamp,
 * Refresh, and the case line's "N tool calls".
 */
export function WorkspaceHeader({ threadId }: { threadId: string }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { snapshot } = useCaseSnapshot();
  const [creating, setCreating] = useState(false);

  const display = snapshot?.seed.value
    ? extractDisplaySeed(snapshot.seed.value, snapshot.seed.type)
    : { selector: "", kind: "other" as DisplaySeedKind, title: snapshot?.hydrated ? "New investigation" : "" };
  const caseName = humanCaseName(snapshot?.seed.caseTitle ?? null, snapshot?.seed.value ?? null, display.title);
  const hydrated = Boolean(snapshot?.hydrated);
  const changedAt = snapshot?.updatedAt ?? null;
  const changedDate = longDate(changedAt);
  const changedClock = clockOf(changedAt);

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

  const copyButton = (label: string, className: string) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={copySeed}
          aria-label={`${label} — copy selector`}
          className={cn("group inline-flex min-w-0 items-center gap-1.5 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
        >
          <span className="truncate font-mono tracking-[-0.02em] text-muted-foreground transition-colors group-hover:text-foreground">{display.title}</span>
          <Copy className="h-3 w-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="text-xs">Copy selector</TooltipContent>
    </Tooltip>
  );

  return (
    // A <header> inside <main> is not a landmark, so the case bar names itself
    // as a region: screen-reader users can jump straight to the case summary.
    <header
      role="region"
      aria-label="Case summary"
      data-thread-id={threadId}
      className="case-bar relative"
    >
      {/* Band 1 — top line: crumb, then sync provenance and New. */}
      <div className="flex h-9 items-center justify-between gap-4 border-b border-border-subtle px-4 text-[12px] sm:px-6 lg:px-8">
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2.5 text-subtle-foreground">
          <Link to="/" className="shrink-0 rounded font-medium text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            Insight Finder
          </Link>
          <ChevronRight className="h-3 w-3 shrink-0 opacity-70" aria-hidden />
          {hydrated
            ? <span className="min-w-0 truncate" aria-current="page">{caseName ?? display.title ?? "Case"}</span>
            : <FigureSkeleton width="w-24" />}
        </nav>
        <div className="flex shrink-0 items-center gap-2">
          <CaseSyncStatus className="hidden md:flex" />
          {/* Secondary on purpose: inside a case the one primary action is
              Continue / Run. The rail carries the same "New investigation". */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={createInvestigation}
                disabled={creating}
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/10 text-muted-foreground transition-colors duration-fast hover:bg-white/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
                aria-label="Start a new investigation"
              >
                <Plus className="h-3.5 w-3.5" aria-hidden />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="text-xs">{creating ? "Creating…" : "New investigation"}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* The heading. The assessment line (run word, date) sits on the title's
          own row, not above it: as a separate band it cost a full row of height
          on a screen where the transcript had barely half the viewport left. */}
      <div className="px-4 pt-3 sm:px-6 lg:px-8 [@media(max-height:700px)]:pt-2">
        <div className="mb-3 flex items-center justify-between gap-6 [@media(max-height:700px)]:mb-2">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-baseline gap-3">
            {caseName ? (
              // The analyst's name for the case leads, in the display face; the
              // selector it started from moves to the line beneath.
              <h1 className="min-w-0 truncate font-display text-[20px] font-semibold leading-[1.25] tracking-[-0.03em] lg:text-[22px] [@media(max-height:700px)]:text-[18px]" title={caseName}>
                {caseName}
              </h1>
            ) : display.title ? (
              // No analyst title yet: the selector is the heading, and the copy
              // control sits inside it.
              <h1 className="flex min-w-0 text-[18px] leading-[1.25] lg:text-[20px] [@media(max-height:700px)]:text-[17px]">
                {snapshot?.seed.value
                  ? copyButton(display.title, "font-medium [&>span]:text-foreground")
                  : <span className="truncate font-display font-semibold tracking-[-0.03em]">{display.title}</span>}
              </h1>
            ) : (
              <FigureSkeleton width="w-40" />
            )}
              <div className="flex shrink-0 items-center gap-2 text-[11px] uppercase tracking-[0.06em] text-subtle-foreground">
                <CaseStatusPill snapshot={snapshot} variant="line" />
                {hydrated && changedDate && changedAt && (
                  <>
                    <span aria-hidden className="text-faint-foreground/60">/</span>
                    <time dateTime={changedAt} className="hidden truncate md:inline" title="When this case's record last changed">{changedDate}</time>
                  </>
                )}
              </div>
            </div>
            {hydrated && snapshot?.seed.value && (
              <div className="mt-1 flex min-w-0 items-center gap-2 text-[12px] [@media(max-height:700px)]:mt-0.5">
                <span className="shrink-0 text-subtle-foreground">{KIND_LABEL[display.kind]} seed</span>
                {caseName && snapshot?.seed.value && (
                  <>
                    <Sep />
                    {copyButton(`${KIND_LABEL[display.kind]} ${display.title}`, "max-w-[14rem] shrink lg:max-w-[22rem]")}
                  </>
                )}
              </div>
            )}
            {/* The case line on its own row, wrapping rather than dropping
                figures: the stats cluster on the right narrows this column, and
                "N tool calls" must stay readable at every desktop width. */}
            <div className="mt-0.5 flex min-w-0">
              <CaseFigures snapshot={snapshot} spendClassName="lg:hidden" />
            </div>
          </div>

          {/* Labelled stats — the prototype's right cluster. Hidden below lg,
              where the case line beneath the title already carries spend. */}
          <div className="hidden shrink-0 items-center gap-5 lg:flex" aria-label="Case stats">
            {hydrated && snapshot ? (
              <>
                <CaseStat
                  label="Last assessment"
                  small
                  value={changedClock ? `${changedClock} · ${timeAgo(changedAt)}` : "—"}
                  hint="When this case's record last changed — the end of its latest run or edit. The sync stamp above is when this page last read it."
                />
                <CaseStat
                  label="Source records"
                  value={snapshot.evidence.available ? snapshot.evidence.artifacts : "—"}
                  hint="Deduplicated artifact rows recorded for this case — the Evidence tab's population. The case line beneath the title counts chain-of-custody entries, which can be more."
                />
                <CaseStat
                  label="Spend"
                  value={snapshot.spend.text}
                  hint="Model and tool spend recorded for this case. Saved in checkpoints during a run, so it can trail live activity by a few calls."
                />
              </>
            ) : (
              <span className="inline-flex items-center gap-5" aria-label="Case stats loading">
                <FigureSkeleton width="w-20" /> <FigureSkeleton width="w-14" /> <FigureSkeleton width="w-12" />
              </span>
            )}
          </div>
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
    : { selector: "", kind: "other" as DisplaySeedKind, title: snapshot?.hydrated ? "New investigation" : "" };
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
