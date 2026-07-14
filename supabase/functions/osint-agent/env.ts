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
import { MODELS } from "./models.ts";
import { createIdleTimeoutFetch } from "./fetch_retry.ts";

// Every orchestrator LLM provider (minimax, xai-grok, openadapter, gemini-direct)
// is built via createOpenAICompatible with this as its `fetch`.
// Without it, a stalled stream (upstream opens the connection then goes silent
// mid-generation) hangs streamText() forever: stopWhen's wall-clock deadline is
// only evaluated BETWEEN completed steps, so a step whose model call never
// resolves is never interrupted — the thread stays "active" and the UI sits
// frozen on the last tool label with no recovery (see fetch_retry.ts).
//
// 90s, not the tighter 45s minimaxChat() uses for a small complete call:
// MiniMax-M2.7 is a reasoning model that can go quiet for a while mid-thought
// before its first output chunk, especially on a large prompt or a hard
// tool-call decision — and because this is an IDLE timeout (resets on every
// chunk, not a flat cap), a legitimately long multi-minute completion is
// never punished, only true silence is. MiniMax is the default/near-always
// orchestrator provider, so a false-abort here ends a run early; start
// generous and tighten only once inter-chunk-gap telemetry justifies it.
export const ORCHESTRATOR_STALL_TIMEOUT_MS = 90_000;
export const ORCHESTRATOR_FETCH = createIdleTimeoutFetch(ORCHESTRATOR_STALL_TIMEOUT_MS);

// ---- CORS headers ------------------------------------------------------------
export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
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

// Lovable AI Gateway provider — LAST-RESORT fallback only, and only when the
// operator explicitly opts in via ALLOW_LOVABLE_FALLBACK=true (or pins it as
// primary with ORCHESTRATOR_PROVIDER=lovable). The gateway proxies through
// Lovable's shared quota and has burned runs on credit-gated models before;
// the default fallback is the DIRECT Gemini API below.
export const ALLOW_LOVABLE_FALLBACK =
  (Deno.env.get("ALLOW_LOVABLE_FALLBACK") ?? "").trim().toLowerCase() === "true";
export const lovableGateway = LOVABLE_API_KEY
  ? createOpenAICompatible({
      name: "lovable-ai-gateway",
      baseURL: "https://ai.gateway.lovable.dev/v1",
      headers: {
        "Lovable-API-Key": LOVABLE_API_KEY,
        "X-Lovable-AIG-SDK": "vercel-ai-sdk",
      },
      fetch: ORCHESTRATOR_FETCH,
    })
  : null;

// Direct Google Gemini — the DEFAULT orchestrator fallback when MiniMax is
// unavailable / preflight-fails / would overflow. Uses Google's OpenAI-compatible
// endpoint so it plugs into the same createOpenAICompatible plumbing as every
// other provider. Keyed by GEMINI_API_KEY (already used by geminiGroundedSearch);
// model is a GA flash SKU, overridable via GEMINI_FALLBACK_MODEL_ID. Preview
// (gemini-3-*-preview) and retired (gemini-2.0-*) SKUs must not be set here.
export const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY");
export const GEMINI_FALLBACK_MODEL_ID =
  Deno.env.get("GEMINI_FALLBACK_MODEL_ID") ?? "gemini-2.5-flash";
export const geminiDirectGateway = GEMINI_API_KEY
  ? createOpenAICompatible({
      name: "gemini-direct",
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
      headers: { Authorization: `Bearer ${GEMINI_API_KEY}` },
      fetch: ORCHESTRATOR_FETCH,
    })
  : null;

// Primary orchestrator model: MiniMax-M2.7 (user's Max token plan, 15k req/5h).
// Context overflows are mitigated by the aggressive per-step trimmer below.
//
// Phase 3 (speed): the model id is env-overridable so an operator can switch to
// MiniMax's HighSpeed variant (~2× tok/s, identical output — audit §6) WITHOUT a
// code change. The DEFAULT is UNCHANGED ("MiniMax-M2.7"): with nothing set this is
// byte-for-byte the prior behavior.
//
// TODO(verify before enabling): third-party aggregators (AI/ML API, ofox) list the
// HighSpeed model id as "MiniMax-M2.7-highspeed", but this was NOT confirmed against
// the official platform.minimax.io docs (they returned HTTP 403 from the build
// environment). A wrong model id 400s every run, so DO NOT hardcode it as the
// default. To enable: confirm the exact case-sensitive string on the live MiniMax
// account, then set the Supabase function secret
//   MINIMAX_ORCHESTRATOR_MODEL_ID=<verified-highspeed-id>
export const PRIMARY_ORCHESTRATOR_MODEL_ID =
  Deno.env.get("MINIMAX_ORCHESTRATOR_MODEL_ID") ?? "MiniMax-M2.7";
