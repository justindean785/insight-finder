import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { useThreadArtifacts } from "@/hooks/useThreadArtifacts";
import { useOptionalCaseSnapshot } from "@/hooks/useCaseSnapshot";
import { selectAuthoritativeFindings } from "@/lib/authoritative-findings";
import { tallyAuthority } from "@/lib/authority";
import { buildReportMarkdown, buildEvidenceMatrixMarkdown } from "@/lib/intel";
import { useReviewStates } from "@/lib/review";
import { useThreadMessages } from "@/hooks/useThreadMessages";
import { useThreadToolActivity } from "@/hooks/useThreadToolActivity";
import { buildConfidenceProfile, REPORT_READY_MIN_READINESS } from "@/lib/confidence-dimensions";
import { SectionHeading } from "@/components/workspace/SectionHeading";
import {
  evaluateExportGate,
  exportFilename,
  markMarkdown,
  withReviewGate,
  wrapJsonExport,
  DRAFT_MARK,
  type ExportGate,
} from "@/lib/report-export-gate";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Copy, FileText, Table, Braces, ScrollText, Download, Printer, ShieldAlert, ShieldCheck, ChevronDown, Info, Lock } from "lucide-react";
import { toast } from "sonner";
import { SubTabs } from "@/components/ui/compact-controls";
import { ConfidenceRadar } from "@/components/workspace/ConfidenceRadar";
import { EmptyState } from "./EmptyState";
import { CaseReport, type ReportType } from "./CaseReport";
import { extractDisplaySeed } from "@/lib/seed";
import { cn } from "@/lib/utils";

const REPORT_TYPES: { key: ReportType; label: string }[] = [
  { key: "full", label: "Full Dossier" },
  { key: "brief", label: "Executive Brief" },
];
/** Formats that are planned but not built. Named in one quiet note, not as three dead buttons. */
const REPORT_TYPES_SOON = ["LE / Court", "OSINT Technical", "Lead Brief"];

type ExportFormat = "copy-md" | "md" | "pdf" | "matrix" | "json";

// ⚠️ These labels must say what the format ACTUALLY produces, and must not
// over-claim. Two things are true at once:
//
//  1. Masking is not uniform by FORMAT. Markdown and JSON run through
//     `markMarkdown` / `wrapJsonExport` → redactSecretsInText /
//     redactSecretsDeep. PDF and Ctrl+P get no export redaction pass: they
//     print CaseReport AS DISPLAYED, so they mask exactly what the on-screen
//     display policy masks — `MaskedValue` under VITE_MASK_BREACH_VALUES, and
//     minor-related breach rows always. "Nothing masked" would over-claim in
//     the other direction (Codex P2 on #609), so the label says "as displayed".
//  2. Masking is narrow in SCOPE. `SECRET_KEY_RE` and the password regexes
//     cover passwords, passcodes and hashes — nothing else. SSNs, DOBs and
//     partial card numbers pass through every format untouched. Verified on a
//     production export (2026-09-22): a 9-digit SSN from an NPD breach row
//     survived the JSON path intact.
//
// So "secrets masked" would be a lie in the other direction — the exact failure
// the old "Raw JSON" label committed. Say PASSWORDS, which is what is true.
// Whether either the format asymmetry or the narrow scope should change is an
// operator decision under the standing REVEAL_BREACH_DATA preference; these
// labels only make the current behaviour legible.
const FORMAT_LABEL: Record<ExportFormat, string> = {
  "copy-md": "Copy markdown · passwords masked",
  md: "Markdown (.md) · passwords masked",
  pdf: "PDF (print) · as displayed",
  matrix: "Evidence matrix",
  json: "JSON · passwords masked",
};

