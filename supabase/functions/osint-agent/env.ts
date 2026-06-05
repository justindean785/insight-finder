/**
 * env.ts — Environment bindings, degraded-tools state, and fetch helpers.
 * Extracted from index.ts (lines 17–132).
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

// ---- Additional API keys -----------------------------------------------------
export const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
export const OSINT_NAVIGATOR_API_KEY = Deno.env.get("OSINT_NAVIGATOR_API_KEY");
export const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");

// ---- fetchRetry --------------------------------------------------------------
// Small fetch helper with exponential backoff on 429/5xx. Used for any
// external API where transient throttling is common (Exa, Firecrawl, etc.).
export async function fetchRetry(
  url: string,
  init: RequestInit,
  opts: { retries?: number; baseDelayMs?: number } = {},
): Promise<Response> {
  const retries = opts.retries ?? 2;
  const base = opts.baseDelayMs ?? 400;
  let lastErr: unknown;
  const signal = (init as { signal?: AbortSignal }).signal;
  for (let attempt = 0; attempt <= retries; attempt++) {
    // If an externally-supplied AbortSignal already fired (e.g. a per-call
    // timeout tripped between retries), stop spinning instead of issuing a
    // pointless next request.
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const r = await fetch(url, init);
      if (r.status === 429 || (r.status >= 500 && r.status < 600)) {
        if (attempt < retries) {
          await new Promise((res) => setTimeout(res, base * Math.pow(2, attempt)));
          continue;
        }
      }
      return r;
    } catch (e) {
      lastErr = e;
      if (attempt < retries) {
        await new Promise((res) => setTimeout(res, base * Math.pow(2, attempt)));
        continue;
      }
      throw e;
    }
  }
  throw lastErr ?? new Error("fetchRetry exhausted");
}
