import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { buildReportMarkdown, buildEvidenceMatrixMarkdown } from "@/lib/intel";
import { useReviewStates } from "@/lib/review";
import { useThreadMessages } from "@/hooks/useThreadMessages";
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
import { Copy, FileText, Table, Braces, ScrollText, Download, Printer, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { TabHeader } from "@/components/ui/workspace-primitives";
import { ConfidenceRadar } from "@/components/workspace/ConfidenceRadar";
import { EmptyState } from "./EmptyState";
import { CaseReport } from "./CaseReport";

export function ReportTab({ threadId, artifacts }: { threadId: string; artifacts: Artifact[] }) {
  const [seed, setSeed] = useState<{ value: string | null; type: string | null }>({ value: null, type: null });
  const [jsonGateOpen, setJsonGateOpen] = useState(false);
  const [jsonGateAck, setJsonGateAck] = useState(false);

  useEffect(() => {
    // Guard against a late response from a previous thread overwriting the
    // current thread's seed when the user switches threads quickly.
    let alive = true;
    supabase
      .from("threads")
      .select("seed_value,seed_type")
      .eq("id", threadId)
      .maybeSingle()
      .then(({ data }) => {
        if (!alive) return;
        const d = data as { seed_value: string | null; seed_type: string | null } | null;
        setSeed({ value: d?.seed_value ?? null, type: d?.seed_type ?? null });
      });
    return () => { alive = false; };
  }, [threadId]);

  const messages = useThreadMessages(threadId);

  // Analyst review verdicts (Verified/Rejected/Key/Recheck) — these previously
  // never reached the report; load them and thread them into both the rendered
  // CaseReport and the markdown export so a marked artifact reads the same in
  // Evidence and Report.
  const review = useReviewStates(threadId);
  const reviews = useMemo(() => {
    const m: Record<string, ReturnType<typeof review.get>> = {};
    for (const a of artifacts) {
      const r = review.get(a.id);
      if (r !== "new") m[a.id] = r;
    }
    return m;
  }, [artifacts, review]);

  const markdown = useMemo(
    () => buildReportMarkdown({ seedValue: seed.value, seedType: seed.type, artifacts, messages, reviews }),
    [seed, artifacts, messages, reviews],
  );
  const matrixMd = useMemo(() => buildEvidenceMatrixMarkdown(artifacts), [artifacts]);

  const copy = (text: string, label: string) =>
    navigator.clipboard.writeText(text).then(() => toast.success(label), () => toast.error("Copy failed"));

  const slug = (seed.value || threadId).replace(/[^a-z0-9._-]+/gi, "_").slice(0, 60);
  const downloadMd = () => {
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `osint-report-${slug}.md`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast.success("Report .md downloaded");
  };
  const printPdf = () => {
    // Print-only stylesheet renders #case-report-print-root as the page
    document.body.classList.add("printing-report");
    setTimeout(() => {
      window.print();
      document.body.classList.remove("printing-report");
    }, 50);
  };

  const openJsonGate = () => {
    setJsonGateAck(false);
    setJsonGateOpen(true);
  };
  const confirmJsonExport = () => {
    if (!jsonGateAck) return;
    copy(JSON.stringify(artifacts, null, 2), "Artifact JSON copied");
    setJsonGateOpen(false);
  };

  // Analyst review state, summarised for the header context line (same tally
  // the report body shows — kept read-only, no semantics changed).
  const reviewTally = useMemo(() => {
    let verified = 0, rejected = 0;
    for (const s of Object.values(reviews)) {
      if (s === "confirmed" || s === "key") verified++;
      else if (s === "wrong" || s === "dismissed") rejected++;
    }
    return { verified, rejected };
  }, [reviews]);

  const subtitle = (
    <span className="inline-flex flex-wrap items-center">
      <span>Case report &amp; exports</span>
      {reviewTally.verified > 0 && (
        <>
          <span className="mx-1.5 text-muted-foreground/40" aria-hidden>·</span>
          <span className="text-[hsl(var(--confidence-high))]">{reviewTally.verified} verified</span>
        </>
      )}
      {reviewTally.rejected > 0 && (
        <>
          <span className="mx-1.5 text-muted-foreground/40" aria-hidden>·</span>
          <span className="text-destructive">{reviewTally.rejected} rejected</span>
        </>
      )}
    </span>
  );

  const exportActions = (
    // Primary downloads grouped together; secondary/raw exports (Matrix / JSON)
    // are quieter and split off by a divider that collapses cleanly on mobile.
    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Report exports">
      <Button size="sm" variant="outline" className="h-7 gap-1 text-data"
        onClick={() => copy(markdown, "Report copied")}>
        <Copy className="w-3 h-3" /> Copy markdown
      </Button>
      <Button size="sm" variant="outline" className="h-7 gap-1 text-data"
        onClick={downloadMd}>
        <Download className="w-3 h-3" /> Download .md
      </Button>
      <Button size="sm" variant="outline" className="h-7 gap-1 text-data"
        onClick={printPdf} title="Opens the print dialog — choose 'Save as PDF'">
        <Printer className="w-3 h-3" /> Download PDF
      </Button>
      <span aria-hidden className="hidden sm:block h-5 w-px bg-border-subtle mx-0.5" />
      <Button size="sm" variant="ghost" className="h-7 gap-1 text-data text-muted-foreground"
        onClick={() => copy(matrixMd, "Evidence matrix copied")}
        title="Copy the evidence matrix as markdown">
        <Table className="w-3 h-3" /> Matrix
      </Button>
      <Button size="sm" variant="ghost" className="h-7 gap-1 text-data text-muted-foreground"
        onClick={openJsonGate}
        title="Raw JSON export — requires confirmation">
        <Braces className="w-3 h-3" /> JSON
      </Button>
    </div>
  );

  if (artifacts.length === 0) {
    return (
      <div className="text-xs">
        <TabHeader icon={FileText} title="Report" subtitle="Case report & exports" className="no-print" />
        <EmptyState icon={ScrollText} title="No report yet" hint="Run the agent on a seed and the case report will populate here." />
      </div>
    );
  }

  return (
    <div className="text-xs">
      <TabHeader icon={FileText} title="Report" subtitle={subtitle} className="no-print sticky top-0 z-10">
        {exportActions}
      </TabHeader>

      <div className="p-3 space-y-3">
      {/* Evidence-signal summary — UI-only, kept out of the printed report. */}
      <div className="no-print">
        <ConfidenceRadar artifacts={artifacts} seedValue={seed.value} reviews={reviews} />
      </div>
      <div className="rounded-lg border border-border-subtle bg-surface-1 px-4 py-5 max-h-[78vh] overflow-y-auto [scrollbar-width:thin]">
        <CaseReport seedValue={seed.value} seedType={seed.type} artifacts={artifacts} reviews={reviews} />
      </div>

      <details className="rounded-lg border border-border-subtle bg-surface-2 no-print">
        <summary className="cursor-pointer px-3 py-2 text-eyebrow uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <FileText className="w-3 h-3" /> Raw markdown
        </summary>
        <pre className="p-3 text-data font-mono leading-relaxed text-foreground/80 whitespace-pre-wrap break-words max-h-[50vh] overflow-y-auto [scrollbar-width:thin] border-t border-border-subtle">
          {markdown}
        </pre>
      </details>
      </div>

      <Dialog open={jsonGateOpen} onOpenChange={setJsonGateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <ShieldAlert className="w-4 h-4 text-warning" /> Export raw artifact JSON?
            </DialogTitle>
            <DialogDescription className="text-xs leading-relaxed">
              Raw artifacts may include PII, unreviewed leads, source metadata, and identifiers
              the case has not yet redacted. Treat the export as sensitive investigative data.
            </DialogDescription>
          </DialogHeader>

          <div className="rounded-md border border-border-subtle bg-surface-2 px-3 py-2 flex items-center justify-between gap-2 text-xs">
            <span className="text-muted-foreground uppercase tracking-wider text-eyebrow">Classification</span>
            <span className="font-mono text-foreground">INTERNAL</span>
          </div>

          <label className="flex items-start gap-2 text-xs leading-relaxed cursor-pointer">
            <Checkbox
              checked={jsonGateAck}
              onCheckedChange={(v) => setJsonGateAck(v === true)}
              className="mt-0.5"
            />
            <span className="text-foreground">
              I understand this export may include sensitive investigative data, including PII and
              unreviewed leads, and I am authorized to handle it.
            </span>
          </label>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setJsonGateOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={!jsonGateAck} onClick={confirmJsonExport}>
              Copy JSON
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
