import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf-8");

describe("analyst access gateway contract", () => {
  const auth = read("src/pages/Auth.tsx");
  const landing = read("src/pages/Landing.tsx");
  const homeHub = read("src/pages/HomeHub.tsx");

  it("uses the canonical product identity and professional workflow language", () => {
    expect(auth).toContain("Insight Finder");
    expect(auth).toContain("Turn fragments into defensible intelligence.");
    expect(auth).toContain("Corroboration before conclusion");
    expect(auth).not.toMatch(/Swarmbot/i);
  });


  it("keeps public and authenticated entry points aligned to investigation language", () => {
    expect(landing).toContain("From open-source signals to");
    expect(landing).toContain("defensible intelligence.");
    expect(landing).toContain("Source-aware");
    expect(homeHub).toContain('title="Investigate"');
    expect(homeHub).toContain('cta="Open workspace"');
    expect(landing).not.toMatch(/investigator beta|chat-driven|swarm harvests/i);
    expect(homeHub).not.toMatch(/title="Chat"|open the chat|let the swarm work/i);
  });

  it("does not present fabricated operational metrics", () => {
    expect(auth).not.toMatch(/\b\d+\s+(?:active\s+)?(?:cases|investigations|signals|sources|hits)\b/i);
  });

  // RENAMED, deliberately. This block used to be called "preserves every
  // authentication and recovery path" — a claim its evidence could not support.
  // Every assertion here is a SOURCE-TEXT match: it passes if `signIn` is gutted
  // to a no-op, if the handler never reaches Supabase, if the submit button is
  // detached from its form, or if the page throws on mount.
  //
  // The behavioural guarantee now lives in src/test/auth-gateway-render.test.tsx,
  // which mounts the real component and asserts that submitting sign-in calls
  // Supabase with the typed credentials and that recovery round-trips. Keep both:
  // this one is a cheap structural tripwire, that one is the actual gate.
  it("still declares the three auth form handlers and the legal links in source", () => {
    expect(auth).toContain("<form onSubmit={signIn}");
    expect(auth).toContain("<form onSubmit={signUp}");
    expect(auth).toContain("<form onSubmit={resetPassword}");
    expect(auth).toContain("googleEnabled");
    expect(auth).toContain('to="/terms"');
    expect(auth).toContain('to="/privacy"');
  });

  // Source-level on purpose, and weak on purpose: the OAuth button is gated
  // behind `VITE_ENABLE_GOOGLE_OAUTH`, which is off in beta, so the button never
  // renders and no behavioural test can reach it. Google's branding guidelines
  // require the mark on the button, and the redesign dropped it — a tripwire is
  // proportionate for a presentational asset that cannot be exercised.
  it("keeps Google's branded mark on the OAuth button", () => {
    expect(auth).toMatch(/<svg[^>]*viewBox="0 0 24 24"/);
    expect(auth).toContain('fill="#EA4335"');
  });

  it("keeps labeled autocomplete-aware inputs", () => {
    for (const id of ["signin-email", "signin-password", "signup-email", "signup-password", "reset-email"]) {
      expect(auth).toContain(`id="${id}"`);
    }
    expect(auth).toContain('autoComplete="email"');
    expect(auth).toContain('autoComplete="current-password"');
    expect(auth).toContain('autoComplete="new-password"');
  });
});

describe("operations surface performance and accessibility contract", () => {
  const css = read("src/index.css");
  const loader = read("src/components/ui/full-page-loader.tsx");
  const tabs = read("src/components/workspace/WorkspaceTabs.tsx");

  it("disables decorative motion and expensive blur where appropriate", () => {
    expect(css).toContain("@media (max-width: 1023px), (prefers-reduced-motion: reduce)");
    expect(css).toContain("backdrop-filter: none");
    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain(".signal-sweep { animation: none");
  });

  it("announces route loading without inventing progress", () => {
    expect(loader).toContain('role="status"');
    expect(loader).toContain('aria-live="polite"');
    expect(loader).toContain('aria-busy="true"');
    expect(loader).not.toMatch(/\{\s*\d+\s*%\s*\}/);
  });

  it("uses investigation language for the primary work surface", () => {
    expect(tabs).toContain('{ key: "chat", label: "Investigate"');
    expect(tabs).toContain('label = "Investigation workspace"');
  });

  // The rename originally reached WorkspaceTabs, HomeHub and the command palette
  // but NOT AppNav — the global header rendered on every route, and the one
  // surface this suite did not cover. AppNav is gone (Stage A): the global nav
  // is AppShell's rail (ThreadSidebar) plus the palette's "Go to" group, and
  // both are pinned here so the old word cannot come back on either.
  it("renames the primary nav destination everywhere it is rendered", () => {
    for (const rel of ["src/components/ThreadSidebar.tsx", "src/components/CommandPalette.tsx"]) {
      const nav = read(rel);
      expect(nav, rel).toContain('label: "Intelligence"');
      expect(nav, rel).not.toMatch(/label:\s*"Chat"/);
    }
  });

  it("has one global nav: AppNav and the viewer's own tab strip are not coming back", () => {
    expect(() => read("src/components/AppNav.tsx")).toThrow();
    expect(() => read("src/components/workspace/ViewWorkspaceTabs.tsx")).toThrow();
    const app = read("src/App.tsx");
    expect(app).toMatch(/<Route element=\{<AppShell \/>\}>/);
  });
});

describe("public metadata contract", () => {
  const html = read("index.html");

  it("describes an evidence-driven product instead of a generic chat app", () => {
    expect(html).toContain("<title>Insight Finder — OSINT Investigator</title>");
    expect(html).toContain("Evidence-driven OSINT investigation workspace");
    expect(html).not.toContain("Chat-driven OSINT investigator");
  });
});
