// Builds the osint-agent edge-function URL from the Supabase env, defensively.
//
// The edge path is `${base}/functions/v1/osint-agent`. If VITE_SUPABASE_URL is
// ever set WITH a trailing `/functions/v1` (a common misconfiguration), naive
// concatenation produces `…/functions/v1/functions/v1/osint-agent`, which 404s
// every health probe and scan. We strip any trailing `/functions[/v1]` from the
// base so the path is always single, regardless of how the env is configured.
export function functionsBaseUrl(
  supabaseUrl?: string | null,
  projectId?: string | null,
): string {
  const fromUrl = supabaseUrl
    ?.trim()
    .replace(/\/+$/, "")              // trailing slashes
    .replace(/\/functions(\/v1)?$/, ""); // trailing /functions or /functions/v1
  if (fromUrl) return fromUrl;
  const pid = projectId?.trim();
  return pid ? `https://${pid}.supabase.co` : "";
}

/** Full URL for an arbitrary edge function, or "" if the env isn't configured.
 *  Shares the trailing-/functions/v1 defense so no caller can double the path. */
export function edgeFunctionUrl(
  name: string,
  supabaseUrl?: string | null,
  projectId?: string | null,
): string {
  const base = functionsBaseUrl(supabaseUrl, projectId);
  return base ? `${base}/functions/v1/${name}` : "";
}

/** Full osint-agent function URL, or "" if the env isn't configured. */
export function osintAgentUrl(supabaseUrl?: string | null, projectId?: string | null): string {
  return edgeFunctionUrl("osint-agent", supabaseUrl, projectId);
}
