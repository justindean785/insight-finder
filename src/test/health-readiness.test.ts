import { describe, it, expect } from "vitest";

/*
 * Tests for the readiness derivation in supabase/functions/osint-agent/index.ts
 * (deriveReadiness) and the URL parser (isHealthProbe).
 *
 * The pure logic is re-implemented inline so vitest can run it under jsdom
 * without loading the Deno-only edge function module.
 *
 * Edge response contract (must stay stable — the frontend probe in
 * ChatWindow.tsx consumes this shape):
 *   GET  /functions/v1/osint-agent?health=1  → 200 when ok:true, 503 when ok:false
 *   HEAD /functions/v1/osint-agent?health=1  → 200 when ok:true, 503 when ok:false (no body)
 *   anything else                            → normal handler (auth, etc.)
 *
 *   ok:true   → orchestrator key + core DB env present
 *   ok:false  → either orchestrator or core env missing (run should be blocked)
 *   checks.tools.ok is always true (optional tools never block), but its
 *                `detail` reports the count of configured optional APIs
 *                (useful for the Admin / diagnostic panel).
 */

type Env = Record<string, string | null | undefined>;

function deriveReadiness(env: Env): {
  ok: boolean;
  checks: Record<string, { ok: boolean; detail?: string }>;
} {
  const has = (v: string | null | undefined) => !!(v && v.length > 0);
  const orchestratorOk = has(env.MINIMAX_API_KEY) || has(env.LOVABLE_API_KEY);
  const coreOk = has(env.SUPABASE_URL) && has(env.SUPABASE_SERVICE_ROLE_KEY) && has(env.SUPABASE_ANON_KEY);
  const tools = {
    oathnet: has(env.OATHNET_API_KEY),
    synapsint: has(env.SYNAPSINT_API_KEY),
    osintnova: has(env.OSINTNOVA_API_KEY),
    socialfetch: has(env.SOCIALFETCH_API_KEY),
    cordcat: has(env.CORDCAT_API_KEY),
    hunter: has(env.HUNTER_API_KEY),
    intelbase: has(env.INTELBASE_API_KEY),
    hibp: has(env.HIBP_API_KEY),
    exa: has(env.EXA_API_KEY),
    firecrawl: has(env.FIRECRAWL_API_KEY),
    serus: has(env.SERUS_API_KEY),
    github: has(env.GITHUB_API_TOKEN),
    perplexity: has(env.PERPLEXITY_API_KEY),
  };
  const enabledOptional = Object.values(tools).filter(Boolean).length;
  const checks: Record<string, { ok: boolean; detail?: string }> = {
    orchestrator: orchestratorOk
      ? { ok: true }
      : { ok: false, detail: "Set MINIMAX_API_KEY or LOVABLE_API_KEY in Supabase secrets" },
    core: coreOk
      ? { ok: true }
      : { ok: false, detail: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY missing" },
    tools: {
      ok: true,
      detail: `${enabledOptional}/${Object.keys(tools).length} optional tool APIs configured`,
    },
  };
  return { ok: orchestratorOk && coreOk, checks };
}

function isHealthProbe(req: { method: string; url: string }): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  try {
    const u = new URL(req.url);
    return u.searchParams.get("health") === "1";
  } catch {
    return false;
  }
}

const fullHealthy: Env = {
  MINIMAX_API_KEY: "sk-minimax-1234",
  SUPABASE_URL: "https://abc.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  SUPABASE_ANON_KEY: "anon-key",
  OATHNET_API_KEY: "o",
  EXA_API_KEY: "e",
  HUNTER_API_KEY: "h",
  SERUS_API_KEY: "s",
};

// ── Happy path ───────────────────────────────────────────────

describe("deriveReadiness — healthy configurations", () => {
  it("returns ok:true when MINIMAX is set + core env is set", () => {
    const r = deriveReadiness({
      MINIMAX_API_KEY: "sk-x",
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "k",
      SUPABASE_ANON_KEY: "anon",
    });
    expect(r.ok).toBe(true);
    expect(r.checks.orchestrator.ok).toBe(true);
    expect(r.checks.core.ok).toBe(true);
  });

  it("returns ok:true when LOVABLE is the only orchestrator (no MINIMAX)", () => {
    const r = deriveReadiness({
      LOVABLE_API_KEY: "lov-1",
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "k",
      SUPABASE_ANON_KEY: "anon",
    });
    expect(r.ok).toBe(true);
    expect(r.checks.orchestrator.ok).toBe(true);
  });

  it("returns ok:true when both orchestrators are set", () => {
    const r = deriveReadiness({
      MINIMAX_API_KEY: "a",
      LOVABLE_API_KEY: "b",
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "k",
      SUPABASE_ANON_KEY: "anon",
    });
    expect(r.ok).toBe(true);
  });

  it("treats empty-string keys as missing", () => {
    const r = deriveReadiness({
      MINIMAX_API_KEY: "",
      LOVABLE_API_KEY: "",
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "k",
      SUPABASE_ANON_KEY: "anon",
    });
    expect(r.ok).toBe(false);
    expect(r.checks.orchestrator.ok).toBe(false);
  });

  it("treats undefined keys as missing", () => {
    const r = deriveReadiness({});
    expect(r.ok).toBe(false);
    expect(r.checks.orchestrator.ok).toBe(false);
    expect(r.checks.core.ok).toBe(false);
  });

  it("treats null keys as missing", () => {
    const r = deriveReadiness({
      MINIMAX_API_KEY: null,
      LOVABLE_API_KEY: null,
      SUPABASE_URL: null,
      SUPABASE_SERVICE_ROLE_KEY: null,
    });
    expect(r.ok).toBe(false);
  });
});

