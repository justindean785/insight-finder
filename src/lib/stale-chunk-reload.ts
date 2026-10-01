/**
 * stale-chunk-reload — recover a tab that outlived a frontend deploy.
 *
 * Every Vercel build renames its lazy chunks (`EvidenceTab-<hash>.js`) and the
 * previous build's files stop being served. A tab opened before the deploy still
 * references the old names, so the first lazy tab it opens afterwards fails with
 * "Failed to fetch dynamically imported module" and lands on the error screen.
 * Measured 2026-09-23: a tab loaded at 23:29Z, #620 went live ~23:34Z, and the
 * Evidence tab broke at 23:38Z. A reload fixes it; this does the reload for the
 * analyst.
 *
 * Loop guard: at most one automatic reload per RELOAD_WINDOW_MS, remembered in
 * sessionStorage. If the chunk is still missing after a reload (a genuinely
 * broken build, not a stale tab), the error surfaces normally. If sessionStorage
 * is unavailable there is no way to prove we are not looping, so we do NOT
 * reload — fail safe, fall through to the existing error screen.
 */

export const STALE_CHUNK_RELOAD_KEY = "if:stale-chunk-reload-at";
export const RELOAD_WINDOW_MS = 30_000;

const STALE_CHUNK_PATTERN =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i;

/** Does this error look like a lazy chunk that is no longer served? */
export function isStaleChunkError(err: unknown): boolean {
  const msg =
    err instanceof Error ? err.message : typeof err === "string" ? err : "";
  return STALE_CHUNK_PATTERN.test(msg);
}

type ReloadHost = {
  sessionStorage: Pick<Storage, "getItem" | "setItem">;
  location: Pick<Location, "reload">;
};

/**
 * Reload once if no automatic reload happened in the last RELOAD_WINDOW_MS.
 * Returns true when a reload was triggered.
 */
export function tryStaleChunkReload(
  host: ReloadHost = window,
  now: number = Date.now(),
): boolean {
  try {
    const last = Number(host.sessionStorage.getItem(STALE_CHUNK_RELOAD_KEY) ?? 0);
    if (Number.isFinite(last) && last > 0 && now - last < RELOAD_WINDOW_MS) return false;
    host.sessionStorage.setItem(STALE_CHUNK_RELOAD_KEY, String(now));
  } catch {
    return false;
  }
  host.location.reload();
  return true;
}

/**
 * Vite dispatches a cancelable `vite:preloadError` on window whenever a lazy
 * import (or its preloads) fails. Cancelling it stops the throw; we only cancel
 * when we are actually reloading, so a real failure still reaches the error
 * boundary.
 */
export function installStaleChunkReload(
  win: Window & ReloadHost = window,
): () => void {
  const onPreloadError = (event: Event) => {
    if (tryStaleChunkReload(win)) event.preventDefault();
  };
  win.addEventListener("vite:preloadError", onPreloadError);
  return () => win.removeEventListener("vite:preloadError", onPreloadError);
}
