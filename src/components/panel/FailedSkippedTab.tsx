import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { extractFailedAndSkipped, type FailedToolEntry, type RawMessage } from "@/lib/intel";
import { Button } from "@/components/ui/button";
import { AlertTriangle, ShieldQuestion, Copy, ArrowDownToLine } from "lucide-react";
import { toast } from "sonner";

export function FailedSkippedTab({ threadId }: { threadId: string }) {
  const [entries, setEntries] = useState<FailedToolEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const { data } = await supabase
        .from("messages")
        .select("id,role,parts,created_at")
        .eq("thread_id", threadId)
        .order("created_at");
      if (!alive) return;
      setEntries(extractFailedAndSkipped((data ?? []) as RawMessage[]));
      setLoading(false);
    };
    load();
    const ch = supabase
      .channel(`failed-${threadId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "messages", filter: `thread_id=eq.${threadId}` }, load)
      .subscribe();
    return () => { alive = false; supabase.removeChannel(ch); };
  }, [threadId]);

  const copy = (text: string, label: string) =>
    navigator.clipboard.writeText(text).then(() => toast.success(label), () => toast.error("Copy failed"));

  const scrollToCard = () => {
    window.dispatchEvent(new CustomEvent("proximity:show-failed-tools", { detail: { threadId } }));
  };

  if (loading) {
    return <div className="p-4 text-xs text-muted-foreground">Loading issues…</div>;
  }
  if (entries.length === 0) {
    return (
      <div className="p-4 text-xs text-muted-foreground space-y-2">
        <div className="flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" /> No failed or skipped tools detected.</div>
        <p>If the agent reports validation errors or 4xx responses, they will show up here.</p>
      </div>
    );
  }

  const failed = entries.filter((e) => e.kind === "failed");
  const skipped = entries.filter((e) => e.kind === "skipped");

  return (
    <div className="p-3 space-y-3 text-xs">
      {failed.length > 0 && (
        <Section title="Failed" count={failed.length} icon={<AlertTriangle className="w-3 h-3 text-destructive" />}>
          {failed.map((e) => (
            <EntryCard key={e.id} entry={e} onCopy={copy} onScroll={scrollToCard} destructive />
          ))}
        </Section>
      )}
      {skipped.length > 0 && (
        <Section title="Skipped" count={skipped.length} icon={<ShieldQuestion className="w-3 h-3 text-muted-foreground" />}>
          {skipped.map((e) => (
            <EntryCard key={e.id} entry={e} onCopy={copy} onScroll={scrollToCard} />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({ title, count, icon, children }: { title: string; count: number; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-eyebrow uppercase tracking-wider text-muted-foreground">
          {icon} {title}
        </div>
        <span className="text-data font-mono text-muted-foreground">{count}</span>
      </div>
      <div className="space-y-1.5">{children}</div>
    </section>
  );
}

function EntryCard({
  entry, onCopy, onScroll, destructive,
}: {
  entry: FailedToolEntry;
  onCopy: (t: string, l: string) => void;
  onScroll: () => void;
  destructive?: boolean;
}) {
  const inputPreview = entry.input != null ? JSON.stringify(entry.input).slice(0, 160) : null;
  return (
    <div className={
      "rounded-md border p-2.5 space-y-1.5 " +
      (destructive ? "border-destructive/30 bg-destructive/5" : "border-border bg-card/40")
    }>
      <div className="flex items-center justify-between gap-2">
        <div className="font-mono text-foreground truncate">{entry.name}</div>
        {entry.time && (
          <span className="text-data font-mono text-muted-foreground shrink-0">
            {new Date(entry.time).toLocaleTimeString()}
          </span>
        )}
      </div>
      <div className={"font-mono text-data break-words " + (destructive ? "text-destructive" : "text-muted-foreground")}>
        {entry.error}
      </div>
      {inputPreview && (
        <div className="text-data font-mono text-muted-foreground break-all">
          <span className="opacity-70">input: </span>{inputPreview}{inputPreview.length === 160 && "…"}
        </div>
      )}
      {entry.suggestion && (
        <div className="text-data text-muted-foreground italic">Suggested: {entry.suggestion}</div>
      )}
      <div className="flex items-center justify-end gap-1 pt-1">
        {destructive && (
          <Button size="sm" variant="ghost" className="h-6 px-2 gap-1 text-data" onClick={onScroll}>
            <ArrowDownToLine className="w-3 h-3" /> Scroll to call
          </Button>
        )}
        <Button size="sm" variant="ghost" className="h-6 px-2 gap-1 text-data"
          onClick={() => onCopy(JSON.stringify(entry, null, 2), "Failure JSON copied")}>
          <Copy className="w-3 h-3" /> Copy JSON
        </Button>
      </div>
    </div>
  );
}