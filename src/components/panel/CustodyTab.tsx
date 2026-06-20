import { useEffect, useState, useCallback } from "react";
import { supabase, SUPABASE_URL } from "@/integrations/supabase/client";
import { edgeFunctionUrl } from "@/lib/functionsUrl";
import { ShieldCheck, ShieldAlert, ExternalLink, Lock, RefreshCw, Link2, Download, Archive, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { HashChip } from "@/components/ui/hash-chip";
import { ArrowRight } from "lucide-react";
import { sanitizeValueForLabel } from "@/lib/report-hygiene";
import { scrollBehavior } from "@/lib/motion";

type EvidenceRow = {
  id: string;
  seq: number;
  classification: "hard" | "soft";
  kind: string | null;
  value: string | null;
  source: string | null;
  source_url: string | null;
  tool_name: string | null;
  confidence: number | null;
  chain_hash: string;
  prev_hash: string;
  collected_at: string;
  metadata: Record<string, unknown> | null;
  archive_storage_path?: string | null;
  archive_sha256?: string | null;
  archive_bytes?: number | null;
};

// Deliberately NOT the shared @/lib/time helper: chain-of-custody entries need a
// precise absolute timestamp (date + time via toLocaleString) once older than a
// day, so this keeps its own provenance-grade formatter.
function timeAgo(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return new Date(iso).toLocaleString();
}

/** Upper bound on evidence_log rows fetched for the visible custody panel.
 *  When the result hits this cap, the panel labels itself as "latest N" rather
 *  than implying the chain visible here is complete — the integrity verify RPC
 *  still runs over the full chain server-side. */
const CUSTODY_VISIBLE_LIMIT = 500;

export function CustodyTab({ threadId }: { threadId: string }) {
  const [rows, setRows] = useState<EvidenceRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [verification, setVerification] = useState<{ ok: boolean; total: number; first_break: number | null } | null>(null);
  const [archiveEnabled, setArchiveEnabled] = useState(false);
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data }, { data: t }] = await Promise.all([
      supabase
        .from("evidence_log")
        .select("id,seq,classification,kind,value,source,source_url,tool_name,confidence,chain_hash,prev_hash,collected_at,metadata,archive_storage_path,archive_sha256,archive_bytes")
        .eq("thread_id", threadId)
        .order("seq", { ascending: false })
        .limit(CUSTODY_VISIBLE_LIMIT),
      supabase.from("threads").select("archive_attachments").eq("id", threadId).maybeSingle(),
    ]);
    setRows((data as EvidenceRow[]) ?? []);
    setArchiveEnabled(!!(t as { archive_attachments?: boolean } | null)?.archive_attachments);
    setLoading(false);
  }, [threadId]);

  useEffect(() => { void load(); }, [load]);

  const verify = useCallback(async () => {
    setVerifying(true);
    setVerification(null);
    const { data, error } = await supabase.rpc("verify_evidence_chain", { _thread_id: threadId });
    setVerifying(false);
    if (error) {
      setVerification({ ok: false, total: 0, first_break: null });
      return;
    }
    const row = Array.isArray(data) ? data[0] : data;
    setVerification({ ok: !!row?.ok, total: Number(row?.total ?? 0), first_break: row?.first_break ?? null });
  }, [threadId]);

  // Auto-verify once entries are present so chain integrity is always surfaced.
  useEffect(() => {
    if (!loading && rows.length > 0 && verification === null && !verifying) {
      void verify();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, rows.length]);

  const hardCount = rows.filter((r) => r.classification === "hard").length;
  const softCount = rows.length - hardCount;
  const archivedCount = rows.filter((r) => r.archive_storage_path).length;

  const toggleArchive = async (next: boolean) => {
    setArchiveEnabled(next);
    const { error } = await supabase.from("threads").update({ archive_attachments: next }).eq("id", threadId);
    if (error) {
      setArchiveEnabled(!next);
      toast.error("Failed to update setting");
    } else {
      toast.success(next ? "Attachment archiving enabled" : "Attachment archiving disabled");
    }
  };

  const exportBundle = async () => {
    setExporting(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      const token = sess.session?.access_token;
      if (!token) throw new Error("Not authenticated");
      const url = edgeFunctionUrl("evidence-export", SUPABASE_URL);
      if (!url) throw new Error("Supabase function URL is not configured.");
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ threadId }),
      });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `evidence-${threadId}-${stamp}.zip`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(a.href);
      toast.success("Evidence bundle exported");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="p-4 space-y-4">
      {/* === Chain Integrity banner (P1) — always surfaced at top === */}
      {rows.length > 0 && (
        <ChainIntegrityBanner
          verification={verification}
          verifying={verifying}
          total={rows.length}
          onRecheck={verify}
          onJumpToBreak={(seq) => {
            const el = document.getElementById(`custody-seq-${seq}`);
            if (el) el.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
          }}
        />
      )}

      {/* Header / stats */}
      <div className="glass-card rounded-lg p-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 text-sm">
          <div className="flex items-center gap-1.5 text-foreground font-medium">
            <Lock className="w-3.5 h-3.5 text-primary" />
            Chain of custody
          </div>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">{rows.length} entries</span>
          <span className="text-muted-foreground">·</span>
          <span className="text-[hsl(var(--confidence-high))]">{hardCount} hard</span>
          <span className="text-muted-foreground">/</span>
          <span className="text-[hsl(var(--confidence-mid))]">{softCount} soft</span>
          {archivedCount > 0 && (
            <>
              <span className="text-muted-foreground">·</span>
              <span className="text-primary inline-flex items-center gap-1"><Archive className="w-3 h-3" />{archivedCount} archived</span>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={exportBundle} disabled={exporting || rows.length === 0}>
            {exporting ? <Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" /> : <Download className="w-3.5 h-3.5 mr-1.5" />}
            {exporting ? "Exporting…" : "Export bundle"}
          </Button>
          <Button size="sm" variant="ghost" onClick={load} title="Refresh">
            <RefreshCw className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Visibility cap banner — only when the latest-N window is saturated. */}
      {rows.length >= CUSTODY_VISIBLE_LIMIT && (
        <div className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning flex items-start gap-2">
          <span aria-hidden>⚠</span>
          <span>
            Showing the latest {CUSTODY_VISIBLE_LIMIT.toLocaleString()} custody entries.
            {verification?.total && verification.total > rows.length
              ? ` ${(verification.total - rows.length).toLocaleString()} older entries exist on the chain and are not displayed in this view — `
              : " Older entries on the chain are not displayed in this view — "}
            integrity verification still runs over the full chain server-side.
          </span>
        </div>
      )}

      {/* Archive toggle */}
      <div className="glass-card rounded-lg p-3 flex items-center justify-between gap-3">
        <div className="flex items-start gap-3">
          <Archive className="w-4 h-4 text-primary mt-0.5" />
          <div>
            <div className="text-sm font-medium text-foreground">Archive attachments to private vault</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              When on, file URLs in new evidence are downloaded, SHA-256 hashed, and stored in your private <code className="px-1 rounded bg-secondary/60">evidence-archive</code> bucket. HTML pages and files &gt; 25 MB are skipped.
            </div>
          </div>
        </div>
        <Switch checked={archiveEnabled} onCheckedChange={toggleArchive} />
      </div>

      {loading ? (
        <CustodySkeleton />
      ) : rows.length === 0 ? (
        <div className="text-sm text-muted-foreground p-4 glass-card rounded-lg">
          No evidence recorded yet. Every artifact the agent saves is appended here with a SHA-256 hash chain.
        </div>
      ) : (
        // Vertical custody timeline. Left axis with seq nodes, right with evidence-tile cards.
        // HARD = solid filled node + lock glyph (immutably anchored).
        // SOFT = hollow ring node (inferred / soft state).
        <div className="relative pl-7">
          {/* Continuous axis line */}
          <div
            className="absolute left-[11px] top-2 bottom-2 w-px"
            style={{
              background:
                "linear-gradient(180deg, hsl(var(--border-strong)) 0%, hsl(var(--border)) 50%, transparent 100%)",
            }}
            aria-hidden
          />
          <div className="space-y-3">
            {rows.map((r) => {
              const hard = r.classification === "hard";
              return (
                <div key={r.id} id={`custody-seq-${r.seq}`} className="relative scroll-mt-20">
                  {/* Node */}
                  <div className="absolute -left-7 top-3 flex items-center justify-center w-6 h-6">
                    {hard ? (
                      <span
                        className="relative flex items-center justify-center w-5 h-5 rounded-full"
                        style={{
                          background: "hsl(var(--confidence-high))",
                          boxShadow:
                            "0 0 0 3px hsl(var(--surface-0)), 0 0 10px -1px hsl(var(--confidence-high) / 0.7)",
                        }}
                        title="HARD — immutably anchored"
                      >
                        <Lock className="w-2.5 h-2.5 text-[hsl(var(--surface-0))]" strokeWidth={2.5} />
                      </span>
                    ) : (
                      <span
                        className="relative flex items-center justify-center w-4 h-4 rounded-full"
                        style={{
                          background: "hsl(var(--surface-0))",
                          boxShadow:
                            "0 0 0 3px hsl(var(--surface-0)), inset 0 0 0 2px hsl(var(--confidence-mid) / 0.85)",
                        }}
                        title="SOFT — inferred / soft state"
                      />
                    )}
                  </div>

                  {/* Card */}
                  <div className={cn(
                    "evidence-tile p-3 space-y-2",
                    hard ? "evidence-tile--highconf" : "",
                  )}>
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-muted-foreground tabular-nums">#{r.seq}</span>
                        <span
                          className={cn(
                            "px-1.5 py-0.5 rounded text-eyebrow uppercase tracking-[0.1em] border font-mono",
                            hard
                              ? "text-[hsl(var(--confidence-high))] border-[hsl(var(--confidence-high))]/40 bg-[hsl(var(--confidence-high))]/10"
                              : "text-[hsl(var(--confidence-mid))] border-[hsl(var(--confidence-mid))]/40 bg-[hsl(var(--confidence-mid))]/10",
                          )}
                        >
                          {hard ? "hard" : "soft"}
                        </span>
                        {r.kind && (
                          <span className="px-1.5 py-0.5 rounded text-eyebrow border border-border-subtle bg-surface-1 text-muted-foreground font-mono uppercase tracking-wider">
                            {r.kind}
                          </span>
                        )}
                        {typeof r.confidence === "number" && (
                          <span className="text-muted-foreground font-mono tabular-nums text-data">{r.confidence}%</span>
                        )}
                      </div>
                      <span className="text-muted-foreground font-mono text-data tabular-nums shrink-0">
                        {timeAgo(r.collected_at)}
                      </span>
                    </div>

                    {r.value && (
                      <div className="text-sm text-foreground font-mono break-all">{sanitizeValueForLabel(r.value, r.classification === "hard")}</div>
                    )}

                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-data text-muted-foreground border-t border-border-subtle pt-2">
                      {r.source && (
                        <span className="font-mono">
                          via <span className="text-foreground/80">{r.source}</span>
                        </span>
                      )}
                      {r.source_url && (
                        <a
                          href={r.source_url}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-primary hover:underline"
                        >
                          <ExternalLink className="w-3 h-3" /> source
                        </a>
                      )}
                      {/* Mini hash chain chip: prev → current. Each segment is independently copyable. */}
                      <span className="inline-flex items-center gap-1">
                        <HashChip value={r.prev_hash} label="prev" icon={Link2} muted />
                        <ArrowRight className="w-3 h-3 text-muted-foreground/60 shrink-0" />
                        <HashChip value={r.chain_hash} />
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ChainIntegrityBanner({
  verification,
  verifying,
  total,
  onRecheck,
  onJumpToBreak,
}: {
  verification: { ok: boolean; total: number; first_break: number | null } | null;
  verifying: boolean;
  total: number;
  onRecheck: () => void;
  onJumpToBreak: (seq: number) => void;
}) {
  const ok = verification?.ok === true;
  const broken = verification && !verification.ok;
  return (
    <div
      className={cn(
        "evidence-tile p-3 flex items-center justify-between gap-3",
        ok && "evidence-tile--highconf",
        broken && "evidence-tile--danger animate-red-edge",
      )}
    >
      <div className="flex items-center gap-3 min-w-0">
        <span
          className={cn(
            "inline-flex items-center justify-center w-9 h-9 rounded-md shrink-0",
            ok && "bg-[hsl(var(--confidence-high))]/15 text-[hsl(var(--confidence-high))]",
            broken && "bg-danger-muted text-danger",
            !verification && "bg-surface-2 text-muted-foreground",
          )}
        >
          {broken ? <ShieldAlert className="w-5 h-5" /> : <ShieldCheck className={cn("w-5 h-5", verifying && "animate-pulse")} />}
        </span>
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="label-eyebrow">Chain integrity</span>
            <span
              className={cn(
                "font-mono text-data tabular-nums",
                ok && "text-[hsl(var(--confidence-high))]",
                broken && "text-danger",
                !verification && "text-muted-foreground",
              )}
            >
              {verifying ? "checking…" : ok ? "100%" : broken ? "broken" : "—"}
            </span>
          </div>
          <div className="text-data text-muted-foreground mt-0.5">
            {ok && <>No broken links · <span className="font-mono tabular-nums text-foreground/80">{verification!.total}</span> events anchored</>}
            {broken && (
              <>
                Hash mismatch at <span className="font-mono text-danger">#{verification!.first_break ?? "?"}</span>
                {" "}— evidence after this point may be tampered.
              </>
            )}
            {!verification && !verifying && (
              <>Awaiting verification of <span className="font-mono tabular-nums">{total}</span> events.</>
            )}
            {verifying && <>Re-hashing entries in sequence…</>}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        {broken && verification?.first_break != null && (
          <Button size="sm" variant="outline"
            className="h-7 border-danger/50 text-danger hover:bg-danger-muted"
            onClick={() => onJumpToBreak(verification.first_break!)}>
            View anomaly
          </Button>
        )}
        <Button size="sm" variant="ghost" className="h-7 text-muted-foreground hover:text-foreground"
          onClick={onRecheck} disabled={verifying}>
          <RefreshCw className={cn("w-3.5 h-3.5 mr-1.5", verifying && "animate-spin")} />
          Re-verify
        </Button>
      </div>
    </div>
  );
}

/* Skeleton loader — timeline-shaped placeholders that match the rendered
   custody rows so the layout doesn't shift when data arrives. */
function CustodySkeleton() {
  return (
    <div className="relative pl-7 space-y-3" aria-busy="true">
      <div className="absolute left-3 top-1 bottom-1 w-px bg-border-subtle" />
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="relative">
          <span className="absolute -left-[18px] top-3 w-3 h-3 rounded-full bg-surface-3 animate-pulse" />
          <div className="glass-card rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-2">
              <div className="h-3 w-20 rounded bg-surface-3 animate-pulse" />
              <div className="h-3 w-12 rounded bg-surface-3 animate-pulse" />
            </div>
            <div className="h-3 w-3/4 rounded bg-surface-3 animate-pulse" />
            <div className="h-3 w-1/2 rounded bg-surface-3 animate-pulse" />
          </div>
        </div>
      ))}
    </div>
  );
}