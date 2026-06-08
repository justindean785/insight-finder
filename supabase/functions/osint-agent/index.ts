/**
 * index.new.ts — Refactored OSINT agent entry point.
 * Imports all extracted modules and uses setupRequest from auth.ts.
 * The tools object and orchestration logic are IDENTICAL to the original index.ts.
 */

// ---- NPM imports -------------------------------------------------------------
import { createClient } from "npm:@supabase/supabase-js@2";
import { convertToModelMessages, streamText, tool, stepCountIs, type UIMessage, type ModelMessage } from "npm:ai@6";
import { z } from "npm:zod@3";
import { createOpenAICompatible } from "npm:@ai-sdk/openai-compatible@1";

// ---- Existing modules --------------------------------------------------------
import { MODELS, ORCHESTRATOR_TIER, tierForTool, modelForTool, type Tier } from "./models.ts";
import { costForTool } from "./costs.ts";
import { tierOf, TIER_A, TIER_B } from "./tiers.ts";
import { playbookFor, renderPlaybookForPrompt } from "./playbooks.ts";
import { auditCoverage } from "./coverage.ts";
import { detectContradictions } from "./contradictions.ts";
import { computeAxes, sourceConfidence, applyEvidenceCaps } from "./confidence.ts";
import { buildWorkflowAddendum } from "./workflow_prompt.ts";
import { STRICT_KINDS, inferKind, isStrictKind, classifySource } from "./artifact_types.ts";
import * as circuit from "./circuit.ts";
import { discoverCapabilities, capabilityEnvKeys } from "./capabilities.ts";
import { buildNodes } from "./graph.ts";
import { selectPivots, type PivotCandidate } from "./graph_pivots.ts";

// ---- Extracted modules -------------------------------------------------------
// env.ts — Environment bindings, API keys, degraded-tools state, fetch helpers
import {
  corsHeaders, SUPABASE_URL, SERVICE_KEY, MINIMAX_API_KEY, LOVABLE_API_KEY,
  lovableGateway, PRIMARY_ORCHESTRATOR_MODEL_ID, FALLBACK_MODEL_ID,
  OATHNET_API_KEY, SYNAPSINT_API_KEY, OSINTNOVA_API_KEY, SOCIALFETCH_API_KEY,
  CORDCAT_API_KEY, HUNTER_API_KEY, INTELBASE_API_KEY, INTELBASE_ENABLED,
  HIBP_API_KEY, GITHUB_API_TOKEN, FIRECRAWL_API_KEY, EXA_API_KEY, JINA_API_KEY,
  GEMINI_API_KEY, OSINT_NAVIGATOR_API_KEY, PERPLEXITY_API_KEY, SERUS_API_KEY,
  firecrawlCreditsLow, markFirecrawlCreditsLow, resetFirecrawlCreditsLow, degradedTools,
  markToolDegraded, isDegraded, fetchRetry, fetchT,
  deadHosts, markHostDead, isHostDead,
} from "./env.ts";

// validation.ts — Seed detection, cache TTLs, artifact validation
import {
  detectSeedServer, validateArtifact, TTL_24H_MS, TOOL_TTL_MS, NO_CACHE_TOOLS,
} from "./validation.ts";

// api_types.ts — Loose TypeScript interfaces for third-party API responses.
// Used at the JSON.parse boundaries in this file to replace `let data: any`
// with a typed shape so the downstream .map((t: any) => ...) cascades
// narrow automatically. See ./api_types.ts for scope discipline notes.
import type { NavigatorQueryResponse, NavigatorSearchResponse, NavigatorTool, StolenTaxResponse, GitHubCodeSearchResponse, GitHubCodeMatch } from "./api_types.ts";

// safety.ts — Artifact scrubbing, sanitization, SSRF guard, part-size capping
import {
  scrubArtifactRow, scrubArtifactRows, hashInput, normalizeForHash,
  sanitizeToolOutput, TOOL_CACHE_LRU, LRU, isPrivateHost, assertSafeUrl,
  capPartsSize,
  type CacheEntry,
} from "./safety.ts";

// guard.ts — Per-investigation guard state, routing guards, triage gating
import {
  guard, routingGuard, HIGH_COST_TOOLS, CONSUMER_DOMAINS, STAGE2_TOOLS,
  triageState, bumpArtifacts, skipStub, gateStage2,
} from "./guard.ts";

// auth.ts — Request setup: CORS preflight, JWT auth, thread ownership, message persistence
import { setupRequest, type SetupContext } from "./auth.ts";

// providers.ts — MiniMax provider, minimaxChat, safeJson, Gemini grounded search
import { minimax, minimaxChat, safeJson, geminiGroundedSearch } from "./providers.ts";

// sweeper.ts — Built-in Username Sweep (~95 platforms)
import { sweepUsername } from "./sweeper.ts";

// archiver.ts — Exa result trimming and attachment archiving
import { trimExaResults, archiveAttachment } from "./archiver.ts";

// catalog.ts — Tool catalog, fan-out recipes, catalog cache, finding labels
import { TOOL_CATALOG, CATALOG_CACHE, FINDING_LABELS } from "./catalog.ts";

// system-prompt.ts — System prompt, identity cluster rules, person search rules
import { SYSTEM_PROMPT, IDENTITY_CLUSTER_RULES, PERSON_SEARCH_RULES, SYSTEM_PROMPT_FULL } from "./system-prompt.ts";

// cache.ts — Central tool cache wrapper, tier tagging, auto-evidence
import { wrapToolsWithCache } from "./cache.ts";
import { okWithSuccessFlag, socialfetchError, isHackertargetApiError, isCrtshOk, dohTypeError, blockchairError } from "./tool_response.ts";

// ---- Local type aliases for the tool registry -------------------------------
// The `tools` object is one large literal that self-references inside its own
// initializer (e.g. `(tools as ToolRegistry).emailrep.execute(...)`) and also
// receives late-injected tools appended after construction (memory_recall,
// coverage_audit, …). We type the registry as `Record<string, unknown>` so
// both the self-references and the late-injection assignments type-check, and
// narrow individual tools to `ExecutableTool` at the call sites that invoke
// their `execute()` function. This replaces the prior `(tools as any)` casts
// without changing any runtime behavior.
type ToolRegistry = Record<string, unknown>;
type ExecutableTool = {
  execute: (input: Record<string, unknown>, options: unknown) => Promise<unknown>;
};

// ---- Health/readiness probe -------------------------------------------------
// `GET /osint-agent?health=1` (and HEAD) returns a JSON readiness summary so
// the frontend preflight + ops smoke tests can tell the difference between:
//   - 404 from the gateway  → function is not deployed
//   - 200 with ok:true     → function is deployed AND all required keys/DB are healthy
//   - 200 with ok:false    → function is deployed but a required dep is missing
//     (e.g. orchestrator key unset). Caller should surface this to the user
//     instead of letting the run fail mid-stream with an opaque 500.
// Always cheap: no LLM calls, no rate-limit check, no DB writes.
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
  GITHUB_API_TOKEN?: string | null;
  PERPLEXITY_API_KEY?: string | null;
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
      : { ok: false, detail: "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing" },
    tools: {
      ok: true, // optional tools are never required
      detail: `${enabledOptional}/${Object.keys(tools).length} optional tool APIs configured`,
    },
  };
  return { ok: orchestratorOk && coreOk, checks };
}

function isHealthProbe(req: Request): boolean {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  try {
    const u = new URL(req.url);
    return u.searchParams.get("health") === "1";
  } catch {
    return false;
  }
}

