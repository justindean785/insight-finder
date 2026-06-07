import { useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { addBreadcrumb } from "@/lib/telemetry";

export function useAuth() {
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      addBreadcrumb("auth", `state change: ${event}`, { hasUser: !!s?.user });
      setSession(s);
      setUser(s?.user ?? null);
    });
    // getSession can reject (network/offline). Without catch/finally the app
    // would sit on loading=true forever and emit an unhandled rejection.
    supabase.auth
      .getSession()
      .then(({ data }) => {
        addBreadcrumb("auth", "bootstrap ok", { hasSession: !!data.session });
        setSession(data.session);
        setUser(data.session?.user ?? null);
      })
      .catch((e) => {
        addBreadcrumb("auth", "bootstrap failed");
        setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => setLoading(false));
    return () => sub.subscription.unsubscribe();
  }, []);

  return { session, user, loading, error };
}