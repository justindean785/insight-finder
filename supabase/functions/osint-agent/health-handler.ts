import {
  corsHeaders, MINIMAX_API_KEY, LOVABLE_API_KEY, SUPABASE_URL, SERVICE_KEY, SUPABASE_ANON_KEY,
  OATHNET_API_KEY, SYNAPSINT_API_KEY, OSINTNOVA_API_KEY, SOCIALFETCH_API_KEY,
  CORDCAT_API_KEY, HUNTER_API_KEY, INTELBASE_API_KEY, INTELBASE_ENABLED,
  HIBP_API_KEY, EXA_API_KEY, FIRECRAWL_API_KEY, SERUS_API_KEY,
  GITHUB_API_TOKEN, PERPLEXITY_API_KEY, IPQUALITYSCORE_API_KEY,
  OPENCORPORATES_API_KEY, RANSOMWARELIVE_API_KEY,
  URLSCANNER_API_KEY,
  XAI_API_KEY, GROK_ORCHESTRATOR_MODEL_ID,
  DEEPSEEK_API_KEY, DEEPSEEK_ORCHESTRATOR_MODEL_ID,
  OSINT_AGENT_PROBE_SECRET, FALLBACK_MODEL_ID,
} from "./env.ts";
import { minimaxChat, markMinimaxHealthy, minimaxHealthyWithin } from "./providers.ts";
import { BUILD_MARKER, BUILD_COMMITTED_AT } from "./build-info.ts";

// ---- checks.minimax — is the PRIMARY orchestrator actually reachable? -------
// `orchestrator.ok` only asserts a key exists; after the MiniMax-primary outage
// it must be possible to confirm from a plain ?health=1 that MiniMax itself
// answers. ok:true requires MINIMAX_API_KEY present AND a live round-trip
// (bounded at 5s, one shot — the health response must never hang on a stalled
// upstream). A recent successful orchestrator turn on this warm isolate counts
// as proof-of-life and skips the paid ping.
export type MinimaxCheck = {
  ok: boolean;
  reason?: "missing_key" | "preflight_failed" | "timeout";
  detail?: string;
};

