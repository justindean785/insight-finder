import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Activity, RefreshCw } from "lucide-react";

type Health = {
  ok: boolean;
  service: string;
  version: string;
  build: string;
  checks?: Record<string, { ok: boolean; detail?: string }>;
  intelbase_enabled?: boolean;
};

export function BackendVersionBadge() {
  const [data, setData] = useState<Health | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [fetchedAt, setFetchedAt] = useState<Date | null>(null);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const { data, error } = await supabase.functions.invoke("osint-agent", {
        method: "GET",
        // health probe is a query param; invoke appends via URL builder
        // @ts-expect-error - body unused for GET; using fetch-style options
        headers: {},
      });
      if (error) throw error;
      // Fallback to direct fetch since invoke doesn't expose query params cleanly
      throw new Error("use-direct");
    } catch {
      // Direct fetch path — supabase.functions.invoke can't pass ?health=1
      try {
        const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/osint-agent?health=1`;
        const res = await fetch(url, {
          headers: { apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as Health;
        setData(json);
        setFetchedAt(new Date());
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const ok = data?.ok === true;
  const dot = err
    ? "bg-[hsl(var(--confidence-low))]"
    : ok
    ? "bg-[hsl(var(--confidence-high))]"
    : "bg-[hsl(var(--confidence-mid))]";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          className="fixed bottom-3 right-3 z-50 inline-flex items-center gap-1.5 rounded-full border border-border-subtle bg-surface-1/90 backdrop-blur px-2.5 py-1 text-[10px] font-mono text-muted-foreground hover:text-foreground hover:bg-surface-2 transition-colors shadow-lg"
          title="Backend build"
        >
          <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
          <Activity className="w-3 h-3" />
          <span className="truncate max-w-[180px]">
            {err ? "backend: unreachable" : data ? data.build : "checking…"}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 text-xs font-mono">
        <div className="flex items-center justify-between mb-2">
          <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Backend health</div>
          <button
            onClick={load}
            disabled={loading}
            className="text-muted-foreground hover:text-foreground disabled:opacity-50"
            title="Refresh"
          >
            <RefreshCw className={`w-3 h-3 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
        {err && <div className="text-[hsl(var(--confidence-low))]">Error: {err}</div>}
        {data && (
          <div className="space-y-1.5">
            <Row k="service" v={data.service} />
            <Row k="version" v={data.version} />
            <Row k="build" v={data.build} highlight />
            <Row k="ok" v={String(data.ok)} />
            {data.checks && (
              <div className="pt-2 border-t border-border-subtle">
                <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground mb-1">Checks</div>
                {Object.entries(data.checks).map(([k, c]) => (
                  <Row
                    key={k}
                    k={k}
                    v={c.ok ? "ok" : (c.detail || "fail")}
                    tone={c.ok ? "ok" : "warn"}
                  />
                ))}
              </div>
            )}
            {fetchedAt && (
              <div className="pt-2 text-[10px] text-muted-foreground">
                fetched {fetchedAt.toLocaleTimeString()}
              </div>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}

function Row({
  k, v, highlight, tone,
}: { k: string; v: string; highlight?: boolean; tone?: "ok" | "warn" }) {
  const valueClass = highlight
    ? "text-foreground font-semibold"
    : tone === "warn"
    ? "text-[hsl(var(--confidence-mid))]"
    : tone === "ok"
    ? "text-[hsl(var(--confidence-high))]"
    : "text-foreground/80";
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-muted-foreground">{k}</span>
      <span className={`text-right break-all ${valueClass}`}>{v}</span>
    </div>
  );
}