// ── Failure paths ────────────────────────────────────────────

describe("deriveReadiness — failure paths", () => {
  it("orchestrator missing but core present → ok:false, core ok, orchestrator detail set", () => {
    const r = deriveReadiness({
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "k",
      SUPABASE_ANON_KEY: "anon",
    });
    expect(r.ok).toBe(false);
    expect(r.checks.orchestrator.ok).toBe(false);
    expect(r.checks.orchestrator.detail).toMatch(/MINIMAX_API_KEY/);
    expect(r.checks.core.ok).toBe(true);
  });

  it("core missing but orchestrator present → ok:false, orchestrator ok, core detail set", () => {
    const r = deriveReadiness({ MINIMAX_API_KEY: "a" });
    expect(r.ok).toBe(false);
    expect(r.checks.orchestrator.ok).toBe(true);
    expect(r.checks.core.ok).toBe(false);
    expect(r.checks.core.detail).toMatch(/SUPABASE_URL/);
  });

  it("only SUPABASE_URL set (no service key) → core check fails", () => {
    const r = deriveReadiness({
      MINIMAX_API_KEY: "a",
      SUPABASE_URL: "https://x.supabase.co",
    });
    expect(r.checks.core.ok).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("only service key set (no URL or anon key) → core check fails", () => {
    const r = deriveReadiness({
      MINIMAX_API_KEY: "a",
      SUPABASE_SERVICE_ROLE_KEY: "k",
    });
    expect(r.checks.core.ok).toBe(false);
  });

  it("orchestrator + URL + service key but no anon key → core check fails", () => {
    const r = deriveReadiness({
      MINIMAX_API_KEY: "a",
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "k",
    });
    expect(r.checks.core.ok).toBe(false);
    expect(r.checks.core.detail).toMatch(/SUPABASE_ANON_KEY/);
    expect(r.ok).toBe(false);
  });
});

// ── Optional tools count ─────────────────────────────────────

describe("deriveReadiness — optional tools accounting", () => {
  it("reports 0/13 when no optional tools configured", () => {
    const r = deriveReadiness({
      MINIMAX_API_KEY: "a",
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "k",
      SUPABASE_ANON_KEY: "anon",
    });
    expect(r.checks.tools.detail).toBe("0/13 optional tool APIs configured");
  });

  it("reports 4/13 when 4 optional tools configured", () => {
    const r = deriveReadiness({
      ...fullHealthy,
      MINIMAX_API_KEY: "a",
    });
    expect(r.checks.tools.detail).toMatch(/^4\/13/);
  });

  it("tools.check is always ok:true (optional, never blocks the run)", () => {
    const r = deriveReadiness({});
    expect(r.checks.tools.ok).toBe(true);
  });

  it("intelbase in the count even though runtime-gated by INTELBASE_ENABLED flag", () => {
    // The count includes intelbase; runtime gating is a separate signal
    // returned as `intelbase_enabled` in the response body. Frontend should
    // not infer health from the optional-tools count alone.
    const r = deriveReadiness({
      MINIMAX_API_KEY: "a",
      SUPABASE_URL: "https://x.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "k",
      INTELBASE_API_KEY: "i",
    });
    expect(r.checks.tools.detail).toBe("1/13 optional tool APIs configured");
  });
});

// ── isHealthProbe URL detection ──────────────────────────────

describe("isHealthProbe", () => {
  it("matches GET with ?health=1", () => {
    expect(isHealthProbe({ method: "GET", url: "https://x.supabase.co/functions/v1/osint-agent?health=1" })).toBe(true);
  });

  it("matches HEAD with ?health=1", () => {
    expect(isHealthProbe({ method: "HEAD", url: "https://x.supabase.co/functions/v1/osint-agent?health=1" })).toBe(true);
  });

  it("rejects POST even with ?health=1 (real scan path)", () => {
    expect(isHealthProbe({ method: "POST", url: "https://x.supabase.co/functions/v1/osint-agent?health=1" })).toBe(false);
  });

  it("rejects GET without ?health=1", () => {
    expect(isHealthProbe({ method: "GET", url: "https://x.supabase.co/functions/v1/osint-agent" })).toBe(false);
  });

  it("rejects GET with ?health=0 or other values", () => {
    expect(isHealthProbe({ method: "GET", url: "https://x.supabase.co/functions/v1/osint-agent?health=0" })).toBe(false);
    expect(isHealthProbe({ method: "GET", url: "https://x.supabase.co/functions/v1/osint-agent?healthy=1" })).toBe(false);
  });

  it("rejects OPTIONS (handled by CORS branch, not by health probe)", () => {
    expect(isHealthProbe({ method: "OPTIONS", url: "https://x.supabase.co/functions/v1/osint-agent?health=1" })).toBe(false);
  });

  it("handles additional query params (order-independent)", () => {
    expect(isHealthProbe({ method: "GET", url: "https://x.supabase.co/functions/v1/osint-agent?foo=bar&health=1&baz=qux" })).toBe(true);
  });
});