// Lovable Gateway fallback model (used when MiniMax is unavailable / preflight
// fails). Single source of truth is MODELS.fallback in models.ts — repointed to a
// served flash-class model + env-overridable via LOVABLE_FALLBACK_MODEL_ID (B5),
// since the old "google/gemini-2.5-pro" 403'd here and killed the run.
export const FALLBACK_MODEL_ID = MODELS.fallback;

// ---- Tranche 2: env-gated alternative orchestrator providers -----------------
// These let an operator move the top-level orchestrator/synthesis turn off
// MiniMax WITHOUT a code change. Both are null unless their keys are set, so the
// default selection (see orchestrator_select.ts) stays MiniMax and behavior is
// unchanged. Activate via Supabase secrets — never the repo.
export const XAI_API_KEY = Deno.env.get("XAI_API_KEY") ?? "";
export const OPENADAPTER_API_KEY = Deno.env.get("OPENADAPTER_API_KEY") ?? "";
export const OPENADAPTER_BASE_URL = Deno.env.get("OPENADAPTER_BASE_URL") ?? "";
// DeepSeek — OpenAI-compatible chat completions at api.deepseek.com. When set,
// DeepSeek takes the lead orchestrator role by default (see orchestrator_select).
// MiniMax stays configured as a secondary/fallback provider.
export const DEEPSEEK_API_KEY = Deno.env.get("DEEPSEEK_API_KEY") ?? "";
// Default to `deepseek-v4-pro` — DeepSeek's V4 flagship (1.6T total / 49B
// active params, 1M-token context). Keep Pro as the lead planner/correlator
// for the initial quality benchmark; Flash can be swapped in later via
// DEEPSEEK_ORCHESTRATOR_MODEL_ID after an apples-to-apples replay test.
export const DEEPSEEK_ORCHESTRATOR_MODEL_ID =
  Deno.env.get("DEEPSEEK_ORCHESTRATOR_MODEL_ID") ?? "deepseek-v4-pro";
/** Operator override pinning the primary orchestrator provider. */
export const ORCHESTRATOR_PROVIDER = (Deno.env.get("ORCHESTRATOR_PROVIDER") ?? "").trim().toLowerCase();
/** Orchestrator model IDs for the alternative providers (overridable).
 * Default grok-4.3 = xAI's current flagship (leads on non-hallucination rate +
 * agentic tool calling — the right properties for OSINT synthesis). Override
 * with GROK_ORCHESTRATOR_MODEL_ID if xAI's lineup changes. */
export const GROK_ORCHESTRATOR_MODEL_ID = Deno.env.get("GROK_ORCHESTRATOR_MODEL_ID") ?? "grok-4.3";
export const OPENADAPTER_ORCHESTRATOR_MODEL_ID = Deno.env.get("OPENADAPTER_ORCHESTRATOR_MODEL_ID") ?? "";

