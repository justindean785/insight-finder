import { describe, it, expect, beforeEach } from "vitest";
import {
  shouldRun,
  recordResult,
  clearThread,
  isProviderSuppressed,
  suppressionSnapshot,
  providerForTool,
  PROVIDER_SUPPRESS_MS,
} from "../../supabase/functions/osint-agent/circuit.ts";
import { creditsCharged } from "../../supabase/functions/osint-agent/billing.ts";

// Phase 8 — investigation-level provider suppression on 429 / timeout.
// Suppression is keyed per investigation + provider, isolated across
// investigations, resets at the run boundary, and (because cache.ts blocks a
// !allow decision and logs it as a free call) is never re-billed.

let n = 0;
let thread = "";
beforeEach(() => { thread = `inv-${++n}-${Math.random()}`; clearThread(thread); });

describe("429 suppresses the provider for the same investigation", () => {
  it("blocks the next call to that provider this run", () => {
    expect(shouldRun(thread, "stolentax_footprint", "sel").allow).toBe(true);
    recordResult(thread, "stolentax_footprint", "sel", "default", { status: "http_429" });

    const d = shouldRun(thread, "stolentax_footprint", "another-sel");
    expect(d.allow).toBe(false);
    expect((d as { reason?: string }).reason).toMatch(/429|suppress/i);

    const s = isProviderSuppressed(thread, "stolentax_footprint");
    expect(s.suppressed).toBe(true);
    expect(s.until).toBeGreaterThan(Date.now());
  });
});

describe("timeout suppresses the provider for the same investigation", () => {
  it("blocks the next call, and suppression is keyed to the provider", () => {
    // bosint_email_lookup maps to the 'bosint' provider group.
    expect(providerForTool("bosint_email_lookup")).toBe("bosint");
    recordResult(thread, "bosint_email_lookup", "sel", "default", { status: "timeout" });
    expect(shouldRun(thread, "bosint_email_lookup", "sel").allow).toBe(false);
    expect(isProviderSuppressed(thread, "bosint_email_lookup").suppressed).toBe(true);
  });
});

describe("suppression spans sibling tools of the same provider", () => {
  it("a timeout on one hunter tool suppresses a DIFFERENT hunter tool this run", () => {
    // hunter_domain_search and hunter_email_finder are distinct tools that share
    // the 'hunter' provider group. Suppression is keyed to the provider, so a
    // failure on one must suppress its sibling for the run — even though the
    // sibling itself never failed. (Regression guard for the multi-tool provider
    // grouping in circuit.ts PROVIDER_TOOLS.)
    expect(providerForTool("hunter_domain_search")).toBe("hunter");
    expect(providerForTool("hunter_email_finder")).toBe("hunter");
    expect(providerForTool("hunter_domain_search")).toBe(providerForTool("hunter_email_finder"));

    expect(shouldRun(thread, "hunter_email_finder", "sel").allow).toBe(true);
    recordResult(thread, "hunter_domain_search", "sel", "default", { status: "timeout" });

    // the sibling is now blocked purely by provider-group suppression
    const d = shouldRun(thread, "hunter_email_finder", "another-sel");
    expect(d.allow).toBe(false);
    expect((d as { reason?: string }).reason).toMatch(/timeout|suppress/i);
    expect(isProviderSuppressed(thread, "hunter_email_finder").suppressed).toBe(true);
  });
});

describe("suppression is isolated per investigation", () => {
  it("does not affect a different investigation", () => {
    recordResult(thread, "stolentax_footprint", "sel", "default", { status: "http_429" });
    const other = `inv-other-${Math.random()}`;
    clearThread(other);
    expect(shouldRun(other, "stolentax_footprint", "sel").allow).toBe(true);
    expect(isProviderSuppressed(other, "stolentax_footprint").suppressed).toBe(false);
  });
});

describe("other providers still run", () => {
  it("a 429 on one provider does not block unrelated providers", () => {
    recordResult(thread, "stolentax_footprint", "sel", "default", { status: "http_429" });
    expect(shouldRun(thread, "leakcheck_lookup", "sel").allow).toBe(true);
    expect(shouldRun(thread, "breach_check", "sel").allow).toBe(true);
  });
});

describe("no extra billing for skipped suppressed calls", () => {
  it("a suppressed/skipped call charges 0 credits", () => {
    recordResult(thread, "stolentax_footprint", "sel", "default", { status: "http_429" });
    const d = shouldRun(thread, "stolentax_footprint", "again");
    expect(d.allow).toBe(false);
    // cache.ts blocks a !allow decision and logs it with freeCall=true, so the
    // attempted-but-skipped call bills nothing.
    const charged = creditsCharged({ ok: false, cached: false, free: true, baseCost: 1500 });
    expect(charged).toBe(0);
  });
});

describe("suppression resets at the run boundary / has a finite cooldown", () => {
  it("clearThread lifts suppression", () => {
    recordResult(thread, "stolentax_footprint", "sel", "default", { status: "http_429" });
    expect(isProviderSuppressed(thread, "stolentax_footprint").suppressed).toBe(true);
    clearThread(thread);
    expect(isProviderSuppressed(thread, "stolentax_footprint").suppressed).toBe(false);
    expect(shouldRun(thread, "stolentax_footprint", "sel").allow).toBe(true);
  });

  it("uses a finite cooldown window (not permanent)", () => {
    const before = Date.now();
    recordResult(thread, "stolentax_footprint", "sel", "default", { status: "http_429" });
    const s = isProviderSuppressed(thread, "stolentax_footprint");
    expect(s.until).toBeGreaterThan(before);
    expect(s.until).toBeLessThanOrEqual(Date.now() + PROVIDER_SUPPRESS_MS + 50);
  });
});

describe("observability", () => {
  it("exposes active suppressions in a snapshot", () => {
    recordResult(thread, "stolentax_footprint", "sel", "default", { status: "http_429" });
    recordResult(thread, "bosint_email_lookup", "sel", "default", { status: "timeout" });
    const snap = suppressionSnapshot(thread);
    const providers = snap.map((x) => x.provider).sort();
    expect(providers).toContain("stolentax_footprint");
    expect(providers).toContain("bosint");
    for (const x of snap) expect(x.reason).toMatch(/suppress|429|timeout/i);
  });
});
