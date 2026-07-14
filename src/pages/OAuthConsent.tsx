import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";

// Supabase Auth (OAuth 2.1 authorization server) redirects here so the analyst
// can approve or deny an MCP client that wants to act as them. Only the fields
// this page reads are typed; the server may return more.
type OAuthAuthorizationData = {
  redirect_url?: string;
  redirect_to?: string;
  client?: { name?: string } | null;
} | null;
type AuthOAuthNs = {
  getAuthorizationDetails: (id: string) => Promise<{ data: OAuthAuthorizationData; error: { message: string } | null }>;
  approveAuthorization: (id: string) => Promise<{ data: OAuthAuthorizationData; error: { message: string } | null }>;
  denyAuthorization: (id: string) => Promise<{ data: OAuthAuthorizationData; error: { message: string } | null }>;
};
function oauth(): AuthOAuthNs {
  return (supabase.auth as unknown as { oauth: AuthOAuthNs }).oauth;
}

export default function OAuthConsent() {
  const [params] = useSearchParams();
  const authorizationId = params.get("authorization_id") ?? "";
  const [details, setDetails] = useState<OAuthAuthorizationData>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    (async () => {
      if (!authorizationId) return setError("Missing authorization_id");
      const { data: sess } = await supabase.auth.getSession();
      if (!sess.session) {
        const next = window.location.pathname + window.location.search;
        window.location.href = "/auth?next=" + encodeURIComponent(next);
        return;
      }
      const { data, error } = await oauth().getAuthorizationDetails(authorizationId);
      if (!active) return;
      if (error) return setError(error.message);
      const immediate = data?.redirect_url ?? data?.redirect_to;
      if (immediate && !data?.client) {
        window.location.href = immediate;
        return;
      }
      setDetails(data);
    })();
    return () => { active = false; };
  }, [authorizationId]);

  async function decide(approve: boolean) {
    setBusy(true);
    const { data, error } = approve
      ? await oauth().approveAuthorization(authorizationId)
      : await oauth().denyAuthorization(authorizationId);
    if (error) { setBusy(false); return setError(error.message); }
    const target = data?.redirect_url ?? data?.redirect_to;
    if (!target) { setBusy(false); return setError("No redirect returned by the authorization server."); }
    window.location.href = target;
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex items-center justify-center p-6">
      <div className="w-full max-w-md rounded-2xl border border-white/10 glass-card p-6 space-y-5">
        <div>
          <div className="text-[10px] uppercase tracking-[0.24em] text-primary/80">Agent access request</div>
          <h1 className="mt-2 text-xl font-semibold tracking-tight">
            {details?.client?.name ? `Connect ${details.client.name}` : "Connect an app"} to Swarmbot
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            This lets {details?.client?.name ?? "the client"} call Swarmbot MCP tools as you.
            It can list and read your investigations.
          </p>
        </div>
        {error && <div className="text-sm text-destructive">{error}</div>}
        {!details && !error && <div className="text-sm text-muted-foreground">Loading…</div>}
        {details && (
          <div className="flex gap-3">
            <Button className="flex-1" onClick={() => decide(true)} disabled={busy}>Approve</Button>
            <Button variant="outline" className="flex-1" onClick={() => decide(false)} disabled={busy}>Deny</Button>
          </div>
        )}
      </div>
    </div>
  );
}