export async function checkMinimax(deps?: {
  hasKey?: boolean;
  chat?: typeof minimaxChat;
  recentlyHealthy?: boolean;
}): Promise<MinimaxCheck> {
  const hasKey = deps?.hasKey ?? !!MINIMAX_API_KEY;
  if (!hasKey) {
    // Config regression, not a routine miss — error-level so it can't hide
    // behind a quietly-working fallback.
    console.error("[health] MINIMAX_API_KEY is not configured — checks.minimax reason=missing_key");
    return { ok: false, reason: "missing_key" };
  }
  if (deps?.recentlyHealthy ?? minimaxHealthyWithin(60_000)) {
    return { ok: true, detail: "recently_ok" };
  }
  const chat = deps?.chat ?? minimaxChat;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_000);
  try {
    const res = await chat({ user: "ping", maxTokens: 4, temperature: 0, signal: ctrl.signal });
    if (res.ok) {
      markMinimaxHealthy();
      return { ok: true };
    }
    return { ok: false, reason: "preflight_failed", detail: `status=${res.status}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return /abort/i.test(msg)
      ? { ok: false, reason: "timeout" }
      : { ok: false, reason: "preflight_failed", detail: msg.slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

// ---- checks.deepseek — is the (now-primary) DeepSeek orchestrator reachable? -
// Mirrors checkMinimax's contract exactly (ok:true requires a configured key
// AND a live round-trip, bounded at 5s, one shot). Deliberately does NOT skip
// the ping on a "recently healthy" warm isolate the way checkMinimax does —
// there is no deepseekHealthyWithin() cache yet (would require wiring a
// markDeepseekHealthy() call into the live orchestrator stream path); a future
// optimization, not required for correctness.
export type DeepseekCheck = {
  ok: boolean;
  reason?: "missing_key" | "preflight_failed" | "timeout";
  detail?: string;
};

export async function checkDeepseek(deps?: {
  hasKey?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<DeepseekCheck> {
  const hasKey = deps?.hasKey ?? !!DEEPSEEK_API_KEY;
  if (!hasKey) {
    return { ok: false, reason: "missing_key" };
  }
  const doFetch = deps?.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_000);
  try {
    const res = await doFetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: DEEPSEEK_ORCHESTRATOR_MODEL_ID,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 4,
        temperature: 0,
      }),
      signal: ctrl.signal,
    });
    if (res.ok) return { ok: true };
    return { ok: false, reason: "preflight_failed", detail: `status=${res.status}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return /abort/i.test(msg)
      ? { ok: false, reason: "timeout" }
      : { ok: false, reason: "preflight_failed", detail: msg.slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

export function deriveReadiness(env: {
  MINIMAX_API_KEY?: string | null;
  LOVABLE_API_KEY?: string | null;
  DEEPSEEK_API_KEY?: string | null;
  SUPABASE_URL?: string | null;
  SUPABASE_SERVICE_ROLE_KEY?: string | null;
  SUPABASE_ANON_KEY?: string | null;
  OATHNET_API_KEY?: string | null;
  SYNAPSINT_API_KEY?: string | null;
  OSINTNOVA_API_KEY?: string | null;
  SOCIALFETCH_API_KEY?: string | null;
  CORDCAT_API_KEY?: string | null;
  HUNTER_API_KEY?: string | null;
  INTELBASE_API_KEY?: string | null;
  HIBP_API_KEY?: string | null;
  EXA_API_KEY?: string | null;
  FIRECRAWL_API_KEY?: string | null;
  SERUS_API_KEY?: string | null;
  IPQUALITYSCORE_API_KEY?: string | null;
  GITHUB_API_TOKEN?: string | null;
  PERPLEXITY_API_KEY?: string | null;
  RAPIDAPI_KEY?: string | null;
  OPENCORPORATES_API_KEY?: string | null;
  RANSOMWARELIVE_API_KEY?: string | null;
  URLSCANNER_API_KEY?: string | null;
}): { ok: boolean; checks: Record<string, { ok: boolean; detail?: string; reason?: string }> } {
  const has = (v: string | null | undefined) => !!(v && v.length > 0);
  // Any configured orchestrator provider satisfies readiness — not just
  // MiniMax/Lovable. DeepSeek is now the default PRIMARY when configured (see
  // orchestrator_select.ts); without DEEPSEEK_API_KEY here, unsetting
  // MINIMAX_API_KEY (now a secondary/fallback-only key) would report the whole
  // function unhealthy even though it's fully functional on DeepSeek.
  const orchestratorOk = has(env.MINIMAX_API_KEY) || has(env.LOVABLE_API_KEY) || has(env.DEEPSEEK_API_KEY);
  const coreOk = has(env.SUPABASE_URL) && has(env.SUPABASE_SERVICE_ROLE_KEY) && has(env.SUPABASE_ANON_KEY);
  const tools = {
    oathnet: has(env.OATHNET_API_KEY),
    synapsint: has(env.SYNAPSINT_API_KEY),
    osintnova: has(env.OSINTNOVA_API_KEY),
    socialfetch: has(env.SOCIALFETCH_API_KEY),
    cordcat: has(env.CORDCAT_API_KEY),
    hunter: has(env.HUNTER_API_KEY),
    intelbase: has(env.INTELBASE_API_KEY), // note: gated by INTELBASE_ENABLED at runtime
    hibp: has(env.HIBP_API_KEY),
    exa: has(env.EXA_API_KEY),
    firecrawl: has(env.FIRECRAWL_API_KEY),
    serus: has(env.SERUS_API_KEY),
    ipqualityscore: has(env.IPQUALITYSCORE_API_KEY),
    github: has(env.GITHUB_API_TOKEN),
    perplexity: has(env.PERPLEXITY_API_KEY),
    rapidapi_breach: has(env.RAPIDAPI_KEY),
    opencorporates: has(env.OPENCORPORATES_API_KEY),
    ransomwarelive: has(env.RANSOMWARELIVE_API_KEY),
    urlscanner: has(env.URLSCANNER_API_KEY),
  };
  const enabledOptional = Object.values(tools).filter(Boolean).length;
  const checks: Record<string, { ok: boolean; detail?: string; reason?: string }> = {
    orchestrator: orchestratorOk
      ? { ok: true }
      : { ok: false, detail: "Set DEEPSEEK_API_KEY, MINIMAX_API_KEY, or LOVABLE_API_KEY in Supabase secrets" },
    core: coreOk
      ? { ok: true }
      : { ok: false, detail: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY missing" },
    tools: {
      ok: true, // optional tools are never required
      detail: `${enabledOptional}/${Object.keys(tools).length} optional tool APIs configured`,
    },
  };
  return { ok: orchestratorOk && coreOk, checks };
}

export function isHealthProbe(req: Request): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  try {
    const u = new URL(req.url);
    return u.searchParams.get("health") === "1";
  } catch {
    return false;
  }
}

export async function handleHealthProbe(req: Request): Promise<Response> {
  const r = deriveReadiness({
    MINIMAX_API_KEY, LOVABLE_API_KEY, DEEPSEEK_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    SUPABASE_ANON_KEY,
    OATHNET_API_KEY, SYNAPSINT_API_KEY, OSINTNOVA_API_KEY, SOCIALFETCH_API_KEY,
    CORDCAT_API_KEY, HUNTER_API_KEY, INTELBASE_API_KEY, HIBP_API_KEY, EXA_API_KEY,
    FIRECRAWL_API_KEY, SERUS_API_KEY, IPQUALITYSCORE_API_KEY, GITHUB_API_TOKEN, PERPLEXITY_API_KEY,
    OPENCORPORATES_API_KEY, RANSOMWARELIVE_API_KEY,
    URLSCANNER_API_KEY,
    RAPIDAPI_KEY: Deno.env.get("RAPIDAPI_KEY"),
  });
  const u = new URL(req.url);
  const wantProbe = u.searchParams.get("probe") === "1";

  // checks.minimax: live reachability of the primary orchestrator (bounded 5s;
  // warm-isolate cache short-circuits the paid ping). Extends the existing
  // checks contract — orchestrator/core/tools keep their exact prior semantics,
  // and overall ok/status is deliberately NOT coupled to this check (a MiniMax
  // blip degrades to the Gemini fallback; it does not make the function "down").
  r.checks.minimax = await checkMinimax();
  // checks.deepseek: same contract, for the now-default primary orchestrator.
  // Reported unconditionally (key-not-configured → ok:false reason:missing_key)
  // so operators can see at a glance whether DeepSeek is actually reachable,
  // not just whether MiniMax (its secondary/fallback) is.
  r.checks.deepseek = await checkDeepseek();

  if (wantProbe) {
    const supplied = req.headers.get("x-probe-secret") ?? "";
    if (!OSINT_AGENT_PROBE_SECRET || supplied !== OSINT_AGENT_PROBE_SECRET) {
      return new Response(
        JSON.stringify({ ok: false, error: "unauthorized" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }
  }

  type ProbeResult = { ok: boolean; latencyMs: number; error?: string };
  const providers: Record<string, ProbeResult> = {};
  if (wantProbe) {
    const PROBE_TIMEOUT_MS = 8000;
    const probeProvider = async (
      name: string,
      hasKey: boolean,
      fn: (signal: AbortSignal) => Promise<{ ok: boolean; status: number }>,
    ): Promise<ProbeResult> => {
      if (!hasKey) return { ok: false, latencyMs: 0, error: "key_not_configured" };
      const t0 = Date.now();
      const ctrl = new AbortController();
      // Hard 8s cap: race the provider call against a timeout that both aborts
      // the in-flight request (bare fetches honor ctrl.signal) AND resolves a
      // bounded result — so a stalled paid probe can never hang the health
      // response (e.g. MiniMax's own 45s internal timeout, or a hung gateway).
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<ProbeResult>((resolve) => {
        timer = setTimeout(() => {
          ctrl.abort();
          resolve({ ok: false, latencyMs: Date.now() - t0, error: "timeout" });
        }, PROBE_TIMEOUT_MS);
      });
      try {
        return await Promise.race([
          fn(ctrl.signal).then((res) => ({
            ok: res.ok,
            latencyMs: Date.now() - t0,
            ...(res.ok ? {} : { error: `status=${res.status}` }),
          })),
          timeout,
        ]);
      } catch {
        return { ok: false, latencyMs: Date.now() - t0, error: "unreachable" };
      } finally {
        clearTimeout(timer);
      }
    };
    const [mm, lov, gk, ds] = await Promise.all([
      probeProvider("minimax", !!MINIMAX_API_KEY, (signal) => minimaxChat({ user: "ping", maxTokens: 4, temperature: 0, signal })),
      probeProvider("lovable", !!LOVABLE_API_KEY, async (signal) => {
        const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: { "Lovable-API-Key": LOVABLE_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ model: FALLBACK_MODEL_ID, messages: [{ role: "user", content: "ping" }], max_tokens: 4 }),
          signal,
        });
        return { ok: res.ok, status: res.status };
      }),
      probeProvider("grok", !!XAI_API_KEY, async (signal) => {
        const res = await fetch("https://api.x.ai/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${XAI_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: GROK_ORCHESTRATOR_MODEL_ID, messages: [{ role: "user", content: "ping" }], max_tokens: 4 }),
          signal,
        });
        return { ok: res.ok, status: res.status };
      }),
      probeProvider("deepseek", !!DEEPSEEK_API_KEY, async (signal) => {
        const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: DEEPSEEK_ORCHESTRATOR_MODEL_ID, messages: [{ role: "user", content: "ping" }], max_tokens: 4 }),
          signal,
        });
        return { ok: res.ok, status: res.status };
      }),
    ]);
    providers.minimax = mm;
    providers.lovable = lov;
    providers.grok = gk;
    providers.deepseek = ds;
  }
  const body: Record<string, unknown> = {
    ok: r.ok,
    service: "osint-agent",
    version: "1.2.2",
    // Build marker derives from the git short SHA (scripts/stamp-build.mjs) so a
    // deployed function is verifiable against source. Compare this to recent
    // `git log` to detect deploy drift. build_committed_at gives the commit date.
    build: BUILD_MARKER,
    build_committed_at: BUILD_COMMITTED_AT,
    checks: r.checks,
    intelbase_enabled: INTELBASE_ENABLED,
  };
  if (wantProbe) body.providers = providers;
  return new Response(
    req.method === "HEAD" ? null : JSON.stringify(body),
    {
      status: r.ok ? 200 : 503,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    },
  );
}
