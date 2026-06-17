import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { ShieldCheck, ShieldAlert, Play, ArrowLeft, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

type TestResult = {
  category: "prompt_injection" | "ssrf" | "oversize";
  name: string;
  passed: boolean;
  severity: "low" | "medium" | "high" | "critical";
  input_snippet: string;
  output_snippet: string;
  notes: string;
  duration_ms: number;
};
type Summary = {
  run_id: string;
  total: number;
  passed: number;
  failed: number;
  by_category: { category: string; total: number; failed: number }[];
  critical_failures: string[];
  elapsed_ms: number;
  results: TestResult[];
};

const severityColor: Record<TestResult["severity"], string> = {
  low: "text-muted-foreground border-border bg-secondary/40",
  medium: "text-[hsl(var(--confidence-mid))] border-[hsl(var(--confidence-mid))]/40 bg-[hsl(var(--confidence-mid))]/10",
  high: "text-amber-400 border-amber-400/40 bg-amber-400/10",
  critical: "text-destructive border-destructive/40 bg-destructive/10",
};

const categoryLabel: Record<TestResult["category"], string> = {
  prompt_injection: "Prompt Injection / PII",
  ssrf: "SSRF Guard",
  oversize: "Oversize / DoS",
};

export default function AdminSecurity() {
  const { user, loading } = useAuth();
  const nav = useNavigate();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loading) return;
    if (!user) { nav("/auth"); return; }
    (async () => {
      const { data } = await supabase.rpc("has_role", { _user_id: user.id, _role: "admin" });
      setIsAdmin(!!data);
    })();
  }, [user, loading, nav]);

  const runRedTeam = async () => {
    setRunning(true);
    setError(null);
    setSummary(null);
    try {
      const { data, error: invokeErr } = await supabase.functions.invoke("security-test-lab", { body: {} });
      if (invokeErr) { setError(invokeErr.message); return; }
      setSummary(data as Summary);
    } catch (e) {
      // A network drop / thrown rejection from invoke() must not strand the
      // button on "Running…" with no feedback.
      setError(e instanceof Error ? e.message : "Red-team run failed to start.");
    } finally {
      setRunning(false);
    }
  };

  if (loading || isAdmin === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-background gap-4 p-6">
        <ShieldAlert className="w-10 h-10 text-destructive" />
        <h1 className="text-xl font-semibold text-foreground">Admin access required</h1>
        <p className="text-sm text-muted-foreground text-center max-w-md">
          The Security Test Lab is restricted to admin users. Ask an admin to grant your account the <code className="px-1 rounded bg-secondary/60">admin</code> role.
        </p>
        <Button variant="outline" onClick={() => nav("/")}>
          <ArrowLeft className="w-4 h-4 mr-1.5" /> Back
        </Button>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-5xl mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={() => nav(-1)}>
              <ArrowLeft className="w-4 h-4 mr-1.5" /> Back
            </Button>
            <h1 className="text-2xl font-semibold flex items-center gap-2">
              <ShieldCheck className="w-6 h-6 text-primary" /> Security Test Lab
            </h1>
          </div>
          <Button onClick={runRedTeam} disabled={running} className="gap-2">
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            {running ? "Running…" : "Run Full Red Team"}
          </Button>
        </div>

        <p className="text-sm text-muted-foreground">
          Runs the active prompt-injection, SSRF, and oversize payload tests against the live sanitizer and SSRF guard. Every run is logged to <code className="px-1 rounded bg-secondary/60">security_tests</code>.
        </p>

        {error && (
          <div className="glass-card rounded-lg p-4 text-sm text-destructive border border-destructive/40 bg-destructive/10">
            {error}
          </div>
        )}

        {summary && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Stat label="Total" value={summary.total} />
              <Stat label="Passed" value={summary.passed} tone="good" />
              <Stat label="Failed" value={summary.failed} tone={summary.failed > 0 ? "bad" : "good"} />
              <Stat label="Elapsed" value={`${summary.elapsed_ms}ms`} />
            </div>

            {summary.critical_failures.length > 0 && (
              <div className="glass-card rounded-lg p-4 border border-destructive/40 bg-destructive/10">
                <div className="text-sm font-medium text-destructive flex items-center gap-2 mb-2">
                  <ShieldAlert className="w-4 h-4" /> Critical failures
                </div>
                <ul className="list-disc list-inside text-sm text-foreground space-y-1">
                  {summary.critical_failures.map((n) => <li key={n}>{n}</li>)}
                </ul>
              </div>
            )}

            {(["prompt_injection", "ssrf", "oversize"] as const).map((cat) => {
              const list = summary.results.filter((r) => r.category === cat);
              const failed = list.filter((r) => !r.passed).length;
              return (
                <div key={cat} className="glass-card rounded-lg p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <h2 className="text-base font-semibold">{categoryLabel[cat]}</h2>
                    <span className={cn("text-xs px-2 py-0.5 rounded border",
                      failed > 0
                        ? "text-destructive border-destructive/40 bg-destructive/10"
                        : "text-[hsl(var(--confidence-high))] border-[hsl(var(--confidence-high))]/40 bg-[hsl(var(--confidence-high))]/10")}>
                      {list.length - failed}/{list.length} passed
                    </span>
                  </div>
                  <div className="space-y-2">
                    {list.map((r, i) => (
                      <div key={i} className="rounded-md border border-border bg-secondary/30 p-3 space-y-1">
                        <div className="flex items-center justify-between gap-3 text-sm">
                          <div className="flex items-center gap-2">
                            {r.passed
                              ? <ShieldCheck className="w-4 h-4 text-[hsl(var(--confidence-high))]" />
                              : <ShieldAlert className="w-4 h-4 text-destructive" />}
                            <span className="font-medium">{r.name}</span>
                            <span className={cn("text-eyebrow uppercase tracking-wide px-1.5 py-0.5 rounded border", severityColor[r.severity])}>
                              {r.severity}
                            </span>
                          </div>
                          <span className="text-xs text-muted-foreground">{r.duration_ms}ms</span>
                        </div>
                        <div className="text-xs text-muted-foreground font-mono break-all">in: {r.input_snippet}</div>
                        <div className="text-xs text-muted-foreground font-mono break-all">out: {r.output_snippet}</div>
                        {r.notes && <div className="text-xs text-foreground/80">{r.notes}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: "good" | "bad" }) {
  return (
    <div className="glass-card rounded-lg p-3">
      <div className="text-xs text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className={cn(
        "text-xl font-semibold mt-1",
        tone === "good" && "text-[hsl(var(--confidence-high))]",
        tone === "bad" && "text-destructive",
      )}>{value}</div>
    </div>
  );
}