import { describe, expect, it, vi } from "vitest";
import {
  RELOAD_WINDOW_MS,
  STALE_CHUNK_RELOAD_KEY,
  installStaleChunkReload,
  isStaleChunkError,
  tryStaleChunkReload,
} from "@/lib/stale-chunk-reload";

function fakeHost(opts: { throwOnStorage?: boolean } = {}) {
  const store = new Map<string, string>();
  const reload = vi.fn();
  const listeners = new Map<string, (e: Event) => void>();
  const host = {
    sessionStorage: {
      getItem: (k: string) => {
        if (opts.throwOnStorage) throw new Error("SecurityError");
        return store.get(k) ?? null;
      },
      setItem: (k: string, v: string) => {
        if (opts.throwOnStorage) throw new Error("SecurityError");
        store.set(k, v);
      },
    },
    location: { reload },
    addEventListener: (t: string, fn: (e: Event) => void) => listeners.set(t, fn),
    removeEventListener: (t: string) => listeners.delete(t),
  };
  const fire = () => {
    const e = new Event("vite:preloadError", { cancelable: true });
    listeners.get("vite:preloadError")?.(e);
    return e;
  };
  return { host, store, reload, fire, listeners };
}

describe("isStaleChunkError", () => {
  it("matches the production message from a tab that outlived a deploy", () => {
    expect(
      isStaleChunkError(
        new TypeError(
          "Failed to fetch dynamically imported module: https://insight-finder-sandy.vercel.app/assets/EvidenceTab-Boel7f09.js",
        ),
      ),
    ).toBe(true);
    expect(isStaleChunkError(new Error("Importing a module script failed."))).toBe(true);
    expect(isStaleChunkError("error loading dynamically imported module")).toBe(true);
  });

  it("does not match ordinary render errors", () => {
    expect(isStaleChunkError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isStaleChunkError(null)).toBe(false);
  });
});

describe("tryStaleChunkReload", () => {
  it("reloads once and records when", () => {
    const { host, store, reload } = fakeHost();
    expect(tryStaleChunkReload(host, 1_000_000)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(store.get(STALE_CHUNK_RELOAD_KEY)).toBe("1000000");
  });

  it("does NOT reload again inside the window — a broken build cannot loop", () => {
    const { host, reload } = fakeHost();
    tryStaleChunkReload(host, 1_000_000);
    expect(tryStaleChunkReload(host, 1_000_000 + RELOAD_WINDOW_MS - 1)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("recovers again after the window, so a later deploy in the same tab also heals", () => {
    const { host, reload } = fakeHost();
    tryStaleChunkReload(host, 1_000_000);
    expect(tryStaleChunkReload(host, 1_000_000 + RELOAD_WINDOW_MS)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("fails safe without sessionStorage: no guard, so no reload", () => {
    const { host, reload } = fakeHost({ throwOnStorage: true });
    expect(tryStaleChunkReload(host, 1_000_000)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("installStaleChunkReload", () => {
  it("cancels vite:preloadError only when it actually reloads", () => {
    const { host, reload, fire } = fakeHost();
    installStaleChunkReload(host as unknown as Window & typeof host);

    const first = fire();
    expect(first.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);

    // Second failure inside the window: left uncancelled so Vite rethrows and
    // the error boundary shows the real error.
    const second = fire();
    expect(second.defaultPrevented).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("returns an uninstaller", () => {
    const { host, listeners } = fakeHost();
    const off = installStaleChunkReload(host as unknown as Window & typeof host);
    expect(listeners.has("vite:preloadError")).toBe(true);
    off();
    expect(listeners.has("vite:preloadError")).toBe(false);
  });
});
