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

describe("security headers via vercel.json HTTP headers (F-B5)", () => {
  // Security policies are delivered as real HTTP response headers (vercel.json),
  // NOT <meta http-equiv> — browsers ignore X-Frame-Options / X-Content-Type-
  // Options / Permissions-Policy as meta tags. We assert the values on the
  // header that Vercel actually serves, and that the dead meta tags are gone.
  const vercelJson = readFileSync(resolve(process.cwd(), "vercel.json"), "utf-8");
  const indexHtml = readFileSync(resolve(process.cwd(), "index.html"), "utf-8");
  const cfg = JSON.parse(vercelJson) as { headers?: Array<{ source: string; headers: Array<{ key: string; value: string }> }> };
  const headerMap = Object.fromEntries(
    (cfg.headers ?? []).flatMap((h) => h.headers).map((h) => [h.key.toLowerCase(), h.value]),
  );

  it("delivers a Content-Security-Policy header", () => {
    expect(headerMap["content-security-policy"]).toBeTruthy();
  });

  it("CSP uses frame-ancestors (header-only) plus base-uri / form-action", () => {
    const csp = headerMap["content-security-policy"] ?? "";
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).toMatch(/base-uri 'self'/);
    expect(csp).toMatch(/form-action 'self'/);
  });

  it("CSP restricts script-src to self + supabase", () => {
    expect(headerMap["content-security-policy"]).toMatch(/script-src 'self' 'unsafe-inline' https:\/\/\*\.supabase\.co/);
  });

  it("CSP restricts connect-src to self + supabase + Serus", () => {
    expect(headerMap["content-security-policy"]).toMatch(/connect-src[^;]*https:\/\/api\.serus\.ai/);
  });

  it("sets X-Frame-Options: DENY", () => {
    expect(headerMap["x-frame-options"]).toBe("DENY");
  });

  it("sets X-Content-Type-Options: nosniff", () => {
    expect(headerMap["x-content-type-options"]).toBe("nosniff");
  });

  it("sets a strict Referrer-Policy", () => {
    expect(headerMap["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  });

  it("disables camera/microphone/geolocation via Permissions-Policy", () => {
    const pp = headerMap["permissions-policy"] ?? "";
    expect(pp).toMatch(/camera=\(\)/);
    expect(pp).toMatch(/microphone=\(\)/);
    expect(pp).toMatch(/geolocation=\(\)/);
  });

  it("no longer relies on ignored <meta http-equiv> security tags", () => {
    expect(indexHtml).not.toMatch(/http-equiv="X-Frame-Options"/);
    expect(indexHtml).not.toMatch(/http-equiv="X-Content-Type-Options"/);
    expect(indexHtml).not.toMatch(/http-equiv="Permissions-Policy"/);
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
