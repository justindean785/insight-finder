import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #476 — the account-deletion control ships DARK.
 *
 * `delete_my_account()` is irreversible: no soft-delete, no tombstone, no export,
 * and no recovery path this repo can perform. The reviewed code lands in `main`,
 * but the affordance must not appear until the activation runbook has been worked
 * through and separately authorized.
 *
 * These tests RENDER the page under both flag states and observe what reaches the
 * DOM and what reaches the Supabase client. A source-text assertion (`expect(src)
 * .toMatch(/accountDeletionEnabled/)`) would pass even if the flag were read and
 * then ignored — which is exactly the bug worth catching.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mock = vi.hoisted(() => ({ rpcCalls: [] as string[] }));

// Stable identity: Settings' effects depend on `user`, and a fresh object per
// render re-fires them forever.
const authValue = { user: { id: "u1" }, session: null, loading: false };
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => authValue }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: (fn: string) => {
      mock.rpcCalls.push(fn);
      return Promise.resolve({ data: null, error: null });
    },
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        order: () => q,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        limit: () => Promise.resolve({ data: [], error: null }),
      };
      return q;
    },
    auth: { signOut: () => Promise.resolve({ error: null }) },
  },
  SUPABASE_URL: "https://example.test",
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => () => {},
  Link: ({ children }: { children?: unknown }) => children,
}));

const roots: Root[] = [];

async function renderSettings() {
  vi.resetModules();
  const { default: Settings } = await import("@/pages/Settings");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  roots.push(root);
  await act(async () => { root.render(<Settings />); });
  await act(async () => { await Promise.resolve(); });
  return host;
}

beforeEach(() => {
  mock.rpcCalls.length = 0;
  vi.unstubAllEnvs();
});

afterEach(() => {
  act(() => { roots.splice(0).forEach((r) => r.unmount()); });
  document.body.innerHTML = "";
  vi.unstubAllEnvs();
});

describe("#476 account deletion — dark by default", () => {
  it("renders NO deletion control when the flag is unset", async () => {
    const host = await renderSettings();
    expect(host.textContent).not.toContain("Delete account");
    expect(host.querySelector('[id="delete-confirm"]')).toBeNull();
  });

  it("renders no deletion control for values that are not exactly \"true\"", async () => {
    // Fails closed on a malformed value rather than guessing intent.
    for (const value of ["1", "TRUE", "True", "yes", "on", "false", ""]) {
      vi.stubEnv("VITE_ENABLE_ACCOUNT_DELETION", value);
      const host = await renderSettings();
      expect(host.textContent, `flag value ${JSON.stringify(value)} must NOT enable`)
        .not.toContain("Delete account");
      act(() => { roots.splice(0).forEach((r) => r.unmount()); });
      document.body.innerHTML = "";
    }
  });

  it("renders the deletion control only when explicitly enabled", async () => {
    vi.stubEnv("VITE_ENABLE_ACCOUNT_DELETION", "true");
    const host = await renderSettings();
    expect(host.textContent).toContain("Delete account");
  });

  it("cannot invoke delete_my_account while disabled — nothing to click", async () => {
    const host = await renderSettings();
    // No control exists, so there is no path to the RPC at all.
    const buttons = Array.from(host.querySelectorAll("button"));
    const deleteButton = buttons.find((b) => /delete/i.test(b.textContent ?? ""));
    expect(deleteButton).toBeUndefined();
    expect(mock.rpcCalls).not.toContain("delete_my_account");
  });

  it("never calls delete_my_account on render, under either flag state", async () => {
    await renderSettings();
    expect(mock.rpcCalls).toHaveLength(0);

    act(() => { roots.splice(0).forEach((r) => r.unmount()); });
    document.body.innerHTML = "";

    vi.stubEnv("VITE_ENABLE_ACCOUNT_DELETION", "true");
    await renderSettings();
    expect(mock.rpcCalls).not.toContain("delete_my_account");
  });
});

describe("#476 account deletion — the handler guard (structural)", () => {
  /**
   * AN HONEST LIMIT, stated rather than papered over.
   *
   * `deleteAccount()` re-checks the flag before touching the RPC. That guard is
   * defence-in-depth for a future refactor that removes or bypasses the render
   * gate — and while the render gate stands it is UNREACHABLE BY CONSTRUCTION:
   * with the flag off no control exists, so no behavioural test can drive the
   * handler to prove the guard fires.
   *
   * Mutation-checking confirmed exactly that: deleting the guard does NOT fail
   * the behavioural tests above. So this is a structural assertion, labelled as
   * one. It is weaker than driving the code, and it is the strongest instrument
   * available for this specific line. The behavioural tests above are what
   * actually prove the RPC is unreachable today.
   */
  it("re-checks the flag inside the handler, before the RPC", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const src = readFileSync(resolve(process.cwd(), "src/pages/Settings.tsx"), "utf8");

    const handler = src.slice(src.indexOf("const deleteAccount"));
    const body = handler.slice(0, handler.indexOf("supabase.rpc"));
    expect(body, "the flag must be re-checked before supabase.rpc is reached")
      .toMatch(/if \(!accountDeletionEnabled\) return;/);
  });

  it("gates the rendered block on the same constant", () => {
    // Not a second source of truth: one constant, read at both sites.
    const src = readFileSync2("src/pages/Settings.tsx");
    expect(src).toMatch(/\{accountDeletionEnabled && \(/);
    const occurrences = src.match(/accountDeletionEnabled/g) ?? [];
    expect(occurrences.length, "declaration + handler guard + render gate").toBeGreaterThanOrEqual(3);
  });
});

function readFileSync2(rel: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require("node:fs") as typeof import("node:fs");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const path = require("node:path") as typeof import("node:path");
  return fs.readFileSync(path.resolve(process.cwd(), rel), "utf8");
}
