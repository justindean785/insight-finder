import { SUPABASE_URL } from "@/integrations/supabase/client";

/**
 * Classify a `redirect: "manual"` pre-flight of Supabase's `/auth/v1/authorize`.
 *
 * A fully configured OAuth provider answers with a 3xx redirect to the provider.
 * For a cross-origin `fetch(..., { redirect: "manual" })` the browser masks that
 * as an *opaque redirect* (`type: "opaqueredirect"`, `status: 0`) — the success
 * signal. A provider that is toggled on but has no client secret (or is disabled)
 * instead returns a readable `4xx` JSON body ("Unsupported provider: missing
 * OAuth secret" / "provider is not enabled"). Navigating the top-level window
 * straight to that URL — what `signInWithOAuth` does — would strand the user on a
 * raw JSON error page, so we probe first and only proceed when it's actually ready.
 */
export function isOAuthProviderReady(res: Pick<Response, "type" | "status">): boolean {
  if (res.type === "opaqueredirect") return true;
  // Some engines report an opaque redirect as status 0 without the type flag.
  if (res.status === 0) return true;
  return res.status >= 300 && res.status < 400;
}

/**
 * Best-effort check that a Supabase OAuth provider is usable before we hand the
 * browser off to it. Returns `true` when ready, `false` when known-broken. On any
 * network/CORS failure it *fails open* (returns `true`) so we never block a
 * provider that might actually work — the real `signInWithOAuth` call stays the
 * source of truth. This makes the button self-healing: the moment the provider's
 * credentials are configured in Supabase, the probe passes and OAuth proceeds.
 */
export async function probeOAuthProvider(provider: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/auth/v1/authorize?provider=${encodeURIComponent(provider)}`,
      { method: "GET", redirect: "manual" },
    );
    return isOAuthProviderReady(res);
  } catch {
    return true;
  }
}