// DeepSeek gateway — OpenAI-compatible.
export const deepseekGateway = DEEPSEEK_API_KEY
  ? createOpenAICompatible({
      name: "deepseek",
      baseURL: "https://api.deepseek.com/v1",
      headers: { Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
      fetch: ORCHESTRATOR_FETCH,
    })
  : null;

// xAI Grok — OpenAI-compatible chat completions at api.x.ai.
export const grokGateway = XAI_API_KEY
  ? createOpenAICompatible({
      name: "xai-grok",
      baseURL: "https://api.x.ai/v1",
      headers: { Authorization: `Bearer ${XAI_API_KEY}` },
      fetch: ORCHESTRATOR_FETCH,
    })
  : null;

// OpenAdapter — operator-supplied OpenAI-compatible gateway (base URL required).
export const openAdapterGateway = (OPENADAPTER_API_KEY && OPENADAPTER_BASE_URL)
  ? createOpenAICompatible({
      name: "openadapter",
      baseURL: OPENADAPTER_BASE_URL,
      headers: { Authorization: `Bearer ${OPENADAPTER_API_KEY}` },
      fetch: ORCHESTRATOR_FETCH,
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

// Account-level breach-reveal policy. When ON, the breach surface returns
// UNMASKED concrete values — serus is queried with reveal=true, rapidapi keeps
// each exposed field's real value, and the OathNet stealer/victim trimmers keep
// raw passwords/cookies instead of stripping them. The platform owner explicitly
// authorized full reveal on their own account for authorized investigations, so
// this defaults ON for this deployment; set REVEAL_BREACH_DATA=false in the edge
// secrets to restore masked-by-default behavior. NOTE: serus reveal still requires
// the SERUS_API_KEY to carry the `darkweb:reveal` scope upstream — this flag opts
// in, it cannot grant a scope the key does not have (a scopeless key 403s).
export const REVEAL_BREACH_DATA =
  (Deno.env.get("REVEAL_BREACH_DATA") ?? "true").trim().toLowerCase() !== "false";

// IPQualityScore — fraud/validity scoring for phone, email, and IP. One key,
// three endpoints. Directly counters false-positive attribution: invalid /
// reserved phones, disposable emails, and proxy/VPN IPs come back with low
// validity + high fraud_score so the orchestrator can down-weight junk.
export const IPQUALITYSCORE_API_KEY = Deno.env.get("IPQUALITYSCORE_API_KEY");

// RapidAPI Email Breach Search — PRIMARY email breach source (~8000 lookups/mo).
// Powers rapidapi_breach_search + rapidapi_all_breaches. Both tools self-skip when
// unset; this export lets the planner/audit drop them off the menu so an un-keyed
// deploy never wastes a planner slot proposing a tool that can only return skipped.
export const RAPIDAPI_KEY = Deno.env.get("RAPIDAPI_KEY");
export const INDICIA_API_KEY = Deno.env.get("INDICIA_API_KEY");
// People Data Labs — person enrichment (~3B profiles). Single tool gated on this
// key; readiness gate drops it from the schema when unset.
export const PEOPLEDATALABS_API_KEY = Deno.env.get("PEOPLEDATALABS_API_KEY");

// OpenCorporates company-registry search. NOW EFFECTIVELY REQUIRED — the v0.4
// search endpoint returns 401 "Invalid Api Token" for ALL keyless requests, so
// opencorporates_search self-skips when this is unset (no `!` so the missing-key
// branch can return a clean { error }). For keyless registry corroboration the
// agent uses gleif_lei_search instead.
export const OPENCORPORATES_API_KEY = Deno.env.get("OPENCORPORATES_API_KEY");

// Ransomware.live PRO API key. The free api.ransomware.live host has been
// retired (every /v2/* path returns the branded 404 splash); only
// api-pro.ransomware.live serves real data and it requires X-API-KEY. When
// this is unset, ransomwarelive_lookup self-reports as degraded instead of
// silently returning listed:false for every domain.
export const RANSOMWARELIVE_API_KEY = Deno.env.get("RANSOMWARELIVE_API_KEY");

// URLScanner.online — private URL malware/phishing/threat scanner. Returns a
// combined report (DNS + SSL + HTTP + WHOIS + threat-blocklists + AI summary)
// in one /scan/sync call. Free 10/day, Solo 100/day, higher tiers via key.
// Private: scans are NOT made public (unlike VirusTotal). Tool self-skips
// when this is unset so missing-key never silently looks like "not flagged".
export const URLSCANNER_API_KEY = Deno.env.get("URLSCANNER_API_KEY");

// Health probe secret — gates the paid ?probe=1 path. Fail closed: if unset,
// ?probe=1 is rejected. The lightweight ?health=1 path remains public.
export const OSINT_AGENT_PROBE_SECRET = Deno.env.get("OSINT_AGENT_PROBE_SECRET") ?? "";

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
// (GEMINI_API_KEY moved up to the orchestrator-provider section — it now also
// keys the direct-Gemini fallback gateway, which must be declared after it.)
export const OSINT_NAVIGATOR_API_KEY = Deno.env.get("OSINT_NAVIGATOR_API_KEY");
export const PERPLEXITY_API_KEY = Deno.env.get("PERPLEXITY_API_KEY");

// ---- fetchRetry (re-exported from fetch_retry.ts) ---------------------------
// Kept as a re-export so existing `import { fetchRetry } from "./env.ts"`
// call sites (7 tool files) continue to work without a sweeping rename.
// New code should import from "./fetch_retry.ts" directly to avoid pulling
// in this file's `npm:@ai-sdk/openai-compatible@1` import.
export { fetchRetry, fetchT } from "./fetch_retry.ts";
