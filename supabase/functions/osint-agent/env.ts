/**
 * env.ts — Environment bindings, degraded-tools state, and fetch helpers.
 * Extracted from index.ts (lines 17–132).
 *
 * ── LOGGING POLICY (audit F-B1) ─────────────────────────────────────
 * console.log/warn in Deno edge functions ends up in Supabase function
 * logs (retained 30 days by default). For an investigation platform this
 * is a PII / chain-of-custody risk.
 *
 *   DO log:  tool names, statuses, error codes, scan IDs, durations,
 *            circuit-breaker state transitions, cost counters.
 *   DON'T log: user-supplied seeds, raw request bodies, full API
 *              responses, breach contents, extracted PII, JWTs, keys.
 *   Mask when in doubt: `seed.slice(0,3) + "***" + seed.slice(-2)`.
 * ────────────────────────────────────────────────────────────────────
 */

import { createOpenAICompatible } from "npm:@ai-sdk/openai-compatible@1";

// ---- CORS headers ------------------------------------------------------------
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ---- Supabase / core secrets ------------------------------------------------
export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

/**
 * Anon (publishable) key — used to build the *user-scoped* Supabase client
 * in auth.ts so that RLS policies (`auth.uid() = user_id`) are actually
 * enforced. Service-role key bypasses RLS entirely, so we must NOT use it
 * for normal user work. Set via:
 *   supabase secrets set SUPABASE_ANON_KEY=*** --env production
 *
 * The anon key is the same one shipped to the frontend
 * (`VITE_SUPABASE_PUBLISHABLE_KEY`). It is safe to use server-side as long
 * as the edge function itself verifies the user's JWT and passes it in
 * the Authorization header (which `createClient` does when you pass the
 * user's session token in `global.headers.Authorization`).
 */
export const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
export const MINIMAX_API_KEY = Deno.env.get("MINIMAX_API_KEY")!;
export const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY") ?? "";

// Lovable AI Gateway provider — used as a fallback when MiniMax hits its
// context-window limit on long-running investigations. Gemini's context window
// is dramatically larger, so the orchestrator can keep reasoning over a full
// fan-out history without truncation.
export const lovableGateway = LOVABLE_API_KEY
  ? createOpenAICompatible({
      name: "lovable-ai-gateway",
      baseURL: "https://ai.gateway.lovable.dev/v1",
      headers: {
        "Lovable-API-Key": LOVABLE_API_KEY,
        "X-Lovable-AIG-SDK": "vercel-ai-sdk",
      },
    })
  : null;

// Primary orchestrator model: MiniMax-M2.7 (user's Max token plan, 15k req/5h).
// Context overflows are mitigated by the aggressive per-step trimmer below.
export const PRIMARY_ORCHESTRATOR_MODEL_ID = "MiniMax-M2.7";
// Lovable Gateway model used only if MiniMax key is missing.
export const FALLBACK_MODEL_ID = "google/gemini-2.5-pro";

// ---- Tranche 2: env-gated alternative orchestrator providers -----------------
// These let an operator move the top-level orchestrator/synthesis turn off
// MiniMax WITHOUT a code change. Both are null unless their keys are set, so the
// default selection (see orchestrator_select.ts) stays MiniMax and behavior is
// unchanged. Activate via Supabase secrets — never the repo.
export const XAI_API_KEY = Deno.env.get("XAI_API_KEY") ?? "";
export const OPENADAPTER_API_KEY = Deno.env.get("OPENADAPTER_API_KEY") ?? "";
export const OPENADAPTER_BASE_URL = Deno.env.get("OPENADAPTER_BASE_URL") ?? "";
/** Operator override pinning the primary orchestrator provider. */
export const ORCHESTRATOR_PROVIDER = (Deno.env.get("ORCHESTRATOR_PROVIDER") ?? "").trim().toLowerCase();
/** Orchestrator model IDs for the alternative providers (overridable).
 * Default grok-4.3 = xAI's current flagship (leads on non-hallucination rate +
 * agentic tool calling — the right properties for OSINT synthesis). Override
 * with GROK_ORCHESTRATOR_MODEL_ID if xAI's lineup changes. */
export const GROK_ORCHESTRATOR_MODEL_ID = Deno.env.get("GROK_ORCHESTRATOR_MODEL_ID") ?? "grok-4.3";
export const OPENADAPTER_ORCHESTRATOR_MODEL_ID = Deno.env.get("OPENADAPTER_ORCHESTRATOR_MODEL_ID") ?? "";

// xAI Grok — OpenAI-compatible chat completions at api.x.ai.
export const grokGateway = XAI_API_KEY
  ? createOpenAICompatible({
      name: "xai-grok",
      baseURL: "https://api.x.ai/v1",
      headers: { Authorization: `Bearer ${XAI_API_KEY}` },
    })
  : null;

// OpenAdapter — operator-supplied OpenAI-compatible gateway (base URL required).
export const openAdapterGateway = (OPENADAPTER_API_KEY && OPENADAPTER_BASE_URL)
  ? createOpenAICompatible({
      name: "openadapter",
      baseURL: OPENADAPTER_BASE_URL,
      headers: { Authorization: `Bearer ${OPENADAPTER_API_KEY}` },
    })
  : null;

