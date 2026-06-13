import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { toast } from "sonner";
import { addBreadcrumb, captureError } from "@/lib/telemetry";
import Landing from "./Landing";

export default function IndexRedirect() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (loading || !user) return;
    let alive = true;
    setError(null);
    addBreadcrumb("route", "index bootstrap start");
    (async () => {
      try {
        const { data: existing, error: selErr } = await supabase
          .from("threads")
          .select("id")
          .order("updated_at", { ascending: false })
          .limit(1);
        if (selErr) throw selErr;
        if (!alive) return;
        if (existing && existing.length > 0) {
          navigate(`/chat/${existing[0].id}`, { replace: true });
          return;
        }
        const { data: created, error: insErr } = await supabase
          .from("threads")
          .insert({ user_id: user.id })
          .select("id")
          .single();
        if (insErr) throw insErr;
        if (alive && created) navigate(`/chat/${created.id}`, { replace: true });
      } catch (e) {
        if (!alive) return;
        captureError(e, "route.indexBootstrap");
        const msg = e instanceof Error ? e.message : "Could not load your cases.";
        setError(msg);
        toast.error("Couldn't open your workspace", { description: msg });
      }
    })();
    return () => { alive = false; };
  }, [user, loading, navigate, attempt]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-muted-foreground">Loading…</div>
    );
  }

  if (!user) return <Landing />;

  if (error) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 px-6 text-center">
        <div>
          <div className="text-sm font-medium text-foreground">Couldn't open your workspace</div>
          <div className="mt-1 max-w-md text-xs text-muted-foreground">{error}</div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setAttempt((n) => n + 1)}
            className="rounded-md border border-border-subtle bg-surface-2 px-3 py-1.5 text-xs text-foreground hover:bg-surface-1"
          >
            Retry
          </button>
          <button
            onClick={() => supabase.auth.signOut().then(() => navigate("/auth", { replace: true }))}
            className="rounded-md px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center text-muted-foreground">Loading…</div>
  );
}