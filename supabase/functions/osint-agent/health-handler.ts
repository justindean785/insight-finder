import {
  corsHeaders, MINIMAX_API_KEY, LOVABLE_API_KEY, SUPABASE_URL, SERVICE_KEY,
  OATHNET_API_KEY, SYNAPSINT_API_KEY, OSINTNOVA_API_KEY, SOCIALFETCH_API_KEY,
  CORDCAT_API_KEY, HUNTER_API_KEY, INTELBASE_API_KEY, INTELBASE_ENABLED,
  HIBP_API_KEY, EXA_API_KEY, FIRECRAWL_API_KEY, SERUS_API_KEY,
  GITHUB_API_TOKEN, PERPLEXITY_API_KEY, IPQUALITYSCORE_API_KEY,
  OPENCORPORATES_API_KEY, RANSOMWARELIVE_API_KEY,
  XAI_API_KEY, GROK_ORCHESTRATOR_MODEL_ID,
  OSINT_AGENT_PROBE_SECRET,
} from "./env.ts";
import { minimaxChat } from "./providers.ts";

function deriveReadiness(env: {
  MINIMAX_API_KEY?: string | null;
  LOVABLE_API_KEY?: string | null;
  SUPABASE_URL?: string | null;
  SUPABASE_SERVICE_ROLE_KEY?: string | null;
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
  OPENCORPORATES_API_KEY?: string | null;
  RANSOMWARELIVE_API_KEY?: string | null;
}): { ok: boolean; checks: Record<string, { ok: boolean; detail?: string }> } {
  const has = (v: string | null | undefined) => !!(v && v.length > 0);
  const orchestratorOk = has(env.MINIMAX_API_KEY) || has(env.LOVABLE_API_KEY);
  const coreOk = has(env.SUPABASE_URL) && has(env.SUPABASE_SERVICE_ROLE_KEY);
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
    opencorporates: has(env.OPENCORPORATES_API_KEY),
    ransomwarelive: has(env.RANSOMWARELIVE_API_KEY),
  };
  const enabledOptional = Object.values(tools).filter(Boolean).length;
  const checks: Record<string, { ok: boolean; detail?: string }> = {
    orchestrator: orchestratorOk
      ? { ok: true }
      : { ok: false, detail: "Set MINIMAX_API_KEY or LOVABLE_API_KEY in Supabase secrets" },
    core: coreOk
      ? { ok: true }
      : { ok: false, detail: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing" },
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
    MINIMAX_API_KEY, LOVABLE_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    OATHNET_API_KEY, SYNAPSINT_API_KEY, OSINTNOVA_API_KEY, SOCIALFETCH_API_KEY,
    CORDCAT_API_KEY, HUNTER_API_KEY, INTELBASE_API_KEY, HIBP_API_KEY, EXA_API_KEY,
    FIRECRAWL_API_KEY, SERUS_API_KEY, IPQUALITYSCORE_API_KEY, GITHUB_API_TOKEN, PERPLEXITY_API_KEY,
    OPENCORPORATES_API_KEY, RANSOMWARELIVE_API_KEY,
  });
  const u = new URL(req.url);
  const wantProbe = u.searchParams.get("probe") === "1";

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
    const [mm, lov, gk] = await Promise.all([
      probeProvider("minimax", !!MINIMAX_API_KEY, (signal) => minimaxChat({ user: "ping", maxTokens: 4, temperature: 0, signal })),
      probeProvider("lovable", !!LOVABLE_API_KEY, async (signal) => {
        const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: { "Lovable-API-Key": LOVABLE_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({ model: "google/gemini-2.5-pro", messages: [{ role: "user", content: "ping" }], max_tokens: 4 }),
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
    ]);
    providers.minimax = mm;
    providers.lovable = lov;
    providers.grok = gk;
  }
  const body: Record<string, unknown> = {
    ok: r.ok,
    service: "osint-agent",
    version: "1.2.1",
    build: "2026-06-19-probe-hardening",
    checks: r.checks,
    intelbase_enabled: INTELBASE_ENABLED,
  };
  if (wantProbe) body.providers = providers;
  return new Response(
    req.method === "HEAD" ? null : JSON.stringify(body),
    {
      status: 200,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    },
  );
}
