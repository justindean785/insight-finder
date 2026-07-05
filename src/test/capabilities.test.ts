import { describe, it, expect, beforeEach } from "vitest";
import {
  discoverCapabilities,
  capabilityEnvKeys,
  unavailableProviders,
  PROVIDER_REQUIREMENTS,
  type ProviderRequirement,
} from "../../supabase/functions/osint-agent/capabilities.ts";
import {
  shouldRun,
  recordResult,
  disableTool,
  clearThread,
} from "../../supabase/functions/osint-agent/circuit.ts";
import { creditsCharged } from "../../supabase/functions/osint-agent/billing.ts";

// Phase 6 — startup capability discovery. Pure evaluation + the circuit
// integration that turns "unavailable" into a pre-invocation, un-billed skip.

// A realistic prod-ish env: most keys present, but HIBP missing (missing-key
// skip) — mirrors the audited trace.
const PROD_ENV: Record<string, boolean> = {};
for (const k of capabilityEnvKeys()) PROD_ENV[k] = true;
PROD_ENV.HIBP_API_KEY = false;       // missing key

const statusOf = (caps: ReturnType<typeof discoverCapabilities>, tool: string) =>
  caps.find((c) => c.tool === tool)!;

describe("discoverCapabilities — pure evaluation", () => {
  const caps = discoverCapabilities(PROD_ENV, null);

  it("skips a missing-key provider (hibp)", () => {
    const h = statusOf(caps, "hibp_lookup");
    expect(h.available).toBe(false);
    expect(h.reason).toBe("missing_key");
    expect(h.detail).toContain("HIBP_API_KEY");
  });

  it("keeps available providers available (exa, oathnet with keys present)", () => {
    expect(statusOf(caps, "exa_search").available).toBe(true);
    expect(statusOf(caps, "oathnet_lookup").available).toBe(true);
  });

  it("flags unsupported seed types when configured", () => {
    const reqs: Record<string, ProviderRequirement> = {
      whois_lookup: { seedTypes: ["domain", "ip"] },
    };
    expect(discoverCapabilities({}, "email", reqs)[0]).toMatchObject({
      available: false,
      reason: "unsupported_seed",
    });
    expect(discoverCapabilities({}, "domain", reqs)[0].available).toBe(true);
  });

  it("never emits a secret — detail carries only env var NAMES", () => {
    for (const c of caps) {
      if (c.detail) expect(c.detail).not.toMatch(/[a-z0-9]{20,}/i); // no key-like blob
    }
  });

  it("capabilityEnvKeys lists the probed vars", () => {
    expect(capabilityEnvKeys()).toEqual(expect.arrayContaining(["HIBP_API_KEY", "EXA_API_KEY"]));
  });
});

describe("capability gating wired through the breaker", () => {
  let thread = "";
  let n = 0;
  beforeEach(() => { thread = `inv-${++n}-${Math.random()}`; clearThread(thread); });

  // mirror the index.ts wiring
  const applyGates = (t: string, env: Record<string, boolean>) => {
    for (const cap of discoverCapabilities(env, null)) {
      if (!cap.available) disableTool(t, cap.tool, `unavailable: ${cap.reason}`);
    }
  };

  it("skips a missing-key provider before invocation", () => {
    applyGates(thread, PROD_ENV);
    expect(shouldRun(thread, "hibp_lookup", "a@b.com").allow).toBe(false);            // missing_key
  });

  it("lets available providers run", () => {
    applyGates(thread, PROD_ENV);
    expect(shouldRun(thread, "exa_search", "q").allow).toBe(true);
    expect(shouldRun(thread, "leakcheck_lookup", "a@b.com").allow).toBe(true);
  });

  it("charges 0 credits for a startup-gated provider", () => {
    applyGates(thread, PROD_ENV);
    expect(shouldRun(thread, "hibp_lookup", "a@b.com").allow).toBe(false);
    // cache.ts blocks the !allow decision and logs it with freeCall=true → no charge
    expect(creditsCharged({ ok: false, cached: false, free: true, baseCost: 3000 })).toBe(0);
  });

  it("is investigation-scoped — does not mutate global/other runs", () => {
    applyGates(thread, PROD_ENV);
    const other = `inv-other-${Math.random()}`;
    clearThread(other);
    // a different run that does NOT gate hibp can still attempt it
    expect(shouldRun(other, "hibp_lookup", "a@b.com").allow).toBe(true);
  });

  it("keeps #9 provider suppression working for available providers after a failure", () => {
    applyGates(thread, PROD_ENV);
    // leakcheck is available (key present) → runs, then 429s → suppressed for the run.
    // (Was stolentax_footprint, now hard-disabled/cut 2026-07-05 — use another
    // available keyed breach provider to exercise the same suppression path.)
    expect(shouldRun(thread, "leakcheck_lookup", "a@b.com").allow).toBe(true);
    recordResult(thread, "leakcheck_lookup", "a@b.com", "default", { status: "http_429" });
    expect(shouldRun(thread, "leakcheck_lookup", "again").allow).toBe(false);
  });
});

describe("unavailableProviders / map sanity", () => {
  it("returns only the unavailable providers", () => {
    const unavail = unavailableProviders(discoverCapabilities(PROD_ENV, null)).map((c) => c.tool);
    expect(unavail).toContain("hibp_lookup");
    expect(unavail).not.toContain("exa_search");
  });

  it("hibp is represented in the requirements", () => {
    expect(PROVIDER_REQUIREMENTS.hibp_lookup.requiresKey).toBe("HIBP_API_KEY");
  });
});
