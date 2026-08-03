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

  it("preserves every authentication and recovery path", () => {
    expect(auth).toContain("<form onSubmit={signIn}");
    expect(auth).toContain("<form onSubmit={signUp}");
    expect(auth).toContain("<form onSubmit={resetPassword}");
    expect(auth).toContain("googleEnabled");
    expect(auth).toContain('to="/terms"');
    expect(auth).toContain('to="/privacy"');
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
    expect(tabs).toContain('aria-label="Investigation workspace"');
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
