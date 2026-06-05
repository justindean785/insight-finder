import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { buildReportMarkdown, buildEvidenceMatrixMarkdown } from "@/lib/intel";
import { useThreadMessages } from "@/hooks/useThreadMessages";
import { Button } from "@/components/ui/button";
import { Copy, FileText, Table, Braces, ScrollText, Download, Printer } from "lucide-react";
import { toast } from "sonner";
import { EmptyState } from "./EmptyState";
import { CaseReport } from "./CaseReport";

export function ReportTab({ threadId, artifacts }: { threadId: string; artifacts: Artifact[] }) {
  const [seed, setSeed] = useState<{ value: string | null; type: string | null }>({ value: null, type: null });

  useEffect(() => {
    supabase
      .from("threads")
      .select("seed_value,seed_type")
      .eq("id", threadId)
      .maybeSingle()
      .then(({ data }) => {
        const d = data as { seed_value: string | null; seed_type: string | null } | null;
        setSeed({ value: d?.seed_value ?? null, type: d?.seed_type ?? null });
      });
  }, [threadId]);

  const messages = useThreadMessages(threadId);

  const markdown = useMemo(
    () => buildReportMarkdown({ seedValue: seed.value, seedType: seed.type, artifacts, messages }),
    [seed, artifacts, messages],
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

  if (artifacts.length === 0) {
    return <EmptyState icon={ScrollText} title="No report yet" hint="Run the agent on a seed and the case report will populate here." />;
  }

  return (
    <div className="p-3 space-y-3 text-xs">
      <div className="flex flex-wrap gap-1.5 no-print">
        <Button size="sm" variant="outline" className="h-7 gap-1 text-[10px]"
          onClick={() => copy(markdown, "Report copied")}>
          <Copy className="w-3 h-3" /> Copy markdown
        </Button>
        <Button size="sm" variant="outline" className="h-7 gap-1 text-[10px]"
          onClick={downloadMd}>
          <Download className="w-3 h-3" /> Download .md
        </Button>
        <Button size="sm" variant="outline" className="h-7 gap-1 text-[10px]"
          onClick={printPdf} title="Opens the print dialog — choose 'Save as PDF'">
          <Printer className="w-3 h-3" /> Download PDF
        </Button>
        <Button size="sm" variant="ghost" className="h-7 gap-1 text-[10px] text-muted-foreground"
          onClick={() => copy(matrixMd, "Evidence matrix copied")}>
          <Table className="w-3 h-3" /> Matrix
        </Button>
        <Button size="sm" variant="ghost" className="h-7 gap-1 text-[10px] text-muted-foreground"
          onClick={() => copy(JSON.stringify(artifacts, null, 2), "Artifact JSON copied")}>
          <Braces className="w-3 h-3" /> JSON
        </Button>
      </div>

      <div className="rounded-lg border border-border-subtle bg-surface-1 px-4 py-5 max-h-[78vh] overflow-y-auto [scrollbar-width:thin]">
        <CaseReport seedValue={seed.value} seedType={seed.type} artifacts={artifacts} />
      </div>

      <details className="rounded-lg border border-border-subtle bg-surface-2 no-print">
        <summary className="cursor-pointer px-3 py-2 text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <FileText className="w-3 h-3" /> Raw markdown
        </summary>
        <pre className="p-3 text-[11px] font-mono leading-relaxed text-foreground/80 whitespace-pre-wrap break-words max-h-[50vh] overflow-y-auto [scrollbar-width:thin] border-t border-border-subtle">
          {markdown}
        </pre>
      </details>
    </div>
  );
}