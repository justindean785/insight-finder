import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

export default function IndexRedirect() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    if (loading) return;
    let alive = true;
    if (!user) {
      navigate("/auth", { replace: true });
      return;
    }
    (async () => {
      const { data: existing } = await supabase
        .from("threads")
        .select("id")
        .order("updated_at", { ascending: false })
        .limit(1);
      if (!alive) return;
      if (existing && existing.length > 0) {
        navigate(`/chat/${existing[0].id}`, { replace: true });
        return;
      }
      const { data: created, error } = await supabase
        .from("threads")
        .insert({ user_id: user.id })
        .select("id")
        .single();
      if (alive && created && !error) navigate(`/chat/${created.id}`, { replace: true });
    })();
    return () => { alive = false; };
  }, [user, loading, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center text-muted-foreground">Loading…</div>
  );
}