// lib/tool-cache-version.ts — invalidate a tool's cached results when its INTERPRETATION changes.
//
// tool_call_cache is user-scoped and keyed on sha256({selector_type, selector, tool, params}).
// Nothing in that key says which build produced the row, so a fix to how a tool reads its
// fetches stays invisible until the old rows expire. Measured 2026-09-14: #594 (live build
// 0a04e1b, deployed ~16:30Z) stopped six platforms proving a registration for any handle, and
// a re-scan at 17:19Z still narrated "3 confirmed hits (Mixcloud, Telegram, HackerRank)" —
// `tool_usage_log.cached = true`, replaying a row written at 13:44Z with those sites in
// `found[]`. The fix was correct; the deploy check could not see it.
//
// A tool listed here gets its version folded into both cache hashes, so rows written under
// an older interpretation simply stop matching — they are never read again and age out on
// their TTL. Tools NOT listed keep byte-identical keys: adding this table invalidates nothing
// else. Bump a tool's number in the same PR that changes how that tool decides its result.

/** Current result-interpretation version per tool. Absent ⇒ unversioned (legacy key). */
export const TOOL_CACHE_VERSION: Readonly<Record<string, number>> = {
  // v2 — #594: echo-unsafe sites (HackerRank, Mixcloud, Spotify, Telegram, Trakt, NameMC) are
  // `unverified`, never `found`. A v1 row counts them as registrations.
  username_sweep: 2,
  // Deprecated alias that returns the same sweepUsername() result under its own cache key.
  username_search: 2,
  // v2 — the socialfetch host-policy + failure-taxonomy change. Three separate
  // reinterpretations of the SAME (url) key, all of which a v1 row contradicts:
  //   • a skipped host (youtube/roblox/steam/…) is `host_unsupported`, not a read;
  //   • a 2xx under the 200-char floor is `empty_body`, not `ok:true` with `data`;
  //   • a timeout / 5xx / thin body may now answer via the free jina fallback.
  // Without the bump the wrapper serves the pre-fix row before this code runs, so
  // a blank page keeps entering cases as page evidence for the full TTL and the
  // deploy looks like it failed. This is the #599 lesson applied in the same PR
  // that changes the interpretation, which is the only time it is cheap.
  socialfetch_web_read: 2,
  // v2 — lib/negative-lookup.ts. Two reinterpretations of the SAME (ip) / (url) key that a
  // v1 row contradicts: an InternetDB 404 is a proven negative (`ok:true, found:false`), not
  // `{ok:false, status:404}`; and a Jina 200 that wraps an origin error is a negative / a
  // failed read, not `{ok:true, markdown}` page evidence. A v1 jina row would keep replaying
  // an error page as ok for the full 6h TTL, so the verification scan would look like the
  // deploy failed (the #599 lesson, applied in the PR that changes the interpretation).
  shodan_internetdb: 2,
  jina_reader_scrape: 2,
};

/**
 * KILL SWITCH. `TOOL_CACHE_VERSION_DISABLED=true` restores the unversioned keys, so rows
 * written before this shipped match again. Read at CALL TIME so it takes effect on the
 * running build the moment the secret changes, with no deploy.
 */
export function toolCacheVersioningEnabled(): boolean {
  return (Deno.env.get("TOOL_CACHE_VERSION_DISABLED") ?? "").trim().toLowerCase() !== "true";
}

/** The version to fold into this tool's cache keys, or null for the legacy key. */
export function cacheVersionFor(tool: string): number | null {
  if (!toolCacheVersioningEnabled()) return null;
  return TOOL_CACHE_VERSION[tool] ?? null;
}

/** `/health` → `checks.tool_cache_version`. Presence of the key proves this build is deployed. */
export function describeToolCacheVersions(): { ok: true; detail: string } {
  if (!toolCacheVersioningEnabled()) {
    return { ok: true, detail: "disabled — TOOL_CACHE_VERSION_DISABLED=true, legacy keys" };
  }
  const entries = Object.entries(TOOL_CACHE_VERSION).map(([tool, v]) => `${tool}=v${v}`);
  return { ok: true, detail: entries.length ? entries.join(", ") : "no versioned tools" };
}
