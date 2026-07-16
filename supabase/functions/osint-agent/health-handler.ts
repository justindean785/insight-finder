import {
  corsHeaders, MINIMAX_API_KEY, SUPABASE_URL, SERVICE_KEY, SUPABASE_ANON_KEY,
  OATHNET_API_KEY, SYNAPSINT_API_KEY, OSINTNOVA_API_KEY, SOCIALFETCH_API_KEY,
  CORDCAT_API_KEY, HUNTER_API_KEY, INTELBASE_API_KEY, INTELBASE_ENABLED,
  HIBP_API_KEY, EXA_API_KEY, FIRECRAWL_API_KEY, SERUS_API_KEY,
  GITHUB_API_TOKEN, PERPLEXITY_API_KEY, IPQUALITYSCORE_API_KEY,
  OPENCORPORATES_API_KEY, RANSOMWARELIVE_API_KEY,
  URLSCANNER_API_KEY, GEMINI_FALLBACK_MODEL_ID,
  XAI_API_KEY, GROK_ORCHESTRATOR_MODEL_ID,
  OSINT_AGENT_PROBE_SECRET,
  DEEPSEEK_API_KEY, DEEPSEEK_ORCHESTRATOR_MODEL_ID, PRIMARY_ORCHESTRATOR_MODEL_ID,
  ORCHESTRATOR_PROVIDER, LOVABLE_API_KEY, OPENADAPTER_API_KEY, OPENADAPTER_BASE_URL,
} from "./env.ts";
import { minimaxChat, markMinimaxHealthy, minimaxHealthyWithin } from "./providers.ts";
import { selectOrchestratorProvider, type OrchestratorProvider } from "./orchestrator_select.ts";
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

// ---- checks.deepseek — is the SELECTED-by-default primary orchestrator reachable?
// DeepSeek is the lead orchestrator when DEEPSEEK_API_KEY is set (orchestrator_select.ts),
// so a plain ?health=1 must be able to confirm DeepSeek itself answers — independently
// of checks.minimax, so a healthy MiniMax fallback can NOT mask a DeepSeek outage. The
// probe pings deepseek in NON-THINKING mode (`thinking:{type:"disabled"}`) — the same
// shape the live orchestrator uses — so the canary matches production and stays cheap.
// Reported UNCONDITIONALLY (missing key → ok:false reason:missing_key) so operators can
// always see whether DeepSeek is actually configured + reachable.
export type DeepseekCheck = {
  ok: boolean;
  reason?: "missing_key" | "preflight_failed" | "timeout";
  detail?: string;
};

