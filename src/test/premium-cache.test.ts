import { describe, it, expect, beforeEach } from "vitest";
import {
  shouldRun,
  recordResult,
  clearThread,
  classifyResult,
  normalizeSelector,
  isPremiumTool,
  PREMIUM_TOOLS,
} from "../../supabase/functions/osint-agent/circuit.ts";
import { creditsCharged } from "../../supabase/functions/osint-agent/billing.ts";

// Phase 7/11 — premium-once-per-entity dedup + negative cache. Targets the
// duplicate premium charges (leakcheck ×2, oathnet ×2, breach ×3) and the
// repeated 422 from the trace audit.

let n = 0;
let thread = "";
beforeEach(() => { thread = `inv-${++n}-${Math.random()}`; clearThread(thread); });

const EMAIL = normalizeSelector("email", "taylorquinn@example.com");

describe("premium-once-per-entity", () => {
  it("runs a premium tool once per entity, then skips the repeat", () => {
    expect(shouldRun(thread, "oathnet_lookup", EMAIL).allow).toBe(true);
    // wrapper records ok with artifactCount: 0
    recordResult(thread, "oathnet_lookup", EMAIL, "default", { status: "ok", artifactCount: 0 });

    const d = shouldRun(thread, "oathnet_lookup", EMAIL);
    expect(d.allow).toBe(false);
    expect((d as { reason?: string }).reason).toMatch(/premium|already ran/i);
  });

  it("dedups across case/whitespace variants of the same entity", () => {
    const a = normalizeSelector("email", "Taylor@Example.com");
    const b = normalizeSelector("email", "  taylor@example.com ");
    expect(a).toBe(b);
    recordResult(thread, "leakcheck_lookup", a, "default", { status: "ok", artifactCount: 0 });
    expect(shouldRun(thread, "leakcheck_lookup", b).allow).toBe(false);
  });

  it("does NOT block a premium tool on a different entity", () => {
    recordResult(thread, "breach_check", EMAIL, "default", { status: "ok", artifactCount: 0 });
    expect(shouldRun(thread, "breach_check", normalizeSelector("email", "other@x.com")).allow).toBe(true);
  });

  it("charges 0 for the skipped premium repeat", () => {
    recordResult(thread, "oathnet_lookup", EMAIL, "default", { status: "ok", artifactCount: 0 });
    expect(shouldRun(thread, "oathnet_lookup", EMAIL).allow).toBe(false);
    // cache.ts blocks a !allow decision and logs freeCall=true → no charge
    expect(creditsCharged({ ok: false, cached: false, free: true, baseCost: 10000 })).toBe(0);
  });

  it("force=true bypasses premium dedup (explicit re-run)", () => {
    recordResult(thread, "exa_search", "q", "default", { status: "ok", artifactCount: 0 });
    expect(shouldRun(thread, "exa_search", "q", "default", { force: true }).allow).toBe(true);
  });
});

describe("behavior preserved for non-premium tools", () => {
  it("a cheap tool with 0 artifacts still re-runs (only premium dedups on 0)", () => {
    expect(isPremiumTool("dns_records")).toBe(false);
    recordResult(thread, "dns_records", "example.com", "default", { status: "ok", artifactCount: 0 });
    expect(shouldRun(thread, "dns_records", "example.com").allow).toBe(true);
  });

  it("a cheap tool that produced an artifact is still deduped (unchanged)", () => {
    recordResult(thread, "dns_records", "example.com", "default", { status: "ok", artifactCount: 2 });
    expect(shouldRun(thread, "dns_records", "example.com").allow).toBe(false);
  });

  it("first premium call is always allowed", () => {
    for (const tool of PREMIUM_TOOLS) {
      const t = `inv-first-${tool}-${Math.random()}`;
      clearThread(t);
      expect(shouldRun(t, tool, "seed").allow).toBe(true);
    }
  });
});

describe("negative cache — http_422", () => {
  it("classifies 422 and blacklists the selector against immediate retry", () => {
    expect(classifyResult({ ok: false, status: 422 }, null)).toBe("http_422");
    recordResult(thread, "jina_reader_scrape", "https://x/y", "default", { status: "http_422" });
    const d = shouldRun(thread, "jina_reader_scrape", "https://x/y");
    expect(d.allow).toBe(false);
    expect((d as { reason?: string }).reason).toMatch(/blacklist|422/i);
  });
});