// ---- Handler -----------------------------------------------------------------
Deno.serve(async (req) => {
  // ── /health short-circuit: cheapest possible path, runs before any
  //    per-request state reset so the probe is side-effect-free.
  if (isHealthProbe(req)) {
    const r = deriveReadiness({
      MINIMAX_API_KEY, LOVABLE_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
      OATHNET_API_KEY, SYNAPSINT_API_KEY, OSINTNOVA_API_KEY, SOCIALFETCH_API_KEY,
      CORDCAT_API_KEY, HUNTER_API_KEY, INTELBASE_API_KEY, HIBP_API_KEY, EXA_API_KEY,
      FIRECRAWL_API_KEY, SERUS_API_KEY, GITHUB_API_TOKEN, PERPLEXITY_API_KEY,
    });
    const body = {
      ok: r.ok,
      service: "osint-agent",
      version: "1.0.0",
      checks: r.checks,
      intelbase_enabled: INTELBASE_ENABLED,
    };
    // HEAD: send headers only (Supabase gateway strips the body anyway, but be
    // explicit). GET: full JSON. Either way status 200 distinguishes "deployed"
    // from "404 = not deployed" at the gateway layer.
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

  // Reset per-invocation sticky flags. Deno isolates are reused across
  // requests, so module-scope state must be cleared at the top of each
  // handler call or one investigation's 402 disables Firecrawl forever.
  degradedTools.clear();
  deadHosts.clear();
  resetFirecrawlCreditsLow(); // Reset per-request: one investigation's 402 shouldn't carry over

  // ---- Reset guard/triage state (module-scoped, must be reset per-request) ----
  guard.artifactsSinceCorrelate = 0;
  guard.artifactsSincePlan = 0;
  guard.planCalledInRound = false;
  routingGuard.artifactsTotal = 0;
  routingGuard.memoryRecallTimestamps = [];
  routingGuard.memoryRecallSubjectsThisStep.clear();
  routingGuard.highCostLastArtifactCount.clear();
  triageState.ran = false;
  triageState.seed = null;
  triageState.seedType = null;
  triageState.seedDomain = null;
  triageState.cleared.clear();
  triageState.reasons = [];
  triageState.skipped = [];
  triageState.identitySignals.name = false;
  triageState.identitySignals.username = false;

  try {
    // ---- setupRequest handles CORS, auth, thread verification, message persistence ----
    const ctx = await setupRequest(req);
    const { supabase, supabaseAdmin, user, userId, threadId, archiveEnabled, detectedSeedType, messages } = ctx;

    const tools = {
      list_tools: tool({
        description:
          "Returns the OSINT tool catalog (names, descriptions, when-to-use, input shape) plus per-seed fan-out recipes and finding-label rules, FILTERED to what's currently allowed in this investigation. If triage_seed has run, Stage-2 tools that did NOT clear the gate are hidden from `tools` and listed in `disabled_tools` with the reason — do NOT call them, they will be skipped. Call this once at the start, and OPTIONALLY again immediately after `triage_seed` to refresh the allowed set.",
        inputSchema: z.object({}).strict(),
        execute: async () => {
          // Build a triage-aware view of the catalog. Stage-2 tools that
          // failed to clear the gate are removed from `tools` and surfaced
          // separately as `disabled_tools` so the agent stops trying them.
          const stage2 = [
            "intelbase_email_lookup","oathnet_lookup",
            "github_code_search","google_dorks","minimax_web_search","urlscan_search",
          ];
          const disabled: Array<{ name: string; reason: string }> = [];
          // IntelBase is hard-gated at the planner level when the feature flag
          // is off — it must never be selected, regardless of triage outcome.
          if (!INTELBASE_ENABLED) {
            disabled.push({
              name: "intelbase_email_lookup",
              reason: "IntelBase gated — provider instability (feature flag off). Use breach_check / leakcheck_lookup / oathnet_lookup / bosint_email_lookup instead.",
            });
          }
          // HIBP needs a paid key; hide it entirely when unset so the agent
          // doesn't burn a fan-out slot on a tool that can only return
          // "not configured" on every email seed.
          if (!HIBP_API_KEY) {
            disabled.push({
              name: "hibp_lookup",
              reason: "HIBP_API_KEY not configured — use breach_check / leakcheck_lookup / oathnet_lookup for breach corroboration.",
            });
          }
          if (triageState.ran) {
            for (const name of stage2) {
              if (!triageState.cleared.has(name)) {
                const r = triageState.skipped.find((s) => s.tool === name)?.reason
                  ?? "Stage 1 produced no qualifying signal (no breach / no real gravatar / low emailrep / consumer domain).";
                disabled.push({ name, reason: r });
              }
            }
          }
          const disabledNames = new Set(disabled.map((d) => d.name));
          const filtered = {
            ...TOOL_CATALOG,
            tools: TOOL_CATALOG.tools.filter((t) => !disabledNames.has(t.name)),
          };
          // Only memoize the BASELINE (pre-triage) catalog so the post-triage
          // refresh isn't poisoned by a stale early-call cache.
          if (!triageState.ran && !CATALOG_CACHE.get(threadId)) {
            CATALOG_CACHE.set(threadId, TOOL_CATALOG);
          }
          return {
            ok: true,
            triage_ran: triageState.ran,
            cached_for_investigation: !triageState.ran && !!CATALOG_CACHE.get(threadId),
            disabled_tools: disabled,
            ...filtered,
          };
        },
      }),
      triage_seed: tool({
        description:
          "MANDATORY first step for email or username seeds. Runs the cheap Stage-1 tools (emailrep, gravatar_profile, breach_check) in parallel, then decides which expensive Stage-2 tools (oathnet_lookup, github_code_search, google_dorks, minimax_web_search, urlscan_search) are allowed to run. Stage-2 tools are blocked at the orchestrator level until this runs and clears them. Records a `triage_decision` artifact.",
        inputSchema: z.object({
          seed: z.string().min(1),
          type: z.enum(["email", "username"]),
        }),
        execute: async ({ seed, type }) => {
          const normalized = seed.trim();
          const domain = type === "email" && normalized.includes("@")
            ? normalized.split("@")[1].toLowerCase()
            : null;
          triageState.seed = normalized;
          triageState.seedType = type;
          triageState.seedDomain = domain;
          if (type === "username") triageState.identitySignals.username = true;

          // ---- Run Stage 1 in parallel (only the tools that apply to the seed type) ----
          const stage1: Record<string, unknown> = {};
          if (type === "email") {
            const [emailrepRes, gravatarRes, breachRes] = await Promise.all([
              ((tools as ToolRegistry).emailrep as ExecutableTool).execute({ email: normalized }, {}).catch((e: unknown) => ({ error: String(e) })),
              ((tools as ToolRegistry).gravatar_profile as ExecutableTool).execute({ email: normalized }, {}).catch((e: unknown) => ({ error: String(e) })),
              ((tools as ToolRegistry).breach_check as ExecutableTool).execute({ email: normalized }, {}).catch((e: unknown) => ({ error: String(e) })),
            ]);
            stage1.emailrep = emailrepRes;
            stage1.gravatar = gravatarRes;
            stage1.breach = breachRes;
          }

          // ---- Evaluate gate signals ----
          // Stage-1 tool results carry an optional `data` payload (and the
          // gravatar result an HTTP `status`). We read a handful of fields off
          // each `data` blob; everything else stays `unknown` and is narrowed
          // at the use site via typeof / Array.isArray guards below.
          interface Stage1Result {
            data?: Record<string, unknown>;
            status?: number;
            [k: string]: unknown;
          }
          const erData = (stage1.emailrep as Stage1Result | undefined)?.data ?? {} as Record<string, unknown>;
          const gvData = (stage1.gravatar as Stage1Result | undefined)?.data ?? {} as Record<string, unknown>;
          const brData = (stage1.breach as Stage1Result | undefined)?.data ?? {} as Record<string, unknown>;

          const REP_SCORE: Record<string, number> = { high: 90, medium: 60, low: 20, none: 0 };
          const numericRep = typeof erData.reputation === "number" ? erData.reputation : null;
          const labelRep = typeof erData.reputation === "string" ? REP_SCORE[erData.reputation] ?? 0 : 0;
          const emailrepScore = numericRep ?? labelRep;

          const breachCount =
            typeof brData.found === "number" ? brData.found
              : Array.isArray(brData.result) ? brData.result.length
              : Array.isArray(brData.sources) ? brData.sources.length
              : Array.isArray(brData) ? brData.length
              : 0;
          const breachHit = breachCount > 0 || brData.success === true;

          const gravatarFound =
            (stage1.gravatar as Stage1Result | undefined)?.status === 200 &&
            (typeof gvData.display_name === "string" ||
             typeof gvData.hash === "string" ||
             (Array.isArray(gvData.accounts) && gvData.accounts.length > 0));

          const nonConsumerDomain = !!domain && !CONSUMER_DOMAINS.has(domain);

          const reasons: string[] = [];
          if (breachHit) reasons.push(`breach hit (${breachCount})`);
          if (gravatarFound) reasons.push("non-default gravatar");
          if (emailrepScore >= 50) reasons.push(`emailrep score ${emailrepScore}`);
          if (nonConsumerDomain) reasons.push(`non-consumer domain ${domain}`);

          // Loosened gate: Stage-2 tools open as soon as triage runs.
          // We still record any qualifying `reasons` for transparency, but
          // even an empty-signal triage (no breach, no gravatar, low emailrep,
          // consumer domain) no longer blocks Stage-2 follow-ups — pivots
          // like minimax_web_search / oathnet_lookup / urlscan_search are
          // still high-value on cold seeds.
          const stage2Open = true;
          if (reasons.length === 0) reasons.push("triage ran (gate permissive)");

          triageState.cleared.clear();
          triageState.skipped = [];
          triageState.reasons = reasons;

          const blockedReasonGlobal = "";

          for (const t of STAGE2_TOOLS) {
            const allow = stage2Open;
            const blockedReason = blockedReasonGlobal;
            // github_code_search used to require a non-consumer domain;
            // we now allow it on all seeds (the agent can still skip noisy
            // consumer-email queries on its own).
            // google_dorks is intentionally NOT gated: it only generates
            // copy-paste query URLs (no external API call, no quota), so it
            // is safe and high-value to run on every seed type. Always allow.
            if (allow) triageState.cleared.add(t);
            else triageState.skipped.push({ tool: t, reason: blockedReason });
          }

          triageState.ran = true;

          const decision = {
            seed: normalized,
            seed_type: type,
            seed_domain: domain,
            stage1_signals: {
              breach_hit: breachHit,
              breach_count: breachCount,
              gravatar_found: gravatarFound,
              emailrep_score: emailrepScore,
              non_consumer_domain: nonConsumerDomain,
            },
            gate_open: stage2Open,
            cleared: [...triageState.cleared],
            skipped: triageState.skipped,
            reasons,
          };

          // ---- Persist as an artifact so it appears in the timeline/resources ----
          try {
            await supabase.from("artifacts").insert([{
              thread_id: threadId,
              user_id: userId,
              kind: "triage_decision",
              value: `triage_decision: ${stage2Open ? "Stage 2 OPEN" : "Stage 2 SKIPPED"} for ${normalized}`,
              confidence: null,
              source: "triage_seed",
              metadata: { label: "triage_decision", ...decision } as Record<string, unknown>,
            }]);
            bumpArtifacts(1, ["triage_decision"]);
          } catch { /* best-effort */ }

          return { ok: true, stage1, decision };
        },
      }),
      minimax_web_search: tool({
        description:
          "Live web search powered by Perplexity Sonar (grounded, real-time, with citations). Use early on the seed and on every new email/handle/name/domain/phone you discover. Returns a concise synthesized answer plus the list of cited source URLs.",
        inputSchema: z.object({
          query: z.string().min(2).describe("Search query, e.g. \"alice@example.com\" leak OR breach"),
          focus: z.string().optional().describe("Optional steering hint, e.g. 'find social profiles', 'find leaks'"),
        }),
        execute: async ({ query, focus }) => {
          const gated = gateStage2("minimax_web_search");
          if (gated) return gated;
          if (!PERPLEXITY_API_KEY) return { error: "PERPLEXITY_API_KEY not configured" };
          try {
            const r = await fetchRetry("https://api.perplexity.ai/chat/completions", {
              method: "POST",
              headers: {
                Authorization: `Bearer ${PERPLEXITY_API_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: "sonar",
                messages: [
                  {
                    role: "system",
                    content:
                      "You are an OSINT web-search worker. Return a concise factual answer in bullet points. Do not speculate. Prefer specific names, dates, URLs, and identifiers. If nothing relevant is found, say so explicitly.",
                  },
                  {
                    role: "user",
                    content: `${focus ? `Focus: ${focus}\n\n` : ""}Query: ${query}`,
                  },
                ],
                max_tokens: 1200,
              }),
            });
            if (!r.ok) {
              const body = await r.text().catch(() => "");
              console.warn(`[minimax_web_search] perplexity ${r.status} for query="${query.slice(0,120)}": ${body.slice(0, 300)}`);
              return { ok: false, status: r.status, error: `perplexity ${r.status}: ${body.slice(0, 300)}`, answer: "", citations: [] };
            }
            const data = await r.json() as {
              choices?: { message?: { content?: string } }[];
              citations?: string[];
              search_results?: { url?: string; title?: string }[];
            };
            const answer = (data.choices?.[0]?.message?.content ?? "").trim();
            const citations = (data.citations ?? data.search_results?.map((s) => s.url ?? "").filter(Boolean) ?? [])
              .filter((u) => typeof u === "string" && /^https?:\/\//i.test(u))
              .slice(0, 25);
            const usable = answer.length > 0 || citations.length > 0;
            if (!usable) {
              return { ok: false, status: r.status, error: "perplexity returned empty answer and no citations", answer, citations };
            }
            return { ok: true, status: r.status, answer, citations };
          } catch (e) {
            console.warn(`[minimax_web_search] threw for query="${query.slice(0,120)}":`, e);
            return { ok: false, error: String(e), answer: "", citations: [] };
          }
        },
      }),
      minimax_extract: tool({
        description:
          "Extract structured OSINT entities from any blob of raw text (HTML excerpts, breach JSON dumps, social profile bios, tool outputs). MiniMax returns deduped emails, usernames, phones, urls, ips, domains, full names, employers, locations, and crypto wallets.",
        inputSchema: z.object({
          text: z.string().min(1).max(20000),
          context: z.string().optional().describe("What the blob is, e.g. 'github bio for handle xyz'"),
        }),
        execute: async ({ text, context }) => {
          try {
            const r = await minimaxChat({
              system:
                "You extract OSINT entities. Reply ONLY with JSON matching: {emails:string[],usernames:string[],phones:string[],urls:string[],ips:string[],domains:string[],names:string[],employers:string[],locations:string[],crypto:{chain:string,address:string}[],notes:string}. Dedupe. Lowercase emails/domains. Empty arrays if none.",
              user: `${context ? "Context: " + context + "\n\n" : ""}Text:\n${text.slice(0, 18000)}`,
              json: true,
              maxTokens: 1200,
            });
            const parsed = safeJson<Record<string, unknown>>(r.content) ?? { raw: r.content };
            return { ok: r.ok, status: r.status, entities: parsed };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      minimax_correlate: tool({
        description:
          "Have MiniMax correlate and rescore a batch of artifacts. Pass the list of artifacts gathered so far; it returns identity clusters, dedup mapping, confidence rescoring, and contradiction flags. Run after each fan-out round.",
        inputSchema: z.object({
          seed: z.string().describe("Original seed identifier"),
          artifacts: z.array(z.object({
            kind: z.string(),
            value: z.string(),
            source: z.string().optional(),
            confidence: z.number().optional(),
            metadata: z.unknown().optional(),
          })).max(200),
        }),
        execute: async ({ seed, artifacts }) => {
          if (guard.artifactsSinceCorrelate < 3) {
            return skipStub(
              "minimax_correlate",
              `need >=3 new artifacts since last correlation (have ${guard.artifactsSinceCorrelate}). Keep gathering, or call at end of round.`,
              { artifactsSinceCorrelate: guard.artifactsSinceCorrelate },
            );
          }
          try {
            const r = await minimaxChat({
              model: MODELS.smart,
              system:
                "You are an OSINT correlation engine focused on avoiding identity misattribution. Given a seed and artifacts list, reply ONLY with JSON: {clusters:[{label:string,artifacts:string[],locations:string[],core_identifiers:string[],confidence:number,warning?:string}],duplicates:[{canonical:string,aliases:string[]}],rescored:[{value:string,new_confidence:number,reason:string}],contradictions:[{a:string,b:string,reason:string}],same_name_collisions:[{cluster_a:string,cluster_b:string,reason:string}],strongest_leads:string[]}. Rules: do not merge same-name people without 2 strong overlapping identifiers (exact email, exact phone, exact profile URL, exact address, exact DOB + another match); split clusters on conflicting geography (different US state, different phone area code, IP geo vs claimed address); breach-only attributes are verification leads, not confirmed identity facts.",
              user: `Seed: ${seed}\n\nArtifacts:\n${JSON.stringify(artifacts).slice(0, 16000)}`,
              json: true,
              maxTokens: 1500,
            });
            const parsed = safeJson<Record<string, unknown>>(r.content) ?? { raw: r.content };
            guard.artifactsSinceCorrelate = 0;
            return { ok: r.ok, status: r.status, analysis: parsed };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      minimax_plan_pivots: tool({
        description:
          "Ask MiniMax to plan the next pivot batch. Pass the seed plus what you've found so far; it returns a prioritized list of {tool, args, reason} for the next tool calls. Use when stuck or to avoid repeating work.",
        inputSchema: z.object({
          seed: z.string(),
          already_queried: z.array(z.string()).max(200).default([]),
          artifacts: z.array(z.object({ kind: z.string(), value: z.string() })).max(200),
          budget_remaining: z.number().int().min(0).max(100).default(30),
        }),
        execute: async ({ seed, already_queried, artifacts, budget_remaining }) => {
          if (guard.artifactsSincePlan === 0) {
            return skipStub(
              "minimax_plan_pivots",
              "previous round produced zero new artifacts — gather more before planning.",
              { artifactsSincePlan: guard.artifactsSincePlan, planCalledInRound: guard.planCalledInRound },
            );
          }
          if (guard.planCalledInRound) {
            return skipStub(
              "minimax_plan_pivots",
              "already called once this fan-out round. Execute the planned pivots before re-planning.",
              { artifactsSincePlan: guard.artifactsSincePlan, planCalledInRound: guard.planCalledInRound },
            );
          }
          try {
            const baseToolList = [
              // Breach + identity
              "breach_check","leakcheck_lookup","hibp_lookup","oathnet_lookup",
              "intelbase_email_lookup","bosint_email_lookup","bosint_phone_lookup",
              "stolentax_footprint",
              // DeepFind suite (shared 1000/day pool)
              "deepfind_reverse_email","deepfind_disposable_email","deepfind_ransomware_exposure",
              "deepfind_ssl_inspect","deepfind_tech_stack","deepfind_url_unshorten",
              "deepfind_profile_analyzer","deepfind_telegram_channel","deepfind_telegram_search",
              "deepfind_vin_lookup","deepfind_aircraft_lookup","deepfind_vessel_lookup",
              "deepfind_mac_lookup","deepfind_dark_web_link",
              // Profile / social
              "socialfetch_lookup","cordcat_discord_lookup","github_user","github_code_search",
              "hackernews_user","reddit_user","gravatar_profile","emailrep",
              "username_sweep","username_search",
              // Email enrichment
              "hunter_domain_search","hunter_email_finder","hunter_email_verifier","hunter_combined",
              // Domain / infra / IP
              "whois_lookup","dns_records","crtsh_subdomains","http_fingerprint",
              "ip_intel","ipgeolocation_lookup","shodan_internetdb","hackertarget",
              "urlscan_search","virustotal_lookup","synapsint_lookup",
              // Search + scrape (preferred order)
              "jina_reader_scrape","exa_search","exa_get_contents","exa_find_similar",
              "minimax_web_search","google_dorks","dork_harvest","gemini_deep_dork",
              // Archive + chain-of-custody + misc
              "wayback_snapshots","archive_url","crypto_wallet",
              // Tool recommender (for unwired pivots)
              "osint_navigator_query","osint_navigator_search",
              // LLM helpers
              "minimax_extract","minimax_correlate",
              // Recording
              "record_artifacts","record_artifact","record_evidence",
              // Firecrawl — last resort only
              // firecrawl_* are disabled — intentionally omitted from pivot planner
            ];
            // Drop high-cost tools from the planner's menu once they've fired
            // unless enough new evidence has appeared to justify a re-run.
            const skippedHighCost: string[] = [];
            // Permanently blocked tools — never let the planner pick them.
            // Firecrawl: credits exhausted, stubs return immediate error.
            // Intelbase: gated due to instability (ENABLE_INTELBASE=false).
            const PERMANENT_BLOCK = new Set([
              "firecrawl_search","firecrawl_scrape","firecrawl_map",
              "intelbase_email_lookup",
            ]);
            // Tools the circuit breaker has disabled this investigation (e.g.
            // synapsint after 3 consecutive HTTP 500s). Without this the planner
            // re-proposes a known-dead tool every round — observed firing
            // synapsint 7x for zero value. degradedTools covers the parallel
            // self-degrade path (markToolDegraded on 5xx).
            const brokenTools = new Set<string>(
              circuit.snapshot(threadId).filter((s) => s.disabledReason).map((s) => s.tool),
            );
            const toolList = baseToolList.filter((name) => {
              if (PERMANENT_BLOCK.has(name)) return false;
              // HIBP can only fail without a key — keep it off the planner menu.
              if (name === "hibp_lookup" && !HIBP_API_KEY) return false;
              // Dead/degraded tools — stop re-proposing them this investigation.
              if (brokenTools.has(name) || isDegraded(name)) return false;
              if (!HIGH_COST_TOOLS.has(name)) return true;
              const last = routingGuard.highCostLastArtifactCount.get(name);
              if (last === undefined) return true;
              if (routingGuard.artifactsTotal - last >= 5) return true;
              skippedHighCost.push(name);
              return false;
            });
            if (skippedHighCost.length) {
              console.log(`[planner] high-cost tools removed from menu (already fired, insufficient new evidence): ${skippedHighCost.join(", ")}`);
            }
            const r = await minimaxChat({
              model: MODELS.smart,
              system:
                `You plan OSINT pivots. ONLY propose tools from this EXACT list (names must match verbatim — do not invent or rename): ${toolList.join(", ")}.${skippedHighCost.length ? ` HIGH-COST tools already fired and hidden this round (do not request): ${skippedHighCost.join(", ")} — only re-eligible once new corroborating evidence appears.` : ""}\n\nPERMANENTLY DISABLED TOOLS — NEVER PROPOSE: firecrawl_search, firecrawl_scrape, firecrawl_map (credits exhausted — use jina_reader_scrape + exa_search + minimax_web_search), intelbase_email_lookup (gated due to instability — use oathnet_lookup + leakcheck_lookup + bosint_email_lookup instead). Any pivot naming these tools is dropped automatically.\n\nCOST + COVERAGE RULES:\n- jina_reader_scrape is the #1 single-page scraper — fire it liberally (free). exa_search + minimax_web_search run in parallel for any web search.\n- For every newly-discovered EMAIL, fan out in parallel: breach_check, leakcheck_lookup, hibp_lookup, oathnet_lookup, bosint_email_lookup, hunter_email_verifier, hunter_combined, deepfind_reverse_email, deepfind_disposable_email, stolentax_footprint, emailrep, gravatar_profile, gemini_deep_dork, dork_harvest.\n- For every COMPANY / ORGANIZATION / NAME seed, fan out: hunter_domain_search (on the corp domain), exa_search (category=company / linkedin profile), exa_find_similar (after first profile), gemini_deep_dork, dork_harvest, minimax_web_search, osint_navigator_query (for tool gaps).\n- For every DOMAIN, fan out: whois_lookup, dns_records, crtsh_subdomains, http_fingerprint, hunter_domain_search, urlscan_search, virustotal_lookup, synapsint_lookup, shodan_internetdb, hackertarget, deepfind_ssl_inspect, deepfind_tech_stack.\n- For every IP, fan out: ip_intel, ipgeolocation_lookup, shodan_internetdb, oathnet_lookup, synapsint_lookup, hackertarget, urlscan_search, virustotal_lookup.\n- For every USERNAME / HANDLE, fan out: username_sweep, socialfetch_lookup (tiktok/instagram/twitter/facebook), github_user, reddit_user, hackernews_user, stolentax_footprint, deepfind_reverse_email, gemini_deep_dork, leakcheck_lookup.\n- For every confirmed evidence URL likely to vanish, propose archive_url.\n\nReply ONLY with JSON: {pivots:[{tool:string,args:object,reason:string,priority:number}],skip:[string]}. Order by priority desc. Drop any pivot whose tool is in the disabled list above. Do not propose tools already queried with same args. Respect budget_remaining as the max number of pivots.`,
              user: `Seed: ${seed}\nBudget remaining: ${budget_remaining}\nAlready queried: ${JSON.stringify(already_queried).slice(0,4000)}\nArtifacts so far: ${JSON.stringify(artifacts).slice(0,8000)}`,
              json: true,
              maxTokens: 1500,
            });
            const parsed = safeJson<Record<string, unknown>>(r.content) ?? { raw: r.content };
            // Phase 9 — dark-launched behind GRAPH_PIVOTS_ENABLED (default off):
            // re-rank/filter the planned pivots through the entity graph (drop
            // dead-end / over-broad / already-confirmed targets, cheapest
            // justified first). Off → byte-for-byte the existing behavior; any
            // error falls back to the planner's raw output.
            if (Deno.env.get("GRAPH_PIVOTS_ENABLED") === "true" && Array.isArray((parsed as { pivots?: unknown }).pivots)) {
              try {
                const nodes = buildNodes(artifacts as Array<{ kind: string; value: string }>);
                const { selected, dropped } = selectPivots(
                  (parsed as { pivots: PivotCandidate[] }).pivots,
                  nodes,
                  { budget: budget_remaining },
                );
                (parsed as { pivots: unknown }).pivots = selected;
                if (dropped.length) {
                  console.log(`[graph-pivots] dropped ${dropped.length} pivot(s): ${dropped.map((d) => `${d.tool}:${d.reason}`).join(", ")}`);
                }
              } catch (e) {
                console.warn("[graph-pivots] selection failed, using planner output:", e);
              }
            }
            guard.planCalledInRound = true;
            guard.artifactsSincePlan = 0;
            return { ok: r.ok, status: r.status, plan: parsed };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      intelbase_email_lookup: tool({
        description:
          "IntelBase email lookup (https://api.intelbase.is/lookup/email). Aggregated breach + profile modules. Use as the PRIMARY email enrichment source — unlimited daily lookups on current plan. Run BEFORE oathnet_lookup. Note: breach_check (stolen.tax, 1000/day) is the main breach source and should already have fired via triage_seed.",
        inputSchema: z.object({
          email: z.string(),
          include_data_breaches: z.boolean().optional().default(true),
          timeout_ms: z.number().int().min(1000).max(60000).optional(),
          exclude_modules: z.array(z.string()).optional(),
        }),
        execute: async ({ email, include_data_breaches, timeout_ms, exclude_modules }) => {
          if (!INTELBASE_ENABLED) {
            console.warn("IntelBase skipped — gated due to instability");
            return {
              ok: false,
              skipped: true,
              gated: true,
              reason: "intelbase disabled (provider unhealthy ~33% success). Use breach_check / leakcheck_lookup / oathnet_lookup / bosint_email_lookup instead.",
            };
          }
          const gated = gateStage2("intelbase_email_lookup");
          if (gated) return gated;
          if (!INTELBASE_API_KEY) return { error: "INTELBASE_API_KEY not configured" };
          try {
            const body: Record<string, unknown> = { email, include_data_breaches };
            if (typeof timeout_ms === "number") body.timeout_ms = timeout_ms;
            if (exclude_modules && exclude_modules.length) body.exclude_modules = exclude_modules;
            // Client-side cap honors the caller's requested upstream timeout_ms
            // (also sent in the body) plus a network buffer, so the fetch never
            // aborts a still-pending server-side lookup.
            const r = await fetchT("https://api.intelbase.is/lookup/email", {
              method: "POST",
              headers: {
                "x-api-key": INTELBASE_API_KEY,
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
            }, (typeof timeout_ms === "number" ? timeout_ms : 30_000) + 5_000);
            const text = await r.text();
            let data: unknown;
            try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 8000) }; }
            if (!r.ok) {
              console.warn(`[intelbase_email_lookup] HTTP ${r.status} snippet=${text.slice(0, 300)}`);
              return { error: `intelbase ${r.status}`, status: r.status, snippet: text.slice(0, 300), data };
            }
            return { ok: true, status: r.status, data };
          } catch (e) {
            return { error: String(e) };
          }
        },
      }),
      osint_navigator_query: tool({
        description:
          "OSINT Navigator natural-language tool recommendation (POST https://navigator.indicator.media/api/query). Ask 'which OSINT tools should I use for X?' in plain English and get back a curated list of verified tools with names + URLs. Use when you (the planner) are unsure which third-party tool fits a pivot, or when the user asks for tool recommendations. Returns {answer, tools:[{name,url,...}]}. Rate-limited by tier. Do NOT invent tools — only cite what's returned.",
        inputSchema: z.object({
          query: z.string().describe("Natural-language question, e.g. 'tools to find who registered a domain' or 'image verification tools'"),
          skip_cache: z.boolean().optional().default(false),
        }),
        execute: async ({ query, skip_cache }) => {
          if (!OSINT_NAVIGATOR_API_KEY) return { error: "OSINT_NAVIGATOR_API_KEY not configured" };
          try {
            const r = await fetchRetry("https://navigator.indicator.media/api/query", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${OSINT_NAVIGATOR_API_KEY}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ query, skip_cache }),
            }, { retries: 1 });
            const text = await r.text();
            let data: NavigatorQueryResponse;
            try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 4000) }; }
            if (!r.ok) {
              console.warn(`[osint_navigator_query] HTTP ${r.status} snippet=${text.slice(0, 300)}`);
              return { error: `osint_navigator ${r.status}`, status: r.status, snippet: text.slice(0, 300) };
            }
            // Trim verbose tool records to essentials so context stays small.
            const tools = Array.isArray(data?.tools)
              ? data.tools.slice(0, 12).map((t) => ({
                  id: t?.tool_id ?? t?.id,
                  name: t?.tool_name ?? t?.name ?? t?.title,
                  url: t?.tool_url ?? t?.url ?? t?.homepage ?? t?.link,
                  category: t?.category ?? t?.categories,
                  tags: t?.tags,
                  summary: t?.short_description ?? (typeof t?.description === "string" ? t.description.slice(0, 400) : (t?.summary ?? null)),
                }))
              : data?.tools;
            return { ok: true, answer: data?.answer ?? null, tools, cache: data?.cache ?? data?.cached };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      osint_navigator_search: tool({
        description:
          "OSINT Navigator direct tool-database search (POST https://navigator.indicator.media/api/tools/search). Keyword / category lookup, NOT Q&A. Optional category slugs: domains_websites, social_media, image_video_analysis, geolocation_mapping, transport, companies. Use for browsing alternatives or when you already know the category. Returns a list of verified tools — do NOT invent.",
        inputSchema: z.object({
          query: z.string().describe("Keyword(s), e.g. 'whois', 'archive', 'vessel tracking'"),
          category: z.string().optional().describe("Optional category slug; omit to broaden"),
          limit: z.number().int().min(1).max(25).optional().default(10),
        }),
        execute: async ({ query, category, limit }) => {
          if (!OSINT_NAVIGATOR_API_KEY) return { error: "OSINT_NAVIGATOR_API_KEY not configured" };
          try {
            const body: Record<string, unknown> = { query, limit };
            if (category) body.category = category;
            const r = await fetchRetry("https://navigator.indicator.media/api/tools/search", {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${OSINT_NAVIGATOR_API_KEY}`,
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
            }, { retries: 1 });
            const text = await r.text();
            let data: NavigatorSearchResponse | NavigatorTool[];
            try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 4000) }; }
            if (!r.ok) {
              console.warn(`[osint_navigator_search] HTTP ${r.status} snippet=${text.slice(0, 300)}`);
              return { error: `osint_navigator ${r.status}`, status: r.status, snippet: text.slice(0, 300) };
            }
            const list = Array.isArray(data) ? data : (data?.tools ?? data?.results ?? []);
            const tools = (Array.isArray(list) ? list : []).slice(0, limit ?? 10).map((t) => ({
              id: t?.tool_id ?? t?.id,
              name: t?.tool_name ?? t?.name ?? t?.title,
              url: t?.tool_url ?? t?.url ?? t?.homepage ?? t?.link,
              category: t?.category ?? t?.categories,
              tags: t?.tags,
              summary: t?.short_description ?? (typeof t?.description === "string" ? t.description.slice(0, 400) : (t?.summary ?? null)),
            }));
            return { ok: true, query, category: category ?? null, count: tools.length, tools };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      oathnet_lookup: tool({
        description:
         "Query OathNet. v2 breach search for email/username/phone/domain; geo+ASN for ip. 100 calls/day. Fire ONCE per high-value email/username/phone/domain in parallel with breach_check, leakcheck_lookup, and intelbase_email_lookup (do NOT wait for them to fail). Always fire on every ip seed for geo+ASN. Skip only after ~50 calls this session or an explicit 429.",
        inputSchema: z.object({
          type: z.enum(["email", "username", "phone", "ip", "domain"]),
          value: z.string(),
        }),
        execute: async ({ type, value }) => {
          const gated = gateStage2("oathnet_lookup");
          if (gated) return gated;
          // High-cost: one call per seed unless new corroborating evidence has appeared.
          {
            const last = routingGuard.highCostLastArtifactCount.get("oathnet_lookup");
            if (last !== undefined && routingGuard.artifactsTotal - last < 5) {
              const note = `oathnet_lookup skipped — high-cost tool already used this seed (${routingGuard.artifactsTotal - last} new artifacts since, need ≥5).`;
              console.log(`[high-cost-gate] ${note}`);
              return { ok: false, skipped: true, gated: true, reason: note };
            }
            routingGuard.highCostLastArtifactCount.set("oathnet_lookup", routingGuard.artifactsTotal);
          }
          if (!OATHNET_API_KEY) return { error: "OATHNET_API_KEY not configured" };
          try {
            let url: string;
            if (type === "ip") {
              url = `https://oathnet.org/api/service/ip-info?ip=${encodeURIComponent(value)}`;
            } else {
              const params = new URLSearchParams();
              if (type === "domain") params.set("email_domain", value);
              else params.set("q", value);
              params.set("limit", "50");
              url = `https://oathnet.org/api/service/v2/breach/search?${params.toString()}`;
            }
            const r = await fetchT(url, {
              headers: { "x-api-key": OATHNET_API_KEY },
            }, 20_000);
            const text = await r.text();
            let data: unknown;
            try {
              data = JSON.parse(text);
            } catch {
              data = { raw: text.slice(0, 4000) };
            }
            return { ok: r.ok, status: r.status, data };
          } catch (e) {
            return { error: String(e) };
          }
        },
      }),
      synapsint_lookup: tool({
        description:
          "Synapsint multi-endpoint OSINT aggregator (synapsint.pythonanywhere.com). One tool, many endpoints — pick the right `endpoint` for the seed type. " +
          "Domain endpoints: links, subdomains, dns, waf, tenant (Microsoft), leaks (emails leaked from this domain), whoisd, dmarc, sh (security headers), tls, ranking, pastes (pastebin mentions), dnssec. " +
          "IP endpoints: check (IP info + open ports), rip (reverse-IP shared-hosting neighbors), whoiss. " +
          "ASN endpoint: asn. Email endpoint: email (leaked credentials). CVE endpoint: cve. " +
          "Use as a fast secondary corroboration source for domain/IP/email/CVE/ASN seeds — especially valuable for `rip` (shared hosting), `tenant` (M365 enumeration), `pastes`, and `leaks` which other tools don't cover. Free tier API key; treat quota as generous but not unlimited.",
        inputSchema: z.object({
          endpoint: z.enum([
            "links","asn","check","waf","subdomains","dns","tenant","rip",
            "email","leaks","whoisd","whoiss","cve","dmarc","sh","tls",
            "ranking","pastes","dnssec",
          ]).describe("Which Synapsint endpoint to call."),
          value: z.string().describe("Parameter for the endpoint — domain, ip, asn, email, or CVE id as appropriate."),
        }),
        execute: async ({ endpoint, value }) => {
          if (!SYNAPSINT_API_KEY) return { error: "SYNAPSINT_API_KEY not configured" };
          const deg = isDegraded("synapsint_lookup"); if (deg) return deg;
          try {
            const url = `https://synapsint.pythonanywhere.com/${endpoint}/${encodeURIComponent(value)}`;
            const r = await fetchRetry(url, {
              headers: { "X-API-KEY": SYNAPSINT_API_KEY, "accept": "application/json" },
            }, { retries: 1 });
            const text = await r.text();
            let data: unknown;
            try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 4000) }; }
            if (r.status >= 500) markToolDegraded("synapsint_lookup", `HTTP ${r.status}`);
            return { ok: r.ok, status: r.status, endpoint, value, data };
          } catch (e) {
            markToolDegraded("synapsint_lookup", `network error`);
            return { error: String(e) };
          }
        },
      }),
      socialfetch_lookup: tool({
        description:
          "Query SocialFetch for normalized public social profiles. SUPPORTED platforms ONLY: 'tiktok' | 'instagram' | 'twitter' | 'facebook'. For ANY OTHER platform (youtube, twitch, soundcloud, bandcamp, roblox, github, reddit, linkedin, mastodon, etc.) DO NOT call this tool — prefer `jina_reader_scrape` on the profile URL (cleanest fallback), then `http_fingerprint`, `wayback_snapshots`, or `minimax_web_search`. SocialFetch quota is LOW — if it errors or returns nothing, retry the same profile URL via `jina_reader_scrape` instead of burning more SocialFetch calls. Unsupported platforms return an informative no-op instead of crashing. Use platform='facebook' with a full profile URL; otherwise pass a bare handle. kind='profile' for profile metadata, kind='videos' (TikTok only) for paginated videos.",
        inputSchema: z.object({
          platform: z.string(),
          handle: z.string().describe("Username/handle, or full URL for facebook"),
          kind: z.enum(["profile", "videos"]).default("profile"),
        }),
        execute: async ({ platform, handle, kind }) => {
          const p = String(platform || "").trim().toLowerCase();
          const SUPPORTED = new Set(["tiktok", "instagram", "twitter", "facebook"]);
          if (!SUPPORTED.has(p)) {
            return {
              ok: false,
              skipped: true,
              reason: `socialfetch_lookup does not support platform='${platform}'. Use http_fingerprint on the profile URL, wayback_snapshots, or minimax_web_search instead.`,
              supported: Array.from(SUPPORTED),
            };
          }
          if (!SOCIALFETCH_API_KEY) return { error: "SOCIALFETCH_API_KEY not configured" };
          try {
            let url: string;
            if (p === "facebook") {
              url = `https://api.socialfetch.dev/v1/facebook/profiles?url=${encodeURIComponent(handle)}`;
            } else if (p === "tiktok" && kind === "videos") {
              url = `https://api.socialfetch.dev/v1/tiktok/profiles/${encodeURIComponent(handle)}/videos`;
            } else {
              url = `https://api.socialfetch.dev/v1/${p}/profiles/${encodeURIComponent(handle)}`;
            }
            const r = await fetchT(url, { headers: { "x-api-key": SOCIALFETCH_API_KEY } });
            const text = await r.text();
            let data: unknown;
            try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 4000) }; }
            // SocialFetch returns {error:{code}} on 4xx/5xx; a 200 may still carry a
            // "not found"/"private" outcome in data (a legitimate negative).
            const err = socialfetchError(data);
            return { ok: r.ok && !err, status: r.status, ...(err ? { error_code: err.code } : {}), data };
          } catch (e) {
            return { error: String(e) };
          }
        },
      }),
      bosint_email_lookup: tool({
        description:
          "OSINTNova (Bosint) email exposure check. Surface-level breach + exposure indicators for an email address. Shared 1000 calls/day quota across Bosint endpoints, 120/min. Fire ONCE per email seed and once per newly-confirmed email mid-run, in parallel with the other breach sources. Returns {success, data, api_metadata}.",
        inputSchema: z.object({ email: z.string().describe("Email address to check") }),
        execute: async ({ email }) => {
          if (!OSINTNOVA_API_KEY) return { error: "OSINTNOVA_API_KEY not configured" };
          try {
            const url = `https://app.osintnova.com/bosintapi/${OSINTNOVA_API_KEY}/email/${encodeURIComponent(email)}`;
            const r = await fetchRetry(url, { headers: { "accept": "application/json" } }, { retries: 1 });
            const text = await r.text();
            let data: unknown;
            try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 4000) }; }
            // OSINTNova returns its {success:false} envelope at HTTP 200 on quota/error.
            return { ok: okWithSuccessFlag(r.ok, data), status: r.status, data };
          } catch (e) {
            return { error: String(e) };
          }
        },
      }),
      bosint_phone_lookup: tool({
        description:
          "OSINTNova (Bosint) phone intelligence. Carrier, location, line type, timezone, and associated names when available. Pass full E.164 number with country code (e.g. '+12025551234'). Shared 1000 calls/day quota across Bosint endpoints, 120/min. Fire ONCE per phone seed in parallel with leakcheck_lookup + oathnet_lookup. SLOW upstream — capped at a single 25s attempt; returns a timeout marker if it hangs.",
        inputSchema: z.object({ phone: z.string().describe("Phone number in E.164 format, e.g. +12025551234") }),
        execute: async ({ phone }) => {
          if (!OSINTNOVA_API_KEY) return { error: "OSINTNOVA_API_KEY not configured" };
          const cleaned = phone.trim();
          const url = `https://app.osintnova.com/bosintapi/${OSINTNOVA_API_KEY}/phone/${encodeURIComponent(cleaned)}`;
          // Single strict 25s attempt — no retry. The old 25s + 10s backoff +
          // 25s retry pushed the worst case to 60s and stalled interactive
          // scans for a full minute (observed in prod). The phone is already
          // covered by leakcheck_lookup + oathnet_lookup, so a hung OSINTNova
          // isn't worth the wait.
          const attemptOnce = async (signal: AbortSignal) => {
            const r = await fetch(url, { headers: { accept: "application/json" }, signal });
            const text = await r.text();
            let data: unknown;
            try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 4000) }; }
            // Same OSINTNova {success:false}-at-200 contract as the email endpoint.
            return { ok: okWithSuccessFlag(r.ok, data), status: r.status, data };
          };
          const runWithTimeout = async (ms: number) => {
            const ctrl = new AbortController();
            const tid = setTimeout(() => ctrl.abort(), ms);
            try { return await attemptOnce(ctrl.signal); }
            finally { clearTimeout(tid); }
          };
          try {
            return await runWithTimeout(25_000);
          } catch {
            console.warn("bosint_phone_lookup timed out — using fallback sources only");
            return { error: "bosint_phone_timeout", skipped: true, hint: "leakcheck_lookup + oathnet_lookup cover this phone." };
          }
        },
      }),
      cordcat_discord_lookup: tool({
        description:
          "CordCat Discord OSINT lookup. Given a 17-20 digit Discord snowflake user ID, returns the full Discord profile (username, global_name, avatar, banner, public_flags), DSA sanction statements, breach hits, and FiveM records in one call. ONLY accepts a numeric snowflake — NOT a Discord username/tag. If you only have a username, extract the snowflake first (jina_reader_scrape on a profile page, message link, or invite, or via discord.id-style lookups). Free plan budget: 60 req/hour — do not spam.",
        inputSchema: z.object({
          discord_id: z.string().regex(/^\d{17,20}$/, "Must be a 17-20 digit Discord snowflake ID"),
        }),
        execute: async ({ discord_id }) => {
          if (!CORDCAT_API_KEY) return { error: "CORDCAT_API_KEY not configured" };
          try {
            const r = await fetchRetry(
              `https://api.cord.cat/api/v2/query/${encodeURIComponent(discord_id)}`,
              { headers: { "X-API-Key": CORDCAT_API_KEY, "Accept": "application/json" } },
            );
            const text = await r.text();
            let data: unknown;
            try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 4000) }; }
            return {
              ok: r.ok,
              status: r.status,
              rate_remaining: r.headers.get("X-RateLimit-Remaining") ?? undefined,
              rate_reset: r.headers.get("X-RateLimit-Reset") ?? undefined,
              data,
            };
          } catch (e) {
            return { error: String(e) };
          }
        },
      }),
      breach_check: tool({
        description:
          "Check whether an email or username appears in public breach datasets. Primary source: stolen.tax — fans out in parallel to (a) OsintCat `database-search` (returns site+password combos), (b) Snusbase (returns identity records: name/phone/address/DOB), and (c) OsintCat plain `breach` mode. Returns combined hit count + per-source raw data. Falls back to the leakcheck public endpoint if stolen.tax is unavailable. Pass `email` for email seeds or `value` for usernames/other identifiers.",
        inputSchema: z.object({
          email: z.string().min(1).optional(),
          value: z.string().min(1).optional(),
        }).refine((v) => !!(v.email || v.value), { message: "Provide `email` or `value`" }),
        execute: async ({ email, value }) => {
          const query = (email ?? value ?? "").trim();
          if (!query) return { error: "missing query" };
          const STOLENTAX_API_KEY = Deno.env.get("STOLENTAX_API_KEY");
          // Primary: stolen.tax — fan out to the three highest-yield endpoints in parallel.
          // The previous implementation only hit OsintCat mode=breach, which on this
          // account returns results_count:0 for nearly every query. The actual breach
          // data lives in mode=database-search and in the snusbase endpoint.
          if (STOLENTAX_API_KEY) {
            const callStolen = async (path: string, body: Record<string, unknown>) => {
              try {
                const r = await fetchT(
                  `https://stolen.tax/api/v2/index.php?path=${encodeURIComponent(path)}`,
                  {
                    method: "POST",
                    headers: {
                      "Authorization": `Bearer ${STOLENTAX_API_KEY}`,
                      "X-API-Key": STOLENTAX_API_KEY,
                      "Content-Type": "application/json",
                    },
                    body: JSON.stringify(body),
                  },
                  20_000,
                );
                const text = await r.text();
                let parsed: unknown;
                try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 4000) }; }
                return { ok: r.ok, status: r.status, parsed };
              } catch (e) {
                return { ok: false, status: 0, parsed: { error: String(e) } };
              }
            };
            // Snusbase auto-detects record snusbase results; record_count comes back as `size` or `results` map.
            const [dbSearch, snus, breachLegacy] = await Promise.all([
              callStolen("osintcat", { query, osintcat_mode: "database-search" }),
              callStolen("snusbase", { query }),
              callStolen("osintcat", { query, osintcat_mode: "breach" }),
            ]);

            // ---- Parse each source into a hit count ----
            // Only the fields we count off each source are typed; everything
            // else stays `unknown` behind the index signature.
            interface StolenData {
              results?: unknown;
              size?: number;
              breach_data?: unknown;
              results_count?: number;
              [k: string]: unknown;
            }
            interface StolenParsed {
              data?: StolenData;
              [k: string]: unknown;
            }
            const dbResults = (dbSearch.parsed as StolenParsed)?.data?.results;
            const dbHits = Array.isArray(dbResults) ? dbResults.length : 0;

            const snusRoot: StolenData = (snus.parsed as StolenParsed)?.data ?? {};
            const snusResultsObj = snusRoot.results ?? {};
            let snusHits = 0;
            const snusSources: string[] = [];
            if (snusResultsObj && typeof snusResultsObj === "object") {
              for (const [srcName, rows] of Object.entries(snusResultsObj)) {
                if (Array.isArray(rows)) {
                  snusHits += rows.length;
                  snusSources.push(srcName);
                }
              }
            }
            if (snusHits === 0 && typeof snusRoot.size === "number") snusHits = snusRoot.size;

            const brRoot: StolenData = (breachLegacy.parsed as StolenParsed)?.data ?? {};
            let brHits = 0;
            const breachData = brRoot.breach_data;
            if (Array.isArray(breachData)) {
              brHits = breachData.length;
            } else if (breachData && typeof breachData === "object") {
              // Some osintcat breach responses key results by source (an object
              // map) rather than a flat array. Sum the per-source array lengths
              // so those hits are counted instead of silently dropped to 0 — same
              // shape handling already applied to snusbase above.
              for (const rows of Object.values(breachData)) {
                if (Array.isArray(rows)) brHits += rows.length;
              }
            }
            if (brHits === 0 && typeof brRoot.results_count === "number") brHits = brRoot.results_count;

            const totalHits = dbHits + snusHits + brHits;
            const anyOk = dbSearch.ok || snus.ok || breachLegacy.ok;

            if (anyOk) {
              return {
                ok: true,
                source: "stolen.tax (osintcat database-search + snusbase + breach)",
                data: {
                  success: totalHits > 0,
                  found: totalHits,
                  per_source: {
                    osintcat_database_search: { ok: dbSearch.ok, hits: dbHits, sample: Array.isArray(dbResults) ? dbResults.slice(0, 25) : [] },
                    snusbase: { ok: snus.ok, hits: snusHits, sources: snusSources, sample_keys: snusSources.slice(0, 10), data_size: snusRoot.size ?? null },
                    osintcat_breach: { ok: breachLegacy.ok, hits: brHits },
                  },
                  // Keep raw payloads (truncated) for the agent / minimax_extract.
                  raw: {
                    osintcat_database_search: dbSearch.parsed,
                    snusbase: snus.parsed,
                    // Retain breach-mode payload too — otherwise breach-only hits
                    // keep a count but lose their actual records downstream.
                    osintcat_breach: breachLegacy.parsed,
                  },
                },
              };
            }
            // All three failed: fall through to leakcheck public.
          }
          // Fallback: legacy leakcheck public endpoint.
          try {
            const r = await fetchT(
              `https://leakcheck.io/api/public?check=${encodeURIComponent(query)}`,
            );
            const data = await r.json().catch(() => ({}));
            // leakcheck public signals failure via {success:false} at HTTP 200.
            return { ok: okWithSuccessFlag(r.ok, data), source: "leakcheck.public", data };
          } catch (e) {
            return { error: String(e) };
          }
        },
      }),
      stolentax_footprint: tool({
        description:
          "stolen.tax OsintCat-Footprint — account-discovery sweep across ~127 sites for an email or username. Returns per-site presence + extra account metadata (display name, user_id, plan, SSO providers, password-set flag, etc.). Complements deepfind_reverse_email (different site list) and is higher-fidelity per hit. Same 1000/day stolen.tax budget as breach_check.",
        inputSchema: z.object({
          value: z.string().min(1),
          type: z.enum(["auto", "email", "username"]).default("auto"),
        }),
        execute: async ({ value, type }) => {
          const STOLENTAX_API_KEY = Deno.env.get("STOLENTAX_API_KEY");
          if (!STOLENTAX_API_KEY) return { error: "STOLENTAX_API_KEY not configured" };
          const q = value.trim();
          if (!q) return { error: "missing value" };
          // Auto-detect: contains '@' -> email, else username.
          const ft = type === "auto" ? (q.includes("@") ? "email" : "username") : type;
          try {
            // 127-site account-discovery sweep — legitimately slow upstream.
            const r = await fetchT(
              "https://stolen.tax/api/v2/index.php?path=osintcat-footprint",
              {
                method: "POST",
                headers: {
                  "Authorization": `Bearer ${STOLENTAX_API_KEY}`,
                  "X-API-Key": STOLENTAX_API_KEY,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ query: q, footprint_type: ft }),
              },
              25_000,
            );
            const text = await r.text();
            let parsed: StolenTaxResponse;
            try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 4000) }; }
            const d = parsed?.data ?? {};
            const taken = Array.isArray(d?.results)
              ? d.results.filter((x) => x?.taken === true).map((x) => ({ domain: x.domain, extra: x.ExtraData ?? null }))
              : [];
            return {
              ok: r.ok,
              status: r.status,
              source: "stolen.tax/osintcat-footprint",
              footprint_type: ft,
              stats: d?.stats ?? null,
              taken_count: taken.length,
              taken,
              raw: parsed,
            };
          } catch (e) {
            return { error: String(e) };
          }
        },
      }),
      leakcheck_lookup: tool({
        description:
          "LeakCheck Pro v2 breach lookup (https://leakcheck.io/api/v2). SECONDARY breach source — 200 calls/day. Returns leak sources, breach dates, and (where present) passwords/usernames for an email, username, phone, hash, or domain. Use to corroborate breach_check and to surface password/source detail. Do NOT spam on low-value handles.",
        inputSchema: z.object({
          value: z.string().min(1),
          type: z.enum(["auto","email","username","phone","hash","domain","keyword"]).optional().default("auto"),
        }),
        execute: async ({ value, type }) => {
          const LEAKCHECK_API_KEY = Deno.env.get("LEAKCHECK_API_KEY");
          if (!LEAKCHECK_API_KEY) return { error: "LEAKCHECK_API_KEY not configured" };
          const q = value.trim();
          if (!q) return { error: "missing value" };
          // High-cost: one call per seed unless new corroborating evidence has appeared.
          {
            const last = routingGuard.highCostLastArtifactCount.get("leakcheck_lookup");
            if (last !== undefined && routingGuard.artifactsTotal - last < 5) {
              const note = `leakcheck_lookup skipped — high-cost tool already used this seed (${routingGuard.artifactsTotal - last} new artifacts since, need ≥5).`;
              console.log(`[high-cost-gate] ${note}`);
              return { ok: false, skipped: true, gated: true, reason: note };
            }
            routingGuard.highCostLastArtifactCount.set("leakcheck_lookup", routingGuard.artifactsTotal);
          }
          try {
            const url = `https://leakcheck.io/api/v2/query/${encodeURIComponent(q)}?type=${encodeURIComponent(type ?? "auto")}`;
            const r = await fetchT(url, { headers: { "X-API-Key": LEAKCHECK_API_KEY, "Accept": "application/json" } }, 20_000);
            const text = await r.text();
            interface LeakCheckResult {
              source?: { name?: string; [k: string]: unknown };
              [k: string]: unknown;
            }
            interface LeakCheckResponse {
              found?: number;
              quota?: number;
              success?: boolean;
              result?: LeakCheckResult[];
              [k: string]: unknown;
            }
            let data: unknown;
            try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 4000) }; }
            const d = data as LeakCheckResponse;
            const found = (typeof d?.found === "number" ? d.found : Array.isArray(d?.result) ? d.result.length : 0);
            const quota = typeof d?.quota === "number" ? d.quota : undefined;
            const sources = Array.isArray(d?.result)
              ? Array.from(new Set(d.result.map((x: LeakCheckResult) => x?.source?.name).filter(Boolean))).slice(0, 50)
              : [];
            return { ok: r.ok, status: r.status, source: "leakcheck.v2", data: { success: !!d?.success, found, quota, sources, raw: data } };
          } catch (e) {
            return { error: String(e) };
          }
        },
      }),
      hibp_lookup: tool({
        description:
          "Have I Been Pwned v3 breach + paste lookup (https://haveibeenpwned.com/api/v3). Authoritative breach corroboration — Troy Hunt's curated breach corpus. Returns breach metadata (name, domain, breach date, data classes). Requires HIBP_API_KEY (paid Pwned subscription). Rate: 1 req / 1.5s per key. Use to corroborate breach_check / leakcheck_lookup on confirmed emails.",
        inputSchema: z.object({
          email: z.string().email(),
          include_pastes: z.boolean().optional().default(false),
          truncate: z.boolean().optional().default(false).describe("If true, only breach names are returned (smaller payload)."),
        }),
        execute: async ({ email, include_pastes, truncate }) => {
          if (!HIBP_API_KEY) return { error: "HIBP_API_KEY not configured", skipped: true };
          const headers = {
            "hibp-api-key": HIBP_API_KEY,
            "user-agent": "lovable-osint-agent",
            "Accept": "application/json",
          };
          try {
            const bUrl = `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=${truncate ? "true" : "false"}`;
            const br = await fetchRetry(bUrl, { headers }, { retries: 1 });
            let breaches: unknown = null;
            if (br.status === 404) breaches = [];
            else if (br.ok) breaches = await br.json().catch(() => null);
            else return { error: `hibp breaches ${br.status}`, status: br.status };
            let pastes: unknown = null;
            if (include_pastes) {
              const pr = await fetchRetry(
                `https://haveibeenpwned.com/api/v3/pasteaccount/${encodeURIComponent(email)}`,
                { headers },
                { retries: 1 },
              );
              if (pr.status === 404) pastes = [];
              else if (pr.ok) pastes = await pr.json().catch(() => null);
            }
            const breachCount = Array.isArray(breaches) ? breaches.length : 0;
            const pasteCount = Array.isArray(pastes) ? (pastes as unknown[]).length : 0;
            return { ok: true, source: "hibp.v3", data: { breachCount, pasteCount, breaches, pastes } };
          } catch (e) {
            return { error: String(e) };
          }
        },
      }),
      // ===== DeepFind.Me suite (shared 1000/day budget, 25 req/min) =====
      deepfind_reverse_email: tool({
        description:
          "DeepFind.Me reverse-email account discovery (https://deepfind.me) — checks ~120 services for accounts registered to an email address. Returns service hits plus partial email/phone recovery hints. Shared DeepFind budget: 1000 calls/day.",
        inputSchema: z.object({ email: z.string().email() }),
        execute: async ({ email }) => {
          const KEY = Deno.env.get("DEEPFIND_API_KEY");
          if (!KEY) return { error: "DEEPFIND_API_KEY not configured" };
          try {
            const r = await fetchT(`https://deepfind.me/api/tools/reverse-email-check?email=${encodeURIComponent(email)}`, {
              headers: { "X-DFME-API-KEY": KEY, "Accept": "application/json" },
            });
            const data = await r.json().catch(() => ({}));
            return { ok: r.ok, status: r.status, source: "deepfind.reverse_email", data };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      deepfind_disposable_email: tool({
        description:
          "DeepFind.Me disposable/burner email detector. Flags temp-mail providers via known-list + MX heuristics. Use to grade email credibility before pivoting.",
        inputSchema: z.object({ email: z.string().email() }),
        execute: async ({ email }) => {
          const KEY = Deno.env.get("DEEPFIND_API_KEY");
          if (!KEY) return { error: "DEEPFIND_API_KEY not configured" };
          try {
            const r = await fetchT(`https://deepfind.me/api/disposable-email/check/${encodeURIComponent(email)}`, {
              headers: { "X-DFME-API-KEY": KEY, "Accept": "application/json" },
            });
            const data = await r.json().catch(() => ({}));
            return { ok: r.ok, status: r.status, source: "deepfind.disposable", data };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      deepfind_ransomware_exposure: tool({
        description:
          "DeepFind.Me ransomware leak-site exposure check. Searches ransomware group leak sites for a domain, email, or identifier. High-signal for breach/extortion context.",
        inputSchema: z.object({ query: z.string().min(3) }),
        execute: async ({ query }) => {
          const KEY = Deno.env.get("DEEPFIND_API_KEY");
          if (!KEY) return { error: "DEEPFIND_API_KEY not configured" };
          try {
            const r = await fetchT(`https://deepfind.me/api/ransomware-exposure`, {
              method: "POST",
              headers: { "X-DFME-API-KEY": KEY, "Content-Type": "application/json", "Accept": "application/json" },
              body: JSON.stringify({ query }),
            });
            const data = await r.json().catch(() => ({}));
            return { ok: r.ok, status: r.status, source: "deepfind.ransomware", data };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      deepfind_ssl_inspect: tool({
        description:
          "DeepFind.Me SSL/TLS certificate inspector. Returns issuer, validity window, SANs, key size, protocol, cipher, and misconfig warnings for a domain.",
        inputSchema: z.object({ domain: z.string().min(3) }),
        execute: async ({ domain }) => {
          const KEY = Deno.env.get("DEEPFIND_API_KEY");
          if (!KEY) return { error: "DEEPFIND_API_KEY not configured" };
          if (isHostDead(domain)) return { skipped: true, reason: "host does not resolve (NXDOMAIN) — skipped" };
          try {
            const r = await fetchT(`https://deepfind.me/api/ssl-certificate`, {
              method: "POST",
              headers: { "X-DFME-API-KEY": KEY, "Content-Type": "application/json", "Accept": "application/json" },
              body: JSON.stringify({ domain }),
            });
            const data = await r.json().catch(() => ({}));
            return { ok: r.ok, status: r.status, source: "deepfind.ssl", data };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      deepfind_tech_stack: tool({
        description:
          "DeepFind.Me tech-stack detector. Identifies CMS, frameworks, analytics, CDN, server tech for a URL. Useful for domain/url seeds.",
        inputSchema: z.object({ url: z.string().min(3) }),
        execute: async ({ url }) => {
          const KEY = Deno.env.get("DEEPFIND_API_KEY");
          if (!KEY) return { error: "DEEPFIND_API_KEY not configured" };
          const deg = isDegraded("deepfind_tech_stack"); if (deg) return deg;
          if (isHostDead(url)) return { skipped: true, reason: "host does not resolve (NXDOMAIN) — skipped" };
          try {
            const r = await fetchT(`https://deepfind.me/api/tech-stack/detect`, {
              method: "POST",
              headers: { "X-DFME-API-KEY": KEY, "Content-Type": "application/json", "Accept": "application/json" },
              body: JSON.stringify({ url }),
            });
            const data = await r.json().catch(() => ({}));
            if (r.status >= 500) markToolDegraded("deepfind_tech_stack", `HTTP ${r.status}`);
            return { ok: r.ok, status: r.status, source: "deepfind.tech_stack", data };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      deepfind_url_unshorten: tool({
        description:
          "DeepFind.Me URL unshortener. Follows full redirect chain for short URLs (bit.ly, t.co, etc) and returns final destination + safety signal.",
        inputSchema: z.object({ url: z.string().min(3) }),
        execute: async ({ url }) => {
          const KEY = Deno.env.get("DEEPFIND_API_KEY");
          if (!KEY) return { error: "DEEPFIND_API_KEY not configured" };
          try {
            const r = await fetchT(`https://deepfind.me/api/url-unshortener/expand`, {
              method: "POST",
              headers: { "X-DFME-API-KEY": KEY, "Content-Type": "application/json", "Accept": "application/json" },
              body: JSON.stringify({ url }),
            });
            const data = await r.json().catch(() => ({}));
            return { ok: r.ok, status: r.status, source: "deepfind.unshorten", data };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      deepfind_profile_analyzer: tool({
        description:
          "DeepFind.Me deep profile analyzer — scans ~350 sites for a username (much wider than the local username_sweep's ~95). Use when the local sweep returns weak coverage or for high-value handles. Slow; one call burns ~1 minute on DeepFind's side.",
        inputSchema: z.object({ username: z.string().min(1) }),
        execute: async ({ username }) => {
          const KEY = Deno.env.get("DEEPFIND_API_KEY");
          if (!KEY) return { error: "DEEPFIND_API_KEY not configured" };
          try {
            const r = await fetchT(`https://deepfind.me/api/analyzer/${encodeURIComponent(username)}`, {
              headers: { "X-DFME-API-KEY": KEY, "Accept": "application/json" },
            });
            interface DeepFindSite {
              status?: string;
              site?: string;
              name?: string;
              url?: string;
              profile_url?: string;
              username?: string;
              [k: string]: unknown;
            }
            interface DeepFindAnalyzerResponse {
              sites?: DeepFindSite[];
              summary?: unknown;
              [k: string]: unknown;
            }
            const data = await r.json().catch(() => ({}));
            const d = data as DeepFindAnalyzerResponse;
            // Drop the long tail of "not found" sites (most of the ~350) — they
            // burn tokens without adding signal. Keep only confirmed hits.
            const allSites: DeepFindSite[] = Array.isArray(d?.sites) ? d.sites : [];
            const foundSites = allSites
              .filter((s: DeepFindSite) => s?.status === "found")
              .slice(0, 120)
              .map((s: DeepFindSite) => ({
                site: s?.site ?? s?.name,
                url: s?.url ?? s?.profile_url,
                username: s?.username,
              }));
            return {
              ok: r.ok,
              status: r.status,
              source: "deepfind.analyzer",
              data: {
                hits: allSites.filter((s: DeepFindSite) => s?.status === "found").length,
                scanned: allSites.length,
                summary: d?.summary,
                sites: foundSites,
                truncated_not_found: true,
              },
            };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      deepfind_telegram_channel: tool({
        description:
          "DeepFind.Me Telegram channel lookup. Returns channel metadata + recent visible messages for a public Telegram handle.",
        inputSchema: z.object({ handle: z.string().min(1) }),
        execute: async ({ handle }) => {
          const KEY = Deno.env.get("DEEPFIND_API_KEY");
          if (!KEY) return { error: "DEEPFIND_API_KEY not configured" };
          const clean = handle.replace(/^@/, "").replace(/^https?:\/\/t\.me\//i, "").replace(/^s\//, "");
          try {
            const r = await fetchT(`https://deepfind.me/api/telegram-osint/channel`, {
              method: "POST",
              headers: { "X-DFME-API-KEY": KEY, "Content-Type": "application/json", "Accept": "application/json" },
              body: JSON.stringify({ handle: clean }),
            });
            const data = await r.json().catch(() => ({}));
            return { ok: r.ok, status: r.status, source: "deepfind.telegram_channel", data };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      deepfind_telegram_search: tool({
        description:
          "DeepFind.Me Telegram channel keyword search — discover public channels matching a topic.",
        inputSchema: z.object({ query: z.string().min(2) }),
        execute: async ({ query }) => {
          const KEY = Deno.env.get("DEEPFIND_API_KEY");
          if (!KEY) return { error: "DEEPFIND_API_KEY not configured" };
          try {
            const r = await fetchT(`https://deepfind.me/api/telegram-osint/search`, {
              method: "POST",
              headers: { "X-DFME-API-KEY": KEY, "Content-Type": "application/json", "Accept": "application/json" },
              body: JSON.stringify({ query }),
            });
            const data = await r.json().catch(() => ({}));
            return { ok: r.ok, status: r.status, source: "deepfind.telegram_search", data };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      deepfind_vin_lookup: tool({
        description:
          "DeepFind.Me VIN decoder (17-char VIN → NHTSA vPIC vehicle specs + safety recalls).",
        inputSchema: z.object({ vin: z.string().length(17) }),
        execute: async ({ vin }) => {
          const KEY = Deno.env.get("DEEPFIND_API_KEY");
          if (!KEY) return { error: "DEEPFIND_API_KEY not configured" };
          try {
            const r = await fetchT(`https://deepfind.me/api/vin-lookup`, {
              method: "POST",
              headers: { "X-DFME-API-KEY": KEY, "Content-Type": "application/json", "Accept": "application/json" },
              body: JSON.stringify({ vin }),
            });
            const data = await r.json().catch(() => ({}));
            return { ok: r.ok, status: r.status, source: "deepfind.vin", data };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      deepfind_aircraft_lookup: tool({
        description:
          "DeepFind.Me FAA N-Number lookup (US-registered aircraft → owner of record, airworthiness, engine).",
        inputSchema: z.object({ nNumber: z.string().min(2) }),
        execute: async ({ nNumber }) => {
          const KEY = Deno.env.get("DEEPFIND_API_KEY");
          if (!KEY) return { error: "DEEPFIND_API_KEY not configured" };
          try {
            const r = await fetchT(`https://deepfind.me/api/us-aircraft-lookup`, {
              method: "POST",
              headers: { "X-DFME-API-KEY": KEY, "Content-Type": "application/json", "Accept": "application/json" },
              body: JSON.stringify({ nNumber }),
            });
            const data = await r.json().catch(() => ({}));
            return { ok: r.ok, status: r.status, source: "deepfind.aircraft", data };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      deepfind_vessel_lookup: tool({
        description:
          "DeepFind.Me vessel lookup (7-digit IMO or 9-digit MMSI → vessel identity, dimensions, build, ownership).",
        inputSchema: z.object({ identifier: z.string().min(7).max(9) }),
        execute: async ({ identifier }) => {
          const KEY = Deno.env.get("DEEPFIND_API_KEY");
          if (!KEY) return { error: "DEEPFIND_API_KEY not configured" };
          try {
            const r = await fetchT(`https://deepfind.me/api/vessel-lookup`, {
              method: "POST",
              headers: { "X-DFME-API-KEY": KEY, "Content-Type": "application/json", "Accept": "application/json" },
              body: JSON.stringify({ identifier }),
            });
            const data = await r.json().catch(() => ({}));
            return { ok: r.ok, status: r.status, source: "deepfind.vessel", data };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      deepfind_mac_lookup: tool({
        description:
          "DeepFind.Me MAC address → manufacturer / OUI / address type lookup.",
        inputSchema: z.object({ macAddress: z.string().min(6) }),
        execute: async ({ macAddress }) => {
          const KEY = Deno.env.get("DEEPFIND_API_KEY");
          if (!KEY) return { error: "DEEPFIND_API_KEY not configured" };
          try {
            const r = await fetchT(`https://deepfind.me/api/mac-lookup`, {
              method: "POST",
              headers: { "X-DFME-API-KEY": KEY, "Content-Type": "application/json", "Accept": "application/json" },
              body: JSON.stringify({ macAddress }),
            });
            const data = await r.json().catch(() => ({}));
            return { ok: r.ok, status: r.status, source: "deepfind.mac", data };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      deepfind_dark_web_link: tool({
        description:
          "DeepFind.Me .onion validator — verifies V2/V3 format and checks DeepFind's 18k+ known-service database.",
        inputSchema: z.object({ url: z.string().min(6) }),
        execute: async ({ url }) => {
          const KEY = Deno.env.get("DEEPFIND_API_KEY");
          if (!KEY) return { error: "DEEPFIND_API_KEY not configured" };
          try {
            const r = await fetchT(`https://deepfind.me/api/dark-web-link`, {
              method: "POST",
              headers: { "X-DFME-API-KEY": KEY, "Content-Type": "application/json", "Accept": "application/json" },
              body: JSON.stringify({ url }),
            });
            const data = await r.json().catch(() => ({}));
            return { ok: r.ok, status: r.status, source: "deepfind.darkweb", data };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      virustotal_lookup: tool({
        description:
          "VirusTotal v3 lookup (https://www.virustotal.com/api/v3). Returns reputation, detections, categories, WHOIS, resolutions, and community votes for a file hash (md5/sha1/sha256), URL, domain, or IP. Public-API quota: 4 req/min, 500/day — use sparingly on high-value artifacts only. Returns the `attributes.last_analysis_stats` (harmless/malicious/suspicious/undetected) plus category and reputation.",
        inputSchema: z.object({
          kind: z.enum(["file", "url", "domain", "ip"]),
          value: z.string().min(3),
        }),
        execute: async ({ kind, value }) => {
          const KEY = Deno.env.get("VIRUSTOTAL_API_KEY");
          if (!KEY) return { error: "VIRUSTOTAL_API_KEY not configured" };
          const v = value.trim();
          let path: string;
          if (kind === "file") {
            path = `files/${encodeURIComponent(v)}`;
          } else if (kind === "url") {
            // VT requires base64url-encoded URL ID (no padding). Encode UTF-8
            // first — bare btoa() throws InvalidCharacterError on any non-ASCII
            // code point (IDN/Unicode URLs are common in phishing cases), which
            // would silently surface as a generic VT failure.
            const bytes = new TextEncoder().encode(v);
            let bin = "";
            for (const byte of bytes) bin += String.fromCharCode(byte);
            const b64 = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
            path = `urls/${b64}`;
          } else if (kind === "domain") {
            path = `domains/${encodeURIComponent(v)}`;
          } else {
            path = `ip_addresses/${encodeURIComponent(v)}`;
          }
          try {
            const r = await fetchT(`https://www.virustotal.com/api/v3/${path}`, {
              headers: { "x-apikey": KEY, "Accept": "application/json" },
            });
            interface VirusTotalResponse {
              data?: { attributes?: Record<string, unknown>; [k: string]: unknown };
              [k: string]: unknown;
            }
            const data = await r.json().catch(() => ({}));
            const attrs: Record<string, unknown> = (data as VirusTotalResponse)?.data?.attributes ?? {};
            return {
              ok: r.ok,
              status: r.status,
              source: "virustotal.v3",
              data: {
                stats: attrs.last_analysis_stats,
                reputation: attrs.reputation,
                total_votes: attrs.total_votes,
                categories: attrs.categories,
                last_analysis_date: attrs.last_analysis_date,
                whois: attrs.whois ? String(attrs.whois).slice(0, 2000) : undefined,
                tags: attrs.tags,
                meaningful_name: attrs.meaningful_name,
                magic: attrs.magic,
                type_description: attrs.type_description,
                raw: data,
              },
            };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      ipgeolocation_lookup: tool({
        description:
          "IPGeolocation.io enrichment for an IP (https://api.ipgeolocation.io). Returns geo, ISP, organization, ASN, connection type (residential/mobile/dch/etc), currency, timezone, calling code. Use as a SECONDARY corroborating source after ip_intel — they agree → high confidence; they disagree → flag VPN/proxy. Free tier: 1000/day.",
        inputSchema: z.object({ ip: z.string().min(3) }),
        execute: async ({ ip }) => {
          const KEY = Deno.env.get("IPGEOLOCATION_API_KEY");
          if (!KEY) return { error: "IPGEOLOCATION_API_KEY not configured" };
          try {
            const r = await fetchT(`https://api.ipgeolocation.io/ipgeo?apiKey=${encodeURIComponent(KEY)}&ip=${encodeURIComponent(ip)}`, {
              headers: { "Accept": "application/json" },
            });
            const data = await r.json().catch(() => ({}));
            return { ok: r.ok, status: r.status, source: "ipgeolocation.io", data };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      ip_intel: tool({
        description: "Geolocate an IP and return ISP, ASN, city, country.",
        inputSchema: z.object({ ip: z.string() }),
        execute: async ({ ip }) => {
          try {
            const r = await fetchT(
              `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,regionName,city,zip,lat,lon,timezone,isp,org,as,mobile,proxy,hosting,query`,
            );
            const data = await r.json().catch(() => ({ status: "fail", message: "non-JSON response from ip-api" })) as {
              status?: string;
              message?: string;
              isp?: string;
              org?: string;
              as?: string;
              [k: string]: unknown;
            };
            // ip-api.com returns HTTP 200 even on failure; the real outcome is in
            // `status`. Treat anything other than "success" (reserved/invalid IP,
            // rate-limit) as a failed lookup so empty geo can't masquerade as a
            // valid "origin" result and poison the CDN / agreement logic downstream.
            if (!r.ok || data.status !== "success") {
              return { ok: false, status: r.status, error: data.message ?? "ip-api lookup failed", query: ip };
            }
            // Reframe results when the IP belongs to a major CDN/edge network —
            // geolocation reflects the edge POP, NOT the actual origin host.
            const blob = `${data?.isp ?? ""} ${data?.org ?? ""} ${data?.as ?? ""}`.toLowerCase();
            const cdnHit = /cloudflare|akamai|fastly|amazon|aws|google\b|googleusercontent|microsoft|azure|incapsula|sucuri|stackpath|cdn77|bunny/.exec(blob);
            if (cdnHit) {
              return {
                ...data,
                cdn: true,
                cdn_provider: cdnHit[0],
                location_kind: "cdn_edge",
                note: `IP belongs to ${cdnHit[0]} edge network — geo reflects CDN POP, not the actual origin server. Origin remains hidden.`,
              };
            }
            return { ...data, location_kind: "origin" };
          } catch (e) {
            return { error: String(e) };
          }
        },
      }),
      whois_lookup: tool({
        description: "RDAP/WHOIS lookup for a domain.",
        inputSchema: z.object({ domain: z.string() }),
        execute: async ({ domain }) => {
          try {
            const r = await fetchT(`https://rdap.org/domain/${encodeURIComponent(domain)}`);
            const data = await r.json().catch(() => ({}));
            return { ok: r.ok, data };
          } catch (e) {
            return { error: String(e) };
          }
        },
      }),
      username_sweep: tool({
        // Until then this is the edge-native built-in sweep.
        description:
          "Built-in Username Sweep: parallel HTTP existence check across ~95 platforms for a handle. Returns the list of sites where the handle resolves. Only call this on a handle with NO spaces. Do NOT call it on a full name or name+location seed — derive candidate handles first.",
        inputSchema: z.object({ username: z.string().min(1) }),
        execute: async ({ username }) => {
          if (/\s/.test(username.trim())) {
            return {
              ok: false,
              skipped: true,
              reason: "username_sweep requires a handle with no spaces; derive candidate handles first (firstlast, first.last, flast, etc.)",
              username,
            };
          }
          return await sweepUsername(username);
        },
      }),
      username_search: tool({
        description: "Alias of username_sweep: same edge-native ~95-site existence check. Same no-spaces rule applies.",
        inputSchema: z.object({ username: z.string().min(1) }),
        execute: async ({ username }) => {
          if (/\s/.test(username.trim())) {
            return {
              ok: false,
              skipped: true,
              reason: "username_search requires a handle with no spaces; derive candidate handles first",
              username,
            };
          }
          return await sweepUsername(username);
        },
      }),
      crtsh_subdomains: tool({
        description: "Enumerate subdomains for a domain via crt.sh certificate transparency logs.",
        inputSchema: z.object({ domain: z.string() }),
        execute: async ({ domain }) => {
          try {
            const r = await fetchT(`https://crt.sh/?q=%25.${encodeURIComponent(domain)}&output=json`, {}, 12_000);
            const data = (await r.json().catch(() => null)) as Array<{ name_value?: string }> | null;
            if (!isCrtshOk(r.ok, data)) return { ok: false, status: r.status, error: r.ok ? "crt.sh returned non-JSON (likely an error/overload page)" : `crt.sh ${r.status}`, domain };
            const arr = data as Array<{ name_value?: string }>;
            const subs = Array.from(new Set(arr.flatMap((d) => (d.name_value ?? "").split("\n")).map((s) => s.trim().toLowerCase()).filter(Boolean))).slice(0, 200);
            return { ok: true, domain, count: subs.length, subdomains: subs };
          } catch (e) {
            return { error: String(e) };
          }
        },
      }),
      dns_records: tool({
        description: "Resolve DNS records (A, AAAA, MX, NS, TXT, CNAME) for a hostname via Cloudflare DoH.",
        inputSchema: z.object({ host: z.string(), types: z.array(z.enum(["A","AAAA","MX","NS","TXT","CNAME","SOA"])).default(["A","MX","NS","TXT"]) }),
        execute: async ({ host, types }) => {
          try {
            const out: Record<string, unknown> = {};
            const errs: Record<string, string> = {};
            const statuses: number[] = [];
            await Promise.all(types.map(async (t) => {
              try {
                const r = await fetchT(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${t}`, { headers: { Accept: "application/dns-json" } }, 8_000);
                const j = await r.json().catch(() => ({})) as { Status?: number; Answer?: Array<{ data: string }> };
                if (typeof j.Status === "number") statuses.push(j.Status);
                out[t] = j.Answer?.map((a) => a.data) ?? [];
                // Distinguish a genuine empty result (NOERROR/NXDOMAIN) from a lookup
                // failure (HTTP error or SERVFAIL) so [] can't read as "no records".
                const dErr = dohTypeError(r.ok, r.status, j.Status);
                if (dErr) errs[t] = dErr;
              } catch (e) {
                // One record-type's network failure/timeout must not collapse the
                // whole DNS lookup (Promise.all would reject and lose the rest).
                out[t] = [];
                errs[t] = String(e instanceof Error ? e.message : e);
              }
            }));
            // NXDOMAIN (Status 3) on any query means the domain doesn't exist —
            // flag the host so the live-host tools skip it instead of each
            // re-discovering the same DNS failure.
            if (statuses.some((s) => s === 3)) {
              markHostDead(host, "NXDOMAIN — domain does not resolve");
            }
            const hasErr = Object.keys(errs).length > 0;
            return { ok: !hasErr, host, records: out, ...(hasErr ? { errors: errs } : {}) };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      github_user: tool({
        description: "Fetch a GitHub user's public profile + recent public repos.",
        inputSchema: z.object({ username: z.string() }),
        execute: async ({ username }) => {
          try {
            const h = { "User-Agent": "Proximity-OSINT", Accept: "application/vnd.github+json" };
            // Per-branch .catch so a network rejection on one call can't discard
            // the other's result (Promise.all rejects on the first rejection).
            const [uRes, rRes] = await Promise.all([
              fetchT(`https://api.github.com/users/${encodeURIComponent(username)}`, { headers: h }, 12_000).catch(() => null),
              fetchT(`https://api.github.com/users/${encodeURIComponent(username)}/repos?sort=updated&per_page=10`, { headers: h }, 12_000).catch(() => null),
            ]);
            const user = uRes ? await uRes.json().catch(() => ({})) : {};
            const repos = (rRes && rRes.ok ? await rRes.json().catch(() => []) : []) as Array<{ name: string; html_url: string; description: string; stargazers_count: number; language: string; updated_at: string }>;
            return {
              ok: !!uRes?.ok,
              user,
              repos: Array.isArray(repos) ? repos.map((r) => ({ name: r.name, url: r.html_url, stars: r.stargazers_count, lang: r.language, updated: r.updated_at, desc: r.description })) : [],
              // The repos call has its own status (rate-limit 403/429 returns a non-array
              // error object); surface it so ok:true can't hide a failed repos fetch.
              ...(rRes?.ok ? {} : { repos_error: `github repos ${rRes?.status ?? "network error"} (rate limit or error)` }),
            };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      wayback_snapshots: tool({
        description: "Look up archive.org Wayback Machine snapshots for a URL. Returns the closest snapshot + total count.",
        inputSchema: z.object({ url: z.string() }),
        execute: async ({ url }) => {
          try {
            const [closest, cdx] = await Promise.all([
              fetchT(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, {}, 12_000).then((r) => r.ok ? r.json() : { error: `available ${r.status}` }).catch((e) => ({ error: String(e) })),
              fetchT(`https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&limit=10&from=20000101`, {}, 12_000).then((r) => r.ok ? r.json() : { error: `cdx ${r.status}` }).catch((e) => ({ error: String(e) })),
            ]);
            // archive.org is reliably flaky; a 5xx/timeout must not read as "no snapshots".
            const cdxOk = Array.isArray(cdx);
            return { ok: cdxOk, closest, recent: cdxOk ? cdx : [], ...(cdxOk ? {} : { error: (cdx as { error?: unknown })?.error ?? "wayback cdx failed" }) };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      http_fingerprint: tool({
        description: "Fetch a URL and return status, server/tech headers, title, and a short text excerpt. Use to investigate a website without leaving the agent.",
        inputSchema: z.object({ url: z.string().url() }),
        execute: async ({ url }) => {
          try {
            // Skip a host already proven dead (NXDOMAIN) this investigation
            // instead of re-incurring the same DNS failure.
            if (isHostDead(url)) return { skipped: true, reason: "host does not resolve (NXDOMAIN) — skipped" };
            // SSRF guard — reject loopback, link-local (cloud metadata!), RFC1918.
            try { assertSafeUrl(url); }
            catch (e) { return { error: String(e instanceof Error ? e.message : e) }; }
            const ctrl = new AbortController();
            // Timer stays armed through the body read (cleared in finally), so a
            // slow-drip response can't outlast the budget the way it would if we
            // cleared it right after headers arrived.
            const t = setTimeout(() => ctrl.abort(), 10000);
            try {
              const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Proximity-OSINT)" }, redirect: "follow", signal: ctrl.signal });
              // Block followed redirects that land on an internal host.
              try { assertSafeUrl(r.url); }
              catch (e) { return { error: `redirect blocked: ${String(e instanceof Error ? e.message : e)}` }; }
              const headers: Record<string, string> = {};
              r.headers.forEach((v, k) => { headers[k] = v; });
              // Bounded read — we only need <title> + a short excerpt, so cap the
              // body at 512 KB. Prevents a huge response from OOMing the function
              // and stops draining the stream once we have enough.
              const CAP = 512 * 1024;
              const reader = r.body?.getReader();
              const decoder = new TextDecoder();
              let body = "";
              let received = 0;
              if (reader) {
                try {
                  while (received < CAP) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    if (value) { received += value.byteLength; body += decoder.decode(value, { stream: true }); }
                  }
                } finally {
                  await reader.cancel().catch(() => {});
                }
              }
              const title = body.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
              const text = body.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200);
              return { status: r.status, finalUrl: r.url, title, headers, excerpt: text };
            } finally {
              clearTimeout(t);
            }
          } catch (e) {
            const msg = String(e instanceof Error ? e.message : e);
            // A DNS-resolution failure is a definitive "host doesn't exist" —
            // flag it so siblings (jina, deepfind_ssl/tech) skip the same host.
            if (/dns error|failed to lookup address|name or service not known|getaddrinfo|ENOTFOUND/i.test(msg)) {
              markHostDead(url, "DNS lookup failed");
            }
            return { error: msg };
          }
        },
      }),
      crypto_wallet: tool({
        description: "Inspect a Bitcoin or Ethereum address. Returns balance, tx count, and recent activity.",
        inputSchema: z.object({ chain: z.enum(["btc", "eth"]), address: z.string() }),
        execute: async ({ chain, address }) => {
          try {
            if (chain === "btc") {
              const r = await fetchT(`https://blockstream.info/api/address/${encodeURIComponent(address)}`, {}, 12_000);
              if (!r.ok) return { ok: false, chain, address, status: r.status, error: `blockstream ${r.status} (invalid address or upstream error)` };
              const data = await r.json().catch(() => ({}));
              return { ok: true, chain, address, data };
            }
            const r = await fetchT(`https://api.blockchair.com/ethereum/dashboards/address/${encodeURIComponent(address)}?limit=10`, {}, 12_000);
            if (!r.ok) return { ok: false, chain, address, status: r.status, error: `blockchair ${r.status}` };
            const data = await r.json().catch(() => ({}));
            const bcErr = blockchairError(data);
            if (bcErr) return { ok: false, chain, address, error: bcErr };
            return { ok: true, chain, address, data };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      google_dorks: tool({
        description:
          "Generate copy-paste Google/Bing/DuckDuckGo/Yandex dork queries for a seed identifier. NO external API cost — always safe to call. Returns a comprehensive, categorized dork menu (60+ queries per kind across breach/pastes, social, code, forums, dark-web-adjacent, docs, archives, public records, etc.). Fire it EARLY and on every newly-discovered high-value artifact (email, username, phone, name, domain, ip, hash, crypto_wallet).",
        inputSchema: z.object({
          seed: z.string(),
          // Accept legacy/alias "person" → mapped to "name" in execute().
          kind: z.enum(["email", "username", "phone", "name", "person", "domain", "ip", "hash", "crypto_wallet"]),
        }),
        execute: async ({ seed, kind: rawKind }) => {
          const kind = rawKind === "person" ? "name" : rawKind;
          // google_dorks is intentionally ungated — it only emits search URLs.
          const e = encodeURIComponent(seed);
          const map: Record<string, Array<{ category: string; query: string; url: string }>> = {
            email: [
              { category: "Direct", query: `"${seed}"`, url: `https://www.google.com/search?q=%22${e}%22` },
              { category: "Direct", query: `intext:"${seed}"`, url: `https://www.google.com/search?q=intext:%22${e}%22` },
              { category: "Direct", query: `"${seed}" "@"`, url: `https://www.google.com/search?q=%22${e}%22+%22@%22` },
              { category: "Leaks/Pastebins", query: `"${seed}" site:pastebin.com OR site:pastie.org OR site:paste.ubuntu.com OR site:paste.debian.net`, url: `https://www.google.com/search?q=%22${e}%22+site:pastebin.com+OR+site:pastie.org+OR+site:paste.ubuntu.com` },
              { category: "Leaks/Pastebins", query: `"${seed}" site:controlc.com OR site:dpaste.com OR site:ideone.com OR site:rentry.co`, url: `https://www.google.com/search?q=%22${e}%22+site:controlc.com+OR+site:dpaste.com+OR+site:rentry.co` },
              { category: "Leaks/Pastebins", query: `"${seed}" "password" OR "pass" OR "passwd" filetype:txt OR filetype:log`, url: `https://www.google.com/search?q=%22${e}%22+%22password%22+filetype:txt` },
              { category: "Leaks/Pastebins", query: `"${seed}" intitle:"index of" "email" OR "users" OR "accounts"`, url: `https://www.google.com/search?q=%22${e}%22+intitle:%22index+of%22+%22email%22` },
              { category: "Code/Git", query: `"${seed}" site:github.com OR site:gitlab.com OR site:bitbucket.org`, url: `https://www.google.com/search?q=%22${e}%22+site:github.com+OR+site:gitlab.com` },
              { category: "Code/Git", query: `"${seed}" site:gist.github.com OR site:gists.github.com`, url: `https://www.google.com/search?q=%22${e}%22+site:gist.github.com` },
              { category: "Code/Git", query: `"${seed}" "config" "email" filetype:json OR filetype:xml OR filetype:yaml OR filetype:yml`, url: `https://www.google.com/search?q=%22${e}%22+%22config%22+filetype:json` },
              { category: "Social", query: `"${seed}" site:reddit.com OR site:old.reddit.com`, url: `https://www.google.com/search?q=%22${e}%22+site:reddit.com` },
              { category: "Social", query: `"${seed}" site:twitter.com OR site:x.com OR site:tweetdeck.twitter.com`, url: `https://www.google.com/search?q=%22${e}%22+site:twitter.com` },
              { category: "Social", query: `"${seed}" site:linkedin.com/in OR site:linkedin.com/pub`, url: `https://www.google.com/search?q=%22${e}%22+site:linkedin.com/in` },
              { category: "Social", query: `"${seed}" site:instagram.com OR site:pinterest.com OR site:tumblr.com`, url: `https://www.google.com/search?q=%22${e}%22+site:instagram.com` },
              { category: "Forums", query: `"${seed}" site:forum OR site:boards OR site:community`, url: `https://www.google.com/search?q=%22${e}%22+site:forum` },
              { category: "Forums", query: `"${seed}" site:hackforums.net OR site:breachforums.is OR site:nulled.to`, url: `https://www.google.com/search?q=%22${e}%22+site:hackforums.net` },
              { category: "Documents", query: `"${seed}" filetype:pdf OR filetype:doc OR filetype:docx OR filetype:rtf`, url: `https://www.google.com/search?q=%22${e}%22+filetype:pdf` },
              { category: "Documents", query: `"${seed}" filetype:xls OR filetype:xlsx OR filetype:csv`, url: `https://www.google.com/search?q=%22${e}%22+filetype:xls` },
              { category: "Documents", query: `"${seed}" ext:sql OR ext:db OR ext:backup OR ext:bak`, url: `https://www.google.com/search?q=%22${e}%22+ext:sql` },
              { category: "Documents", query: `"${seed}" intitle:"database" OR intitle:"backup" OR intitle:"dump"`, url: `https://www.google.com/search?q=%22${e}%22+intitle:%22database%22` },
              { category: "Caches/Archives", query: `"${seed}" site:webcache.googleusercontent.com OR site:web.archive.org`, url: `https://www.google.com/search?q=%22${e}%22+site:web.archive.org` },
              { category: "Caches/Archives", query: `cache:"${seed}"`, url: `https://webcache.googleusercontent.com/search?q=cache:${e}` },
              { category: "Breaches", query: `"${seed}" "breach" OR "leaked" OR "database" OR "combo list"`, url: `https://www.google.com/search?q=%22${e}%22+%22breach%22` },
              { category: "Breaches", query: `"${seed}" "haveibeenpwned" OR "dehashed" OR "snusbase" OR "leakcheck"`, url: `https://www.google.com/search?q=%22${e}%22+%22haveibeenpwned%22` },
              { category: "WHOIS/RDAP", query: `"${seed}" site:whois.com OR site:whois.domaintools.com OR site:who.is`, url: `https://www.google.com/search?q=%22${e}%22+site:whois.com` },
              { category: "Images/Media", query: `"${seed}" site:imgur.com OR site:flickr.com OR site:photobucket.com`, url: `https://www.google.com/search?q=%22${e}%22+site:imgur.com` },
              { category: "Images/Media", query: `"${seed}" site:youtube.com OR site:vimeo.com OR site:dailymotion.com`, url: `https://www.google.com/search?q=%22${e}%22+site:youtube.com` },
              { category: "Resumes/CVs", query: `"${seed}" "resume" OR "cv" OR "curriculum vitae" filetype:pdf OR filetype:doc`, url: `https://www.google.com/search?q=%22${e}%22+%22resume%22+filetype:pdf` },
              { category: "Resumes/CVs", query: `"${seed}" "portfolio" OR "about me" OR "contact"`, url: `https://www.google.com/search?q=%22${e}%22+%22portfolio%22` },
              { category: "OSINT Tools", query: `"${seed}" site:osint.org OR site:osintcurious.io OR site:osintframework.com`, url: `https://www.google.com/search?q=%22${e}%22+site:osint.org` },
              { category: "Public Records", query: `"${seed}" site:opencorporates.com OR site:bizapedia.com OR site:manta.com`, url: `https://www.google.com/search?q=%22${e}%22+site:opencorporates.com` },
              { category: "Public Records", query: `"${seed}" site:crunchbase.com OR site:angel.co OR site:wellfound.com`, url: `https://www.google.com/search?q=%22${e}%22+site:crunchbase.com` },
              { category: "Public Records", query: `"${seed}" site:opencalais.com OR site:alexa.com OR site:builtwith.com`, url: `https://www.google.com/search?q=%22${e}%22+site:builtwith.com` },
              { category: "Pastes/Leaks", query: `"${seed}" site:ghostbin.co OR site:hastebin.com OR site:0bin.net OR site:privatebin.info`, url: `https://www.google.com/search?q=%22${e}%22+site:ghostbin.co+OR+site:hastebin.com` },
              { category: "Pastes/Leaks", query: `"${seed}" site:justpaste.it OR site:paste.ee OR site:bpaste.net OR site:termbin.com`, url: `https://www.google.com/search?q=%22${e}%22+site:justpaste.it+OR+site:paste.ee` },
              { category: "Pastes/Leaks", query: `"${seed}" "combo" OR "combolist" OR "stealer" OR "redline" OR "raccoon"`, url: `https://www.google.com/search?q=%22${e}%22+%22combolist%22+OR+%22stealer%22` },
              { category: "Stealer Logs", query: `"${seed}" "passwords.txt" OR "credentials.txt" OR "logins.txt"`, url: `https://www.google.com/search?q=%22${e}%22+%22passwords.txt%22+OR+%22credentials.txt%22` },
              { category: "Stealer Logs", query: `"${seed}" "autofill" OR "cookies.txt" OR "wallets.txt"`, url: `https://www.google.com/search?q=%22${e}%22+%22autofill%22+OR+%22cookies.txt%22` },
              { category: "Dark-web Adjacent", query: `"${seed}" site:dread.onion OR site:darkfailllnkf4vf.onion OR "dark web" "marketplace"`, url: `https://www.google.com/search?q=%22${e}%22+%22dark+web%22+%22marketplace%22` },
              { category: "Dark-web Adjacent", query: `"${seed}" site:tor.taxi OR site:darknetlive.com OR site:tor.link`, url: `https://www.google.com/search?q=%22${e}%22+site:darknetlive.com` },
              { category: "Telegram", query: `"${seed}" site:t.me OR site:telegram.me OR site:telegramchannels.me`, url: `https://www.google.com/search?q=%22${e}%22+site:t.me+OR+site:telegram.me` },
              { category: "Telegram", query: `"${seed}" "telegram" "channel" OR "group" OR "@"`, url: `https://www.google.com/search?q=%22${e}%22+%22telegram%22+%22channel%22` },
              { category: "Discord", query: `"${seed}" site:discord.com OR site:discord.gg OR site:disboard.org OR site:top.gg`, url: `https://www.google.com/search?q=%22${e}%22+site:discord.gg+OR+site:disboard.org` },
              { category: "Federated Social", query: `"${seed}" site:bsky.app OR site:bsky.social OR site:mastodon.social OR site:threads.net`, url: `https://www.google.com/search?q=%22${e}%22+site:bsky.app+OR+site:mastodon.social` },
              { category: "Federated Social", query: `"${seed}" site:lemmy.world OR site:kbin.social OR site:pixelfed.social`, url: `https://www.google.com/search?q=%22${e}%22+site:lemmy.world+OR+site:pixelfed.social` },
              { category: "Adult/Cam", query: `"${seed}" site:onlyfans.com OR site:fansly.com OR site:manyvids.com OR site:chaturbate.com`, url: `https://www.google.com/search?q=%22${e}%22+site:onlyfans.com+OR+site:fansly.com` },
              { category: "Payment Handles", query: `"${seed}" site:cash.app OR site:venmo.com OR site:paypal.me OR site:account.venmo.com`, url: `https://www.google.com/search?q=%22${e}%22+site:cash.app+OR+site:venmo.com` },
              { category: "Alt Search Engines", query: `"${seed}"`, url: `https://www.bing.com/search?q=%22${e}%22` },
              { category: "Alt Search Engines", query: `"${seed}"`, url: `https://duckduckgo.com/?q=%22${e}%22` },
              { category: "Alt Search Engines", query: `"${seed}"`, url: `https://yandex.com/search/?text=%22${e}%22` },
              { category: "Education", query: `"${seed}" site:edu OR site:ac.uk OR site:edu.au`, url: `https://www.google.com/search?q=%22${e}%22+site:edu+OR+site:ac.uk` },
              { category: "Dating", query: `"${seed}" site:tinder.com OR site:bumble.com OR site:okcupid.com OR site:hinge.co`, url: `https://www.google.com/search?q=%22${e}%22+site:tinder.com+OR+site:hinge.co` },
            ],
            username: [
              { category: "Direct", query: `"${seed}"`, url: `https://www.google.com/search?q=%22${e}%22` },
              { category: "Direct", query: `intext:"${seed}"`, url: `https://www.google.com/search?q=intext:%22${e}%22` },
              { category: "Direct", query: `"@${seed}"`, url: `https://www.google.com/search?q=%22%40${e}%22` },
              { category: "Social", query: `"${seed}" site:reddit.com/user/${seed} OR site:reddit.com/u/${seed}`, url: `https://www.google.com/search?q=%22${e}%22+site:reddit.com/user/${e}` },
              { category: "Social", query: `"${seed}" site:twitter.com/${seed} OR site:x.com/${seed}`, url: `https://www.google.com/search?q=%22${e}%22+site:twitter.com/${e}` },
              { category: "Social", query: `"${seed}" site:instagram.com/${seed} OR site:instagram.com/${seed}/`, url: `https://www.google.com/search?q=%22${e}%22+site:instagram.com/${e}` },
              { category: "Social", query: `"${seed}" site:tiktok.com/@${seed} OR site:tiktok.com/${seed}`, url: `https://www.google.com/search?q=%22${e}%22+site:tiktok.com/@${e}` },
              { category: "Social", query: `"${seed}" site:linkedin.com/in OR site:linkedin.com/pub`, url: `https://www.google.com/search?q=%22${e}%22+site:linkedin.com/in` },
              { category: "Social", query: `"${seed}" site:facebook.com/${seed} OR site:fb.com/${seed}`, url: `https://www.google.com/search?q=%22${e}%22+site:facebook.com/${e}` },
              { category: "Social", query: `"${seed}" site:discord.com OR site:discord.gg OR site:disboard.org`, url: `https://www.google.com/search?q=%22${e}%22+site:discord.com` },
              { category: "Code/Dev", query: `"${seed}" site:github.com/${seed} OR site:gitlab.com/${seed} OR site:bitbucket.org/${seed}`, url: `https://www.google.com/search?q=%22${e}%22+site:github.com/${e}` },
              { category: "Code/Dev", query: `"${seed}" site:stackoverflow.com/users OR site:stackexchange.com/users`, url: `https://www.google.com/search?q=%22${e}%22+site:stackoverflow.com/users` },
              { category: "Code/Dev", query: `"${seed}" site:dev.to/${seed} OR site:hashnode.com/@${seed} OR site:medium.com/@${seed}`, url: `https://www.google.com/search?q=%22${e}%22+site:dev.to/${e}` },
              { category: "Code/Dev", query: `"${seed}" site:hackerrank.com/${seed} OR site:leetcode.com/${seed} OR site:codewars.com/users/${seed}`, url: `https://www.google.com/search?q=%22${e}%22+site:hackerrank.com/${e}` },
              { category: "Gaming", query: `"${seed}" site:steamcommunity.com/id/${seed} OR site:steamcommunity.com/profiles`, url: `https://www.google.com/search?q=%22${e}%22+site:steamcommunity.com/id/${e}` },
              { category: "Gaming", query: `"${seed}" site:twitch.tv/${seed} OR site:youtube.com/@${seed} OR site:youtube.com/c/${seed}`, url: `https://www.google.com/search?q=%22${e}%22+site:twitch.tv/${e}` },
              { category: "Gaming", query: `"${seed}" site:roblox.com/users OR site:roblox.com/user`, url: `https://www.google.com/search?q=%22${e}%22+site:roblox.com/users` },
              { category: "Creative", query: `"${seed}" site:behance.net/${seed} OR site:dribbble.com/${seed}`, url: `https://www.google.com/search?q=%22${e}%22+site:behance.net/${e}` },
              { category: "Creative", query: `"${seed}" site:flickr.com/people/${seed} OR site:500px.com/${seed}`, url: `https://www.google.com/search?q=%22${e}%22+site:flickr.com/people/${e}` },
              { category: "Creative", query: `"${seed}" site:vimeo.com/${seed} OR site:soundcloud.com/${seed} OR site:bandcamp.com`, url: `https://www.google.com/search?q=%22${e}%22+site:soundcloud.com/${e}` },
              { category: "Forums", query: `"${seed}" site:hackforums.net OR site:breachforums.is OR site:cracked.io OR site:nulled.to`, url: `https://www.google.com/search?q=%22${e}%22+site:hackforums.net` },
              { category: "Forums", query: `"${seed}" site:forum.onion OR site:boards.4chan.org OR site:8kun.top`, url: `https://www.google.com/search?q=%22${e}%22+site:boards.4chan.org` },
              { category: "Leaks/Pastebins", query: `"${seed}" site:pastebin.com OR site:pastie.org OR site:rentry.co`, url: `https://www.google.com/search?q=%22${e}%22+site:pastebin.com` },
              { category: "Leaks/Pastebins", query: `"${seed}" filetype:log OR filetype:txt OR filetype:csv "password" OR "email"`, url: `https://www.google.com/search?q=%22${e}%22+filetype:log+%22password%22` },
              { category: "Documents", query: `"${seed}" filetype:pdf OR filetype:doc OR filetype:docx`, url: `https://www.google.com/search?q=%22${e}%22+filetype:pdf` },
              { category: "Documents", query: `"${seed}" "resume" OR "cv" OR "portfolio" filetype:pdf`, url: `https://www.google.com/search?q=%22${e}%22+%22resume%22+filetype:pdf` },
              { category: "Documents", query: `"${seed}" "about me" OR "contact" OR "bio"`, url: `https://www.google.com/search?q=%22${e}%22+%22about+me%22` },
              { category: "WHOIS/Domain", query: `"${seed}" site:who.is OR site:whois.com OR site:whois.domaintools.com`, url: `https://www.google.com/search?q=%22${e}%22+site:who.is` },
              { category: "Caches", query: `cache:"${seed}"`, url: `https://webcache.googleusercontent.com/search?q=cache:${e}` },
              { category: "Caches", query: `"${seed}" site:web.archive.org OR site:archive.is OR site:archive.org`, url: `https://www.google.com/search?q=%22${e}%22+site:web.archive.org` },
              { category: "Keybase/Crypto", query: `"${seed}" site:keybase.io/${seed} OR site:keybase.pub/${seed}`, url: `https://www.google.com/search?q=%22${e}%22+site:keybase.io/${e}` },
              { category: "Keybase/Crypto", query: `"${seed}" site:keys.openpgp.org OR site:pgp.mit.edu OR site:pool.sks-keyservers.net`, url: `https://www.google.com/search?q=%22${e}%22+site:keys.openpgp.org` },
              { category: "OSINT Aggregators", query: `"${seed}" site:osint.org OR site:osintcurious.io OR site:osintframework.com`, url: `https://www.google.com/search?q=%22${e}%22+site:osint.org` },
              { category: "OSINT Aggregators", query: `"${seed}" site:whatsmyname.app OR site:sherlock-project.xyz OR site:namechk.com`, url: `https://www.google.com/search?q=%22${e}%22+site:whatsmyname.app` },
              { category: "Telegram", query: `"${seed}" site:t.me/${seed} OR site:telegram.me/${seed} OR site:tgstat.com/en/channel/@${seed}`, url: `https://www.google.com/search?q=%22${e}%22+site:t.me/${e}` },
              { category: "Telegram", query: `"@${seed}" site:t.me OR site:telegram.me OR site:telegramindex.com`, url: `https://www.google.com/search?q=%22%40${e}%22+site:t.me` },
              { category: "Federated Social", query: `"${seed}" site:bsky.app/profile/${seed} OR site:bsky.app/profile/${seed}.bsky.social`, url: `https://www.google.com/search?q=site:bsky.app/profile/${e}` },
              { category: "Federated Social", query: `"@${seed}" site:mastodon.social OR site:mastodon.online OR site:hachyderm.io OR site:infosec.exchange`, url: `https://www.google.com/search?q=%22%40${e}%22+site:mastodon.social` },
              { category: "Federated Social", query: `"${seed}" site:threads.net/@${seed}`, url: `https://www.google.com/search?q=site:threads.net/@${e}` },
              { category: "Federated Social", query: `"${seed}" site:lemmy.world/u/${seed} OR site:kbin.social/u/${seed}`, url: `https://www.google.com/search?q=site:lemmy.world/u/${e}` },
              { category: "Adult/Cam", query: `"${seed}" site:onlyfans.com/${seed} OR site:fansly.com/${seed} OR site:manyvids.com OR site:chaturbate.com/${seed}`, url: `https://www.google.com/search?q=site:onlyfans.com/${e}+OR+site:fansly.com/${e}` },
              { category: "Adult/Cam", query: `"${seed}" site:pornhub.com/users/${seed} OR site:xvideos.com/profiles/${seed}`, url: `https://www.google.com/search?q=site:pornhub.com/users/${e}` },
              { category: "Payment Handles", query: `"${seed}" site:cash.app/$${seed} OR site:venmo.com/u/${seed} OR site:paypal.me/${seed}`, url: `https://www.google.com/search?q=site:cash.app/%24${e}+OR+site:venmo.com/u/${e}+OR+site:paypal.me/${e}` },
              { category: "Payment Handles", query: `"${seed}" "cashapp" OR "$cashtag" OR "venmo" OR "zelle" OR "paypal"`, url: `https://www.google.com/search?q=%22${e}%22+%22cashapp%22+OR+%22venmo%22+OR+%22zelle%22` },
              { category: "Stealer Logs", query: `"${seed}" "passwords" OR "logins" OR "autofill" filetype:txt`, url: `https://www.google.com/search?q=%22${e}%22+%22passwords%22+filetype:txt` },
              { category: "Stealer Logs", query: `"${seed}" "redline" OR "raccoon" OR "vidar" OR "lumma" OR "stealer log"`, url: `https://www.google.com/search?q=%22${e}%22+%22redline%22+OR+%22stealer+log%22` },
              { category: "Dark-web Adjacent", query: `"${seed}" site:dread.onion OR site:tor.taxi OR site:darknetlive.com`, url: `https://www.google.com/search?q=%22${e}%22+site:darknetlive.com` },
              { category: "Marketplaces", query: `"${seed}" site:ebay.com OR site:depop.com OR site:poshmark.com OR site:mercari.com`, url: `https://www.google.com/search?q=%22${e}%22+site:depop.com+OR+site:poshmark.com` },
              { category: "Marketplaces", query: `"${seed}" site:etsy.com OR site:fiverr.com OR site:upwork.com/freelancers`, url: `https://www.google.com/search?q=%22${e}%22+site:fiverr.com+OR+site:upwork.com` },
              { category: "Gaming", query: `"${seed}" site:battle.net OR site:epicgames.com OR site:xbox.com/en-us/play/user/${seed} OR site:psnprofiles.com/${seed}`, url: `https://www.google.com/search?q=%22${e}%22+site:psnprofiles.com/${e}` },
              { category: "Gaming", query: `"${seed}" site:tracker.gg OR site:op.gg OR site:lolprofile.net OR site:dotabuff.com`, url: `https://www.google.com/search?q=%22${e}%22+site:tracker.gg+OR+site:op.gg` },
              { category: "Crypto", query: `"${seed}" site:keybase.io OR site:warpcast.com OR site:lens.xyz OR site:farcaster.xyz`, url: `https://www.google.com/search?q=%22${e}%22+site:warpcast.com+OR+site:lens.xyz` },
              { category: "Crypto", query: `"${seed}" "ens" OR ".eth" OR "wallet" OR "address"`, url: `https://www.google.com/search?q=%22${e}%22+%22.eth%22+OR+%22wallet%22` },
              { category: "Pastes/Leaks", query: `"${seed}" site:ghostbin.co OR site:hastebin.com OR site:0bin.net OR site:justpaste.it`, url: `https://www.google.com/search?q=%22${e}%22+site:ghostbin.co+OR+site:justpaste.it` },
              { category: "Alt Search Engines", query: `"${seed}"`, url: `https://www.bing.com/search?q=%22${e}%22` },
              { category: "Alt Search Engines", query: `"${seed}"`, url: `https://duckduckgo.com/?q=%22${e}%22` },
              { category: "Alt Search Engines", query: `"${seed}"`, url: `https://yandex.com/search/?text=%22${e}%22` },
            ],
            phone: [
              { category: "Direct", query: `"${seed}"`, url: `https://www.google.com/search?q=%22${e}%22` },
              { category: "Direct", query: `intext:"${seed}"`, url: `https://www.google.com/search?q=intext:%22${e}%22` },
              { category: "Social", query: `"${seed}" site:facebook.com OR site:fb.com`, url: `https://www.google.com/search?q=%22${e}%22+site:facebook.com` },
              { category: "Social", query: `"${seed}" site:linkedin.com/in OR site:linkedin.com/pub`, url: `https://www.google.com/search?q=%22${e}%22+site:linkedin.com/in` },
              { category: "Social", query: `"${seed}" site:twitter.com OR site:x.com`, url: `https://www.google.com/search?q=%22${e}%22+site:twitter.com` },
              { category: "Social", query: `"${seed}" site:instagram.com OR site:reddit.com`, url: `https://www.google.com/search?q=%22${e}%22+site:instagram.com` },
              { category: "Business", query: `"${seed}" site:yelp.com OR site:yellowpages.com OR site:bbb.org`, url: `https://www.google.com/search?q=%22${e}%22+site:yelp.com` },
              { category: "Business", query: `"${seed}" site:manta.com OR site:superpages.com OR site:chamberofcommerce.com`, url: `https://www.google.com/search?q=%22${e}%22+site:manta.com` },
              { category: "Business", query: `"${seed}" site:opencorporates.com OR site:bizapedia.com OR site:dnb.com`, url: `https://www.google.com/search?q=%22${e}%22+site:opencorporates.com` },
              { category: "Directories", query: `"${seed}" site:whitepages.com OR site:spokeo.com OR site:beenverified.com`, url: `https://www.google.com/search?q=%22${e}%22+site:whitepages.com` },
              { category: "Directories", query: `"${seed}" site:intelius.com OR site:peekyou.com OR site:pipl.com`, url: `https://www.google.com/search?q=%22${e}%22+site:intelius.com` },
              { category: "Forums/Marketplaces", query: `"${seed}" site:craigslist.org OR site:offerup.com OR site:letgo.com`, url: `https://www.google.com/search?q=%22${e}%22+site:craigslist.org` },
              { category: "Forums/Marketplaces", query: `"${seed}" site:ebay.com OR site:amazon.com OR site:etsy.com`, url: `https://www.google.com/search?q=%22${e}%22+site:ebay.com` },
              { category: "Leaks", query: `"${seed}" filetype:txt OR filetype:csv OR filetype:pdf "phone" OR "contact"`, url: `https://www.google.com/search?q=%22${e}%22+filetype:txt+%22phone%22` },
              { category: "Leaks", query: `"${seed}" site:pastebin.com OR site:rentry.co OR site:controlc.com`, url: `https://www.google.com/search?q=%22${e}%22+site:pastebin.com` },
              { category: "Documents", query: `"${seed}" filetype:pdf OR filetype:doc OR filetype:docx`, url: `https://www.google.com/search?q=%22${e}%22+filetype:pdf` },
              { category: "Documents", query: `"${seed}" "resume" OR "cv" OR "contact" filetype:pdf`, url: `https://www.google.com/search?q=%22${e}%22+%22resume%22+filetype:pdf` },
              { category: "Public Records", query: `"${seed}" site:courtlistener.com OR site:justia.com OR site:findlaw.com`, url: `https://www.google.com/search?q=%22${e}%22+site:courtlistener.com` },
              { category: "Public Records", query: `"${seed}" site:gov OR site:gov.uk OR site:europa.eu`, url: `https://www.google.com/search?q=%22${e}%22+site:gov` },
              { category: "Caches", query: `"${seed}" site:web.archive.org OR site:archive.is`, url: `https://www.google.com/search?q=%22${e}%22+site:web.archive.org` },
              { category: "Messaging Handles", query: `"${seed}" site:t.me OR site:telegram.me OR "telegram" "contact"`, url: `https://www.google.com/search?q=%22${e}%22+site:t.me+OR+%22telegram%22+%22contact%22` },
              { category: "Messaging Handles", query: `"${seed}" "whatsapp" OR "wa.me" OR "signal" OR "viber"`, url: `https://www.google.com/search?q=%22${e}%22+%22whatsapp%22+OR+%22wa.me%22+OR+%22signal%22` },
              { category: "Reverse Lookup", query: `"${seed}" site:truecaller.com OR site:nuwber.com OR site:radaris.com OR site:fastpeoplesearch.com`, url: `https://www.google.com/search?q=%22${e}%22+site:truecaller.com+OR+site:fastpeoplesearch.com` },
              { category: "Reverse Lookup", query: `"${seed}" site:thatsthem.com OR site:usphonebook.com OR site:411.com OR site:zabasearch.com`, url: `https://www.google.com/search?q=%22${e}%22+site:thatsthem.com+OR+site:411.com` },
              { category: "Scam Reports", query: `"${seed}" site:800notes.com OR site:whocallsme.com OR site:reportedcall.com OR site:nomorobo.com`, url: `https://www.google.com/search?q=%22${e}%22+site:800notes.com+OR+site:whocallsme.com` },
              { category: "Scam Reports", query: `"${seed}" "scam" OR "spam" OR "fraud" OR "robocall"`, url: `https://www.google.com/search?q=%22${e}%22+%22scam%22+OR+%22robocall%22` },
              { category: "Dating", query: `"${seed}" site:tinder.com OR site:bumble.com OR site:hinge.co OR site:okcupid.com`, url: `https://www.google.com/search?q=%22${e}%22+site:tinder.com+OR+site:hinge.co` },
              { category: "Alt Search Engines", query: `"${seed}"`, url: `https://duckduckgo.com/?q=%22${e}%22` },
              { category: "Alt Search Engines", query: `"${seed}"`, url: `https://yandex.com/search/?text=%22${e}%22` },
            ],
            name: [
              { category: "Direct", query: `"${seed}"`, url: `https://www.google.com/search?q=%22${e}%22` },
              { category: "Direct", query: `intext:"${seed}"`, url: `https://www.google.com/search?q=intext:%22${e}%22` },
              { category: "LinkedIn", query: `"${seed}" site:linkedin.com/in`, url: `https://www.google.com/search?q=%22${e}%22+site:linkedin.com/in` },
              { category: "LinkedIn", query: `"${seed}" "linkedin"`, url: `https://www.google.com/search?q=%22${e}%22+%22linkedin%22` },
              { category: "Social", query: `"${seed}" site:facebook.com OR site:fb.com`, url: `https://www.google.com/search?q=%22${e}%22+site:facebook.com` },
              { category: "Social", query: `"${seed}" site:twitter.com OR site:x.com OR site:instagram.com`, url: `https://www.google.com/search?q=%22${e}%22+site:twitter.com` },
              { category: "Documents", query: `"${seed}" filetype:pdf OR filetype:doc`, url: `https://www.google.com/search?q=%22${e}%22+filetype:pdf` },
              { category: "Documents", query: `"${seed}" "resume" OR "cv" filetype:pdf`, url: `https://www.google.com/search?q=%22${e}%22+%22resume%22+filetype:pdf` },
              { category: "Documents", query: `"${seed}" "portfolio" OR "about me" OR "contact"`, url: `https://www.google.com/search?q=%22${e}%22+%22portfolio%22` },
              { category: "Public Records", query: `"${seed}" site:whitepages.com OR site:spokeo.com OR site:intelius.com`, url: `https://www.google.com/search?q=%22${e}%22+site:whitepages.com` },
              { category: "Public Records", query: `"${seed}" site:opencorporates.com OR site:crunchbase.com OR site:bizapedia.com`, url: `https://www.google.com/search?q=%22${e}%22+site:opencorporates.com` },
              { category: "Public Records", query: `"${seed}" site:gov OR site:gov.uk OR site:europa.eu`, url: `https://www.google.com/search?q=%22${e}%22+site:gov` },
              { category: "Public Records", query: `"${seed}" site:courtlistener.com OR site:justia.com OR site:pacer.gov`, url: `https://www.google.com/search?q=%22${e}%22+site:courtlistener.com` },
              { category: "Public Records", query: `"${seed}" "address" OR "phone" OR "email"`, url: `https://www.google.com/search?q=%22${e}%22+%22address%22+%22phone%22` },
              { category: "Images", query: `"${seed}" site:imgur.com OR site:flickr.com OR site:photobucket.com`, url: `https://www.google.com/search?q=%22${e}%22+site:imgur.com` },
              { category: "Images", query: `"${seed}" site:youtube.com OR site:vimeo.com OR site:dailymotion.com`, url: `https://www.google.com/search?q=%22${e}%22+site:youtube.com` },
              { category: "News", query: `"${seed}" site:news.google.com OR site:bing.com/news`, url: `https://www.google.com/search?q=%22${e}%22+site:news.google.com` },
              { category: "News", query: `"${seed}" "news" OR "article" OR "interview"`, url: `https://www.google.com/search?q=%22${e}%22+%22news%22` },
              { category: "Forums", query: `"${seed}" site:reddit.com OR site:quora.com OR site:stackexchange.com`, url: `https://www.google.com/search?q=%22${e}%22+site:reddit.com` },
              { category: "Forums", query: `"${seed}" site:medium.com OR site:substack.com OR site:ghost.io`, url: `https://www.google.com/search?q=%22${e}%22+site:medium.com` },
              { category: "Caches", query: `"${seed}" site:web.archive.org OR site:archive.is`, url: `https://www.google.com/search?q=%22${e}%22+site:web.archive.org` },
              { category: "Obituaries/Genealogy", query: `"${seed}" site:legacy.com OR site:findagrave.com OR site:ancestry.com OR site:familysearch.org`, url: `https://www.google.com/search?q=%22${e}%22+site:legacy.com+OR+site:findagrave.com` },
              { category: "Obituaries/Genealogy", query: `"${seed}" "obituary" OR "in memoriam" OR "memorial"`, url: `https://www.google.com/search?q=%22${e}%22+%22obituary%22` },
              { category: "Political/Donations", query: `"${seed}" site:fec.gov OR site:opensecrets.org OR site:followthemoney.org`, url: `https://www.google.com/search?q=%22${e}%22+site:fec.gov+OR+site:opensecrets.org`},
              { category: "Political/Donations", query: `"${seed}" "donor" OR "campaign contribution" OR "PAC"`, url: `https://www.google.com/search?q=%22${e}%22+%22donor%22+%22campaign%22` },
              { category: "Property/Real Estate", query: `"${seed}" site:zillow.com OR site:realtor.com OR site:redfin.com OR site:trulia.com`, url: `https://www.google.com/search?q=%22${e}%22+site:zillow.com+OR+site:realtor.com` },
              { category: "Property/Real Estate", query: `"${seed}" "deed" OR "property record" OR "assessor" OR "tax record"`, url: `https://www.google.com/search?q=%22${e}%22+%22deed%22+OR+%22property+record%22` },
              { category: "Sex Offender / Mugshots", query: `"${seed}" site:nsopw.gov OR site:mugshots.com OR site:bustedmugshots.com`, url: `https://www.google.com/search?q=%22${e}%22+site:nsopw.gov+OR+site:mugshots.com` },
              { category: "Patents/Academic", query: `"${seed}" site:patents.google.com OR site:scholar.google.com OR site:orcid.org`, url: `https://www.google.com/search?q=%22${e}%22+site:patents.google.com+OR+site:scholar.google.com` },
              { category: "People Search", query: `"${seed}" site:peoplefinders.com OR site:beenverified.com OR site:truthfinder.com OR site:instantcheckmate.com`, url: `https://www.google.com/search?q=%22${e}%22+site:peoplefinders.com+OR+site:beenverified.com` },
              { category: "Alt Search Engines", query: `"${seed}"`, url: `https://duckduckgo.com/?q=%22${e}%22` },
              { category: "Alt Search Engines", query: `"${seed}"`, url: `https://yandex.com/search/?text=%22${e}%22` },
            ],
            domain: [
              { category: "Direct", query: `site:${seed}`, url: `https://www.google.com/search?q=site:${e}` },
              { category: "Exposed Files", query: `site:${seed} ext:env OR ext:log OR ext:bak OR ext:sql OR ext:dump OR ext:backup`, url: `https://www.google.com/search?q=site:${e}+ext:env+OR+ext:log+OR+ext:bak` },
              { category: "Exposed Files", query: `site:${seed} ext:json OR ext:xml OR ext:yaml OR ext:yml OR ext:config`, url: `https://www.google.com/search?q=site:${e}+ext:json+OR+ext:xml+OR+ext:config` },
              { category: "Exposed Files", query: `site:${seed} filetype:sql "password" OR "secret" OR "api_key" OR "token"`, url: `https://www.google.com/search?q=site:${e}+filetype:sql+%22password%22` },
              { category: "Exposed Files", query: `site:${seed} "config" "database" "password" ext:php OR ext:py OR ext:rb`, url: `https://www.google.com/search?q=site:${e}+%22config%22+%22database%22+ext:php` },
              { category: "Directory Listings", query: `site:${seed} intitle:"index of"`, url: `https://www.google.com/search?q=site:${e}+intitle:%22index+of%22` },
              { category: "Directory Listings", query: `site:${seed} intitle:"index of" "config" OR "backup" OR "database"`, url: `https://www.google.com/search?q=site:${e}+intitle:%22index+of%22+%22config%22` },
              { category: "Directory Listings", query: `site:${seed} intitle:"index of" ext:sql OR ext:db OR ext:sqlite`, url: `https://www.google.com/search?q=site:${e}+intitle:%22index+of%22+ext:sql` },
              { category: "Git/SVN", query: `site:${seed} inurl:.git OR inurl:.svn OR inurl:.hg`, url: `https://www.google.com/search?q=site:${e}+inurl:.git+OR+inurl:.svn` },
              { category: "Git/SVN", query: `site:${seed} "GITHUB_TOKEN" OR "AWS_ACCESS_KEY_ID" OR "PRIVATE KEY"`, url: `https://www.google.com/search?q=site:${e}+%22GITHUB_TOKEN%22+OR+%22AWS_ACCESS_KEY_ID%22` },
              { category: "Git/SVN", query: `site:${seed} "-----BEGIN RSA PRIVATE KEY-----" OR "-----BEGIN OPENSSH PRIVATE KEY-----"`, url: `https://www.google.com/search?q=site:${e}+%22-----BEGIN+RSA+PRIVATE+KEY-----` },
              { category: "Admin Panels", query: `site:${seed} inurl:admin OR inurl:administrator OR inurl:login OR inurl:signin`, url: `https://www.google.com/search?q=site:${e}+inurl:admin+OR+inurl:login` },
              { category: "Admin Panels", query: `site:${seed} intitle:"login" "admin" OR "cpanel" OR "webmail"`, url: `https://www.google.com/search?q=site:${e}+intitle:%22login%22+%22admin%22` },
              { category: "Admin Panels", query: `site:${seed} inurl:phpmyadmin OR inurl:wp-admin OR inurl:wp-login`, url: `https://www.google.com/search?q=site:${e}+inurl:phpmyadmin+OR+inurl:wp-admin` },
              { category: "API/Endpoints", query: `site:${seed} inurl:api OR inurl:swagger OR inurl:graphql OR inurl:rest`, url: `https://www.google.com/search?q=site:${e}+inurl:api+OR+inurl:swagger` },
              { category: "API/Endpoints", query: `site:${seed} "api_key" OR "api_secret" OR "client_id" OR "client_secret"`, url: `https://www.google.com/search?q=site:${e}+%22api_key%22+OR+%22api_secret%22` },
              { category: "API/Endpoints", query: `site:${seed} ext:wsdl OR ext:wadl OR ext:raml`, url: `https://www.google.com/search?q=site:${e}+ext:wsdl+OR+ext:wadl` },
              { category: "CMS/WP", query: `site:${seed} inurl:wp-content OR inurl:wp-includes`, url: `https://www.google.com/search?q=site:${e}+inurl:wp-content` },
              { category: "CMS/WP", query: `site:${seed} "wp-config.php" OR "wp-config.php.bak" OR "wp-config.php~"`, url: `https://www.google.com/search?q=site:${e}+%22wp-config.php%22` },
              { category: "CMS/WP", query: `site:${seed} inurl:wp-json/wp/v2/users`, url: `https://www.google.com/search?q=site:${e}+inurl:wp-json/wp/v2/users` },
              { category: "Subdomains", query: `site:*.${seed} -www`, url: `https://www.google.com/search?q=site:*.${e}+-www` },
              { category: "Subdomains", query: `site:${seed} -inurl:www`, url: `https://www.google.com/search?q=site:${e}+-inurl:www` },
              { category: "Subdomains", query: `site:*.${seed} ext:pdf OR ext:doc`, url: `https://www.google.com/search?q=site:*.${e}+ext:pdf` },
              { category: "Off-domain Mentions", query: `"${seed}" -site:${seed}`, url: `https://www.google.com/search?q=%22${e}%22+-site:${e}` },
              { category: "Off-domain Mentions", query: `"${seed}" "breach" OR "leaked" OR "database"`, url: `https://www.google.com/search?q=%22${e}%22+%22breach%22` },
              { category: "Off-domain Mentions", query: `"${seed}" site:shodan.io OR site:censys.io OR site:spyse.com`, url: `https://www.google.com/search?q=%22${e}%22+site:shodan.io` },
              { category: "SSL/Certs", query: `site:${seed} "BEGIN CERTIFICATE" OR "END CERTIFICATE"`, url: `https://www.google.com/search?q=site:${e}+%22BEGIN+CERTIFICATE%22` },
              { category: "SSL/Certs", query: `site:${seed} ext:crt OR ext:pem OR ext:cer`, url: `https://www.google.com/search?q=site:${e}+ext:crt+OR+ext:pem` },
              { category: "Whois/RDAP", query: `"${seed}" site:whois.com OR site:whois.domaintools.com OR site:who.is`, url: `https://www.google.com/search?q=%22${e}%22+site:whois.com` },
              { category: "Wayback", query: `"${seed}" site:web.archive.org OR site:archive.is`, url: `https://www.google.com/search?q=%22${e}%22+site:web.archive.org` },
              { category: "Employees/Team", query: `"${seed}" "team" OR "about us" OR "staff" OR "employees"`, url: `https://www.google.com/search?q=%22${e}%22+%22team%22+%22about+us%22` },
              { category: "Employees/Team", query: `"${seed}" site:linkedin.com "works at" OR "employed at"`, url: `https://www.google.com/search?q=%22${e}%22+site:linkedin.com+%22works+at%22` },
              { category: "Documents", query: `site:${seed} filetype:pdf OR filetype:doc OR filetype:docx OR filetype:ppt OR filetype:pptx`, url: `https://www.google.com/search?q=site:${e}+filetype:pdf` },
              { category: "Documents", query: `site:${seed} filetype:xls OR filetype:xlsx OR filetype:csv`, url: `https://www.google.com/search?q=site:${e}+filetype:xls` },
              { category: "Documents", query: `site:${seed} "confidential" OR "internal use only" OR "proprietary" filetype:pdf`, url: `https://www.google.com/search?q=site:${e}+%22confidential%22+filetype:pdf` },
              { category: "S3/Buckets", query: `site:${seed} "s3.amazonaws.com" OR "s3://" OR "bucket"`, url: `https://www.google.com/search?q=site:${e}+%22s3.amazonaws.com%22` },
              { category: "S3/Buckets", query: `site:${seed} "cloudfront.net" OR "gcs" OR "blob.core.windows.net"`, url: `https://www.google.com/search?q=site:${e}+%22cloudfront.net%22` },
              { category: "Error Pages", query: `site:${seed} "PHP Error" OR "Fatal error" OR "MySQL Error"`, url: `https://www.google.com/search?q=site:${e}+%22PHP+Error%22` },
              { category: "Error Pages", query: `site:${seed} "Internal Server Error" OR "Stack Trace" OR "Debug Mode"`, url: `https://www.google.com/search?q=site:${e}+%22Internal+Server+Error%22` },
              { category: "Cloud/CI", query: `site:${seed} ".travis.yml" OR ".github/workflows" OR ".gitlab-ci.yml"`, url: `https://www.google.com/search?q=site:${e}+%22.travis.yml%22` },
              { category: "Cloud/CI", query: `site:${seed} "docker-compose.yml" OR "Dockerfile" OR ".dockerignore"`, url: `https://www.google.com/search?q=site:${e}+%22docker-compose.yml%22` },
              { category: "Cloud/CI", query: `site:${seed} "terraform.tfstate" OR "terraform.tfvars" OR ".tfstate"`, url: `https://www.google.com/search?q=site:${e}+%22terraform.tfstate%22` },
              { category: "Jira/Confluence", query: `site:${seed} inurl:/jira OR inurl:/confluence OR inurl:/wiki`, url: `https://www.google.com/search?q=site:${e}+inurl:/jira` },
              { category: "Jira/Confluence", query: `site:${seed} intitle:"Jira" OR intitle:"Confluence" OR intitle:"Wiki"`, url: `https://www.google.com/search?q=site:${e}+intitle:%22Jira%22` },
              { category: "Open Redirects", query: `site:${seed} inurl:redirect OR inurl:redir OR inurl:url= OR inurl:next= OR inurl:return=`, url: `https://www.google.com/search?q=site:${e}+inurl:redirect+OR+inurl:url%3D` },
              { category: "Auth Endpoints", query: `site:${seed} inurl:oauth OR inurl:sso OR inurl:saml OR inurl:openid`, url: `https://www.google.com/search?q=site:${e}+inurl:oauth+OR+inurl:saml` },
              { category: "Backups", query: `site:${seed} ext:bak OR ext:old OR ext:backup OR ext:tmp OR ext:swp`, url: `https://www.google.com/search?q=site:${e}+ext:bak+OR+ext:old+OR+ext:backup` },
              { category: "Backups", query: `site:${seed} ext:zip OR ext:tar OR ext:gz OR ext:7z OR ext:rar`, url: `https://www.google.com/search?q=site:${e}+ext:zip+OR+ext:tar+OR+ext:7z` },
              { category: "Source Maps", query: `site:${seed} ext:map OR inurl:.map OR "sourceMappingURL"`, url: `https://www.google.com/search?q=site:${e}+ext:map+OR+%22sourceMappingURL%22` },
              { category: "Env/Secrets", query: `site:${seed} ".env" OR "/.env" OR "/.envrc"`, url: `https://www.google.com/search?q=site:${e}+%22.env%22+OR+%22%2F.envrc%22` },
              { category: "Env/Secrets", query: `site:${seed} "DB_PASSWORD" OR "MAIL_PASSWORD" OR "STRIPE_SECRET" OR "SLACK_TOKEN"`, url: `https://www.google.com/search?q=site:${e}+%22DB_PASSWORD%22+OR+%22STRIPE_SECRET%22` },
              { category: "Email Mentions", query: `site:${seed} "@${seed}"`, url: `https://www.google.com/search?q=site:${e}+%22%40${e}%22` },
              { category: "Email Mentions", query: `"@${seed}" -site:${seed}`, url: `https://www.google.com/search?q=%22%40${e}%22+-site:${e}` },
              { category: "Subdomains (Bing)", query: `site:${seed} -site:www.${seed}`, url: `https://www.bing.com/search?q=site:${e}+-site:www.${e}` },
              { category: "Subdomains (crt.sh)", query: `%.${seed}`, url: `https://crt.sh/?q=%25.${e}` },
              { category: "Hosting Footprints", query: `"${seed}" site:builtwith.com OR site:wappalyzer.com OR site:netcraft.com`, url: `https://www.google.com/search?q=%22${e}%22+site:builtwith.com+OR+site:netcraft.com` },
              { category: "Cert Transparency", query: `"${seed}" site:censys.io OR site:crt.sh OR site:certspotter.com`, url: `https://www.google.com/search?q=%22${e}%22+site:censys.io+OR+site:crt.sh` },
              { category: "Bug Bounty", query: `"${seed}" site:hackerone.com OR site:bugcrowd.com OR site:intigriti.com OR site:huntr.dev`, url: `https://www.google.com/search?q=%22${e}%22+site:hackerone.com+OR+site:bugcrowd.com` },
              { category: "Phishing/Brand Abuse", query: `inurl:${seed.replace(/\./g, "-")} -site:${seed}`, url: `https://www.google.com/search?q=inurl:${encodeURIComponent(seed.replace(/\./g, "-"))}+-site:${e}` },
              { category: "Phishing/Brand Abuse", query: `"${seed}" site:phishtank.org OR site:openphish.com OR site:urlscan.io`, url: `https://www.google.com/search?q=%22${e}%22+site:phishtank.org+OR+site:openphish.com` },
              { category: "Alt Search Engines", query: `site:${seed}`, url: `https://www.bing.com/search?q=site:${e}` },
              { category: "Alt Search Engines", query: `site:${seed}`, url: `https://duckduckgo.com/?q=site:${e}` },
              { category: "Alt Search Engines", query: `site:${seed}`, url: `https://yandex.com/search/?text=site%3A${e}` },
            ],
            ip: [
              { category: "Direct", query: `"${seed}"`, url: `https://www.google.com/search?q=%22${e}%22` },
              { category: "Shodan/Censys", query: `"${seed}" site:shodan.io OR site:censys.io`, url: `https://www.google.com/search?q=%22${e}%22+site:shodan.io` },
              { category: "Shodan/Censys", query: `"${seed}" site:spyse.com OR site:zoomeye.org OR site:fofa.info`, url: `https://www.google.com/search?q=%22${e}%22+site:spyse.com` },
              { category: "Threat Intel", query: `"${seed}" site:virustotal.com OR site:abuseipdb.com OR site:ipvoid.com`, url: `https://www.google.com/search?q=%22${e}%22+site:virustotal.com` },
              { category: "Threat Intel", query: `"${seed}" site:greynoise.io OR site:threatminer.org OR site:otx.alienvault.com`, url: `https://www.google.com/search?q=%22${e}%22+site:greynoise.io` },
              { category: "Threat Intel", query: `"${seed}" site:ibm.com/security OR site:cisco.com OR site:fireeye.com`, url: `https://www.google.com/search?q=%22${e}%22+site:ibm.com/security` },
              { category: "ASN/BGP", query: `"${seed}" site:ipinfo.io OR site:ip-api.com OR site:ipstack.com`, url: `https://www.google.com/search?q=%22${e}%22+site:ipinfo.io` },
              { category: "ASN/BGP", query: `"${seed}" site:asnlookup.com OR site:bgp.he.net OR site:peeringdb.com`, url: `https://www.google.com/search?q=%22${e}%22+site:bgp.he.net` },
              { category: "Hosting/VPS", query: `"${seed}" site:digitalocean.com OR site:aws.amazon.com OR site:linode.com`, url: `https://www.google.com/search?q=%22${e}%22+site:digitalocean.com` },
              { category: "Hosting/VPS", query: `"${seed}" site:ovh.com OR site:hetzner.com OR site:vultr.com`, url: `https://www.google.com/search?q=%22${e}%22+site:ovh.com` },
              { category: "Pastes/Leaks", query: `"${seed}" site:pastebin.com OR site:rentry.co OR site:controlc.com`, url: `https://www.google.com/search?q=%22${e}%22+site:pastebin.com` },
              { category: "Pastes/Leaks", query: `"${seed}" filetype:log OR filetype:txt "ssh" OR "rdp" OR "vpn"`, url: `https://www.google.com/search?q=%22${e}%22+filetype:log+%22ssh%22` },
              { category: "URLScan", query: `"${seed}" site:urlscan.io OR site:screenshot.guru OR site:archive.org`, url: `https://www.google.com/search?q=%22${e}%22+site:urlscan.io` },
              { category: "Domains on IP", query: `"${seed}" "reverse ip" OR "shared hosting" OR "domains on"`, url: `https://www.google.com/search?q=%22${e}%22+%22reverse+ip%22` },
              { category: "Caches", query: `"${seed}" site:web.archive.org OR site:archive.is`, url: `https://www.google.com/search?q=%22${e}%22+site:web.archive.org` },
              { category: "Forums", query: `"${seed}" site:hackforums.net OR site:breachforums.is OR site:nulled.to`, url: `https://www.google.com/search?q=%22${e}%22+site:hackforums.net` },
              { category: "Social", query: `"${seed}" site:reddit.com OR site:twitter.com OR site:4chan.org`, url: `https://www.google.com/search?q=%22${e}%22+site:reddit.com` },
              { category: "OSINT DBs", query: `"${seed}" site:oathnet.org OR site:osintnova.com OR site:osint.org`, url: `https://www.google.com/search?q=%22${e}%22+site:oathnet.org` },
              { category: "OSINT DBs", query: `"${seed}" site:osintcurious.io OR site:osintframework.com OR site:osintcombine.com`, url: `https://www.google.com/search?q=%22${e}%22+site:osintcurious.io` },
              { category: "Cert Transparency", query: `"${seed}" site:crt.sh OR site:censys.io OR site:certspotter.com`, url: `https://www.google.com/search?q=%22${e}%22+site:crt.sh+OR+site:censys.io` },
              { category: "Mail/SPF", query: `"${seed}" "spf" OR "include:" OR "v=spf1" OR "dmarc"`, url: `https://www.google.com/search?q=%22${e}%22+%22v%3Dspf1%22+OR+%22dmarc%22` },
              { category: "Honeypot/Scanner Lists", query: `"${seed}" site:honeynet.org OR site:dshield.org OR site:isc.sans.edu`, url: `https://www.google.com/search?q=%22${e}%22+site:dshield.org+OR+site:isc.sans.edu` },
              { category: "Blocklists", query: `"${seed}" site:spamhaus.org OR site:abuse.ch OR site:emergingthreats.net OR site:badips.com`, url: `https://www.google.com/search?q=%22${e}%22+site:spamhaus.org+OR+site:abuse.ch` },
              { category: "Alt Search Engines", query: `"${seed}"`, url: `https://www.bing.com/search?q=%22${e}%22` },
              { category: "Alt Search Engines", query: `"${seed}"`, url: `https://duckduckgo.com/?q=%22${e}%22` },
              { category: "Alt Search Engines", query: `"${seed}"`, url: `https://yandex.com/search/?text=%22${e}%22` },
            ],
            hash: [
              { category: "Direct", query: `"${seed}"`, url: `https://www.google.com/search?q=%22${e}%22` },
              { category: "Malware/Threat Intel", query: `"${seed}" site:virustotal.com OR site:hybrid-analysis.com OR site:any.run`, url: `https://www.google.com/search?q=%22${e}%22+site:virustotal.com+OR+site:hybrid-analysis.com` },
              { category: "Malware/Threat Intel", query: `"${seed}" site:malwarebazaar.abuse.ch OR site:malshare.com OR site:vx-underground.org`, url: `https://www.google.com/search?q=%22${e}%22+site:malwarebazaar.abuse.ch+OR+site:vx-underground.org` },
              { category: "Sandbox/Reports", query: `"${seed}" site:tria.ge OR site:joesandbox.com OR site:cuckoosandbox.org`, url: `https://www.google.com/search?q=%22${e}%22+site:tria.ge+OR+site:joesandbox.com` },
              { category: "Threat Reports", query: `"${seed}" site:otx.alienvault.com OR site:threatminer.org OR site:threatcrowd.org`, url: `https://www.google.com/search?q=%22${e}%22+site:otx.alienvault.com+OR+site:threatminer.org` },
              { category: "GitHub IOCs", query: `"${seed}" site:github.com OR site:gist.github.com`, url: `https://www.google.com/search?q=%22${e}%22+site:github.com+OR+site:gist.github.com` },
              { category: "Password Cracking", query: `"${seed}" site:hashes.com OR site:crackstation.net OR site:hashkiller.io`, url: `https://www.google.com/search?q=%22${e}%22+site:hashes.com+OR+site:crackstation.net` },
              { category: "Pastes", query: `"${seed}" site:pastebin.com OR site:ghostbin.co OR site:rentry.co`, url: `https://www.google.com/search?q=%22${e}%22+site:pastebin.com+OR+site:rentry.co` },
              { category: "Alt Search Engines", query: `"${seed}"`, url: `https://www.bing.com/search?q=%22${e}%22` },
              { category: "Alt Search Engines", query: `"${seed}"`, url: `https://duckduckgo.com/?q=%22${e}%22` },
              { category: "Alt Search Engines", query: `"${seed}"`, url: `https://yandex.com/search/?text=%22${e}%22` },
            ],
            crypto_wallet: [
              { category: "Direct", query: `"${seed}"`, url: `https://www.google.com/search?q=%22${e}%22` },
              { category: "Block Explorers", query: `"${seed}" site:etherscan.io OR site:blockchain.com OR site:blockchair.com`, url: `https://www.google.com/search?q=%22${e}%22+site:etherscan.io+OR+site:blockchain.com` },
              { category: "Block Explorers", query: `"${seed}" site:bscscan.com OR site:polygonscan.com OR site:arbiscan.io OR site:snowtrace.io`, url: `https://www.google.com/search?q=%22${e}%22+site:bscscan.com+OR+site:polygonscan.com` },
              { category: "Block Explorers", query: `"${seed}" site:solscan.io OR site:explorer.solana.com OR site:tronscan.org`, url: `https://www.google.com/search?q=%22${e}%22+site:solscan.io+OR+site:tronscan.org` },
              { category: "Web3 Profiles", query: `"${seed}" site:opensea.io OR site:rarible.com OR site:zapper.xyz OR site:debank.com`, url: `https://www.google.com/search?q=%22${e}%22+site:opensea.io+OR+site:debank.com` },
              { category: "Web3 Profiles", query: `"${seed}" site:warpcast.com OR site:lens.xyz OR site:farcaster.xyz OR site:mirror.xyz`, url: `https://www.google.com/search?q=%22${e}%22+site:warpcast.com+OR+site:mirror.xyz` },
              { category: "ENS / Reverse Resolve", query: `"${seed}" site:app.ens.domains OR ".eth" OR ".lens" OR ".sol"`, url: `https://www.google.com/search?q=%22${e}%22+site:app.ens.domains+OR+%22.eth%22` },
              { category: "Scam DBs", query: `"${seed}" site:cryptoscamdb.org OR site:chainabuse.com OR site:scam-alert.io`, url: `https://www.google.com/search?q=%22${e}%22+site:cryptoscamdb.org+OR+site:chainabuse.com` },
              { category: "Forums/Chatter", query: `"${seed}" site:reddit.com OR site:bitcointalk.org OR site:cryptopanic.com`, url: `https://www.google.com/search?q=%22${e}%22+site:reddit.com+OR+site:bitcointalk.org` },
              { category: "Telegram/Discord", query: `"${seed}" site:t.me OR site:discord.com OR site:discord.gg`, url: `https://www.google.com/search?q=%22${e}%22+site:t.me+OR+site:discord.gg` },
              { category: "GitHub", query: `"${seed}" site:github.com OR site:gist.github.com`, url: `https://www.google.com/search?q=%22${e}%22+site:github.com+OR+site:gist.github.com` },
              { category: "Pastes", query: `"${seed}" site:pastebin.com OR site:rentry.co OR site:ghostbin.co`, url: `https://www.google.com/search?q=%22${e}%22+site:pastebin.com+OR+site:rentry.co` },
              { category: "Stealer/Wallets.txt", query: `"${seed}" "wallets.txt" OR "metamask" OR "seed phrase"`, url: `https://www.google.com/search?q=%22${e}%22+%22wallets.txt%22+OR+%22metamask%22` },
              { category: "Alt Search Engines", query: `"${seed}"`, url: `https://www.bing.com/search?q=%22${e}%22` },
              { category: "Alt Search Engines", query: `"${seed}"`, url: `https://duckduckgo.com/?q=%22${e}%22` },
              { category: "Alt Search Engines", query: `"${seed}"`, url: `https://yandex.com/search/?text=%22${e}%22` },
            ],
          };
          return { seed, kind, dorks: map[kind] ?? [] };
        },
      }),
      dork_harvest: tool({
        description:
          "Execute the highest-yield document/leak dorks for a seed and AUTO-RECORD any PDFs, Office docs, CSV/SQL/log/env dumps, pastebin entries, and stealer-log URLs as artifacts (kind='document' for files, kind='leak_paste' for pastes). This is the way to turn google_dorks output into real evidence. Runs N targeted queries through MiniMax web_search, parses URLs from results, classifies them by extension/host, and inserts them directly into the case. Costs 1 MiniMax call per query.",
        inputSchema: z.object({
          seed: z.string(),
          kind: z.enum(["email", "username", "phone", "name", "domain", "ip", "hash", "crypto_wallet"]),
          max_queries: z.number().int().min(1).max(10).default(5),
        }),
        execute: async ({ seed, kind, max_queries }) => {
          // Targeted dork queries per kind, ordered by document/leak yield.
          const QUERIES: Record<string, string[]> = {
            email: [
              `"${seed}" (filetype:pdf OR filetype:doc OR filetype:docx OR filetype:xls OR filetype:xlsx OR filetype:csv)`,
              `"${seed}" (site:pastebin.com OR site:rentry.co OR site:ghostbin.co OR site:justpaste.it OR site:controlc.com OR site:0bin.net)`,
              `"${seed}" ("passwords.txt" OR "credentials.txt" OR "logins.txt" OR "combolist" OR "stealer log")`,
              `"${seed}" (intitle:"index of" OR "directory listing") ("email" OR "users" OR "accounts")`,
              `"${seed}" ("resume" OR "cv" OR "curriculum vitae") (filetype:pdf OR filetype:doc)`,
              `"${seed}" (ext:sql OR ext:db OR ext:bak OR ext:log OR ext:env OR ext:json)`,
            ],
            username: [
              `"${seed}" (site:pastebin.com OR site:rentry.co OR site:ghostbin.co OR site:justpaste.it OR site:0bin.net)`,
              `"${seed}" ("passwords" OR "logins" OR "autofill" OR "wallets.txt") (filetype:txt OR filetype:log)`,
              `"${seed}" (filetype:pdf OR filetype:doc OR filetype:docx)`,
              `"@${seed}" (filetype:pdf OR filetype:csv OR filetype:xlsx)`,
              `"${seed}" ("stealer log" OR "redline" OR "raccoon" OR "vidar" OR "lumma")`,
              `"${seed}" ("combo" OR "combolist" OR "leak" OR "dump")`,
            ],
            phone: [
              `"${seed}" (filetype:pdf OR filetype:csv OR filetype:xls OR filetype:txt)`,
              `"${seed}" (site:pastebin.com OR site:rentry.co OR site:ghostbin.co OR site:justpaste.it)`,
              `"${seed}" ("contact" OR "phone" OR "directory") (filetype:pdf OR filetype:csv)`,
              `"${seed}" ("resume" OR "cv") filetype:pdf`,
              `"${seed}" (intitle:"index of" "contacts" OR "phones")`,
            ],
            name: [
              `"${seed}" (filetype:pdf OR filetype:doc OR filetype:docx)`,
              `"${seed}" ("resume" OR "cv" OR "curriculum vitae") filetype:pdf`,
              `"${seed}" ("deed" OR "property record" OR "court" OR "lawsuit") (filetype:pdf OR filetype:html)`,
              `"${seed}" (site:fec.gov OR site:opensecrets.org) filetype:pdf OR filetype:csv`,
              `"${seed}" ("biography" OR "about" OR "portfolio") filetype:pdf`,
            ],
            domain: [
              `site:${seed} (ext:env OR ext:log OR ext:bak OR ext:sql OR ext:dump OR ext:backup)`,
              `site:${seed} (ext:json OR ext:xml OR ext:yaml OR ext:yml OR ext:config OR ext:map)`,
              `site:${seed} intitle:"index of"`,
              `site:${seed} (filetype:pdf OR filetype:doc OR filetype:docx OR filetype:xls OR filetype:csv)`,
              `site:${seed} ("confidential" OR "internal use only" OR "proprietary") filetype:pdf`,
              `site:${seed} (ext:zip OR ext:tar OR ext:gz OR ext:7z OR ext:rar)`,
            ],
            ip: [
              `"${seed}" (site:pastebin.com OR site:rentry.co OR site:ghostbin.co)`,
              `"${seed}" (filetype:log OR filetype:txt) ("ssh" OR "rdp" OR "vpn" OR "access")`,
              `"${seed}" (filetype:pcap OR filetype:csv OR filetype:json)`,
            ],
            hash: [
              `"${seed}" (site:virustotal.com OR site:hybrid-analysis.com OR site:any.run OR site:tria.ge OR site:joesandbox.com)`,
              `"${seed}" (site:malwarebazaar.abuse.ch OR site:malshare.com OR site:vx-underground.org)`,
              `"${seed}" (site:otx.alienvault.com OR site:threatminer.org OR site:github.com)`,
              `"${seed}" (site:pastebin.com OR site:rentry.co OR site:ghostbin.co)`,
              `"${seed}" (filetype:pdf OR filetype:csv) ("IOC" OR "indicator" OR "report")`,
            ],
            crypto_wallet: [
              `"${seed}" (site:etherscan.io OR site:bscscan.com OR site:polygonscan.com OR site:solscan.io OR site:tronscan.org)`,
              `"${seed}" (site:cryptoscamdb.org OR site:chainabuse.com OR site:scam-alert.io)`,
              `"${seed}" (site:pastebin.com OR site:rentry.co OR site:ghostbin.co)`,
              `"${seed}" ("wallets.txt" OR "metamask" OR "seed phrase" OR "private key")`,
              `"${seed}" (filetype:csv OR filetype:json OR filetype:txt)`,
              `"${seed}" (site:github.com OR site:gist.github.com)`,
            ],
          };

          const queries = (QUERIES[kind] ?? []).slice(0, max_queries);
          if (queries.length === 0) return { ok: false, error: `no dork_harvest queries for kind=${kind}` };

          const DOC_EXT_RE = /\.(pdf|docx?|pptx?|xlsx?|csv|txt|log|sql|bak|env|json|xml|ya?ml|zip|tar|gz|7z|rar|pcap|map|dump|sqlite|db)(?:[?#]|$)/i;
          const PASTE_HOST_RE = /(?:^|\/\/|\.)(pastebin\.com|rentry\.co|ghostbin\.co|justpaste\.it|controlc\.com|0bin\.net|hastebin\.com|paste\.ee|bpaste\.net|termbin\.com|dpaste\.com|paste\.ubuntu\.com|privatebin\.info|gist\.github\.com)\b/i;
          const URL_RE = /https?:\/\/[^\s)\]'"<>]+/g;

          const collected: Array<{ url: string; via: string; classify: "document" | "leak_paste" }> = [];
          const seen = new Set<string>();
          const queryResults: Array<{
            query: string;
            ok: boolean;
            hits: number;
            provider?: "minimax_web_search" | "exa_search";
            status?: number;
            answer?: string;
            error?: string;
          }> = [];

          const extractUrls = (text: string): string[] =>
            Array.from(new Set((text.match(URL_RE) ?? []).map((u) => u.replace(/[).,;:]+$/, ""))));

          const exaSearchUrls = async (q: string): Promise<{ ok: boolean; status: number; urls: string[]; note?: string }> => {
            if (!EXA_API_KEY) return { ok: false, status: 0, urls: [], note: "EXA_API_KEY not configured" };
            try {
              const r = await fetchRetry("https://api.exa.ai/search", {
                method: "POST",
                headers: {
                  "x-api-key": EXA_API_KEY,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ query: q, type: "keyword", numResults: 10, contents: false }),
              });
              interface ExaSearchResp {
                results?: Array<{ url?: unknown; [k: string]: unknown }>;
                [k: string]: unknown;
              }
              const data = await r.json().catch(() => ({}));
              const exaResults = (data as ExaSearchResp)?.results;
              const urls = Array.isArray(exaResults)
                ? exaResults
                    .map((x) => (typeof x?.url === "string" ? x.url : ""))
                    .filter((u: string) => !!u)
                : [];
              return { ok: r.ok, status: r.status, urls };
            } catch (e) {
              return { ok: false, status: 0, urls: [], note: String(e) };
            }
          };

          for (const q of queries) {
            try {
              const r = await minimaxChat({
                system:
                  "You are an OSINT dork-harvester. Use the web_search tool. Run the user's query VERBATIM. Return ONLY a bullet list of every result URL you find (one URL per line, no commentary). Do not summarize. Do not editorialize. If nothing is found, reply with exactly: NONE.",
                user: q,
                webSearch: true,
                maxTokens: 1200,
              });

              let provider: "minimax_web_search" | "exa_search" = "minimax_web_search";
              let status = r.status;
              let text = r.content ?? "";
              let urls = extractUrls(text);
              let providerError: string | undefined;

              // MiniMax web_search occasionally returns upstream 5xx/timeout responses.
              // Treat those as provider degradation, then fall back to Exa so
              // Google Dorking remains available instead of surfacing as offline.
              if (!r.ok || urls.length === 0) {
                const exa = await exaSearchUrls(q);
                if (exa.ok && exa.urls.length > 0) {
                  provider = "exa_search";
                  status = exa.status;
                  urls = exa.urls;
                  text = `EXA_FALLBACK:${exa.urls.slice(0, 20).join("\n")}`;
                } else {
                  providerError = !r.ok
                    ? `minimax_web_search HTTP ${r.status}`
                    : (exa.note ? `fallback exa failed: ${exa.note}` : "no URLs returned by minimax or exa");
                }
              }

              let hits = 0;
              for (const u of urls) {
                if (seen.has(u)) continue;
                let classify: "document" | "leak_paste" | null = null;
                if (PASTE_HOST_RE.test(u)) classify = "leak_paste";
                else if (DOC_EXT_RE.test(u)) classify = "document";
                if (!classify) continue;
                seen.add(u);
                collected.push({ url: u, via: q, classify });
                hits++;
              }

              queryResults.push({
                query: q,
                ok: hits > 0,
                provider,
                status,
                hits,
                answer: text.slice(0, 400),
                ...(providerError ? { error: providerError } : {}),
              });
            } catch (e) {
              queryResults.push({ query: q, ok: false, hits: 0, error: String(e) });
            }
          }

          let inserted = 0;
          const providerStats = queryResults.reduce(
            (acc, q) => {
              const p = q.provider ?? "minimax_web_search";
              if (p === "exa_search") acc.exa++;
              else acc.minimax++;
              if (q.ok) acc.success++;
              else acc.failed++;
              return acc;
            },
            { minimax: 0, exa: 0, success: 0, failed: 0 },
          );
          if (collected.length > 0) {
            const rows = collected.map((c) => ({
              thread_id: threadId,
              user_id: userId,
              kind: c.classify,
              value: c.url,
              confidence: c.classify === "leak_paste" ? 55 : 60,
              source: "dork_harvest",
              metadata: {
                seed,
                seed_kind: kind,
                dork_query: c.via,
                discovered_via: "google_dork → minimax web_search",
              },
            }));
            const safeRows = scrubArtifactRows(rows);
            const { error } = await supabase.from("artifacts").insert(safeRows);
            if (!error) {
              inserted = safeRows.length;
              bumpArtifacts(safeRows.length, safeRows.map((r) => String(r.kind)));
            } else {
              return { ok: false, error: error.message, queries: queryResults, found: collected.length, inserted: 0 };
            }
          }

          return {
            ok: true,
            seed,
            kind,
            queries_run: queryResults.length,
            urls_found: collected.length,
            artifacts_inserted: inserted,
            sample: collected.slice(0, 20),
            per_query: queryResults,
            provider_stats: providerStats,
            degraded: providerStats.exa > 0,
            note: inserted > 0
              ? `Inserted ${inserted} document/leak artifacts. They are now in the case — do NOT also record them via record_artifacts.${providerStats.exa > 0 ? ` Fallback engaged: Exa handled ${providerStats.exa}/${queryResults.length} query(ies).` : ""}`
              : `No document/leak URLs found in this harvest pass.${providerStats.exa > 0 ? ` Fallback engaged: Exa handled ${providerStats.exa}/${queryResults.length} query(ies).` : ""}`,
          };
        },
      }),
      gemini_deep_dork: tool({
        description:
          "DEEP DORK via Gemini 2.5 Flash with native Google Search grounding. Gemini reasons about the seed, formulates several targeted Google dork queries internally, executes them against real Google, and returns a synthesized writeup PLUS all source URLs as grounding citations. Use this when google_dorks/dork_harvest miss something or you want LLM-driven dork generation (e.g. tricky person/handle disambiguation, leak/breach context, niche forum surfacing). AUTO-RECORDS every cited URL as an artifact (kind='url' or classified by extension as 'document'/'leak_paste'). 1 Gemini call ≈ $0.002.",
        inputSchema: z.object({
          seed: z.string(),
          kind: z.enum(["email","username","phone","name","person","domain","ip","hash","crypto_wallet","url","other"]),
          focus: z.string().optional().describe("Optional angle, e.g. 'breach exposure', 'resume/CV leaks', 'social handles', 'pastebin dumps', 'forum posts', 'court records'."),
        }),
        execute: async ({ seed, kind, focus }) => {
          if (!GEMINI_API_KEY) return { ok: false, error: "GEMINI_API_KEY not configured" };
          const system =
            "You are an elite OSINT dork operator. For the given seed, design 5-8 high-yield Google dork queries (use site:, filetype:, intitle:, inurl:, exact-phrase quoting, boolean OR groups). EXECUTE them with the google_search tool. Then write a concise bulletized intelligence summary citing ONLY what your searches actually found. Be specific: name the platforms/leak sites/forums/document types you surfaced and quote any usernames, emails, phone fragments, or filenames discovered. If nothing material is found, say so plainly. Do not fabricate.";
          const user =
            `Seed (${kind}): ${seed}\n` +
            (focus ? `Focus: ${focus}\n` : "") +
            `Goal: deep-dork this seed across Google. Surface breach/leak exposure, document/file leaks (PDFs, CVs, dumps), pastebin/rentry/ghostbin pastes, forum mentions, social/profile traces, and any public-records or news hits. Prefer recent + high-signal results.`;
          const res = await geminiGroundedSearch({ prompt: user, system });
          if (!res.ok) return { ok: false, status: res.status, error: "gemini_grounded_search_failed", detail: String((res.raw as { error?: { message?: unknown } })?.error?.message ?? "").slice(0, 400) };

          // Classify + dedupe citations, then auto-record.
          const seen = new Set<string>();
          const classify = (u: string): "document" | "leak_paste" | "url" => {
            const low = u.toLowerCase();
            if (/\.(pdf|docx?|xlsx?|pptx?|csv|sql|db|bak|log|env|json|txt)(\?|$)/.test(low)) return "document";
            if (/(pastebin\.com|rentry\.co|ghostbin\.co|justpaste\.it|controlc\.com|0bin\.net|hastebin\.com|paste\.ee|dpaste\.com)/.test(low)) return "leak_paste";
            return "url";
          };
          const rows = res.citations
            .filter((c) => {
              if (!c.uri || seen.has(c.uri)) return false;
              // Drop ephemeral Gemini grounding-redirect URLs (expire in minutes,
              // zero OSINT value) and raw google search URLs. Massive junk source.
              const low = c.uri.toLowerCase();
              if (low.includes("vertexaisearch.cloud.google.com")) return false;
              if (low.includes("google.com/search?") || low.includes("/url?q=")) return false;
              if (low.startsWith("https://www.google.com/") && !low.includes("/maps/")) return false;
              seen.add(c.uri);
              return true;
            })
            .map((c) => {
              const k = classify(c.uri);
              return {
                thread_id: threadId,
                user_id: userId,
                kind: k,
                value: c.uri,
                confidence: k === "leak_paste" ? 60 : k === "document" ? 65 : 55,
                source: "gemini_deep_dork",
                metadata: {
                  seed,
                  seed_kind: kind,
                  focus: focus ?? null,
                  title: c.title ?? null,
                  discovered_via: "gemini google_search grounding",
                },
              };
            });
          let inserted = 0;
          if (rows.length) {
            const safeRows = scrubArtifactRows(rows);
            const { error } = await supabase.from("artifacts").insert(safeRows);
            if (!error) {
              inserted = safeRows.length;
              bumpArtifacts(safeRows.length, safeRows.map((r) => String(r.kind)));
            }
          }
          return {
            ok: true,
            seed,
            kind,
            focus: focus ?? null,
            summary: res.text.slice(0, 6000),
            dork_queries: res.queries,
            citations: res.citations.slice(0, 40),
            artifacts_inserted: inserted,
            note: inserted > 0
              ? `Recorded ${inserted} cited URLs as artifacts — do NOT re-record via record_artifacts.`
              : "No grounded citations returned.",
          };
        },
      }),
      shodan_internetdb: tool({
        description:
          "Free, no-auth Shodan InternetDB lookup for an IP. Returns open ports, hostnames, CPEs, tags, and known CVEs. Use on every IP after ip_intel.",
        inputSchema: z.object({ ip: z.string() }),
        execute: async ({ ip }) => {
          try {
            const r = await fetchT(`https://internetdb.shodan.io/${encodeURIComponent(ip)}`, {}, 12_000);
            const data = await r.json().catch(() => ({}));
            return { ok: r.ok, status: r.status, data };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      firecrawl_search: tool({
        description:
          "DISABLED. Use exa_search + minimax_web_search instead. Calling this tool wastes a step and returns an immediate error.",
        inputSchema: z.object({
          query: z.string().min(2),
          limit: z.number().int().min(1).max(20).default(10),
          tbs: z.string().optional().describe("Time filter: qdr:h | qdr:d | qdr:w | qdr:m | qdr:y"),
          country: z.string().optional(),
          lang: z.string().optional(),
          sources: z.array(z.enum(["web", "news", "images"])).optional(),
          scrape: z.boolean().default(false).describe("If true, also scrape markdown for each result."),
        }),
        execute: async () => ({
          error: "firecrawl_disabled",
          skipped: true,
          hint: "Firecrawl is permanently disabled. Call exa_search and minimax_web_search in parallel instead. Do NOT retry firecrawl_search.",
        }),
      }),
      firecrawl_scrape: tool({
        description:
          "DISABLED. Use jina_reader_scrape instead. Calling this tool wastes a step and returns an immediate error.",
        inputSchema: z.object({
          url: z.string().url(),
          formats: z.array(z.enum(["markdown", "html", "links", "screenshot", "summary"])).default(["markdown"]),
          onlyMainContent: z.boolean().default(true),
          waitFor: z.number().int().min(0).max(15000).optional(),
        }),
        execute: async ({ url }) => ({
          error: "firecrawl_disabled",
          skipped: true,
          hint: `Firecrawl is permanently disabled. Call jina_reader_scrape({ url: "${url}" }) instead.`,
        }),
      }),
      firecrawl_map: tool({
        description:
          "DISABLED. Use crtsh_subdomains + dns_records instead. Calling this tool wastes a step and returns an immediate error.",
        inputSchema: z.object({
          url: z.string().url(),
          search: z.string().optional(),
          limit: z.number().int().min(1).max(5000).default(500),
          includeSubdomains: z.boolean().default(false),
        }),
        execute: async () => ({
          error: "firecrawl_disabled",
          skipped: true,
          hint: "Firecrawl is permanently disabled. Call crtsh_subdomains + dns_records for domain enumeration instead.",
        }),
      }),
      jina_reader_scrape: tool({
        description:
          "#1 PRIMARY scraper for ANY URL — free, unlimited, returns clean LLM-ready markdown. Always prefer this over firecrawl/exa_contents for single-page extraction. Use https://r.jina.ai/{url} under the hood. Works on articles, profile pages, forums, leak listings, dorks hits, Discord/Telegram links, PDFs (best-effort), etc. Pass a fully-qualified http(s) URL — do NOT pass relative paths or text snippets.",
        inputSchema: z.object({
          url: z.string().url(),
          maxChars: z.number().int().min(500).max(40000).default(18000),
        }),
        execute: async ({ url, maxChars }) => {
          // Preflight: trim whitespace, drop fragment, drop non-http(s),
          // reject relative paths, snippets, and IDN/odd schemes that 422 on Jina.
          const raw = (url ?? "").trim();
          if (!raw) return { error: "empty_url", skipped: true };
          let parsed: URL;
          try { parsed = new URL(raw); } catch { return { error: "invalid_url", skipped: true, url: raw }; }
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            return { error: "non_http_url", skipped: true, url: raw };
          }
          parsed.hash = ""; // r.jina.ai 422s on fragments
          // Skip a host already proven dead (NXDOMAIN) this investigation.
          if (isHostDead(parsed.hostname)) return { skipped: true, reason: "host does not resolve (NXDOMAIN) — skipped", url: raw };
          // Rebuild a clean URL; r.jina.ai expects the raw URL appended.
          const clean = parsed.toString();
          try {
            const headers: Record<string, string> = { Accept: "text/plain" };
            if (JINA_API_KEY) headers.Authorization = `Bearer ${JINA_API_KEY}`;
            const target = `https://r.jina.ai/${clean}`;
            const r = await fetchRetry(target, { headers }, { retries: 2 });
            if (!r.ok) {
              // 422 = unprocessable URL (paywall, JS app, binary, login wall, etc.)
              // 451/403 = blocked by origin. Do NOT retry — signal the agent to pivot.
              const hint = r.status === 422
                ? "jina cannot parse this URL — try a different source or wayback snapshot"
                : r.status === 451 || r.status === 403
                  ? "origin blocked — try wayback_snapshots or a different result"
                  : undefined;
              return { error: `jina ${r.status}`, status: r.status, url: clean, hint };
            }
            const text = await r.text();
            return { ok: true, url: clean, markdown: text.slice(0, maxChars), truncated: text.length > maxChars };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      exa_search: tool({
        description:
          "Exa /search — neural + keyword web search with optional inline contents (text, highlights, summary). PRIMARY web search alongside minimax_web_search — call BOTH in parallel on any meaningful query. Exa's neural mode is best for semantic / concept queries ('people who wrote about X', 'companies similar to Y'); keyword mode is best for exact strings (emails, usernames, hashes, wallets). Supports includeDomains/excludeDomains, startPublishedDate/endPublishedDate, and category ('company','research paper','news','pdf','github','tweet','personal site','linkedin profile','financial report').",
        inputSchema: z.object({
          query: z.string().min(2),
          type: z.enum(["auto", "neural", "keyword"]).default("auto"),
          numResults: z.number().int().min(1).max(25).default(10),
          includeDomains: z.array(z.string()).optional(),
          excludeDomains: z.array(z.string()).optional(),
          startPublishedDate: z.string().optional().describe("ISO date, e.g. 2024-01-01"),
          endPublishedDate: z.string().optional(),
          category: z.enum([
            "company","research paper","news","pdf","github","tweet",
            "personal site","linkedin profile","financial report",
          ]).optional(),
          contents: z.boolean().default(true).describe("If true, include text+highlights+summary for each result."),
        }),
        execute: async ({ query, type, numResults, includeDomains, excludeDomains, startPublishedDate, endPublishedDate, category, contents }) => {
          if (!EXA_API_KEY) return { error: "EXA_API_KEY not configured" };
          try {
            const body: Record<string, unknown> = { query, type, numResults };
            if (includeDomains?.length) body.includeDomains = includeDomains;
            if (excludeDomains?.length) body.excludeDomains = excludeDomains;
            if (startPublishedDate) body.startPublishedDate = startPublishedDate;
            if (endPublishedDate) body.endPublishedDate = endPublishedDate;
            if (category) body.category = category;
            if (contents) body.contents = { text: { maxCharacters: 2000 }, highlights: true, summary: true };
            const r = await fetchRetry("https://api.exa.ai/search", {
              method: "POST",
              headers: {
                "x-api-key": EXA_API_KEY,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(body),
            });
            const data = await r.json().catch(() => ({}));
            return { ok: r.ok, status: r.status, data: trimExaResults(data) };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      exa_find_similar: tool({
        description:
          "Exa /findSimilar — given a known URL, find pages similar to it (same person's other profiles, related company sites, similar leak listings). Powerful for OSINT pivoting from any single confirmed profile URL.",
        inputSchema: z.object({
          url: z.string().url(),
          numResults: z.number().int().min(1).max(25).default(10),
          excludeSourceDomain: z.boolean().default(true),
          contents: z.boolean().default(true),
        }),
        execute: async ({ url, numResults, excludeSourceDomain, contents }) => {
          if (!EXA_API_KEY) return { error: "EXA_API_KEY not configured" };
          try {
            const body: Record<string, unknown> = { url, numResults, excludeSourceDomain };
            if (contents) body.contents = { text: { maxCharacters: 1500 }, highlights: true };
            const r = await fetchRetry("https://api.exa.ai/findSimilar", {
              method: "POST",
              headers: {
                "x-api-key": EXA_API_KEY,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(body),
            });
            const data = await r.json().catch(() => ({}));
            return { ok: r.ok, status: r.status, data: trimExaResults(data) };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      exa_get_contents: tool({
        description:
          "Exa /contents — fetch full text, highlights, and an AI summary for up to 10 URLs in a single call. Best for bulk URL reading when you already have URLs from search results and just need their content. Set livecrawl='always' to bypass Exa's cache for time-sensitive pages.",
        inputSchema: z.object({
          urls: z.array(z.string().url()).min(1).max(10),
          text: z.boolean().default(true),
          highlights: z.boolean().default(true),
          summary: z.boolean().default(true),
          livecrawl: z.enum(["never","fallback","auto","always"]).default("auto"),
          maxCharacters: z.number().int().min(200).max(8000).default(3000),
        }),
        execute: async ({ urls, text, highlights, summary, livecrawl, maxCharacters }) => {
          if (!EXA_API_KEY) return { error: "EXA_API_KEY not configured" };
          try {
            const body: Record<string, unknown> = { urls, livecrawl };
            if (text) body.text = { maxCharacters };
            if (highlights) body.highlights = true;
            if (summary) body.summary = true;
            const r = await fetchRetry("https://api.exa.ai/contents", {
              method: "POST",
              headers: {
                "x-api-key": EXA_API_KEY,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(body),
            });
            const data = await r.json().catch(() => ({}));
            return { ok: r.ok, status: r.status, data: trimExaResults(data) };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      emailrep: tool({
        description:
          "Free EmailRep.io reputation lookup. Returns reputation (high/medium/low/none), suspicious flag, deliverability, breach count, domain age, and which sites the email is registered on. Great corroboration for any email seed.",
        inputSchema: z.object({ email: z.string().email() }),
        execute: async ({ email }) => {
          try {
            const r = await fetchT(`https://emailrep.io/${encodeURIComponent(email)}`, {
              headers: { "User-Agent": "Proximity-OSINT", Accept: "application/json" },
            });
            const data = await r.json().catch(() => ({}));
            return { ok: r.ok, status: r.status, data };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      gravatar_profile: tool({
        description:
          "Look up a Gravatar profile by email. Returns display name, bio, linked social accounts, avatar URL — and confirms the email is real. Always run on any email seed.",
        inputSchema: z.object({ email: z.string().email() }),
        execute: async ({ email }) => {
          try {
            const enc = new TextEncoder().encode(email.trim().toLowerCase());
            const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", enc)))
              .map((b) => b.toString(16).padStart(2, "0")).join("");
            const r = await fetchT(`https://api.gravatar.com/v3/profiles/${hash}`, {
              headers: { Accept: "application/json", "User-Agent": "Proximity-OSINT" },
            });
            const data = await r.json().catch(() => ({}));
            return { ok: r.ok, status: r.status, hash, avatar_url: `https://gravatar.com/avatar/${hash}`, data };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      hackertarget: tool({
        description:
          "Free HackerTarget recon (50 queries/day per source IP, no key). Modes: reverseiplookup (domains hosted on an IP), hostsearch (subdomains+IPs of a domain), dnslookup (all DNS records), aslookup (ASN of an IP), geoip, reverse-dns.",
        inputSchema: z.object({
          mode: z.enum(["reverseiplookup", "hostsearch", "dnslookup", "aslookup", "geoip", "reversedns"]),
          query: z.string(),
        }),
        execute: async ({ mode, query }) => {
          const slug = mode === "reversedns" ? "reversedns" : mode;
          try {
            const r = await fetchT(`https://api.hackertarget.com/${slug}/?q=${encodeURIComponent(query)}`, {}, 12_000);
            const text = await r.text();
            const trimmed = text.trim();
            // HackerTarget returns HTTP 200 with a plain-text error/quota body, e.g.
            // "error invalid host", "API count exceeded - ...", "No DNS Records found".
            // Without this check those strings get returned as legitimate recon "lines".
            const apiError = isHackertargetApiError(trimmed);
            const lines = trimmed.split("\n").filter(Boolean).slice(0, 500);
            return { ok: r.ok && !apiError, status: r.status, mode, query, ...(apiError ? { error: trimmed.slice(0, 200) } : {}), lines };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      urlscan_search: tool({
        description:
          "Search urlscan.io's public scan database (no auth). Use to find historical URLs/screenshots referencing a domain, IP, hash, or string. Returns up to 20 scan results with page URL, screenshot, IP, ASN.",
        inputSchema: z.object({ query: z.string().describe('Lucene query, e.g. domain:example.com or ip:1.2.3.4 or page.url:"keyword"') }),
        execute: async ({ query }) => {
          const gated = gateStage2("urlscan_search");
          if (gated) return gated;
          try {
            const r = await fetchT(`https://urlscan.io/api/v1/search/?q=${encodeURIComponent(query)}&size=20`, {}, 12_000);
            interface UrlscanResult {
              page?: { url?: unknown; domain?: unknown; ip?: unknown; asn?: unknown; country?: unknown; [k: string]: unknown };
              screenshot?: unknown;
              task?: { time?: unknown; [k: string]: unknown };
              result?: unknown;
              [k: string]: unknown;
            }
            const data = await r.json().catch(() => ({}));
            const results = (data as { results?: UrlscanResult[] }).results ?? [];
            return {
              ok: r.ok, total: (data as { total?: number }).total,
              results: results.map((x: UrlscanResult) => ({
                url: x?.page?.url, domain: x?.page?.domain, ip: x?.page?.ip,
                asn: x?.page?.asn, country: x?.page?.country,
                screenshot: x?.screenshot, scanned: x?.task?.time, result: x?.result,
              })),
            };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      hackernews_user: tool({
        description: "Fetch a Hacker News user profile (karma, about, account age, submitted item IDs).",
        inputSchema: z.object({ username: z.string() }),
        execute: async ({ username }) => {
          try {
            const r = await fetchT(`https://hacker-news.firebaseio.com/v0/user/${encodeURIComponent(username)}.json`);
            const data = await r.json().catch(() => null);
            return { ok: r.ok && data != null, data };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      reddit_user: tool({
        description: "Fetch a Reddit user's public profile and recent posts/comments.",
        inputSchema: z.object({ username: z.string() }),
        execute: async ({ username }) => {
          try {
            const h = { "User-Agent": "Proximity-OSINT/1.0" };
            const u = encodeURIComponent(username);
            const fetchJson = async (url: string): Promise<{ status: number; body: unknown }> => {
              try {
                const rr = await fetchT(url, { headers: h });
                return { status: rr.status, body: await rr.json().catch(() => null) };
              } catch {
                return { status: 0, body: null };
              }
            };
            const [aboutRes, postsRes] = await Promise.all([
              fetchJson(`https://www.reddit.com/user/${u}/about.json`),
              fetchJson(`https://www.reddit.com/user/${u}.json?limit=15`),
            ]);
            // Reddit serves 429 (rate-limit) / 403 (blocked datacenter IP) / 404
            // (suspended or nonexistent user) with a JSON error body that has no
            // .data.children. Without a status check those would be returned as
            // "user exists but has no activity" — a false negative. Surface the
            // failure when neither endpoint returned a 2xx.
            if (aboutRes.status >= 400 && postsRes.status >= 400) {
              const status = postsRes.status || aboutRes.status;
              return {
                ok: false,
                status,
                error: status === 429 ? "reddit rate-limited (429)"
                  : status === 404 ? "reddit user not found (404)"
                  : `reddit request failed (${status})`,
                username,
              };
            }
            const about = aboutRes.body;
            const posts = postsRes.body;
            interface RedditChild {
              kind?: unknown;
              data?: {
                subreddit?: unknown;
                title?: unknown;
                body?: string;
                permalink?: string;
                created_utc?: unknown;
                [k: string]: unknown;
              };
              [k: string]: unknown;
            }
            interface RedditListing {
              data?: { children?: RedditChild[]; [k: string]: unknown };
              [k: string]: unknown;
            }
            const items = ((posts as RedditListing)?.data?.children ?? []).map((c: RedditChild) => ({
              kind: c.kind, subreddit: c.data?.subreddit, title: c.data?.title,
              body: c.data?.body?.slice?.(0, 300), url: c.data?.permalink ? `https://reddit.com${c.data.permalink}` : undefined,
              created: c.data?.created_utc,
            }));
            return { ok: true, about: (about as RedditListing)?.data, recent: items };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      github_code_search: tool({
        description:
          "Search GitHub's public code index for a string (email, username, key fragment, internal hostname). Returns up to 20 file matches with repo and snippet. Authenticated via GITHUB_API_TOKEN (5,000 req/hr) when configured, else falls back to unauthenticated (60 req/hr).",
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => {
          const gated = gateStage2("github_code_search");
          if (gated) return gated;
          try {
            const headers: Record<string, string> = {
              "User-Agent": "Proximity-OSINT",
              Accept: "application/vnd.github.v3.text-match+json",
            };
            if (GITHUB_API_TOKEN) headers.Authorization = `Bearer ${GITHUB_API_TOKEN}`;
            const r = await fetchT(`https://api.github.com/search/code?q=${encodeURIComponent(query)}&per_page=20`, { headers });
            const text = await r.text();
            let data: GitHubCodeSearchResponse = {};
            try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
            if (!r.ok) {
              const remaining = r.headers.get("x-ratelimit-remaining");
              const reset = r.headers.get("x-ratelimit-reset");
              console.warn(`[github_code_search] HTTP ${r.status} authed=${!!GITHUB_API_TOKEN} remaining=${remaining} reset=${reset} msg=${(data?.message ?? "").slice(0, 200)}`);
              return { error: `github ${r.status}`, status: r.status, authenticated: !!GITHUB_API_TOKEN, rate_remaining: remaining, message: data?.message, snippet: text.slice(0, 300) };
            }
            const items = (data?.items ?? []).map((i: GitHubCodeMatch) => {
              const textMatches = Array.isArray(i.text_matches) ? (i.text_matches as Array<{ fragment?: unknown }>) : [];
              return {
                repo: i.repository?.full_name, path: i.path, url: i.html_url,
                matches: textMatches.map((m) => m.fragment).slice(0, 3),
              };
            });
            return { ok: true, authenticated: !!GITHUB_API_TOKEN, total: data?.total_count, items };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      hunter_domain_search: tool({
        description:
          "Hunter.io domain-search. Returns emails associated with a domain, plus organization, pattern, department/seniority breakdown, and per-email sources. Premium signal — use on any non-consumer domain.",
        inputSchema: z.object({
          domain: z.string(),
          limit: z.number().int().min(1).max(100).optional(),
          department: z.string().optional().describe("executive, it, finance, management, sales, legal, support, hr, marketing, communication, education, design, health, operations"),
          seniority: z.string().optional().describe("junior, senior, executive"),
          type: z.enum(["personal", "generic"]).optional(),
        }),
        execute: async ({ domain, limit, department, seniority, type }) => {
          if (!HUNTER_API_KEY) return { error: "HUNTER_API_KEY not configured" };
          try {
            const params = new URLSearchParams({ domain, api_key: HUNTER_API_KEY });
            if (limit) params.set("limit", String(limit));
            if (department) params.set("department", department);
            if (seniority) params.set("seniority", seniority);
            if (type) params.set("type", type);
            interface HunterDomainEmail {
              value?: unknown;
              first_name?: unknown;
              last_name?: unknown;
              position?: unknown;
              department?: unknown;
              seniority?: unknown;
              linkedin?: unknown;
              twitter?: unknown;
              phone_number?: unknown;
              confidence?: unknown;
              sources?: Array<{ uri?: unknown; [k: string]: unknown }>;
              [k: string]: unknown;
            }
            interface HunterDomainData {
              organization?: unknown;
              country?: unknown;
              pattern?: unknown;
              webmail?: unknown;
              disposable?: unknown;
              meta?: { results?: number; [k: string]: unknown };
              emails?: HunterDomainEmail[];
              [k: string]: unknown;
            }
            const r = await fetchT(`https://api.hunter.io/v2/domain-search?${params}`);
            const data = await r.json().catch(() => ({}));
            // On a non-200 (bad/expired key, plan limit, 429) Hunter omits `data`; without
            // this guard the payload reads as a legitimate "0 emails for this domain".
            if (!r.ok) return { ok: false, status: r.status, error: `hunter ${r.status}`, errors: (data as { errors?: unknown })?.errors };
            const d: HunterDomainData = (data as { data?: HunterDomainData })?.data ?? {};
            return {
              ok: r.ok,
              status: r.status,
              organization: d.organization,
              country: d.country,
              pattern: d.pattern,
              webmail: d.webmail,
              disposable: d.disposable,
              total: d.meta?.results ?? (d.emails?.length ?? 0),
              emails: (d.emails ?? []).map((e: HunterDomainEmail) => ({
                value: e.value,
                first_name: e.first_name,
                last_name: e.last_name,
                position: e.position,
                department: e.department,
                seniority: e.seniority,
                linkedin: e.linkedin,
                twitter: e.twitter,
                phone: e.phone_number,
                confidence: e.confidence,
                sources_count: (e.sources ?? []).length,
                sample_source: e.sources?.[0]?.uri,
              })),
              errors: (data as { errors?: unknown })?.errors,
            };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      hunter_email_finder: tool({
        description:
          "Hunter.io email-finder. Guess and verify a person's email at a given domain using their name. Returns email + score + verification status.",
        inputSchema: z.object({
          domain: z.string(),
          first_name: z.string().optional(),
          last_name: z.string().optional(),
          full_name: z.string().optional(),
        }),
        execute: async ({ domain, first_name, last_name, full_name }) => {
          if (!HUNTER_API_KEY) return { error: "HUNTER_API_KEY not configured" };
          if (!first_name && !last_name && !full_name) return { error: "Provide first_name+last_name or full_name" };
          try {
            const params = new URLSearchParams({ domain, api_key: HUNTER_API_KEY });
            if (first_name) params.set("first_name", first_name);
            if (last_name) params.set("last_name", last_name);
            if (full_name) params.set("full_name", full_name);
            interface HunterFinderData {
              email?: unknown;
              score?: unknown;
              first_name?: unknown;
              last_name?: unknown;
              position?: unknown;
              linkedin_url?: unknown;
              verification?: unknown;
              sources?: unknown[];
              [k: string]: unknown;
            }
            const r = await fetchT(`https://api.hunter.io/v2/email-finder?${params}`);
            const data = await r.json().catch(() => ({}));
            const d: HunterFinderData = (data as { data?: HunterFinderData })?.data ?? {};
            return {
              ok: r.ok && !!d.email,
              status: r.status,
              email: d.email,
              score: d.score,
              first_name: d.first_name,
              last_name: d.last_name,
              position: d.position,
              linkedin: d.linkedin_url,
              verification: d.verification,
              sources_count: (d.sources ?? []).length,
              errors: (data as { errors?: unknown })?.errors,
            };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      hunter_email_verifier: tool({
        description:
          "Hunter.io email-verifier. Returns deliverability status (deliverable/undeliverable/risky/unknown), MX/SMTP checks, disposable/webmail/gibberish flags, and a 0-100 score.",
        inputSchema: z.object({ email: z.string().email() }),
        execute: async ({ email }) => {
          if (!HUNTER_API_KEY) return { error: "HUNTER_API_KEY not configured" };
          try {
            interface HunterVerifierData {
              email?: unknown;
              result?: unknown;
              status?: unknown;
              score?: unknown;
              regexp?: unknown;
              gibberish?: unknown;
              disposable?: unknown;
              webmail?: unknown;
              mx_records?: unknown;
              smtp_server?: unknown;
              smtp_check?: unknown;
              accept_all?: unknown;
              block?: unknown;
              sources?: unknown[];
              [k: string]: unknown;
            }
            const r = await fetchT(`https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${HUNTER_API_KEY}`);
            const data = await r.json().catch(() => ({}));
            // On a non-200 Hunter omits `data`; without this guard the blank result reads
            // like a genuine "unknown" deliverability verdict instead of an API failure.
            if (!r.ok) return { ok: false, status: r.status, error: `hunter ${r.status}`, errors: (data as { errors?: unknown })?.errors };
            const d: HunterVerifierData = (data as { data?: HunterVerifierData })?.data ?? {};
            return {
              ok: r.ok,
              status: r.status,
              email: d.email,
              result: d.result,
              status_detail: d.status,
              score: d.score,
              regexp: d.regexp,
              gibberish: d.gibberish,
              disposable: d.disposable,
              webmail: d.webmail,
              mx_records: d.mx_records,
              smtp_server: d.smtp_server,
              smtp_check: d.smtp_check,
              accept_all: d.accept_all,
              block: d.block,
              sources_count: (d.sources ?? []).length,
              errors: (data as { errors?: unknown })?.errors,
            };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      hunter_combined: tool({
        description:
          "Hunter.io combined enrichment (person + company) for an email. Returns name, role, seniority, social profiles, plus the company's industry, size, tech stack, HQ, founded date, social presence.",
        inputSchema: z.object({ email: z.string().email() }),
        execute: async ({ email }) => {
          if (!HUNTER_API_KEY) return { error: "HUNTER_API_KEY not configured" };
          try {
            interface HunterHandle { handle?: unknown; [k: string]: unknown }
            // city/country are interpolated into a template string below, so
            // they are typed string-coercible rather than `unknown`.
            interface HunterGeo { city?: string; country?: string; [k: string]: unknown }
            interface HunterPerson {
              name?: { fullName?: unknown; givenName?: unknown; familyName?: unknown; [k: string]: unknown };
              geo?: HunterGeo;
              bio?: unknown;
              site?: unknown;
              avatar?: unknown;
              employment?: unknown;
              github?: HunterHandle;
              twitter?: HunterHandle;
              linkedin?: HunterHandle;
              aboutme?: HunterHandle;
              [k: string]: unknown;
            }
            // city/country are interpolated into a template string below, so
            // they are typed string-coercible rather than `unknown`.
            interface HunterCompany {
              name?: unknown;
              legalName?: unknown;
              domain?: unknown;
              description?: unknown;
              category?: { industry?: unknown; subIndustry?: unknown; [k: string]: unknown };
              metrics?: { employees?: unknown; employeesRange?: unknown; annualRevenue?: unknown; [k: string]: unknown };
              foundedYear?: unknown;
              tech?: unknown[];
              geo?: HunterGeo;
              linkedin?: HunterHandle;
              twitter?: HunterHandle;
              facebook?: HunterHandle;
              [k: string]: unknown;
            }
            const r = await fetchT(`https://api.hunter.io/v2/combined/find?email=${encodeURIComponent(email)}&api_key=${HUNTER_API_KEY}`);
            const data = await r.json().catch(() => ({}));
            // Hunter's Combined endpoint requires a paid plan; on 400/403 the
            // free plan falls through. Try person + company enrichment in
            // parallel as a graceful fallback so the email still gets enriched.
            if (!r.ok && (r.status === 400 || r.status === 403)) {
              const domain = email.split("@")[1] ?? "";
              const [pr, cr] = await Promise.all([
                fetchT(`https://api.hunter.io/v2/people/find?email=${encodeURIComponent(email)}&api_key=${HUNTER_API_KEY}`).then(x => x.json()).catch(() => ({})),
                domain ? fetchT(`https://api.hunter.io/v2/companies/find?domain=${encodeURIComponent(domain)}&api_key=${HUNTER_API_KEY}`).then(x => x.json()).catch(() => ({})) : Promise.resolve({}),
              ]);
              const pp: HunterPerson = (pr as { data?: HunterPerson })?.data ?? {};
              const cc: HunterCompany = (cr as { data?: HunterCompany })?.data ?? {};
              const hasAny = Object.keys(pp).length > 0 || Object.keys(cc).length > 0;
              if (hasAny) {
                return {
                  ok: true,
                  status: 200,
                  fallback: "people+companies",
                  person: {
                    name: pp.name?.fullName,
                    location: pp.geo?.city ? `${pp.geo.city}, ${pp.geo.country}` : undefined,
                    employment: pp.employment,
                    github: pp.github?.handle,
                    twitter: pp.twitter?.handle,
                    linkedin: pp.linkedin?.handle,
                  },
                  company: {
                    name: cc.name,
                    domain: cc.domain,
                    industry: cc.category?.industry,
                    employees: cc.metrics?.employees,
                    tech: (cc.tech ?? []).slice(0, 25),
                  },
                };
              }
              return { ok: false, status: r.status, error: `hunter_combined ${r.status} (plan-gated; people/companies also empty)` };
            }
            const d: { person?: HunterPerson; company?: HunterCompany; [k: string]: unknown } =
              (data as { data?: { person?: HunterPerson; company?: HunterCompany; [k: string]: unknown } })?.data ?? {};
            const p: HunterPerson = d.person ?? {};
            const c: HunterCompany = d.company ?? {};
            return {
              ok: r.ok,
              status: r.status,
              person: {
                name: p.name?.fullName,
                given_name: p.name?.givenName,
                family_name: p.name?.familyName,
                location: p.geo?.city ? `${p.geo.city}, ${p.geo.country}` : undefined,
                bio: p.bio,
                site: p.site,
                avatar: p.avatar,
                employment: p.employment,
                github: p.github?.handle,
                twitter: p.twitter?.handle,
                linkedin: p.linkedin?.handle,
                aboutme: p.aboutme?.handle,
              },
              company: {
                name: c.name,
                legal_name: c.legalName,
                domain: c.domain,
                description: c.description,
                industry: c.category?.industry,
                sub_industry: c.category?.subIndustry,
                employees: c.metrics?.employees,
                employees_range: c.metrics?.employeesRange,
                annual_revenue: c.metrics?.annualRevenue,
                founded: c.foundedYear,
                tech: (c.tech ?? []).slice(0, 25),
                location: c.geo?.city ? `${c.geo.city}, ${c.geo.country}` : undefined,
                linkedin: c.linkedin?.handle,
                twitter: c.twitter?.handle,
                facebook: c.facebook?.handle,
              },
              errors: (data as { errors?: unknown })?.errors,
            };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      archive_url: tool({
        description:
          "Submit a URL to the Wayback Machine to create a permanent archived snapshot. Returns the archived URL. Use on any volatile evidence (social posts, leak listings) so a [CONFIRMED] finding remains defensible.",
        inputSchema: z.object({ url: z.string().url() }),
        execute: async ({ url }) => {
          try {
            const r = await fetchT(`https://web.archive.org/save/${url}`, {
              method: "GET",
              headers: { "User-Agent": "Proximity-OSINT/1.0" },
              redirect: "manual",
            }, 15_000);
            const location = r.headers.get("content-location") || r.headers.get("location");
            const archived = location ? `https://web.archive.org${location.startsWith("/") ? location : "/" + location}` : undefined;
            return {
              ok: r.ok || !!archived,
              status: r.status,
              original_url: url,
              archived_url: archived,
              note: archived ? "Snapshot created" : "Submission accepted — snapshot may take ~30s to be retrievable",
            };
          } catch (e) { return { error: String(e) }; }
        },
      }),
      record_artifacts: tool({
        description:
          "Save a BATCH of discovered intelligence items. Strict kinds (pick one): " + STRICT_KINDS.join(", ") + ". " +
          "Do NOT use 'other' — pick the most specific kind, or use 'weak_lead' with metadata.reason. " +
          "Confidence is automatically CAPPED by source class server-side: breach-only ≤60, two-breach ≤65, username_sweep-only ≤45, social_profile_passive ≤40, ai_summary ≤55. " +
          "Setting confidence ≥90 only works when the artifact has corroboration from a court_record + independent_public/news source. " +
          "Each artifact may include metadata.{status, cluster_id, reason_for_confidence, reason_not_confirmed, contradictions, next_verification_step}. status enum: new|verified|probable|needs_review|contradicted|excluded|exhausted|manual_review_required.",
        inputSchema: z.object({
          // Tolerant input: some models emit `artifacts` as a JSON string
          // (or fenced code block). Parse it back into an array.
          artifacts: z.preprocess((raw) => {
            const parseMaybe = (v: unknown): unknown => {
              if (typeof v !== "string") return v;
              const s = v.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
              try { return JSON.parse(s); } catch { /* fall through */ }
              const a = s.indexOf("["); const b = s.lastIndexOf("]");
              if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* noop */ } }
              return v;
            };
            let v: unknown = parseMaybe(raw);
            if (v && !Array.isArray(v) && typeof v === "object") v = [v];
            return v;
          }, z.array(
              z.object({
                kind: z.string().describe("Pick the most specific kind. Primary: email|phone|ip|username|domain|subdomain|avatar|breach|address|name|social|organization|case|legal_record|infrastructure|financial_claim|event|source_person|risk_note. Use 'other' ONLY as a last resort. Common reclass: company/firm names → organization; 'United States v. X' → case; DRE/court records → legal_record; crm./portal./ledger./staging. hosts → subdomain; DNS/MX/SPF/CDN summaries → infrastructure; reporter/journalist → source_person; real-estate / donation summaries → financial_claim. Unknown kinds are coerced to 'other'."),
                value: z.string(),
                confidence: z.number().min(0).max(100).optional(),
                source: z.string().optional(),
                metadata: z.record(z.unknown()).optional(),
              }),
            )
            .min(1)
            .max(200)),
        }),
        execute: async ({ artifacts }) => {
          const accepted: Array<{ index: number; kind: string; value: string }> = [];
          const rejected: Array<{ index: number; reason: string; kind: string; value: string }> = [];
          const rows: Array<Record<string, unknown>> = [];
          artifacts.forEach((a, i) => {
            // Infer strict kind from value patterns (LAPD → law_enforcement_unit,
            // People v X → court_case, wallet hex → crypto_wallet, etc.).
            const inferred = inferKind(a.kind, a.value);
            const v = validateArtifact(inferred.kind, a.value);
            if (!v.ok) {
              rejected.push({ index: i, reason: v.reason, kind: a.kind, value: a.value });
              return;
            }
            // Apply conservative confidence caps based on source class.
            const cap = applyEvidenceCaps({
              rawConfidence: a.confidence ?? 50,
              sources: [a.source ?? "", ...((a.metadata?.sources ?? []) as Iterable<unknown>)].filter(Boolean) as string[],
            });
            // Required-fields envelope — fill conservative defaults when the
            // agent didn't supply them.
            const meta: Record<string, unknown> = {
              ...(a.metadata ?? {}),
              ...(v.metaPatch ?? {}),
              ...(inferred.reclassified_from ? { reclassified_from: inferred.reclassified_from } : {}),
              source_category: cap.source_classes,
              status: a.metadata?.status ?? "new",
              cluster_id: a.metadata?.cluster_id ?? null,
              reason_for_confidence: cap.reason_for_confidence,
              reason_not_confirmed: a.metadata?.reason_not_confirmed ?? cap.reason_not_confirmed ?? null,
              contradictions: a.metadata?.contradictions ?? [],
              next_verification_step: a.metadata?.next_verification_step ?? null,
              confidence_cap_applied: cap.cap,
            };
            rows.push({
              thread_id: threadId,
              user_id: userId,
              kind: v.kind,
              value: v.value,
              confidence: cap.confidence,
              source: a.source ?? null,
              metadata: meta,
            });
            accepted.push({ index: i, kind: v.kind, value: v.value });
          });
          if (rows.length === 0) {
            return { ok: false, count: 0, accepted, rejected, hint: "All items failed validation — re-check kinds/values against the rules in the tool description." };
          }
          const safeRows = scrubArtifactRows(rows);
          let insertedRows = safeRows;
          const { error } = await supabase.from("artifacts").insert(safeRows);
          if (error) {
            // Bulk insert failed — fall back to per-row inserts so a single
            // bad row doesn't lose the whole batch of evidence.
            console.warn("[record_artifacts] bulk insert failed, retrying per-row:", error.message);
            const surviving: typeof safeRows = [];
            const perRowErrors: Array<{ index: number; error: string }> = [];
            for (let i = 0; i < safeRows.length; i++) {
              const { error: rowErr } = await supabase.from("artifacts").insert(safeRows[i]);
              if (rowErr) {
                perRowErrors.push({ index: i, error: rowErr.message });
              } else {
                surviving.push(safeRows[i]);
              }
            }
            if (surviving.length === 0) {
              return { ok: false, error: error.message, per_row_errors: perRowErrors, count: 0, accepted: [], rejected };
            }
            insertedRows = surviving;
          }
          const safeRowsForFollowup = insertedRows;
          const flagged = safeRows.filter((r) => (r.metadata as { minor_warning?: unknown } | undefined)?.minor_warning).length;
          bumpArtifacts(safeRowsForFollowup.length, safeRowsForFollowup.map((r) => String(r.kind)));
          // Collision detection: for any phone/email/address just inserted,
          // check if the same normalized value is already linked to a
          // different cluster_id or different name in this thread. Record a
          // contradiction artifact instead of silently merging clusters.
          try {
            const collisionKinds = new Set(["phone", "email", "address"]);
            const candidates = safeRowsForFollowup.filter((r) => collisionKinds.has(String(r.kind)));
            for (const r of candidates) {
              const { data: peers } = await supabase
                .from("artifacts")
                .select("value,kind,source,metadata")
                .eq("thread_id", threadId)
                .eq("kind", String(r.kind))
                .eq("value", String(r.value));
              const sources = new Set<string>();
              const clusters = new Set<string>();
              type PeerRow = { source?: unknown; metadata?: Record<string, unknown> | null };
              for (const p of (peers ?? []) as PeerRow[]) {
                if (p.source) sources.add(String(p.source));
                const cid = (p.metadata ?? {}).cluster_id;
                if (cid) clusters.add(String(cid));
              }
              if (sources.size >= 3 || clusters.size >= 2) {
                await supabase.from("artifacts").insert({
                  thread_id: threadId,
                  user_id: userId,
                  kind: "contradiction",
                  value: `${r.kind}:${r.value}`,
                  confidence: 40,
                  source: "collision_detector",
                  metadata: {
                    collision_value: r.value,
                    collision_kind: r.kind,
                    sources: Array.from(sources),
                    clusters: Array.from(clusters),
                    severity: clusters.size >= 2 ? "high" : "medium",
                    status: "needs_review",
                  },
                });
              }
            }
          } catch (e) { console.warn("[collision_detect]", (e as Error).message); }
          // Auto-recall: for every high-value artifact just recorded, fan-out a
          // memory lookup so the orchestrator never burns fresh quota on a
          // value we already learned about in a previous investigation.
          const HIGH_VALUE = new Set(["email", "username", "domain", "wallet", "phone", "name"]);
          const recallSubjects = Array.from(
            new Set(
              safeRows
                .filter((r) => HIGH_VALUE.has(String(r.kind)))
                .map((r) => String(r.value).trim().toLowerCase())
                .filter(Boolean),
            ),
          ).slice(0, 12);
          let memory_hits: Array<{ subject: string; count: number; memories: unknown[] }> = [];
          if (recallSubjects.length > 0) {
            try {
              const recalled = await Promise.all(
                recallSubjects.map(async (subj) => {
                  const { data } = await supabase
                    .from("agent_memory")
                    .select("id,kind,subject,subject_kind,related_values,content,confidence,hit_count")
                    .eq("user_id", userId)
                    .or(`subject.eq.${subj},related_values.cs.{${subj}}`)
                    .order("confidence", { ascending: false })
                    .limit(5);
                  return { subject: subj, count: data?.length ?? 0, memories: data ?? [] };
                }),
              );
              memory_hits = recalled.filter((r) => r.count > 0);
              const allIds = memory_hits.flatMap((h) => (h.memories as Array<{ id?: unknown }>).map((m) => m.id));
              if (allIds.length > 0) {
                supabase.rpc("bump_memory_hits", { _ids: allIds }).then(() => {}, () => {});
              }
            } catch (e) {
              console.warn("[record_artifacts] auto memory_recall failed:", e);
            }
          }
          // ---- Chain-of-custody: append one append-only evidence row per
          // accepted artifact. Serial (not parallel) because append_evidence
          // reads MAX(seq) per thread and would race under Promise.all.
          // Per-row try/catch so a single bad row doesn't break the hash chain
          // for the rest of the batch.
          let evidence_appended = 0;
          for (const r of safeRowsForFollowup) {
            try {
              const meta = (r.metadata as Record<string, unknown> | null) ?? {};
              const conf = typeof r.confidence === "number" ? (r.confidence as number) : null;
              const declared = String(meta.classification ?? "").toLowerCase();
              const classification =
                declared === "hard" || declared === "soft"
                  ? declared
                  : (conf ?? 0) >= 85
                  ? "hard"
                  : "soft";
              const sourceUrl =
                meta.source_url ||
                meta.url ||
                meta.profile_url ||
                meta.archived_url ||
                null;
              const snapshot = JSON.stringify(meta).slice(0, 1500);
              const { error: evErr } = await supabase.rpc("append_evidence", {
                _thread_id: threadId,
                _artifact_id: null,
                _tool_name: (r.source as string) ?? "agent",
                _source: (r.source as string) ?? null,
                _source_url: typeof sourceUrl === "string" ? sourceUrl : null,
                _classification: classification,
                _confidence: conf,
                _kind: String(r.kind),
                _value: String(r.value),
                _content_snapshot: snapshot,
                _metadata: meta,
              });
              if (!evErr) {
                evidence_appended++;
                // Fire-and-forget archive
                if (archiveEnabled && typeof sourceUrl === "string") {
                  archiveAttachment(supabase, threadId, userId, sourceUrl).then(async (arch) => {
                    if (!arch) return;
                    await supabase
                      .from("evidence_log")
                      .update({
                        archive_storage_path: arch.path,
                        archive_sha256: arch.sha256,
                        archive_bytes: arch.bytes,
                        archive_content_type: arch.content_type,
                      })
                      .eq("thread_id", threadId)
                      .eq("value", String(r.value))
                      .eq("kind", String(r.kind))
                      .is("archive_storage_path", null);
                  }).catch((e) => console.warn("[archive] post-evidence:", (e as Error).message));
                }
              } else console.warn("[record_artifacts] append_evidence:", evErr.message);
            } catch (e) {
              console.warn("[record_artifacts] chain-of-custody row failed:", (e as Error)?.message ?? e);
            }
          }
          return {
            ok: true,
            count: safeRowsForFollowup.length,
            accepted,
            rejected,
            minor_safety_flags: flagged,
            evidence_appended,
            ...(memory_hits.length > 0
              ? {
                  memory_hits,
                  memory_hint:
                    "Prior memory found for some of the artifacts you just recorded. Read `memory_hits` — incorporate confirmed connections/lessons and cite them as [MEMORY] in the final report. Do NOT re-investigate values already covered.",
                }
              : {}),
          };
        },
      }),
      record_artifact: tool({
        description:
          "Backwards-compatible shim. PREFER record_artifacts with an array. This wraps a single item into a one-element batch.",
        inputSchema: z.object({
          kind: z.string(),
          value: z.string(),
          confidence: z.number().min(0).max(100).optional(),
          source: z.string().optional(),
          metadata: z.record(z.unknown()).optional(),
        }),
        execute: async ({ kind, value, confidence, source, metadata }) => {
          const inferred = inferKind(kind, value);
          const v = validateArtifact(inferred.kind, value);
          if (!v.ok) return { ok: false, rejected: true, reason: v.reason };
          const cap = applyEvidenceCaps({
            rawConfidence: confidence ?? 50,
            sources: [source ?? "", ...((metadata?.sources ?? []) as Iterable<unknown>)].filter(Boolean) as string[],
          });
          const enrichedMeta = {
            ...(metadata ?? {}),
            ...(v.metaPatch ?? {}),
            ...(inferred.reclassified_from ? { reclassified_from: inferred.reclassified_from } : {}),
            source_category: cap.source_classes,
            status: metadata?.status ?? "new",
            cluster_id: metadata?.cluster_id ?? null,
            reason_for_confidence: cap.reason_for_confidence,
            reason_not_confirmed: metadata?.reason_not_confirmed ?? cap.reason_not_confirmed ?? null,
            contradictions: metadata?.contradictions ?? [],
            next_verification_step: metadata?.next_verification_step ?? null,
            confidence_cap_applied: cap.cap,
          };
          const row = scrubArtifactRow({
            thread_id: threadId,
            user_id: userId,
            kind: v.kind,
            value: v.value,
            confidence: cap.confidence,
            source: source ?? null,
            metadata: enrichedMeta,
          });
          const { error } = await supabase.from("artifacts").insert([row]);
          if (error) return { ok: false, error: error.message };
          bumpArtifacts(1, [String(row.kind)]);
          const minor = (row.metadata as { minor_warning?: unknown } | null)?.minor_warning === true;
          // Chain-of-custody append
          const meta = (row.metadata as Record<string, unknown> | null) ?? {};
          const conf = typeof row.confidence === "number" ? (row.confidence as number) : null;
          const declared = String(meta.classification ?? "").toLowerCase();
          const classification =
            declared === "hard" || declared === "soft"
              ? declared
              : (conf ?? 0) >= 85
              ? "hard"
              : "soft";
          const sourceUrl =
            meta.source_url || meta.url || meta.profile_url || meta.archived_url || null;
          await supabase.rpc("append_evidence", {
            _thread_id: threadId,
            _artifact_id: null,
            _tool_name: (row.source as string) ?? "agent",
            _source: (row.source as string) ?? null,
            _source_url: typeof sourceUrl === "string" ? sourceUrl : null,
            _classification: classification,
            _confidence: conf,
            _kind: String(row.kind),
            _value: String(row.value),
            _content_snapshot: JSON.stringify(meta).slice(0, 1500),
            _metadata: meta,
          }).then(() => {}, (e: unknown) => console.warn("[record_artifact] append_evidence:", e));
          return { ok: true, kind: row.kind, value: row.value, ...(minor ? { minor_safety_flag: true } : {}) };
        },
      }),
      record_evidence: tool({
        description:
          "Append one tamper-evident row to the investigation's chain-of-custody log. Use for high-stakes findings that need provenance (a Hard claim with an archived URL, a court/government record, a verified breach hit). Each call appends a hashed row whose chain_hash depends on the prior row — the UI can verify the whole chain. Classification: 'hard' = official record or first-party verified source. 'soft' = social/inferred/pattern-match.",
        inputSchema: z.object({
          classification: z.enum(["hard", "soft"]),
          kind: z.string().describe("artifact kind this evidence relates to (email/phone/ip/username/domain/breach/name/other)"),
          value: z.string(),
          source: z.string().describe("tool or human-readable provider name, e.g. 'hunter.io', 'archive.org', 'whois'"),
          source_url: z.string().url().optional().describe("Canonical or archived URL of the evidence — prefer archive.org / archive.is link"),
          confidence: z.number().min(0).max(100).optional(),
          notes: z.string().max(2000).optional().describe("Free-text collection notes / extraction context"),
          metadata: z.record(z.unknown()).optional(),
        }),
        execute: async ({ classification, kind, value, source, source_url, confidence, notes, metadata }) => {
          const meta = { ...(metadata ?? {}), ...(notes ? { notes } : {}) };
          const { data, error } = await supabase.rpc("append_evidence", {
            _thread_id: threadId,
            _artifact_id: null,
            _tool_name: source,
            _source: source,
            _source_url: source_url ?? null,
            _classification: classification,
            _confidence: confidence ?? null,
            _kind: kind,
            _value: value,
            _content_snapshot: JSON.stringify(meta).slice(0, 1500),
            _metadata: meta,
          });
          if (error) return { ok: false, error: error.message };
          const row = Array.isArray(data) ? data[0] : data;
          let archived: unknown = undefined;
          if (archiveEnabled && source_url) {
            const arch = await archiveAttachment(supabase, threadId, userId, source_url);
            if (arch && row?.id) {
              await supabase
                .from("evidence_log")
                .update({
                  archive_storage_path: arch.path,
                  archive_sha256: arch.sha256,
                  archive_bytes: arch.bytes,
                  archive_content_type: arch.content_type,
                })
                .eq("id", row.id);
              archived = { sha256: arch.sha256, bytes: arch.bytes };
            }
          }
          return { ok: true, id: row?.id, seq: row?.seq, chain_hash: row?.chain_hash, ...(archived ? { archived } : {}) };
        },
      }),
    };
    const modelMessages = await convertToModelMessages(messages);

    // ---- Context window guard ------------------------------------------------
    // MiniMax (and other models) error with "context window exceeds limit" when
    // tool-result history balloons across many fan-out rounds. We aggressively
    // truncate large tool-result payloads in older turns while keeping the most
    // recent few rounds intact for the orchestrator to reason over.
    // MiniMax-M2.7 supports ~200k tokens (~700k chars). Be generous so the
    // orchestrator can actually see prior tool results across long fan-outs.
    const MAX_TOOL_RESULT_CHARS_OLD = 4000;
    const MAX_TOOL_RESULT_CHARS_RECENT = 16000;
    const RECENT_WINDOW = 10; // last N messages keep larger results
    const truncateStr = (s: string, max: number) =>
      s.length <= max ? s : s.slice(0, max) + `\n…[truncated ${s.length - max} chars]`;
    const truncateValue = (val: unknown, max: number): unknown => {
      if (typeof val === "string") return truncateStr(val, max);
      if (Array.isArray(val)) {
        const joined = JSON.stringify(val);
        if (joined.length <= max) return val;
        return truncateStr(joined, max);
      }
      if (val && typeof val === "object") {
        const joined = JSON.stringify(val);
        if (joined.length <= max) return val;
        return truncateStr(joined, max);
      }
      return val;
    };
    // Message content part shape we read while trimming. Only the fields we
    // touch are modeled; everything else rides along untouched via the spread.
    interface TrimPart {
      type?: string;
      output?: unknown;
      text?: unknown;
      [k: string]: unknown;
    }
    const trimmedMessages: ModelMessage[] = modelMessages.map((m: ModelMessage, idx: number) => {
      const isRecent = idx >= modelMessages.length - RECENT_WINDOW;
      const max = isRecent ? MAX_TOOL_RESULT_CHARS_RECENT : MAX_TOOL_RESULT_CHARS_OLD;
      if (m.role !== "tool" && m.role !== "assistant") return m;
      if (!Array.isArray(m.content)) return m;
      const content = (m.content as TrimPart[]).map((part: TrimPart) => {
        if (part?.type === "tool-result" && part.output != null) {
          // AI SDK v6 tool-result output shapes: { type: 'json', value } | { type: 'text', value } | raw
          if (part.output && typeof part.output === "object" && "value" in part.output) {
            return { ...part, output: { ...part.output, value: truncateValue((part.output as { value: unknown }).value, max) } };
          }
          return { ...part, output: truncateValue(part.output, max) };
        }
        if (part?.type === "text" && typeof part.text === "string") {
          return { ...part, text: truncateStr(part.text, isRecent ? 16000 : 4000) };
        }
        return part;
      });
      return { ...m, content } as ModelMessage;
    });

    // Inject memory tools (cross-investigation learning) into the registry.
    //
    // Late-injected registry tools, written as `(tools as ToolRegistry).X =
    // tool(...)`. The catalog↔runtime contract test
    // (src/test/tool-catalog-contract.test.ts) discovers these by grepping this
    // file for that assignment pattern, so keep the notation consistent.
    (tools as ToolRegistry).memory_recall = tool({
      description:
        "Recall prior agent memory for this user (lessons learned, identity links, recurring patterns, known false positives). Call EARLY in any investigation with the seed value AND with each newly confirmed high-value artifact (email, username, domain, wallet). Returns up to 20 most-relevant memory entries.",
      inputSchema: z.object({
        subject: z.string().describe("The value to recall around — the seed, an email, a handle, a domain, a wallet, etc."),
        kind: z.enum(["pattern", "connection", "lesson", "identity", "any"]).optional().default("any"),
        limit: z.number().int().min(1).max(50).optional().default(20),
      }),
      execute: async ({ subject, kind, limit }) => {
        const subj = String(subject ?? "").trim().toLowerCase();
        if (!subj) return { ok: false, error: "empty subject" };
        // Per-step dedup: never recall the same subject twice in one reasoning step.
        if (routingGuard.memoryRecallSubjectsThisStep.has(subj)) {
          const msg = "memory_recall skipped — rate limit reached (duplicate subject in current reasoning step).";
          console.log(`[memory_recall] ${msg} subject=${subj}`);
          return { ok: false, skipped: true, gated: true, reason: msg };
        }
        // Sliding 30s window, max 2 calls.
        const now = Date.now();
        routingGuard.memoryRecallTimestamps = routingGuard.memoryRecallTimestamps.filter((t) => now - t < 30_000);
        if (routingGuard.memoryRecallTimestamps.length >= 2) {
          const msg = "memory_recall skipped — rate limit reached (max 2 calls per 30s window).";
          console.log(`[memory_recall] ${msg} subject=${subj}`);
          return { ok: false, skipped: true, gated: true, reason: msg };
        }
        routingGuard.memoryRecallTimestamps.push(now);
        routingGuard.memoryRecallSubjectsThisStep.add(subj);
        let q = supabase
          .from("agent_memory")
          .select("id,kind,subject,subject_kind,related_values,content,confidence,source_thread_id,hit_count,last_used_at,created_at")
          .eq("user_id", userId)
          .or(`subject.eq.${subj},related_values.cs.{${subj}}`)
          .order("confidence", { ascending: false })
          .limit(limit ?? 20);
        if (kind && kind !== "any") q = supabase
          .from("agent_memory")
          .select("id,kind,subject,subject_kind,related_values,content,confidence,source_thread_id,hit_count,last_used_at,created_at")
          .eq("user_id", userId)
          .eq("kind", kind)
          .or(`subject.eq.${subj},related_values.cs.{${subj}}`)
          .order("confidence", { ascending: false })
          .limit(limit ?? 20);
        const { data, error } = await q;
        if (error) return { ok: false, error: error.message };
        const memories = data ?? [];
        // Best-effort: mark surfaced memories as recently used so they
        // bubble up next time and so stale unused ones can be pruned.
        if (memories.length > 0) {
          const ids = memories.map((m: { id: unknown }) => m.id);
          // Atomic hit_count + last_used_at bump (no read-modify-write race).
          supabase.rpc("bump_memory_hits", { _ids: ids }).then(() => {}, () => {});
        }
        return { ok: true, count: memories.length, memories };
      },
    });

    (tools as ToolRegistry).memory_save = tool({
      description:
        "Persist a durable cross-investigation memory: a learned pattern, a confirmed connection between artifacts, an analyst lesson, or an identity cluster. Call AT THE END of an investigation with the strongest connections + any lessons (e.g. \"this domain is always parked\", \"this handle resolves to person X\", \"breach DB Y has stale phones\"). Idempotent: calling with the same kind+subject+content updates the existing entry.",
      inputSchema: z.object({
        // Tolerant input: some models emit `entries` as a JSON string, or as
        // an array containing stringified objects. Normalize both shapes.
        entries: z.preprocess((raw) => {
          const parseMaybe = (v: unknown): unknown => {
            if (typeof v !== "string") return v;
            const s = v.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
            try { return JSON.parse(s); } catch { /* fall through */ }
            const a = s.indexOf("["); const b = s.lastIndexOf("]");
            if (a >= 0 && b > a) { try { return JSON.parse(s.slice(a, b + 1)); } catch { /* noop */ } }
            const oa = s.indexOf("{"); const ob = s.lastIndexOf("}");
            if (oa >= 0 && ob > oa) { try { return JSON.parse(s.slice(oa, ob + 1)); } catch { /* noop */ } }
            return v;
          };
          let v: unknown = parseMaybe(raw);
          if (v && !Array.isArray(v) && typeof v === "object") v = [v];
          if (Array.isArray(v)) {
            v = v
              .map(parseMaybe)
              .filter((x: unknown): x is Record<string, unknown> => !!x && typeof x === "object")
              // Drop entries with missing/blank subject — the LLM occasionally
              // emits one. Better to save the rest than reject the whole batch.
              .filter((x) => typeof x.subject === "string" && x.subject.trim().length > 0);
          }
          return v;
        }, z.array(z.object({
          kind: z.enum(["pattern", "connection", "lesson", "identity"]),
          subject: z.string().min(1).describe("Primary value this memory pivots on (lowercased)."),
          subject_kind: z.string().optional(),
          related_values: z.array(z.string()).optional(),
          content: z.string().min(3).max(2000).describe("The learning, in 1-3 sentences."),
          confidence: z.number().min(0).max(100).optional().default(60),
        })).min(1).max(20)),
        scope: z.enum(["global", "case"]).optional().default("global").describe(
          "global = reusable cross-case knowledge (default). case = facts/decisions tied to THIS investigation only (dismissed leads, analyst confirmations, false positives).",
        ),
      }),
      execute: async ({ entries, scope }) => {
        // Upserts on (user_id, kind, subject, md5(content)) — re-saving the same
        // lesson bumps hit_count + last_used_at instead of duplicating rows.
        try {
          const { data, error } = await supabase.rpc("save_agent_memories", {
            _user_id: userId,
            _thread_id: threadId,
            _entries: entries as unknown as Record<string, unknown>[],
            _scope: scope ?? "global",
          });
          if (error) {
            console.warn("[memory_save] rpc error:", error.message);
            return { ok: false, error: error.message, scope: scope ?? "global" };
          }
          return { ok: true, scope: scope ?? "global", saved: data?.length ?? 0, entries: data ?? [] };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn("[memory_save] threw:", msg);
          return { ok: false, error: msg, scope: scope ?? "global" };
        }
      },
    });

    // ---------------------------------------------------------------------
    // Workflow-gate tools (Lead Investigator must call these before final report)
    // ---------------------------------------------------------------------
    const availableToolsForAudit = new Set<string>([
      ...(OATHNET_API_KEY ? ["oathnet_lookup"] : []),
      ...(SERUS_API_KEY ? ["serus_darkweb_scan"] : []),
      ...(OSINTNOVA_API_KEY ? ["osintnova_lookup", "osintnova_email_lookup", "osintnova_phone_lookup"] : []),
      ...(SOCIALFETCH_API_KEY ? ["socialfetch_lookup"] : []),
      ...(SYNAPSINT_API_KEY ? ["synapsint_lookup"] : []),
      ...(HUNTER_API_KEY ? ["hunter_combined", "hunter_email_verifier", "hunter_domain_search"] : []),
      ...(Deno.env.get("LEAKCHECK_API_KEY") ? ["leakcheck_lookup"] : []),
      ...(Deno.env.get("STOLENTAX_API_KEY") ? ["breach_check", "stolentax_footprint"] : []),
      ...(Deno.env.get("DEEPFIND_API_KEY") ? ["deepfind_reverse_email","deepfind_disposable_email","deepfind_ransomware_exposure","deepfind_ssl_inspect","deepfind_tech_stack","deepfind_telegram_channel","deepfind_telegram_search"] : []),
      ...(Deno.env.get("INTELBASE_API_KEY") && INTELBASE_ENABLED ? ["intelbase_email_lookup"] : []),
      ...(Deno.env.get("VIRUSTOTAL_API_KEY") ? ["virustotal_lookup"] : []),
      ...(Deno.env.get("IPGEOLOCATION_API_KEY") ? ["ipgeolocation_lookup"] : []),
      ...(Deno.env.get("EXA_API_KEY") ? ["exa_search","exa_get_contents","exa_find_similar"] : []),
      ...(Deno.env.get("GEMINI_API_KEY") ? ["gemini_deep_dork"] : []),
      // Free / always-on tools
      "whois_lookup","dns_records","crtsh_subdomains","wayback_snapshots","archive_url","http_fingerprint",
      "ip_intel","shodan_internetdb","hackertarget","urlscan_search","emailrep","gravatar_profile","hibp_lookup",
      "google_dorks","dork_harvest","username_sweep","github_user","reddit_user","hackernews_user",
      "minimax_web_search","jina_reader_scrape",
    ]);

    async function callsForThread(): Promise<string[]> {
      const { data } = await supabaseAdmin
        .from("tool_usage_log")
        .select("tool_name")
        .eq("thread_id", threadId)
        .eq("ok", true);
      return [...new Set((data ?? []).map((r: { tool_name: string }) => r.tool_name))];
    }

    (tools as ToolRegistry).coverage_audit = tool({
      description:
        "MANDATORY before record_finding. Audits the 12 investigative coverage categories (identity/email/username/phone/domain/infrastructure/social/breach/location/employment/relationships/timeline) against the playbook for this seed type. Returns {complete, categories, missingOpportunities}. If complete=false you MUST either run the missing tools or mark the case 'incomplete' in the final report.",
      inputSchema: z.object({}).strict(),
      execute: async () => {
        const called = await callsForThread();
        const report = auditCoverage(detectedSeedType, called, availableToolsForAudit);
        return { ok: true, seed_type: detectedSeedType, ...report };
      },
    });

    (tools as ToolRegistry).detect_contradictions = tool({
      description:
        "MANDATORY before record_finding. Examines the artifacts already recorded for this investigation and surfaces conflicts (location mismatch, employer mismatch, common-handle collision, CDN/shared-infra false-link, stale breach data, thin same-name). Each contradiction reduces relevant confidence axes.",
      inputSchema: z.object({
        cluster_artifact_kinds: z.array(z.string()).optional()
          .describe("Optional. Restrict to specific artifact kinds (e.g. ['email','username','name','ip'])."),
      }),
      execute: async ({ cluster_artifact_kinds }) => {
        let q = supabase.from("artifacts").select("kind,value,source,metadata,created_at").eq("thread_id", threadId);
        if (cluster_artifact_kinds?.length) q = q.in("kind", cluster_artifact_kinds);
        const { data, error } = await q;
        if (error) return { ok: false, error: error.message };
        const findings = detectContradictions((data ?? []) as Parameters<typeof detectContradictions>[0]);
        return { ok: true, count: findings.length, contradictions: findings };
      },
    });

    (tools as ToolRegistry).tool_audit = tool({
      description:
        "MANDATORY before record_finding. Returns tool health + API utilization for this investigation: which Tier-A APIs were configured, which were called, which were skipped without justification (a 'missed_opportunity'), failure counts per tool, and artifact yield per tool.",
      inputSchema: z.object({}).strict(),
      execute: async () => {
        const { data: rows } = await supabaseAdmin
          .from("tool_usage_log")
          .select("tool_name,ok,cached,cost_micro_usd,duration_ms,error_msg,status_code")
          .eq("thread_id", threadId);
        const used = new Set<string>();
        const failures: Record<string, number> = {};
        const counts: Record<string, number> = {};
        let totalMicro = 0;
        type UsageLogRow = { tool_name: string; ok?: boolean; cost_micro_usd?: number };
        for (const r of (rows ?? []) as UsageLogRow[]) {
          used.add(r.tool_name);
          counts[r.tool_name] = (counts[r.tool_name] ?? 0) + 1;
          totalMicro += r.cost_micro_usd ?? 0;
          if (!r.ok) failures[r.tool_name] = (failures[r.tool_name] ?? 0) + 1;
        }
        const pb = playbookFor(detectedSeedType);
        const missed: string[] = [];
        for (const t of pb.required) {
          if (availableToolsForAudit.has(t) && !used.has(t) && tierOf(t) !== "C") missed.push(t);
        }
        const tierAUsed = [...used].filter((t) => tierOf(t) === "A");
        return {
          ok: true,
          seed_type: detectedSeedType,
          total_cost_usd: +(totalMicro / 1_000_000).toFixed(5),
          tools_used: [...used],
          tier_a_used: tierAUsed,
          tools_available: [...availableToolsForAudit],
          missed_opportunities: missed,
          failures,
          call_counts: counts,
        };
      },
    });

    (tools as ToolRegistry).record_finding = tool({
      description:
        "Persist an analyst-grade FINDING (distinct from a raw artifact). Use ONLY after coverage_audit + detect_contradictions + tool_audit have run. Each finding must cite supporting artifacts, name drivers and reducers, and acknowledge contradictions. Confidence is computed server-side from sources + corroboration + contradictions; your `confidence` value is treated as a target, not a guarantee. Tier-C-only evidence is hard-capped at 50.",
      inputSchema: z.object({
        conclusion: z.string().min(5).max(2000),
        cluster_label: z.string().optional().describe("e.g. 'Cluster A — Rocklin candidate'"),
        supporting_sources: z.array(z.string()).min(1).describe("Tool names that produced the evidence."),
        supporting_artifact_values: z.array(z.string()).optional(),
        drivers: z.array(z.string()).min(1).describe("Why this conclusion holds (named evidence)."),
        reducers: z.array(z.string()).optional().describe("Reasons the conclusion could be wrong."),
        contradictions: z.array(z.string()).optional(),
        unresolved: z.array(z.string()).optional(),
        next_pivots: z.array(z.string()).optional(),
        identity_evidence_strength: z.number().min(0).max(100).default(60),
        relationship_evidence_strength: z.number().min(0).max(100).default(60),
        corroboration_count: z.number().min(1).default(1),
        label: z.enum(["CONFIRMED","CORROBORATED","INFERRED","VERIFY","LOW","DISMISSED"]).default("INFERRED"),
      }),
      execute: async (i) => {
        const { data: contraRows } = await supabase
          .from("artifacts")
          .select("kind,value,source,metadata,created_at")
          .eq("thread_id", threadId);
        const contras = detectContradictions((contraRows ?? []) as Parameters<typeof detectContradictions>[0]);
        const axes = computeAxes({
          sources: i.supporting_sources,
          corroborationCount: i.corroboration_count,
          contradictions: contras,
          identityEvidenceStrength: i.identity_evidence_strength,
          relationshipEvidenceStrength: i.relationship_evidence_strength,
        });
        const row = {
          thread_id: threadId,
          user_id: userId,
          kind: "finding",
          value: i.conclusion.slice(0, 500),
          confidence: axes.case,
          source: i.supporting_sources.join(","),
          metadata: {
            label: i.label,
            cluster_label: i.cluster_label,
            drivers: i.drivers,
            reducers: i.reducers ?? [],
            contradictions: i.contradictions ?? contras.map((c) => `${c.kind}: ${c.detail}`),
            unresolved: i.unresolved ?? [],
            next_pivots: i.next_pivots ?? [],
            supporting_sources: i.supporting_sources,
            supporting_artifact_values: i.supporting_artifact_values ?? [],
            confidence_axes: axes,
            source_reliability: sourceConfidence(i.supporting_sources),
          },
        };
        const { data, error } = await supabase.from("artifacts").insert([row]).select("id").maybeSingle();
        if (error) return { ok: false, error: error.message };
        return { ok: true, id: data?.id ?? null, confidence_axes: axes, applied_label: i.label };
      },
    });

    // Cumulative cost tracker for this run.
    let runCostMicroUsd = 0;
    let costCheckpointCounter = 0;
    // Bootstrap per-thread circuit breakers (firecrawl/intelbase pre-disabled).
    circuit.applyBaselineDisables(threadId);
    // Capability discovery: gate providers that can't run (missing key / gated /
    // disabled / unsupported seed) BEFORE the execution loop, so they never
    // become attempted live calls or consume credits. Pure evaluation over key
    // PRESENCE booleans (no secret values); unavailable tools are disabled via
    // the breaker, which cache.ts skips without billing.
    {
      const envPresence: Record<string, boolean> = {};
      for (const k of capabilityEnvKeys()) envPresence[k] = !!Deno.env.get(k);
      for (const cap of discoverCapabilities(envPresence, null)) {
        if (!cap.available) {
          circuit.disableTool(threadId, cap.tool, `unavailable: ${cap.reason}${cap.detail ? ` (${cap.detail})` : ""}`);
        }
      }
    }
    // Tracks the cost amount already written to the DB via mid-run
    // checkpoints so the final write only adds the remaining delta.
    let lastCheckpointMicroUsd = 0;
    const onCost = (m: number) => {
      runCostMicroUsd += m;
      // Checkpoint the running cost to threads every 5 paid tool calls so
      // mid-run crashes (context overflow, network errors) don't wipe the
      // entire spend accounting. onFinish does the final exact write.
      costCheckpointCounter++;
      if (costCheckpointCounter % 5 === 0) {
        // Use the atomic RPC so concurrent runs on the same thread don't
        // overwrite each other's running totals.
        const delta = runCostMicroUsd - lastCheckpointMicroUsd;
        lastCheckpointMicroUsd = runCostMicroUsd;
        if (delta > 0) {
          // Use service-role client — increment_thread_cost is SECURITY DEFINER
          // but has no EXECUTE grant for `authenticated`, so the user-scoped
          // client silently fails and thread spend stays at $0.
          supabaseAdmin.rpc("increment_thread_cost", { _id: threadId, _delta_cost: delta })
            .then(
              ({ error }: { error: unknown }) => { if (error) console.warn("[cost checkpoint] failed:", error); },
              (e: unknown) => console.warn("[cost checkpoint] failed:", e),
            );
        }
      }
    };

    // Primary: MiniMax-M2.7 via direct API (user's Max plan covers 15k req/5h).
    // Fallback: Gemini 2.5 Pro via Lovable AI Gateway, used only if the MiniMax
    // key is missing or the initial prompt is so large it would overflow
    // MiniMax's ~200k context window on the first step.
    const approxPromptChars =
      (SYSTEM_PROMPT_FULL.length + FINDING_LABELS.length) +
      JSON.stringify(trimmedMessages).length;
    // Pre-pivot only when we'd genuinely overflow MiniMax's ~200k-token window.
    // ~600k chars ≈ 150k tokens, leaving headroom for streamed completions.
    const MINIMAX_CHAR_BUDGET = 600_000;
    const MINIMAX_MSG_BUDGET = 150;
    const minimaxAvailable = !!MINIMAX_API_KEY;
    const wouldOverflow =
      approxPromptChars > MINIMAX_CHAR_BUDGET ||
      trimmedMessages.length > MINIMAX_MSG_BUDGET;
    let useFallback = !minimaxAvailable || wouldOverflow;
    // Pre-flight MiniMax health probe. The fallback selection above only fires
    // when MiniMax's key is missing or the prompt would overflow — it does NOT
    // catch the case where MiniMax is configured and accepts the request but is
    // currently rate-limited / 5xx / unreachable. In that case the run commits
    // to MiniMax and dies mid-stream with no failover (the live "Provider
    // returned error"). So when MiniMax is the chosen provider and a Gemini
    // fallback exists, ping MiniMax first; if it can't answer a trivial probe,
    // fail the whole run over to Gemini instead of dying. Best-effort: any
    // probe-internal fault leaves the original selection untouched so a healthy
    // run is never broken by the probe itself.
    if (!useFallback && lovableGateway) {
      try {
        const probePromise = minimaxChat({ user: "ping", maxTokens: 4, temperature: 0 });
        // Swallow a late rejection if the timeout wins the race below, so it
        // never surfaces as an unhandled rejection after we've moved on.
        probePromise.catch(() => {});
        const probe = (await Promise.race([
          probePromise,
          new Promise<{ ok: boolean; status: number }>((resolve) =>
            setTimeout(() => resolve({ ok: false, status: 0 }), 6000)),
        ])) as { ok: boolean; status: number };
        if (!probe.ok) {
          useFallback = true;
          console.warn(
            `[orchestrator] minimax preflight unhealthy (status=${probe.status || "timeout"}) → Gemini fallback for thread ${threadId}`,
          );
        }
      } catch (e) {
        // Network error / abort during the probe → MiniMax is unreachable.
        useFallback = true;
        console.warn(
          `[orchestrator] minimax preflight threw → Gemini fallback:`,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
    if (useFallback && !lovableGateway) {
      throw new Error(
        "Neither MINIMAX_API_KEY nor LOVABLE_API_KEY is configured for the orchestrator.",
      );
    }
    const orchestratorModel = useFallback
      ? lovableGateway!.chatModel(FALLBACK_MODEL_ID)
      : minimax.chatModel(PRIMARY_ORCHESTRATOR_MODEL_ID);
    console.log(
      `[orchestrator] running on ${useFallback ? FALLBACK_MODEL_ID + " (Lovable Gateway fallback)" : PRIMARY_ORCHESTRATOR_MODEL_ID + " (MiniMax direct)"} ` +
        `(approx prompt chars=${approxPromptChars}, messages=${trimmedMessages.length})`,
    );

    // Per-step trimmer: re-applies aggressive tool-result truncation to the
    // growing in-stream history so we don't drift back over the budget after
    // a dozen fan-out rounds. Keeps only the last RECENT_WINDOW messages at
    // full size; everything older is heavily compacted.
    const STEP_RECENT_WINDOW = 8;
    const STEP_RECENT_CHARS = 12000;
    const STEP_OLDER_CHARS = 3000;
    const prepareStep: NonNullable<Parameters<typeof streamText>[0]["prepareStep"]> =
      async ({ messages: stepMessages }) => {
        // Clear per-step dedup set at the *start* of every step. Doing this
        // only inside bumpArtifacts() means steps that find zero artifacts
        // never clear the set, silently blocking memory_recall for any
        // previously-queried subject for the rest of the investigation.
        routingGuard.memoryRecallSubjectsThisStep.clear();
        if (!Array.isArray(stepMessages) || stepMessages.length === 0) return {};
        const trimmed: ModelMessage[] = stepMessages.map((m: ModelMessage, idx: number) => {
          const isRecent = idx >= stepMessages.length - STEP_RECENT_WINDOW;
          const max = isRecent ? STEP_RECENT_CHARS : STEP_OLDER_CHARS;
          if (m.role !== "tool" && m.role !== "assistant") return m;
          if (!Array.isArray(m.content)) return m;
          const content = (m.content as TrimPart[]).map((part: TrimPart) => {
            if (part?.type === "tool-result" && part.output != null) {
              if (part.output && typeof part.output === "object" && "value" in part.output) {
                return { ...part, output: { ...part.output, value: truncateValue((part.output as { value: unknown }).value, max) } };
              }
              return { ...part, output: truncateValue(part.output, max) };
            }
            if (part?.type === "text" && typeof part.text === "string") {
              return { ...part, text: truncateStr(part.text, isRecent ? STEP_RECENT_CHARS : STEP_OLDER_CHARS) };
            }
            return part;
          });
          return { ...m, content } as ModelMessage;
        });
        return { messages: trimmed };
      };

    const result = streamText({
      // Top-level orchestrator runs on the smart tier — it's the multi-source
      // synthesis step that produces the final report. Per-tool sub-calls use
      // their own tier (see ./models.ts) via wrapToolsWithCache.
      model: orchestratorModel,
      system: SYSTEM_PROMPT_FULL + FINDING_LABELS + buildWorkflowAddendum(detectedSeedType),
      messages: trimmedMessages,
      tools: wrapToolsWithCache(tools, { investigationId: threadId, userId, supabase, supabaseAdmin, onCost }),
      stopWhen: stepCountIs(100),
      prepareStep,
      // Meter orchestrator LLM token spend per step so threads.cost_micro_usd
      // reflects the actual model cost, not just tool fan-out cost.
      // Rates (micro-USD per token):
      //   MiniMax-M2.7:    in $0.30/M  out $1.20/M  → 0.30, 1.20
      //   Gemini 2.5 Pro:  in $1.25/M  out $10.00/M → 1.25, 10.00
      onStepFinish: ({ usage }) => {
        try {
          const u = usage as { inputTokens?: number; promptTokens?: number; outputTokens?: number; completionTokens?: number } | undefined;
          const inTok = Number(u?.inputTokens ?? u?.promptTokens ?? 0);
          const outTok = Number(u?.outputTokens ?? u?.completionTokens ?? 0);
          if (!inTok && !outTok) return;
          const [inRate, outRate] = useFallback ? [1.25, 10] : [0.3, 1.2];
          const micro = Math.round(inTok * inRate + outTok * outRate);
          if (micro > 0) onCost(micro);
        } catch (e) {
          console.warn("[orchestrator] usage meter failed:", e);
        }
      },
      // Intentionally NOT bound to req.signal: when the analyst navigates away
      // from the chat, the browser cancels the fetch — but we want the
      // investigation to keep running server-side, persist its artifacts as
      // they come in, and save the final assistant message via onFinish.
      onError: async ({ error }) => {
        const msg = error instanceof Error ? error.message : String(error);
        const isCtxOverflow =
          /context window|context length|2013|invalid params.*context|exceeds limit/i.test(msg);
        console.warn(
          "[orchestrator] stream error:",
          JSON.stringify({
            thread_id: threadId,
            provider: useFallback ? "lovable-gateway" : "minimax",
            model: useFallback ? FALLBACK_MODEL_ID : MODELS[ORCHESTRATOR_TIER],
            approx_prompt_chars: approxPromptChars,
            context_overflow: isCtxOverflow,
            message: msg.slice(0, 600),
          }),
        );
        if (isCtxOverflow) {
          // Await the status write so it actually persists before the isolate
          // potentially dies. Otherwise the UI is stuck on "running".
          try {
            const { error: updErr } = await supabase
              .from("threads")
              .update({ status: "failed_context_limit" })
              .eq("id", threadId);
            if (updErr) console.warn("[thread status] update failed:", updErr.message);
          } catch (e) {
            console.warn("[thread status] update threw:", e);
          }
        }
      },
    });

    // Keep the edge function alive after the HTTP response closes so the
    // model keeps running, tools keep firing, and onFinish persists the
    // final assistant message even if the client tab is closed.
    try {
      // `EdgeRuntime.waitUntil` is the Supabase-Deno equivalent of the
      // Cloudflare/Vercel `ctx.waitUntil` — schedules background work that
      // outlives the response.
      const ert = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
      if (ert && typeof ert.waitUntil === "function") {
        ert.waitUntil(result.consumeStream());
      } else {
        // Fallback: fire-and-forget consumption.
        void result.consumeStream();
      }
    } catch { /* best-effort background completion */ }

    return result.toUIMessageStreamResponse({
      headers: corsHeaders,
      originalMessages: messages,
      // Surface the REAL (redacted) provider reason to the client instead of the
      // SDK's default generic mask ("An error occurred" / "Provider returned
      // error"). The failed-run card then shows an actionable message, and a
      // context-overflow vs. rate-limit vs. unreachable failure is
      // distinguishable. Strip anything that looks like a credential first.
      onError: (error) => {
        const m = error instanceof Error ? error.message : String(error);
        const redacted = m
          .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
          .replace(/sk-[A-Za-z0-9._-]+/g, "sk-[REDACTED]")
          .replace(/xai-[A-Za-z0-9._-]+/g, "xai-[REDACTED]")
          .replace(/AIza[A-Za-z0-9_-]+/g, "AIza[REDACTED]");
        return redacted.slice(0, 300) || "Provider stream error";
      },
      onFinish: async ({ messages: finalMessages }) => {
        const assistant = [...finalMessages].reverse().find((m) => m.role === "assistant");
        if (assistant) {
          // Cap `messages.parts` payload to avoid silent PostgREST 500s when
          // a long fan-out produces multi-MB tool-result blobs. We strip
          // `output.raw` from any tool-result part above the cap.
          const safeParts = capPartsSize(assistant.parts as unknown[], 3_500_000);
          const { error: msgErr } = await supabase.from("messages").insert({
            thread_id: threadId,
            user_id: userId,
            role: "assistant",
            parts: safeParts as unknown,
          });
          if (msgErr) {
            console.error(JSON.stringify({ event: "assistant_message_insert_fail", thread_id: threadId, error: msgErr.message }));
          }
          // Atomic cost increment — only the remaining delta past the last
          // mid-run checkpoint. No read-modify-write fallback: a racy fallback
          // is worse than a missed write, since two parallel runs can silently
          // overwrite each other's totals.
          {
            const finalDelta = runCostMicroUsd - lastCheckpointMicroUsd;
            if (finalDelta > 0) {
              const { error: rpcErr } = await supabaseAdmin.rpc("increment_thread_cost", {
                _id: threadId, _delta_cost: finalDelta,
              });
              if (rpcErr) {
                console.error(JSON.stringify({
                  event: "cost_final_write_failed",
                  thread_id: threadId,
                  delta_micro_usd: finalDelta,
                  error: rpcErr.message,
                }));
              } else {
                lastCheckpointMicroUsd = runCostMicroUsd;
              }
            }
          }

          // ---- Persist investigation cache (per seed, per user) ----
          try {
            const firstUser = finalMessages.find((m) => m.role === "user");
            const seedText = ((firstUser?.parts ?? []) as Array<{ type: string; text?: string }>)
              .filter((p) => p.type === "text").map((p) => p.text ?? "").join(" ").trim();
            const detected = detectSeedServer(seedText);
            if (detected) {
              const { data: arts } = await supabase
                .from("artifacts")
                .select("kind,value,confidence,source,metadata")
                .eq("thread_id", threadId)
                .order("created_at", { ascending: true });
              // Cache is long-lived (7d) and is replayed back into a future
              // run's context, so strip credentials / PII / oversized blobs.
              const cachedParts = sanitizeToolOutput(safeParts, 1500);
              const cachedArts = sanitizeToolOutput(arts ?? [], 1500);
              const payload = {
                seed: detected,
                assistant_parts: cachedParts,
                artifacts: cachedArts,
                finished_at: new Date().toISOString(),
              };
              await supabase.from("investigation_cache").upsert(
                {
                  user_id: userId,
                  seed_kind: detected.kind,
                  seed_value_normalized: detected.normalized,
                  result_json: payload as unknown as Record<string, unknown>,
                  created_at: new Date().toISOString(),
                  expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
                },
                { onConflict: "user_id,seed_kind,seed_value_normalized" },
              );
            }
          } catch (e) {
            console.error(JSON.stringify({ event: "investigation_cache_fail", thread_id: threadId, error: String(e) }));
          }
        }
      },
    });
  } catch (e) {
    // setupRequest throws Response objects for 401/403/400 — return them directly
    if (e instanceof Response) return e;
    console.error("osint-agent error", e);
    const message = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: "Internal Server Error", code: "ORCHESTRATOR_FAULT", detail: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

});
