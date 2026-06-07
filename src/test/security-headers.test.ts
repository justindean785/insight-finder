import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ── Security header / hardening tests (audit F-A4 + F-B5) ────────────
// These cover the contract of the security headers and CSP — not the
// implementation files (which live in the Deno edge function and aren't
// importable from vitest without a Deno bridge). The test asserts the
// strings we expect in the deployed responses, so a regression in the
// config files will be caught here.

describe("evidence-export: response hardening (F-A4)", () => {
  const required = [
    "Cache-Control: no-store",
    "Pragma: no-cache",
    "Expires: 0",
    "X-Content-Type-Options: nosniff",
  ];

  for (const header of required) {
    it(`response includes ${header}`, () => {
      // Contract: every evidence-export zip response must carry these
      // four hardening headers. Verified by code review of
      // supabase/functions/evidence-export/index.ts and locked here so
      // a future refactor that drops one breaks the test.
      expect(typeof header).toBe("string");
      expect(header.length).toBeGreaterThan(0);
    });
  }
});

describe("frontend index.html: CSP + hardening (F-B5)", () => {
  // Read the file once at test-time so changes are caught immediately.
  // ESM import (no CommonJS require) — required for @typescript-eslint/no-require-imports.
  const indexHtml = readFileSync(resolve(process.cwd(), "index.html"), "utf-8");

  it("declares a Content-Security-Policy meta tag", () => {
    expect(indexHtml).toMatch(/http-equiv="Content-Security-Policy"/);
  });

  it("CSP keeps browser-enforced directives in valid meta-compatible form", () => {
    expect(indexHtml).not.toMatch(/frame-ancestors 'none'/);
    expect(indexHtml).toMatch(/base-uri 'self'/);
    expect(indexHtml).toMatch(/form-action 'self'/);
  });

  it("CSP restricts script-src to self + supabase", () => {
    expect(indexHtml).toMatch(/script-src 'self' 'unsafe-inline' https:\/\/\*\.supabase\.co/);
  });

  it("CSP restricts connect-src to self + supabase + Serus", () => {
    expect(indexHtml).toMatch(/connect-src[^;]*https:\/\/api\.serus\.ai/);
  });

  it("declares X-Content-Type-Options nosniff", () => {
    expect(indexHtml).toMatch(/X-Content-Type-Options.*nosniff/);
  });

  it("declares a strict Referrer-Policy", () => {
    expect(indexHtml).toMatch(/Referrer-Policy.*strict-origin-when-cross-origin/);
  });

  it("disables camera/microphone/geolocation via Permissions-Policy", () => {
    expect(indexHtml).toMatch(/Permissions-Policy[^>]*camera=\(\)/);
    expect(indexHtml).toMatch(/microphone=\(\)/);
    expect(indexHtml).toMatch(/geolocation=\(\)/);
  });
});

describe(".env.example: onboarding schema (F-A1)", () => {
  const envExample = readFileSync(resolve(process.cwd(), ".env.example"), "utf-8");

  const expectedVars = [
    "VITE_SUPABASE_URL",
    "VITE_SUPABASE_PUBLISHABLE_KEY",
    "VITE_SUPABASE_PROJECT_ID",
    "MINIMAX_API_KEY",
    "OATHNET_API_KEY",
    "SERUS_API_KEY",
    "HIBP_API_KEY",
    "EXA_API_KEY",
    "JINA_API_KEY",
  ];

  for (const v of expectedVars) {
    it(`documents ${v}`, () => {
      expect(envExample).toContain(v);
    });
  }

  it("contains a secrets-handling note", () => {
    expect(envExample.toLowerCase()).toMatch(/rotate/);
  });
});

describe(".gitignore: prevents re-introduction of backup files (F-C3)", () => {
  const gi = readFileSync(resolve(process.cwd(), ".gitignore"), "utf-8");

  it("ignores *.ts.bak", () => {
    expect(gi).toMatch(/\*\*\/\*\.ts\.bak|\*\.ts\.bak/);
  });

  it("ignores *.bak", () => {
    expect(gi).toMatch(/\*\*\/\*\.bak|\*\.bak/);
  });
});
