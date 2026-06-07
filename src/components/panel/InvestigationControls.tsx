import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { buildEvidenceMatrixMarkdown, buildInvestigationSummary, buildReportMarkdown } from "@/lib/intel";
import { useReviewStates } from "@/lib/review";
import { summarizeRunCosts } from "@/lib/runCost";
import { Button } from "@/components/ui/button";
import { Copy, FileText, Table, Braces, RotateCcw, CheckCheck, Undo2, Download, Activity, Lock, AlertTriangle } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { ChevronDown } from "lucide-react";
import { toast } from "sonner";

export function InvestigationControls({
  threadId, artifacts,
}: { threadId: string; artifacts: Artifact[] }) {
  const { clear } = useReviewStates(threadId);
  const [seed, setSeed] = useState<{ value: string | null; type: string | null }>({ value: null, type: null });
  const [status, setStatus] = useState<"active" | "finished">("active");

  useEffect(() => {
    supabase
      .from("threads")
      .select("seed_value,seed_type,status")
      .eq("id", threadId)
      .maybeSingle()
      .then(({ data }) => {
        const d = data as { seed_value: string | null; seed_type: string | null; status: "active" | "finished" | null } | null;
        setSeed({ value: d?.seed_value ?? null, type: d?.seed_type ?? null });
        setStatus((d?.status as "active" | "finished") ?? "active");
      });
  }, [threadId]);

  const copy = (text: string, label: string) =>
    navigator.clipboard.writeText(text).then(() => toast.success(label), () => toast.error("Copy failed"));

  const toggleStatus = async () => {
    const next = status === "active" ? "finished" : "active";
    const { error } = await supabase.from("threads").update({ status: next }).eq("id", threadId);
    if (error) { toast.error(error.message); return; }
    setStatus(next);
    toast.success(next === "finished" ? "Investigation marked finished" : "Investigation reopened");
  };

  const buildToolTrace = async () => {
    const [{ data: usage }, { data: thread }] = await Promise.all([
      supabase
        .from("tool_usage_log")
        .select("tool_name,ok,cached,status_code,duration_ms,cost_micro_usd,error_msg,created_at")
        .eq("thread_id", threadId)
        .order("created_at", { ascending: true }),
      supabase
        .from("threads")
        .select("id,title,seed_value,seed_type,status,cost_micro_usd,credits_used,created_at,updated_at")
        .eq("id", threadId)
        .maybeSingle(),
    ]);
    return {
      exported_at: new Date().toISOString(),
      thread: thread ?? { id: threadId },
      // Charged cost (successful calls) is reported separately from the cost
      // avoided by not billing failed/timed-out calls. cost_micro_usd is the
      // amount actually charged.
      summary: summarizeRunCosts(usage ?? []),
      tool_calls: usage ?? [],
      artifacts,
    };
  };

  const copyTrace = async () => {
    try {
      const payload = await buildToolTrace();
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      toast.success(`Tool trace copied (${payload.summary.calls} calls)`);
    } catch (e) {
      toast.error(`Copy failed: ${(e as Error).message}`);
    }
  };

  const downloadTrace = async () => {
    try {
      const payload = await buildToolTrace();
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const slug = (seed.value || threadId).replace(/[^a-z0-9._-]+/gi, "_").slice(0, 60);
      a.href = url;
      a.download = `osint-trace-${slug}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toast.success("Tool trace downloaded");
    } catch (e) {
      toast.error(`Download failed: ${(e as Error).message}`);
    }
  };

  return (
    <section className="evidence-tile p-2.5 flex items-center justify-between gap-2 flex-wrap">
      {/* Views — segmented control for export formats */}
      <div className="inline-flex items-stretch rounded-md border border-border-subtle bg-surface-1 p-0.5">
        <SegBtn icon={Braces} label="JSON"
          onClick={() => copy(JSON.stringify(artifacts, null, 2), "Artifacts JSON copied")} />
        <SegBtn icon={Table} label="Matrix"
          onClick={() => copy(buildEvidenceMatrixMarkdown(artifacts), "Matrix copied")} />
        <SegBtn icon={FileText} label="Report"
          onClick={() => copy(buildReportMarkdown({ seedValue: seed.value, seedType: seed.type, artifacts }), "Report copied")} />
        <SegBtn icon={Copy} label="Summary"
          onClick={() => copy(buildInvestigationSummary({ seedValue: seed.value, seedType: seed.type, artifacts }), "Summary copied")} />
      </div>

      {/* Case actions — right-aligned. Trace/Clear demoted into overflow. */}
      <div className="flex items-center gap-1 ml-auto">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="ghost" className="h-7 gap-1 text-[10px] text-muted-foreground hover:text-foreground">
              <Activity className="w-3 h-3" /> Trace <ChevronDown className="w-3 h-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="text-xs">
            <DropdownMenuItem onClick={copyTrace}>
              <Copy className="w-3 h-3 mr-2" /> Copy tool trace JSON
            </DropdownMenuItem>
            <DropdownMenuItem onClick={downloadTrace}>
              <Download className="w-3 h-3 mr-2" /> Download tool trace
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive focus:text-destructive"
              onClick={() => { clear(); toast.success("Local review states cleared"); }}
            >
              <RotateCcw className="w-3 h-3 mr-2" /> Clear local review
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {status === "finished" ? (
          <Button size="sm" variant="outline"
            className="h-7 gap-1 text-[10px] border-[hsl(var(--confidence-high))]/40 text-[hsl(var(--confidence-high))]"
            onClick={toggleStatus}>
            <Undo2 className="w-3 h-3" /> Reopen case
          </Button>
        ) : (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                size="sm"
                className="h-7 gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] bg-[hsl(var(--confidence-high))] text-[hsl(var(--surface-0))] hover:opacity-90 shadow-[0_0_18px_-4px_hsl(var(--confidence-high)/0.55)]"
              >
                <Lock className="w-3 h-3" /> Close case
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle className="flex items-center gap-2">
                  <Lock className="w-4 h-4 text-[hsl(var(--confidence-high))]" />
                  Close out investigation
                </AlertDialogTitle>
                <AlertDialogDescription className="space-y-3">
                  <span className="block">
                    This will <span className="text-foreground font-medium">lock the chain of custody</span> and mark
                    the case as complete. New evidence can still be appended after reopen, but the current snapshot
                    will be timestamped as a closing checkpoint.
                  </span>
                  <span className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning-muted px-2.5 py-2 text-[11px] text-warning">
                    <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span>
                      Closing logs the action to the custody trail. Downstream exports will reference
                      this state as the official record.
                    </span>
                  </span>
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-[hsl(var(--confidence-high))] text-[hsl(var(--surface-0))] hover:opacity-90 gap-1.5"
                  onClick={toggleStatus}
                >
                  <CheckCheck className="w-3.5 h-3.5" /> Lock & close case
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
    </section>
  );
}

function SegBtn({
  icon: Icon, label, onClick,
}: { icon: React.ComponentType<{ className?: string }>; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="px-2.5 h-6 inline-flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-muted-foreground rounded hover:bg-surface-3 hover:text-foreground transition-colors"
    >
      <Icon className="w-3 h-3" /> {label}
    </button>
  );
}