export async function checkDeepseek(deps?: {
  hasKey?: boolean;
  apiKey?: string;
  model?: string;
  doFetch?: typeof fetch;
}): Promise<DeepseekCheck> {
  const hasKey = deps?.hasKey ?? !!DEEPSEEK_API_KEY;
  if (!hasKey) {
    // Config regression when DeepSeek is the intended primary — error-level so it
    // can't hide behind a quietly-working MiniMax fallback.
    console.error("[health] DEEPSEEK_API_KEY is not configured — checks.deepseek reason=missing_key");
    return { ok: false, reason: "missing_key" };
  }
  const apiKey = deps?.apiKey ?? DEEPSEEK_API_KEY;
  const model = deps?.model ?? DEEPSEEK_ORCHESTRATOR_MODEL_ID;
  const doFetch = deps?.doFetch ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_000);
  try {
    const res = await doFetch("https://api.deepseek.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 4,
        temperature: 0,
        // Non-thinking canary: match the live orchestrator's request shape and keep
        // the paid health ping to a single cheap token.
        thinking: { type: "disabled" },
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

// Resolve which orchestrator provider is ACTUALLY selected at runtime + its model,
// using the same pure selector index.ts uses — so the health endpoint reports the
// live truth (not a hardcoded guess). Pure; env is injected for testability.
export function resolveSelectedOrchestrator(env?: {
  pin?: string;
  deepseek?: boolean;
  minimax?: boolean;
  grok?: boolean;
  openadapter?: boolean;
}): { provider: OrchestratorProvider; reason: string; model: string } {
  const choice = selectOrchestratorProvider({
    pin: env?.pin ?? ORCHESTRATOR_PROVIDER,
    deepseek: env?.deepseek ?? !!DEEPSEEK_API_KEY,
    minimax: env?.minimax ?? !!MINIMAX_API_KEY,
    grok: env?.grok ?? !!XAI_API_KEY,
    openadapter: env?.openadapter ?? !!(OPENADAPTER_API_KEY && OPENADAPTER_BASE_URL),
  });
  const model =
    choice.provider === "deepseek" ? DEEPSEEK_ORCHESTRATOR_MODEL_ID :
    choice.provider === "grok" ? GROK_ORCHESTRATOR_MODEL_ID :
    choice.provider === "minimax" ? PRIMARY_ORCHESTRATOR_MODEL_ID :
    "";
  return { provider: choice.provider, reason: choice.reason, model };
}

// Role of a provider's diagnostic RELATIVE to the live selection: only the selected
// provider is "active"; every other configured provider is a "fallback" diagnostic.
// So MiniMax is labeled "fallback" (never "active") whenever DeepSeek is selected.
export function providerRole(
  selected: OrchestratorProvider,
  provider: OrchestratorProvider,
): "active" | "fallback" {
  return selected === provider ? "active" : "fallback";
}

// The orchestrator readiness gate, keyed on the SELECTED provider — symmetric by
// construction, so it can both FAIL a deployment whose active provider has no key and
// PASS one whose active provider is keyed but whose (unused) MiniMax fallback is not.
// Pure so both directions are unit-testable without env or network.
export function orchestratorGate(
  provider: OrchestratorProvider,
  keyPresent: boolean,
  coreOk: boolean,
): { check: { ok: boolean; detail?: string; reason?: string }; ok: boolean } {
  const check = keyPresent
    ? { ok: true }
    : {
      ok: false,
      detail: `selected orchestrator "${provider}" has no API key configured`,
      reason: "missing_key",
    };
  // Mirrors deriveReadiness's contract (orchestrator && core decide ok; tools do not),
  // with the orchestrator term now answering "is the ACTIVE provider usable?".
  return { check, ok: keyPresent && coreOk };
}

export function deriveReadiness(env: {
  MINIMAX_API_KEY?: string | null;
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
}): { ok: boolean; checks: Record<string, { ok: boolean; detail?: string; reason?: string; role?: "active" | "fallback" }> } {
  const has = (v: string | null | undefined) => !!(v && v.length > 0);
  const orchestratorOk = has(env.MINIMAX_API_KEY);
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
  const checks: Record<string, { ok: boolean; detail?: string; reason?: string; role?: "active" | "fallback" }> = {
    orchestrator: orchestratorOk
      ? { ok: true }
      : { ok: false, detail: "Set MINIMAX_API_KEY in Supabase secrets" },
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
    MINIMAX_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
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

  // Which provider is ACTUALLY selected at runtime (same pure selector index.ts
  // uses) + its model. This is the DeepSeek STOP-gate signal: selected_provider tells
  // an operator at a glance whether DeepSeek — not MiniMax — is the live orchestrator.
  const selected = resolveSelectedOrchestrator();

  // Probe DeepSeek (now-default primary when keyed) AND MiniMax in parallel so the
  // health response stays bounded. checks.deepseek is reported UNCONDITIONALLY and is
  // INDEPENDENT of checks.minimax — a healthy MiniMax fallback can never mask a
  // DeepSeek key-missing / probe failure.
  const [deepseekCheck, minimaxCheck] = await Promise.all([
    checkDeepseek(),
    checkMinimax(),
  ]);
  // Role labels: only the SELECTED provider is "active"; the other is a "fallback"
  // diagnostic. So MiniMax is never labeled active when DeepSeek is selected.
  r.checks.deepseek = { ...deepseekCheck, role: providerRole(selected.provider, "deepseek") };
  r.checks.minimax = { ...minimaxCheck, role: providerRole(selected.provider, "minimax") };

  // Re-gate the orchestrator check on the SELECTED provider's key, in BOTH directions.
  // deriveReadiness() still hardcodes orchestrator := has(MINIMAX_API_KEY) (its pure
  // unit tests pin that), which is now the wrong question: MiniMax is the FALLBACK once
  // DeepSeek is selected. A one-directional override would be a false NEGATIVE — drop
  // MINIMAX_API_KEY on a healthy DeepSeek-only deployment and the function would report
  // itself down. So the gate is symmetric: the selected provider's key decides, and
  // overall ok is recomputed from it (core is the other hard requirement; tools are not).
  // Losing the MiniMax fallback is NOT hidden by this — it still surfaces as
  // checks.minimax {ok:false, reason:"missing_key", role:"fallback"}.
  const selectedKeyPresent =
    selected.provider === "deepseek" ? !!DEEPSEEK_API_KEY :
    selected.provider === "minimax" ? !!MINIMAX_API_KEY :
    selected.provider === "grok" ? !!XAI_API_KEY :
    selected.provider === "openadapter" ? !!(OPENADAPTER_API_KEY && OPENADAPTER_BASE_URL) :
    (!!MINIMAX_API_KEY || !!LOVABLE_API_KEY);
  const gate = orchestratorGate(selected.provider, selectedKeyPresent, r.checks.core?.ok === true);
  r.checks.orchestrator = gate.check;
  r.ok = gate.ok;
  // Active-provider reachability, surfaced separately (visible) without coupling the
  // 200/503 status to a transient probe blip — a failed probe on a keyed provider still
  // has the MiniMax fallback, matching the existing MiniMax-blip philosophy.
  const activeCheck = selected.provider === "deepseek" ? deepseekCheck
    : selected.provider === "minimax" ? minimaxCheck : null;
  const orchestratorActiveOk = activeCheck ? activeCheck.ok : selectedKeyPresent;

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
    const [ds, mm, gk, gm] = await Promise.all([
      probeProvider("deepseek", !!DEEPSEEK_API_KEY, async (signal) => {
        const res = await fetch("https://api.deepseek.com/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${DEEPSEEK_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: DEEPSEEK_ORCHESTRATOR_MODEL_ID,
            messages: [{ role: "user", content: "ping" }],
            max_tokens: 4,
            thinking: { type: "disabled" },
          }),
          signal,
        });
        return { ok: res.ok, status: res.status };
      }),
      probeProvider("minimax", !!MINIMAX_API_KEY, (signal) => minimaxChat({ user: "ping", maxTokens: 4, temperature: 0, signal })),
      probeProvider("grok", !!XAI_API_KEY, async (signal) => {
        const res = await fetch("https://api.x.ai/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${XAI_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: GROK_ORCHESTRATOR_MODEL_ID, messages: [{ role: "user", content: "ping" }], max_tokens: 4 }),
          signal,
        });
        return { ok: res.ok, status: res.status };
      }),
      probeProvider("gemini", !!Deno.env.get("GEMINI_API_KEY"), async (signal) => {
        const res = await fetch("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${Deno.env.get("GEMINI_API_KEY")}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: GEMINI_FALLBACK_MODEL_ID, messages: [{ role: "user", content: "ping" }], max_tokens: 4 }),
          signal,
        });
        return { ok: res.ok, status: res.status };
      }),
    ]);
    providers.deepseek = ds;
    providers.minimax = mm;
    providers.grok = gk;
    providers.gemini = gm;
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
    // The live orchestrator selection — the DeepSeek STOP-gate signal.
    selected_provider: selected.provider,
    selected_model: selected.model,
    orchestrator_reason: selected.reason,
    orchestrator_active_ok: orchestratorActiveOk,
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