// ---- External API keys -------------------------------------------------------
export const OATHNET_API_KEY = Deno.env.get("OATHNET_API_KEY");
export const SYNAPSINT_API_KEY = Deno.env.get("SYNAPSINT_API_KEY");
// OSINTNOVA (Bosint) — email + phone modules only. The username module
// is intentionally NOT wired here: it scans 3000+ sites synchronously
// and routinely takes 60+s, which times out the edge function. Use
// `username_sweep` (local Sherlock-style) for usernames instead.
export const OSINTNOVA_API_KEY = Deno.env.get("OSINTNOVA_API_KEY");
export const SOCIALFETCH_API_KEY = Deno.env.get("SOCIALFETCH_API_KEY");
export const CORDCAT_API_KEY = Deno.env.get("CORDCAT_API_KEY");
export const HUNTER_API_KEY = Deno.env.get("HUNTER_API_KEY");
export const INTELBASE_API_KEY = Deno.env.get("INTELBASE_API_KEY");
// IntelBase is currently DISABLED at the tool level — recent health check
// showed 33% OK rate. Re-enable by flipping this flag once provider is healthy.
export const INTELBASE_ENABLED = false;
export const HIBP_API_KEY = Deno.env.get("HIBP_API_KEY");
export const GITHUB_API_TOKEN = Deno.env.get("GITHUB_API_TOKEN") ?? Deno.env.get("GITHUB_TOKEN");
export const FIRECRAWL_API_KEY = Deno.env.get("FIRECRAWL_API_KEY");
export const EXA_API_KEY = Deno.env.get("EXA_API_KEY");
export const JINA_API_KEY = Deno.env.get("JINA_API_KEY"); // optional — r.jina.ai works unauth too
// Serus darkweb scan API. Bearer auth, 0.25 credits/scan, 3 req/s write budget.
// Optional `reveal=true` query param unlocks unmasked breach fields
// (passwords, tokens) when the key has the `darkweb:reveal` scope.
export const SERUS_API_KEY = Deno.env.get("SERUS_API_KEY");

// ---- Degraded state ----------------------------------------------------------
// Sticky flag — once Firecrawl returns 402 (insufficient credits) we stop
// touching it for the rest of this invocation and route through Jina + Exa.
export let firecrawlCreditsLow = false;
export function markFirecrawlCreditsLow(where: string) {
  if (!firecrawlCreditsLow) {
    firecrawlCreditsLow = true;
    console.warn(`Firecrawl credits low — using Jina Reader + Exa fallback (tripped at ${where})`);
  }
}
export function resetFirecrawlCreditsLow() { firecrawlCreditsLow = false; }

// Sticky per-thread degraded-tools set. Any tool that 500s twice in a row, or
// that the caller manually marks, short-circuits with a uniform error for the
// rest of the invocation. Prevents the agent from burning cost + time on a
// provider that's already proven dead this run.
export const degradedTools = new Set<string>();
export function markToolDegraded(name: string, reason: string) {
  if (!degradedTools.has(name)) {
    degradedTools.add(name);
    console.warn(`[degraded] ${name} disabled for this thread: ${reason}`);
  }
}
export function isDegraded(name: string): { error: string; degraded: true } | null {
  if (degradedTools.has(name)) {
    return { error: `${name} degraded this run — skipped`, degraded: true };
  }
  return null;
}

// ---- Dead-host tracking ------------------------------------------------------
// Hosts proven not to resolve (NXDOMAIN / DNS failure) this run. Live-host
// tools (http_fingerprint, jina_reader_scrape, deepfind_ssl_inspect,
// deepfind_tech_stack) skip a known-dead host instead of re-collecting the
// same DNS failure every fan-out round (observed on a seized doxbin.net seed).
export const deadHosts = new Set<string>();
export function normalizeHost(input: string): string {
  const raw = (input ?? "").trim().toLowerCase();
  if (!raw) return "";
  let host: string;
  try { host = new URL(raw.includes("://") ? raw : `http://${raw}`).hostname; }
  catch { host = raw.replace(/^https?:\/\//, "").split("/")[0] ?? ""; }
  // Exact host match only — do NOT fold www.host into host. They can resolve
  // independently (apex-only / www-only sites), so conflating them would let a
  // dead www. wrongly gate live-host tools on the live apex (and vice versa).
  return host;
}
export function markHostDead(input: string, reason: string) {
  const host = normalizeHost(input);
  if (host && !deadHosts.has(host)) {
    deadHosts.add(host);
    console.warn(`[dead-host] ${host} unresolvable this thread: ${reason}`);
  }
}
export function isHostDead(input: string): boolean {
  const host = normalizeHost(input);
  return !!host && deadHosts.has(host);
}

// ---- Additional API keys -----------------------------------------------------
export const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
export const OSINT_NAVIGATOR_API_KEY = Deno.env.get("OSINT_NAVIGATOR_API_KEY");
export const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");

// ---- fetchRetry (re-exported from fetch_retry.ts) ---------------------------
// Kept as a re-export so existing `import { fetchRetry } from "./env.ts"`
// call sites (7 tool files) continue to work without a sweeping rename.
// New code should import from "./fetch_retry.ts" directly to avoid pulling
// in this file's `npm:@ai-sdk/openai-compatible@1` import.
export { fetchRetry, fetchT } from "./fetch_retry.ts";