export function ReportTab({
  threadId, artifacts, printActive = true,
}: {
  threadId: string;
  artifacts: Artifact[];
  /** Whether Ctrl+P / the print menu should print this report. False while the
   *  tab is mounted but hidden behind another workspace section. */
  printActive?: boolean;
}) {
  const [reportType, setReportType] = useState<ReportType>("full");
  const [pending, setPending] = useState<ExportFormat | null>(null);
  const [ack, setAck] = useState(false);
  // A draft acknowledged for THIS version of the case is not re-asked for every
  // export of that same version; any change to the case asks again.
  const ackedVersion = useRef<number | null>(null);

  const caseApi = useOptionalCaseSnapshot();
  const snapshot = caseApi?.snapshot ?? null;

  const [seedFallback, setSeedFallback] = useState<{ value: string | null; type: string | null }>({ value: null, type: null });
  const seed = snapshot ? snapshot.seed : seedFallback;
  useEffect(() => {
    if (snapshot) return;
    // Standalone (no provider): read the seed directly. Guard against a late
    // response from a previous thread overwriting the current thread's seed.
    let alive = true;
    supabase
      .from("threads")
      .select("seed_value,seed_type")
      .eq("id", threadId)
      .maybeSingle()
      .then(({ data }) => {
        if (!alive) return;
        setSeedFallback({ value: data?.seed_value ?? null, type: data?.seed_type ?? null });
      });
    return () => { alive = false; };
  }, [threadId, snapshot]);

  const messages = useThreadMessages(threadId);

  // Analyst review verdicts (Verified/Rejected/Key/Recheck) — threaded into both
  // the rendered CaseReport and every export so a marked artifact reads the same
  // in Evidence and Report.
  const review = useReviewStates(threadId);
  // #499 — the retrieval signals for the authority panel, from the shared store.
  const { hasMore, error: artifactsFailed } = useThreadArtifacts(threadId);
  const reviews = useMemo(() => {
    const m: Record<string, ReturnType<typeof review.get>> = {};
    for (const a of artifacts) {
      const r = review.get(a.id);
      if (r !== "new") m[a.id] = r;
    }
    return m;
  }, [artifacts, review]);

  // #499 — computed ONCE and handed to both producers, so the rendered Report and
  // the markdown export cannot disagree about what the engine adjudicated.
  const authority = useMemo(
    () => selectAuthoritativeFindings(artifacts, reviews, {
      ceilingHit: !!hasMore,
      retrievalFailed: !!artifactsFailed,
      reviewsAvailable: review.availability === "ok",
    }),
    [artifacts, reviews, hasMore, artifactsFailed, review.availability],
  );

  // Tool activity from the case snapshot when mounted in the workspace, so the
  // report's "Tool invocations" is the same number the case bar prints.
  const standaloneTools = useThreadToolActivity(snapshot ? "" : threadId);
  const toolEvents = snapshot ? snapshot.tools.events : standaloneTools.events;
  const toolInvocations = snapshot ? snapshot.tools.total : standaloneTools.persistedTotal;
  // Same availability rule as the case bar: an unread ledger is not 0 calls.
  const toolCallsKnown = snapshot
    ? snapshot.tools.available
    : !standaloneTools.loading && (!standaloneTools.error || standaloneTools.loadedAt !== null);
  const toolActivityList = useMemo(() => toolEvents.map((e) => ({ toolName: e.toolName })), [toolEvents]);

  const markdown = useMemo(
    () => buildReportMarkdown({
      seedValue: seed.value, seedType: seed.type, artifacts, messages, reviews, reportType,
      toolActivity: toolActivityList, toolInvocations, authority,
    }),
    [seed.value, seed.type, artifacts, messages, reviews, reportType, toolActivityList, toolInvocations, authority],
  );
  // Through the analyst's verdicts, like the full report: a dismissed row reads
  // FAILED in the exported matrix instead of keeping its source-derived label.
  const matrixMd = useMemo(() => buildEvidenceMatrixMarkdown(artifacts, reviews), [artifacts, reviews]);

  // Readiness: the snapshot's profile (same version as every other figure), or
  // computed here when rendered standalone. Never computed locally beside a
  // snapshot that has none yet — that would read an empty verdict map.
  const localProfile = useMemo(
    () => (snapshot ? null : withReviewGate(buildConfidenceProfile({ artifacts, seedValue: seed.value, reviews }), review.availability)),
    [snapshot, artifacts, seed.value, reviews, review.availability],
  );
  const profile = snapshot ? snapshot.readiness?.profile ?? null : localProfile;
  const gate: ExportGate = useMemo(() => evaluateExportGate(profile, review.availability), [profile, review.availability]);
  const isDraft = gate.mode === "draft";

  // Toolbar summary: verified and excluded come from the shared authority ladder
  // (src/lib/authority.ts), the same figures the case bar, Overview and Evidence print.
  // The rest of the tally feeds the readiness block below.
  const reviewTally = useMemo(() => {
    const authority = tallyAuthority(artifacts, review.get);
    return { verified: authority.verified, review: authority.review, conflict: authority.conflict, quarantined: authority.quarantined, excluded: authority.failed };
  }, [artifacts, review]);

  const copy = (text: string, label: string) =>
    navigator.clipboard.writeText(text).then(() => toast.success(label), () => toast.error("Copy failed"));

  const slug = (extractDisplaySeed(seed.value, seed.type).selector || threadId).replace(/[^a-z0-9._-]+/gi, "_").slice(0, 60);

  // The print-only stylesheet keys on `body.printing-report`. `beforeprint`
  // fires for every print path (button, shortcut, menu), so the class is set for
  // all of them — a class toggled only around this tab's own `window.print()`
  // left Ctrl+P printing one clipped viewport.
  //
  // Only while the Report is the tab on screen. The workspace keeps a visited
  // panel mounted (hidden), so an always-on listener made Ctrl+P on Evidence or
  // Investigate print the hidden report — or a blank page.
  useEffect(() => {
    if (!printActive) return;
    const on = () => document.body.classList.add("printing-report");
    const off = () => document.body.classList.remove("printing-report");
    window.addEventListener("beforeprint", on);
    window.addEventListener("afterprint", off);
    return () => {
      window.removeEventListener("beforeprint", on);
      window.removeEventListener("afterprint", off);
      off();
    };
  }, [printActive]);

  const perform = (format: ExportFormat) => {
    const now = new Date().toISOString();
    if (format === "copy-md") {
      void copy(markMarkdown(markdown, gate, now), isDraft ? "Draft report copied — marked UNVERIFIED DRAFT" : "Report copied");
    } else if (format === "md") {
      const blob = new Blob([markMarkdown(markdown, gate, now)], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = exportFilename("osint-report", slug, "md", gate);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success(isDraft ? "Draft .md downloaded — marked UNVERIFIED DRAFT" : "Report .md downloaded");
    } else if (format === "pdf") {
      // The draft marking is rendered inside the print root, so the printed copy
      // carries it whether it is printed from here or from Ctrl+P.
      window.print();
    } else if (format === "matrix") {
      void copy(markMarkdown(matrixMd, gate, now), isDraft ? "Draft evidence matrix copied" : "Evidence matrix copied");
    } else if (format === "json") {
      void copy(wrapJsonExport(artifacts, gate, now), isDraft ? "Draft artifact JSON copied" : "Artifact JSON copied");
    }
  };

  /** Every export goes through here. JSON always asks (it carries raw PII);
   *  a draft asks once per case version. */
  const request = (format: ExportFormat) => {
    const needsDraftAck = isDraft && ackedVersion.current !== (snapshot?.version ?? -1);
    if (format === "json" || needsDraftAck) {
      setAck(false);
      setPending(format);
      return;
    }
    perform(format);
  };

  const confirmPending = () => {
    if (!pending || !ack) return;
    if (isDraft) ackedVersion.current = snapshot?.version ?? -1;
    const f = pending;
    setPending(null);
    perform(f);
  };

  const statusChip = (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          tabIndex={0}
          className={cn(
            "inline-flex h-8 cursor-help items-center gap-1.5 rounded-md border px-2.5 text-data font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring",
            isDraft
              ? "border-[hsl(var(--warning)/0.4)] bg-[hsl(var(--warning)/0.08)] text-[hsl(var(--warning))]"
              : "border-[hsl(var(--success)/0.4)] bg-[hsl(var(--success)/0.08)] text-[hsl(var(--success))]",
          )}
        >
          {isDraft ? <ShieldAlert className="h-3.5 w-3.5" aria-hidden /> : <ShieldCheck className="h-3.5 w-3.5" aria-hidden />}
          {isDraft ? `Unverified draft · ${gate.readinessPct}% ready` : "Report-safe"}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[300px] text-xs leading-relaxed">
        {isDraft ? gate.reasons.join(" ") : `Report readiness ${gate.readinessPct}% with conflicts under control.`}
      </TooltipContent>
    </Tooltip>
  );

  const toolbar = (
    <div className="no-print flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-white/[0.07] pb-3">
      <SubTabs<ReportType>
        label="Report type"
        options={REPORT_TYPES}
        active={reportType}
        onChange={setReportType}
      />
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`More report formats coming soon: ${REPORT_TYPES_SOON.join(", ")}`}
            className="grid h-8 w-8 place-items-center rounded-md text-muted-foreground transition-colors duration-fast hover:bg-white/[0.04] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:w-11"
          >
            <Info className="h-3.5 w-3.5" aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">Coming soon: {REPORT_TYPES_SOON.join(" · ")}</TooltipContent>
      </Tooltip>
      <span className="hidden text-data text-muted-foreground md:inline">
        {reviewTally.verified > 0 && <span className="text-[hsl(var(--authority-verified))]">{reviewTally.verified} verified</span>}
        {reviewTally.verified > 0 && reviewTally.excluded > 0 && <span className="mx-1.5 text-muted-foreground/40" aria-hidden>·</span>}
        {reviewTally.excluded > 0 && <span className="text-[hsl(var(--danger))]">{reviewTally.excluded} excluded</span>}
      </span>

      <div className="ml-auto flex flex-wrap items-center gap-2" role="group" aria-label="Report exports">
        {statusChip}
        <Button
          size="sm"
          variant="ghost"
          className="h-8 gap-1.5 text-data text-muted-foreground hover:text-foreground [@media(pointer:coarse)]:h-11"
          onClick={() => request("copy-md")}
        >
          <Copy className="h-3.5 w-3.5" aria-hidden /> Copy markdown
        </Button>
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 text-data [@media(pointer:coarse)]:h-11"
              aria-label={isDraft ? "Export draft — not report-safe" : "Export report"}
            >
              <Download className="h-3.5 w-3.5" aria-hidden />
              {isDraft ? "Export draft" : "Export"}
              <ChevronDown className="h-3 w-3 text-muted-foreground" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={6} className="w-64 rounded-xl border-white/10 bg-[hsl(var(--popover))] p-1 shadow-overlay">
            <DropdownMenuLabel className="px-2.5 pb-1 pt-1.5 text-micro font-medium text-muted-foreground">
              {isDraft ? `Draft — every file is marked ${DRAFT_MARK}` : "Report-safe export"}
            </DropdownMenuLabel>
            {([
              ["md", Download],
              ["pdf", Printer],
              ["matrix", Table],
              ["json", Braces],
            ] as const).map(([f, Icon]) => (
              <DropdownMenuItem key={f} onSelect={() => request(f)} className="min-h-9 gap-2 rounded-lg px-2.5 text-meta">
                <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />
                {FORMAT_LABEL[f]}
                {f === "json" && <span className="ml-auto text-micro text-muted-foreground">sensitive</span>}
              </DropdownMenuItem>
            ))}
            {isDraft && (
              <>
                <DropdownMenuSeparator className="bg-white/[0.07]" />
                <DropdownMenuItem disabled className="min-h-9 items-start gap-2 rounded-lg px-2.5 text-meta">
                  <Lock className="mt-0.5 h-3.5 w-3.5" aria-hidden />
                  <span>
                    Report-safe export
                    <span className="block text-micro leading-snug">
                      Needs {REPORT_READY_MIN_READINESS}% readiness (now {gate.readinessPct}%)
                    </span>
                  </span>
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );

  if (artifacts.length === 0) {
    return (
      <div className="text-xs">
        <h2 className="sr-only">Report</h2>
        <EmptyState icon={ScrollText} title="No report yet" hint="Run the agent on a seed and the case report will populate here." />
      </div>
    );
  }

  return (
    <div className="text-xs">
      <SectionHeading
        className="mb-3"
        title="Case assessment"
        subtitle={isDraft ? `Unverified draft · ${gate.readinessPct}% ready · every export is marked ${DRAFT_MARK}` : "Report-safe · readiness and conflicts under control"}
      />
      {toolbar}

      <div className="space-y-3 pt-3">
        {/* Evidence-signal summary — UI-only, kept out of the printed report. */}
        <div className="no-print">
          {profile && <ConfidenceRadar artifacts={artifacts} seedValue={seed.value} reviews={reviews} profile={profile} />}
        </div>
        {/* No inner scroll: the report flows in the page's single scroll container. */}
        <div className="panel px-4 py-5">
          <CaseReport
            seedValue={seed.value}
            seedType={seed.type}
            artifacts={artifacts}
            reviews={reviews}
            messages={messages}
            reportType={reportType}
            authority={authority}
            draftMark={isDraft ? { readinessPct: gate.readinessPct, reasons: gate.reasons } : null}
            toolCallTotal={toolCallsKnown ? toolInvocations : undefined}
          />
        </div>

        <details className="rounded-lg border border-border-subtle bg-surface-2 no-print">
          <summary className="cursor-pointer px-3 py-2 text-micro font-medium tracking-normal text-muted-foreground flex items-center gap-1.5">
            <FileText className="w-3 h-3" aria-hidden /> Raw markdown
          </summary>
          <pre className="p-3 text-data font-mono leading-relaxed text-foreground/80 whitespace-pre-wrap break-words max-h-[50vh] overflow-y-auto [scrollbar-width:thin] border-t border-border-subtle">
            {markdown}
          </pre>
        </details>
      </div>

      <Dialog open={pending !== null} onOpenChange={(o) => { if (!o) setPending(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <ShieldAlert className="w-4 h-4 text-warning" aria-hidden />
              {isDraft ? "Export an unverified draft?" : "Export raw artifact JSON?"}
            </DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              {isDraft
                ? `This report is not report-safe. The ${pending ? FORMAT_LABEL[pending].toLowerCase() : "export"} will be marked ${DRAFT_MARK} on the cover, in the file name and inside the data.`
                : "Raw artifacts may include PII, unreviewed leads, source metadata, and identifiers the case has not yet redacted. Treat the export as sensitive investigative data."}
            </DialogDescription>
          </DialogHeader>

          {isDraft && (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-md border border-border-subtle bg-surface-2 px-3 py-2.5 text-xs">
              <dt className="text-muted-foreground">Report readiness</dt>
              <dd className="text-right font-mono tabular-nums text-[hsl(var(--warning))]">{gate.readinessPct}% <span className="text-muted-foreground">/ {REPORT_READY_MIN_READINESS}%</span></dd>
              <dt className="text-muted-foreground">Verified</dt>
              <dd className="text-right font-mono tabular-nums">{reviewTally.verified}</dd>
              <dt className="text-muted-foreground">Needs review</dt>
              <dd className="text-right font-mono tabular-nums">{reviewTally.review}</dd>
              <dt className="text-muted-foreground">Conflict (authority state)</dt>
              <dd className="text-right font-mono tabular-nums">{reviewTally.conflict}</dd>
              <dt className="text-muted-foreground">Quarantined</dt>
              <dd className="text-right font-mono tabular-nums">{reviewTally.quarantined}</dd>
              <dt className="text-muted-foreground">Coverage gaps (failed tool calls)</dt>
              <dd className="text-right font-mono tabular-nums">{snapshot?.tools.failed ?? standaloneTools.failed}</dd>
            </dl>
          )}
          {isDraft && gate.reasons.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
              {gate.reasons.map((r) => <li key={r}>{r}</li>)}
            </ul>
          )}
          {pending === "json" && isDraft && (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Raw artifacts may also include PII, unreviewed leads and unredacted identifiers.
            </p>
          )}

          <label className="flex items-start gap-2 text-xs leading-relaxed cursor-pointer">
            <Checkbox checked={ack} onCheckedChange={(v) => setAck(v === true)} className="mt-0.5" />
            <span className="text-foreground">
              {isDraft
                ? "I understand this is an unverified draft and will not present it as confirmed findings."
                : "I understand this export may include sensitive investigative data, including PII and unreviewed leads, and I am authorized to handle it."}
              {pending === "json" && isDraft && " I am authorized to handle the sensitive data it contains."}
            </span>
          </label>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPending(null)}>Cancel</Button>
            <Button size="sm" disabled={!ack} onClick={confirmPending}>
              {pending ? (isDraft ? `Export draft · ${FORMAT_LABEL[pending]}` : pending === "json" ? "Copy JSON" : FORMAT_LABEL[pending]) : "Export"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
