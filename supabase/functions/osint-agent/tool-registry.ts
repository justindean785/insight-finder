import { tool } from "npm:ai@6";
import { z } from "npm:zod@3";
import { createClient } from "npm:@supabase/supabase-js@2";
import type { UIMessage } from "npm:ai@6";

import { MODELS, tierForTool, modelForTool, type Tier } from "./models.ts";
import { costForTool } from "./costs.ts";
import { tierOf, TIER_A, TIER_B } from "./tiers.ts";
import { playbookFor, renderPlaybookForPrompt } from "./playbooks.ts";
import { auditCoverage } from "./coverage.ts";
import {
  detectContradictions,
  clusterScopedContradictionPatches,
  artifactsForFinding,
  mergeStructuredContradictions,
  type StructuredContradiction,
} from "./contradictions.ts";
import { applyDateSanity } from "./date-sanity.ts";
import { computeAxes, sourceConfidence, applyEvidenceCaps, isUnrelatedEntity, EXCLUDED_COLLISION_CONFIDENCE, isBioCrossLinkName, BIO_CROSS_LINK_NAME_CAP, deriveStatus, coerceCoherentStatus, looksDeadEnd } from "./confidence.ts";
import { queryTypesOf } from "./query-type-router.ts";
import { isSameSurnameOnlyLead, isListingAgentLead } from "./collision-policy.ts";
import { STRICT_KINDS, inferKind, isStrictKind, classifySource, isLlmAssertedDomainSource, LLM_ASSERTED_PROVENANCE } from "./artifact_types.ts";
import * as circuit from "./circuit.ts";
import { buildNodes } from "./graph.ts";
import { inferEdges, clusterGraph } from "./graph_reasoning.ts";
import { selectPivots, proposedCallToCandidate, type PivotCandidate, type ProposedCall } from "./graph_pivots.ts";
import { renderPivotChecklistForPrompt } from "./pivot-checklists.ts";
import { unknownToolNudge } from "./unknown-tool-guard.ts";
import type { QueryType } from "./query-type-router.ts";
import { DNS_TYPES, VIRTUAL_TYPE_MAP, isVirtualType, resolveVirtualHost, filterTxtByPrefix } from "./tools/dns-virtual.ts";

import {
  MINIMAX_API_KEY, LOVABLE_API_KEY,
  OATHNET_API_KEY, OSINTNOVA_API_KEY, SOCIALFETCH_API_KEY,
  CORDCAT_API_KEY, HUNTER_API_KEY,
  HIBP_API_KEY, GITHUB_API_TOKEN, EXA_API_KEY, JINA_API_KEY,
  GEMINI_API_KEY, OSINT_NAVIGATOR_API_KEY, PERPLEXITY_API_KEY, SERUS_API_KEY, IPQUALITYSCORE_API_KEY,
  RAPIDAPI_KEY, INDICIA_API_KEY,
  OPENCORPORATES_API_KEY, RANSOMWARELIVE_API_KEY,
  URLSCANNER_API_KEY,
  degradedTools,
  markToolDegraded, isDegraded, fetchRetry, fetchT,
  deadHosts, markHostDead, isHostDead,
} from "./env.ts";
import { buildLeakcheckUrl, buildOathnetUrl } from "./breach-request.ts";
import {
  indicia_email, indicia_phone, indicia_person,
  indicia_address, indicia_web_dbs, indicia_hudsonrock,
} from "./tools/indicia.ts";

import {
  validateArtifact, TTL_24H_MS, TOOL_TTL_MS, NO_CACHE_TOOLS,
  coerceArtifactsInput,
} from "./validation.ts";

import type { NavigatorQueryResponse, NavigatorSearchResponse, NavigatorTool, StolenTaxResponse, GitHubCodeSearchResponse, GitHubCodeMatch } from "./api_types.ts";

import {
  scrubArtifactRow, scrubArtifactRows, hashInput, normalizeForHash,
  sanitizeToolOutput, TOOL_CACHE_LRU, LRU, isPrivateHost, assertSafeUrl,
  type CacheEntry,
} from "./safety.ts";

import {
  guard, routingGuard, CONSUMER_DOMAINS, STAGE2_TOOLS,
  triageState, bumpArtifacts, skipStub,
} from "./guard.ts";

import { minimaxChat, minimaxChatWithFallback, safeJson, geminiGroundedSearch, perplexitySearch } from "./providers.ts";
import { dorkToExaQuery } from "./dork-translate.ts";
import { augmentDorkQuery, isTemplateOrSampleUrl } from "./dork-relevance.ts";
import { buildAutoRecordedRow } from "./auto-record-integrity.ts";

import { TOOL_CATALOG, CATALOG_CACHE, FINDING_LABELS } from "./catalog.ts";
import { beginCycle, recordFindingSummary } from "./runtime-policy.ts";
import { serus_darkweb_scan } from "./tools/serus.ts";
import { okWithSuccessFlag, socialfetchError, isHackertargetApiError, isCrtshOk, dohTypeError, blockchairError } from "./tool_response.ts";
import { enforceNameSeedPriority, enforceFallbackToolPolicy, NAME_SEED_PLANNER_RULES } from "./planner-guidance.ts";
import { sweepUsername } from "./sweeper.ts";
import { trimExaResults, archiveAttachment } from "./archiver.ts";

type ToolRegistry = Record<string, unknown>;
type ExecutableTool = {
  execute: (input: Record<string, unknown>, options: unknown) => Promise<unknown>;
};

export interface ToolContext {
  supabase: ReturnType<typeof createClient>;
  supabaseAdmin: ReturnType<typeof createClient>;
  userId: string;
  threadId: string;
  archiveEnabled: boolean;
  detectedSeedType: string;
  messages: UIMessage[];
  manualOverrideSelector: string | null;
}

// Hosts that reliably return 451/403 THROUGH r.jina.ai — scraping them is a
// guaranteed ~8s dead round-trip (the abort signal only cancels AFTER the cap
// fires; the wasted wall-clock is already spent). Skip the call entirely and
// return the same origin-blocked shape the agent already knows how to pivot on.
// SCOPE: this guard is Jina-specific — these same hosts remain valid targets for
// socialfetch_lookup, reddit_user (.json), and direct-API tools; do NOT promote
// this to a global domain block.
const JINA_HARD_BLOCK_HOSTS = [
  "x.com",
  "twitter.com",
  "twitch.tv",
  "instagram.com",
  "reddit.com",
  "facebook.com",
];
function isJinaHardBlocked(hostname: string): boolean {
  return JINA_HARD_BLOCK_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`));
}

export function buildTools(ctx: ToolContext) {
  const { supabase, supabaseAdmin, userId, threadId, archiveEnabled, detectedSeedType, messages, manualOverrideSelector } = ctx;

  const tools = {
    list_tools: tool({
      description:
        "Returns the OSINT tool catalog, per-seed fan-out recipes, finding-label rules, and tools disabled by provider configuration. Triage and expected-value signals never hide otherwise available tools.",
      inputSchema: z.object({}).strict(),
      execute: async () => {
        const disabled: Array<{ name: string; reason: string }> = [];
        // HIBP needs a paid key; hide it entirely when unset so the agent
        // doesn't burn a fan-out slot on a tool that can only return
        // "not configured" on every email seed.
        if (!HIBP_API_KEY) {
          disabled.push({
            name: "hibp_lookup",
            reason: "HIBP_API_KEY not configured — use breach_check / leakcheck_lookup / oathnet_lookup for breach corroboration.",
          });
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
        "Optional early classification for email or username seeds. Records a `triage_decision` artifact but never unlocks or blocks other tools.",
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

        // Triage is classification-only. Provider calls must pass through the
        // shared planner/cache/runtime wrapper so they are budgeted, logged,
        // deduplicated, and eligible for user-scoped cache reuse.
        const stage1: Record<string, unknown> = {};

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

        // Stage-2 categories become eligible after triage, but every provider
        // call still requires a structured cycle plan and runtime approval.
        const stage2Open = true;
        if (reasons.length === 0) reasons.push("seed classified; provider checks require a planned cycle");

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
        "Live web search powered by Perplexity Sonar (grounded, real-time, with citations). Use for the original seed or a corroborated selector when the planned query can answer a distinct verification question. Returns a concise synthesized answer plus cited source URLs.",
      inputSchema: z.object({
        query: z.string().min(2).describe("Search query, e.g. \"alice@example.com\" leak OR breach"),
        focus: z.string().optional().describe("Optional steering hint, e.g. 'find social profiles', 'find leaks'"),
      }),
      execute: async ({ query, focus }) => {
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
      execute: async ({ text, context }, opts) => {
        try {
          const signal = (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
          const r = await minimaxChatWithFallback({
            system:
              "You extract OSINT entities. Reply ONLY with JSON matching: {emails:string[],usernames:string[],phones:string[],urls:string[],ips:string[],domains:string[],names:string[],employers:string[],locations:string[],crypto:{chain:string,address:string}[],notes:string}. Dedupe. Lowercase emails/domains. Empty arrays if none.",
            user: `${context ? "Context: " + context + "\n\n" : ""}Text:\n${text.slice(0, 18000)}`,
            json: true,
            maxTokens: 1200,
            signal,
          });
          const parsed = safeJson<Record<string, unknown>>(r.content) ?? { raw: r.content };
          return { ok: r.ok, status: r.status, entities: parsed };
        } catch (e) { return { error: String(e) }; }
      },
    }),
    minimax_correlate: tool({
      description:
        "Have MiniMax correlate and rescore a batch of artifacts. Pass the relevant artifacts gathered so far; it returns identity clusters, dedup mapping, confidence rescoring, and contradiction flags. Run after at least three meaningful new artifacts or before final verification.",
      inputSchema: z.object({
        seed: z.string().describe("Original seed identifier"),
        // Models frequently pass `artifacts` as a JSON STRING; coerce to an
        // array before validating (same as record_artifacts) so a stringified
        // batch doesn't fail correlation and lose the run's findings.
        artifacts: z.preprocess(coerceArtifactsInput, z.array(z.object({
          kind: z.string(),
          value: z.string(),
          source: z.string().optional(),
          confidence: z.number().optional(),
          metadata: z.unknown().optional(),
        })).max(200)),
      }),
      execute: async ({ seed, artifacts }) => {
        // Input guard: never spend a paid MiniMax call on an empty/invalid
        // payload. The counter check below tracks how many NEW artifacts were
        // recorded, but the model can still invoke this with no seed or an
        // empty / malformed `artifacts` array — correlating nothing is pure
        // waste. Gate on the actual inputs, not just the counter.
        const cleanSeed = typeof seed === "string" ? seed.trim() : "";
        const validArtifacts = Array.isArray(artifacts)
          ? artifacts.filter((a) => a && typeof a.value === "string" && a.value.trim().length > 0)
          : [];
        if (!cleanSeed || validArtifacts.length === 0) {
          return skipStub(
            "minimax_correlate",
            `no valid inputs to correlate (seed=${cleanSeed ? "present" : "empty"}, ${validArtifacts.length} valid artifacts). Pass the seed and the artifacts gathered so far.`,
            { seedProvided: !!cleanSeed, validArtifactCount: validArtifacts.length },
          );
        }
        try {
          const r = await minimaxChatWithFallback({
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
        "Plan the next bounded investigation cycle. Returns structured JSON with stage, goal, current_findings, proposed_calls[], and calls_rejected[]. Use it before any non-planner pivot batch so the investigation stays budgeted, cache-aware, and evidence-led.",
      inputSchema: z.object({
        seed: z.string(),
        already_queried: z.array(z.string()).max(200).default([]),
        artifacts: z.preprocess(coerceArtifactsInput, z.array(z.object({ kind: z.string(), value: z.string() })).max(200)),
        budget_remaining: z.number().int().min(0).max(100).default(30),
      }),
      execute: async ({ seed, already_queried, artifacts, budget_remaining }) => {
        try {
          const baseToolList = [
            // Breach + identity
            "rapidapi_breach_search","rapidapi_all_breaches",
            "breach_check","leakcheck_lookup","hibp_lookup","oathnet_lookup",
            "bosint_email_lookup",
            "stolentax_footprint","serus_darkweb_scan",
            // Indicia — US person/phone/email/address + web-DB breach aggregator.
            "indicia_email","indicia_phone","indicia_person","indicia_address",
            "indicia_web_dbs","indicia_hudsonrock",
            // DeepFind suite (shared 1000/day pool).
            "deepfind_reverse_email","deepfind_disposable_email",
            "deepfind_ssl_inspect","deepfind_tech_stack","deepfind_url_unshorten",
            "deepfind_telegram_channel","deepfind_telegram_search",
            "deepfind_vin_lookup","deepfind_aircraft_lookup","deepfind_vessel_lookup",
            "deepfind_mac_lookup","deepfind_dark_web_link",
            "deepfind_email_breach","deepfind_transaction_viewer",
            // Profile / social
            "socialfetch_lookup","cordcat_discord_lookup","github_user","github_code_search",
            "hackernews_user","reddit_user","gravatar_profile","emailrep",
            "username_sweep","username_search",
            // Email enrichment
            "hunter_domain_search","hunter_email_finder","hunter_email_verifier","hunter_combined",
            // Domain / infra / IP
            "whois_lookup","dns_records","crtsh_subdomains","crtsh_lookup","http_fingerprint",
            "ip_intel","ipgeolocation_lookup","ipqualityscore_lookup","shodan_internetdb","hackertarget",
            "urlscan_search","virustotal_lookup",
            "urlscanner_scan",
            // Phase 1 free / no-key corroboration tools
            "ransomwarelive_lookup","wayback_cdx_search","census_geocode","nominatim_geocode",
            "hibp_pwned_passwords_kanon","gleif_lei_search","opencorporates_search",
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
          // Permanently blocked tools — never let the planner pick them.
          // Blocked from production telemetry (tool_usage_log over ~106
          // investigations): these burned planner slots, latency, and cost
          // for ~0 yield. Runtime defs + catalog entries are kept (contract
          // test stays green) and they're decoupled from playbooks; re-add
          // here only after the underlying integration/key is repaired.
          //   stolentax_footprint  22% ok, ~10s latency (401 bad key + aborts)
          //   hackernews_user       0% ok
          //   gravatar_profile     14% ok (404s; already demoted in #171)
          //   emailrep             19% ok (429 rate-limited; low value)
          //   ipqualityscore_lookup 0/28 ok — dead key ("Invalid or unauthorized
          //                        key" for 30d); cut 2026-07-05.
          // NB: hibp_lookup (0%) stays on its API-key gate (valuable once keyed) and
          // is NOT hard-blocked. ipqualityscore is now hard-cut (dead key).
          // stolentax_footprint / synapsint_lookup / emailrep / ipqualityscore_lookup
          // are ALSO hard-disabled in capabilities.ts (disabled:true) so the readiness
          // gate deletes them from the tool schema entirely; keeping them here is
          // belt-and-suspenders for the planner menu.
          const PERMANENT_BLOCK = new Set([
            "stolentax_footprint","synapsint_lookup","hackernews_user",
            "gravatar_profile","emailrep","ipqualityscore_lookup",
          ]);
          // Tools the circuit breaker has disabled this investigation (e.g.
          // a provider after consecutive HTTP 500s). Without this the planner
          // re-proposes a known-dead tool every round for zero value.
          // degradedTools covers the parallel self-degrade path
          // (markToolDegraded on 5xx).
          const brokenTools = new Set<string>(
            circuit.snapshot(threadId).filter((s) => s.disabledReason).map((s) => s.tool),
          );
          const toolList = baseToolList.filter((name) => {
            if (PERMANENT_BLOCK.has(name)) return false;
            // HIBP can only fail without a key — keep it off the planner menu.
            if (name === "hibp_lookup" && !HIBP_API_KEY) return false;
            // Serus needs its API key — without it every call errors, so keep
            // it off the planner menu (it's still in baseToolList so it appears
            // the moment SERUS_API_KEY is configured).
            if (name === "serus_darkweb_scan" && !SERUS_API_KEY) return false;
            // IPQualityScore: same key-gating — only proposable when configured.
            if (name === "ipqualityscore_lookup" && !IPQUALITYSCORE_API_KEY) return false;
            // Indicia — all six endpoints share one key; keep them off the planner
            // menu until INDICIA_API_KEY is set.
            if (name.startsWith("indicia_") && !INDICIA_API_KEY) return false;
            // RapidAPI breach tools are the PRIMARY email breach source but only
            // work with RAPIDAPI_KEY — both self-skip without it. Keep them off the
            // planner menu when unkeyed so an un-keyed deploy doesn't burn a planner
            // slot on a tool that can only return { skipped:true }.
            if ((name === "rapidapi_breach_search" || name === "rapidapi_all_breaches") && !RAPIDAPI_KEY) return false;
            // OpenCorporates is now key-required (keyless = 401). Keep it off the
            // planner menu until OPENCORPORATES_API_KEY is set — gleif_lei_search
            // is the keyless company-registry alternative.
            if (name === "opencorporates_search" && !OPENCORPORATES_API_KEY) return false;
            // Ransomware.live free API is dead; tool only works with the api-pro
            // key. Keep it off the planner menu until RANSOMWARELIVE_API_KEY is set.
            if (name === "ransomwarelive_lookup" && !RANSOMWARELIVE_API_KEY) return false;
            // URLScanner.online needs its API key — without it every call errors;
            // keep it off the planner menu until URLSCANNER_API_KEY is set.
            if (name === "urlscanner_scan" && !URLSCANNER_API_KEY) return false;
            // Dead/degraded tools — stop re-proposing them this investigation.
            if (brokenTools.has(name) || isDegraded(name)) return false;
            // gemini_deep_dork (~46% success, 21s latency) is fallback-only — keep
            // it off the planner menu until the cheaper dork path has been tried.
            if (name === "gemini_deep_dork" && !already_queried.some((e) =>
              /dork_harvest|google_dorks/.test(String(e).toLowerCase())
            )) return false;
            return true;
          });

          // Slice 2 / Phase A1 — cost-tier guide so the planner prefers the
          // cheapest tool that can answer (free/low validation before paid
          // confirmation). Advisory only; mirrors the cost_tier field the
          // planner already emits per proposed call.
          const costBucket = (n: string): "free" | "low" | "expensive" => {
            const c = costForTool(n);
            return c === 0 ? "free" : c <= 1500 ? "low" : "expensive";
          };
          const tierBuckets: Record<"free" | "low" | "expensive", string[]> = { free: [], low: [], expensive: [] };
          for (const n of toolList) tierBuckets[costBucket(n)].push(n);
          const costGuide =
            `TOOL COST TIERS (prefer the cheapest tool that can answer; run FREE/LOW validation before spending on EXPENSIVE/premium confirmation):\n` +
            `- FREE: ${tierBuckets.free.join(", ") || "(none)"}\n` +
            `- LOW: ${tierBuckets.low.join(", ") || "(none)"}\n` +
            `- EXPENSIVE: ${tierBuckets.expensive.join(", ") || "(none)"}`;

          // Slice 2 / Phase A2 — feed prior cross-investigation memory (lessons,
          // known false-positives, identity links) into the planner so it learns
          // from past scans. Best-effort + read-only: a failure never blocks
          // planning. No hit_count bump here — that stays the memory_recall tool's
          // job so its rate-limit/dedup semantics are unaffected.
          let memoryHint = "";
          try {
            const seedNorm = String(seed ?? "").trim().toLowerCase();
            if (seedNorm) {
              const { data: mem } = await supabase
                .from("agent_memory")
                .select("kind,content,confidence")
                .eq("user_id", userId)
                .or(`subject.eq.${seedNorm},related_values.cs.{${seedNorm}}`)
                .order("confidence", { ascending: false })
                .limit(8);
              const rows = (mem ?? []) as Array<{ kind?: string; content?: string; confidence?: number }>;
              if (rows.length) {
                memoryHint =
                  `\n\nPRIOR MEMORY for this subject (weight these — lessons / known false-positives / confirmed links from earlier investigations):\n` +
                  rows.map((m) => `- [${m.kind ?? "note"}${m.confidence != null ? ` ${m.confidence}` : ""}] ${String(m.content ?? "").slice(0, 240)}`).join("\n");
              }
            }
          } catch (e) {
            console.warn("[planner] memory hint lookup failed (non-fatal):", e);
          }

          // Slice 2 / Phase A (item 2) — wire the (previously unwired)
          // graph_reasoning engine into the planner: infer relationship EDGES +
          // identity CLUSTERS from the thread's recorded artifacts and feed a
          // compact summary into the prompt so the planner pivots on CONNECTIONS
          // (who works for whom, aliases, contradictions), not just isolated
          // selectors. Reads the artifacts TABLE (not the thin {kind,value} input)
          // because edge inference needs node metadata (display_name/founder/
          // parent). Summary/advisory ONLY — no confidence mutation (propagate-
          // Confidence stays unwired; scoring it would be an integrity change).
          // Best-effort; failure never blocks planning.
          let relationshipHint = "";
          try {
            const { data: fullArts } = await supabase
              .from("artifacts")
              .select("kind,value,confidence,source,metadata")
              .eq("thread_id", threadId)
              .order("created_at", { ascending: true });
            const arts = (fullArts ?? []) as Parameters<typeof buildNodes>[0];
            if (arts.length) {
              const nodes = buildNodes(arts);
              const edges = inferEdges(nodes);
              const { clusters, contradictions } = clusterGraph(nodes, edges);
              const valOf = new Map(nodes.map((n) => [n.id, n.raw || n.value]));
              const lines: string[] = [];
              const multi = clusters.filter((c) => c.nodeIds.length > 1 || c.label);
              if (multi.length) {
                lines.push("Connected identity clusters:");
                for (const c of multi.slice(0, 10)) {
                  const members = c.nodeIds.map((id) => valOf.get(id) ?? id).filter(Boolean).slice(0, 8);
                  lines.push(`  - ${c.label ? `[${c.label}] ` : ""}${members.join(" ↔ ")}${c.conflicted ? " (CONFLICTED — ≥2 distinct identities; do not merge, corroborate)" : ""}`);
                }
              }
              const rel = edges.filter((e) => e.type !== "same_selector").slice(0, 15);
              if (rel.length) {
                lines.push("Relationship edges:");
                for (const e of rel) lines.push(`  - ${valOf.get(e.from) ?? e.from} --${e.type}--> ${valOf.get(e.to) ?? e.to}`);
              }
              if (contradictions.length) {
                lines.push(`Contradictions: ${contradictions.length} (a selector resolves to multiple people — corroborate before asserting identity).`);
              }
              if (lines.length) {
                relationshipHint =
                  `\n\nRELATIONSHIP GRAPH (pivot on these connections — expand outward from connected entities, corroborate across clusters):\n` +
                  lines.join("\n");
              }
            }
          } catch (e) {
            console.warn("[planner] relationship graph lookup failed (non-fatal):", e);
          }

          // Slice 2 / Phase A (item 3) — per-data-point expansion: for each KIND
          // of artifact discovered so far, surface recipe-grounded next pivots so
          // the planner runs the right tool for each new data point and expands
          // outward (the recursive email→name→email→address chain). Exact tools
          // come from playbook.pivots[kind] (email/domain/username/phone/ip);
          // person/address/business get the pivot-checklist required cross-checks
          // (tool-group hints). Advisory — the planner still picks from toolList.
          let pivotHint = "";
          try {
            const kinds = new Set<string>();
            for (const a of (artifacts as Array<{ kind?: string }>)) {
              if (a && typeof a.kind === "string" && a.kind.trim()) kinds.add(a.kind.trim().toLowerCase());
            }
            if (kinds.size) {
              const pivots = playbookFor(detectedSeedType).pivots;
              const KIND_TO_QT: Record<string, QueryType> = {
                person: "person", name: "person", address: "address", location: "address",
                organization: "business", company: "business", url: "url", image: "image",
              };
              const perKind: string[] = [];
              const qts = new Set<QueryType>();
              for (const k of kinds) {
                const tools = pivots[k];
                if (Array.isArray(tools) && tools.length) {
                  const allowed = tools.filter((t) => toolList.includes(t)).slice(0, 6);
                  if (allowed.length) perKind.push(`  - ${k} → ${allowed.join(", ")}`);
                }
                const qt = KIND_TO_QT[k];
                if (qt) qts.add(qt);
              }
              const checklist = qts.size ? renderPivotChecklistForPrompt([...qts]) : "";
              const parts: string[] = [];
              if (perKind.length) parts.push("NEXT PIVOTS PER DISCOVERED DATA POINT (run the right tool for each new kind, then expand on its results):\n" + perKind.join("\n"));
              if (checklist) parts.push(checklist);
              if (parts.length) pivotHint = `\n\n${parts.join("\n\n")}`;
            }
          } catch (e) {
            console.warn("[planner] pivot hint build failed (non-fatal):", e);
          }

          const r = await minimaxChatWithFallback({
            model: MODELS.smart,
            system:
              `You are the execution planner for a forensic OSINT runtime. ONLY propose tools from this EXACT list (names must match verbatim — do not invent or rename): ${toolList.join(", ")}.\n\n${NAME_SEED_PLANNER_RULES}\n\nRUNTIME RULES:\n- Stage choices: TRIAGE, REVIEW, TARGETED_PIVOT, VERIFY, REPORT.\n- Propose ALL independent, non-redundant pivots that can run in PARALLEL this cycle (free/low-cost especially) so the investigation finishes in FEWER cycles. Only serialize a pivot when it depends on a prior pivot's result.\n- Respect the hard total-call and concurrency ceilings enforced by the runtime.\n- Weak-lead and expected-value signals are advisory. Do not turn them into prerequisites or retry loops.\n- Prefer the cheapest tool that can answer the current question: run FREE/LOW-cost validation before spending on EXPENSIVE/premium tools (see TOOL COST TIERS in the context below). Cost is advisory — never drop a uniquely high-value lead just because it is expensive.\n- When a finding is breach-derived or otherwise confidence-capped, propose ONE independent, trusted NON-infrastructure source to corroborate it and lift the cap, rather than re-running the same breach source.\n- Cached results NEVER count as corroboration. If a fresh cache hit would satisfy the question, prefer it over a live call.\n- If evidence is weak, explain that in the reason and keep the result [VERIFY].\n\nReply ONLY with JSON matching this exact shape:\n{\n  "stage":"TRIAGE|REVIEW|TARGETED_PIVOT|VERIFY|REPORT",\n  "goal":"string",\n  "current_findings":["string"],\n  "proposed_calls":[{\n    "tool_name":"exact_tool_name",\n    "selector":"string",\n    "selector_type":"string",\n    "params_preview":{},\n    "expected_value":0,\n    "cost_tier":"free|low|expensive",\n    "reason":"string",\n    "stop_condition":"string",\n    "cache_status":"thread|user|stale|miss"\n  }],\n  "calls_rejected":[{\n    "tool_name":"exact_tool_name",\n    "selector":"string",\n    "selector_type":"string",\n    "expected_value":0,\n    "reason":"string",\n    "cost_tier":"free|low|expensive",\n    "weak_lead":true,\n    "stale_cache":false,\n    "manual_override":false\n  }]\n}\nOrder proposed_calls by expected_value descending. Respect budget_remaining as the max number of proposed_calls.`,
            user: `Seed: ${seed}\nBudget remaining: ${budget_remaining}\nAlready queried: ${JSON.stringify(already_queried).slice(0,4000)}\nArtifacts so far: ${JSON.stringify(artifacts).slice(0,8000)}\n\n${costGuide}${relationshipHint}${pivotHint}${memoryHint}`,
            json: true,
            maxTokens: 1500,
          });
          const parsed = enforceFallbackToolPolicy(
            enforceNameSeedPriority(
              safeJson<Record<string, unknown>>(r.content) ?? { raw: r.content },
              { seedType: detectedSeedType, alreadyQueried: already_queried },
            ),
            { alreadyQueried: already_queried },
          );
          // Slice 2 / Phase B1 — re-rank & filter the planned pivots through the
          // entity graph: drop dead-end / over-broad-unconfirmed / already-
          // confirmed targets and order the rest cheapest-justified-first.
          // NOTE: the planner emits `proposed_calls` (NOT `pivots` — the prior
          // dark-launched block read the wrong field, so it never fired even when
          // enabled). Map proposed_calls → PivotCandidate, run the pure selector,
          // then rewrite proposed_calls in the chosen order. Off (default) →
          // byte-for-byte the existing behavior; any error falls back to the
          // planner's raw output.
          if (Deno.env.get("GRAPH_PIVOTS_ENABLED") === "true") {
            try {
              const calls = (parsed as { proposed_calls?: unknown }).proposed_calls;
              if (Array.isArray(calls) && calls.length) {
                const nodes = buildNodes(artifacts as Array<{ kind: string; value: string }>);
                const candidates = (calls as ProposedCall[]).map(proposedCallToCandidate);
                const { selected, dropped } = selectPivots(candidates, nodes, { budget: budget_remaining });
                (parsed as { proposed_calls: unknown }).proposed_calls =
                  (selected as Array<PivotCandidate & { _orig: ProposedCall }>).map((c) => c._orig);
                if (dropped.length) {
                  console.log(`[graph-pivots] dropped ${dropped.length} pivot(s): ${dropped.map((d) => `${d.tool}:${d.reason}`).join(", ")}`);
                }
              }
            } catch (e) {
              console.warn("[graph-pivots] selection failed, using planner output:", e);
            }
          }
          return { ok: r.ok, status: r.status, plan: parsed };
        } catch (e) { return { error: String(e) }; }
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
       "Query OathNet v2 for breach correlation on a high-value email/username/phone/domain/NAME, or geo+ASN on an IP. For a person's full NAME pass type:'name' (searched as a free-text query across the breach corpus — expect same-name collisions, so treat name-only hits as [VERIFY] until a selector overlaps). A first-class breach source: run it on the seed AND on high-value selectors/names discovered mid-investigation.",
      inputSchema: z.object({
        type: z.enum(["email", "username", "phone", "ip", "domain", "name"]),
        value: z.string(),
      }),
      execute: async ({ type, value }, opts) => {
        if (!OATHNET_API_KEY) return { error: "OATHNET_API_KEY not configured" };
        try {
          const url = buildOathnetUrl(type, value);
          const signal = (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
          // OathNet upstream intermittently 502s; fetchRetry retries transient
          // 5xx/network with backoff so a flaky gateway doesn't hard-fail a
          // mandatory breach-fan-out call on the first blip. The per-tool timeout
          // signal aborts the in-flight request instead of leaking the paid call.
          const r = await fetchRetry(url, {
            headers: { "x-api-key": OATHNET_API_KEY },
            signal,
          }, { retries: 1, timeoutMs: 20_000 });
          const text = await r.text();
          let data: unknown;
          try {
            data = JSON.parse(text);
          } catch {
            data = { raw: text.slice(0, 4000) };
          }
          // HTTP 200 with an empty breach payload is a successful negative — not a
          // provider failure (inflated the 23% "failure" rate in beta telemetry).
          if (r.ok) return { ok: true, status: r.status, data };
          return { ok: false, status: r.status, data };
        } catch (e) {
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
          // A 404 means the handle has no profile on this platform — a legitimate
          // negative, not a tool failure. Mark it ok with found:false so it doesn't
          // inflate the failure rate (the live API + key are healthy).
          if (r.status === 404 && !err) {
            return { ok: true, status: 404, found: false, data };
          }
          const found = r.ok && !err;
          return { ok: found, status: r.status, found, ...(err ? { error_code: err.code } : {}), data };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),
    bosint_email_lookup: tool({
      description:
        "OSINTNova (Bosint) email exposure check. Surface-level breach + exposure indicators for an email address. Shared 1000 calls/day quota across Bosint endpoints, 120/min. Use for an original or independently corroborated email when the planner needs exposure context. Returns {success, data, api_metadata}.",
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
        "Check whether an email, username, or PERSON NAME appears in public breach datasets. Primary source: stolen.tax — fans out in parallel to (a) OsintCat `database-search` (returns site+password combos), (b) Snusbase (returns identity records: name/phone/address/DOB — so a full NAME is a valid query here), and (c) OsintCat plain `breach` mode. Returns combined hit count + per-source raw data. Falls back to the leakcheck public endpoint if stolen.tax is unavailable. Pass `email` for email seeds, or `value` for a username, phone, or a person's full NAME (name hits carry same-name collision risk — treat as [VERIFY] until a selector overlaps).",
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
        "LeakCheck Pro v2 breach lookup (https://leakcheck.io/api/v2). SECONDARY breach source — 200 calls/day. Returns leak sources, breach dates, and (where present) passwords/usernames for an email, username, phone, hash, or domain. Pass a phone in any format (E.164 ok — it's normalized to digits). For a person's full NAME, use oathnet_lookup type:'name' instead — LeakCheck v2 /query does not support keyword/name search and 400s on it. Use to corroborate breach_check and to surface password/source detail. Do NOT spam on low-value handles.",
      inputSchema: z.object({
        value: z.string().min(1),
        // NOTE: no 'keyword' — LeakCheck v2 /query 400s on keyword/name searches
        // (verified in prod). Names go to oathnet_lookup type:'name'.
        type: z.enum(["auto","email","username","phone","hash","domain"]).optional().default("auto"),
      }),
      execute: async ({ value, type }) => {
        const LEAKCHECK_API_KEY = Deno.env.get("LEAKCHECK_API_KEY");
        if (!LEAKCHECK_API_KEY) return { error: "LEAKCHECK_API_KEY not configured" };
        const q = value.trim();
        if (!q) return { error: "missing value" };
        try {
          const url = buildLeakcheckUrl(q, type);
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
          // Clean negative (HTTP 200, zero hits) is success — not a failure.
          if (r.ok && found === 0) {
            return { ok: true, status: r.status, source: "leakcheck.v2", found: 0, data: { success: !!d?.success, found: 0, quota, sources, raw: data } };
          }
          if (r.status === 429) {
            return { ok: false, skipped: true, status: r.status, source: "leakcheck.v2", error: "leakcheck rate-limited — provider suppressed for investigation", found, quota };
          }
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
    rapidapi_breach_search: tool({
      description:
        "PRIMARY + MANDATORY breach source — RapidAPI Email Breach Search (~8000 lookups/month, broadest corpus). MUST be the FIRST breach call on ANY email — the seed OR any email discovered mid-investigation (pivot/contact/breach-derived) — BEFORE breach_check / leakcheck_lookup / oathnet_lookup. For an email, returns the breach corpus it appears in: per-breach id/name, breach date, and the exposed field set (email, password, etc.) with per-field `sensitive` flags. Then corroborate hits with leakcheck_lookup / hibp_lookup / breach_check (independent corpora). A breach hit is an EXPOSURE association — record it as observed/needs_corroboration, never as confirmed identity on its own. Requires RAPIDAPI_KEY in Supabase secrets (host/path overridable via RAPIDAPI_BREACH_HOST/PATH); self-skips when the key is absent.",
      inputSchema: z.object({ email: z.string().email() }),
      execute: async ({ email }) => {
        const RAPIDAPI_KEY = Deno.env.get("RAPIDAPI_KEY");
        if (!RAPIDAPI_KEY) return { error: "RAPIDAPI_KEY not configured", skipped: true };
        // Host + path prefix are env-overridable so the listing can be corrected
        // without a code change. Per the DataBreach.com listing the email goes in
        // the PATH: GET /rapidapi/search-email/<email>.
        const host = (Deno.env.get("RAPIDAPI_BREACH_HOST") ?? "email-breach-search.p.rapidapi.com").trim();
        const pathPrefix = (Deno.env.get("RAPIDAPI_BREACH_PATH") ?? "/rapidapi/search-email/").trim();
        const q = email.trim();
        if (!q) return { error: "missing email" };
        try {
          const url = `https://${host}${pathPrefix}${encodeURIComponent(q)}`;
          const r = await fetchT(url, {
            headers: {
              "X-RapidAPI-Key": RAPIDAPI_KEY,
              "X-RapidAPI-Host": host,
              "Accept": "application/json",
            },
          }, 20_000);
          const text = await r.text();
          let data: unknown;
          try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 4000) }; }
          interface BreachField { field?: string; value?: string; label?: string; sensitive?: boolean; [k: string]: unknown }
          interface BreachEntry { id?: string; name?: string; title?: string; found?: BreachField[]; breach_date?: string; upload_date?: string; rows?: number; hibp_id?: string; summary?: string; [k: string]: unknown }
          const asArr = (v: unknown): BreachEntry[] => Array.isArray(v) ? v as BreachEntry[] : [];
          const entries: BreachEntry[] = Array.isArray(data)
            ? data as BreachEntry[]
            : asArr((data as { results?: unknown })?.results).length
              ? asArr((data as { results?: unknown })?.results)
              : asArr((data as { breaches?: unknown })?.breaches);
          const breaches = entries.map((e) => ({
            id: e.id ?? null,
            name: e.name ?? e.title ?? e.id ?? null,
            breach_date: e.breach_date ?? null,
            rows: typeof e.rows === "number" ? e.rows : null,
            hibp_id: e.hibp_id ?? null,
            exposed_fields: Array.isArray(e.found)
              ? Array.from(new Set(e.found.map((f) => f.label ?? f.field).filter(Boolean)))
              : [],
            has_sensitive: Array.isArray(e.found) ? e.found.some((f) => f.sensitive === true) : false,
          }));
          const names = breaches.map((b) => b.name).filter(Boolean).slice(0, 50);
          return {
            ok: r.ok,
            status: r.status,
            source: "rapidapi.breach_search",
            data: {
              email: q,
              breaches_found: breaches.length,
              breach_names: names,
              has_sensitive_exposure: breaches.some((b) => b.has_sensitive),
              breaches,
              raw: data,
            },
          };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),
    rapidapi_all_breaches: tool({
      description:
        "RapidAPI Email Breach Search — All Breaches catalog (GET /rapidapi/all-breaches). Returns the DataBreach.com breach corpus: per-breach name, id, row count, exposed field types (+ per-field counts), breach/upload dates, summary, hibp_id. REFERENCE/metadata only — it does NOT check a specific email or return PII about a subject. Use to contextualize a breach id surfaced by rapidapi_breach_search (how large the corpus is, which fields were exposed) or to answer 'is breach X in the database'. Optional `filter` narrows by name/id substring. Requires RAPIDAPI_KEY; self-skips when absent.",
      inputSchema: z.object({
        filter: z.string().optional().describe("case-insensitive substring to match against breach name or id"),
        limit: z.number().int().min(1).max(500).optional().default(100),
      }),
      execute: async ({ filter, limit }) => {
        const RAPIDAPI_KEY = Deno.env.get("RAPIDAPI_KEY");
        if (!RAPIDAPI_KEY) return { error: "RAPIDAPI_KEY not configured", skipped: true };
        const host = (Deno.env.get("RAPIDAPI_BREACH_HOST") ?? "email-breach-search.p.rapidapi.com").trim();
        const path = (Deno.env.get("RAPIDAPI_ALL_BREACHES_PATH") ?? "/rapidapi/all-breaches").trim();
        try {
          const url = `https://${host}${path}`;
          const r = await fetchT(url, {
            headers: {
              "X-RapidAPI-Key": RAPIDAPI_KEY,
              "X-RapidAPI-Host": host,
              "Accept": "application/json",
            },
          }, 20_000);
          const text = await r.text();
          let data: unknown;
          try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 4000) }; }
          interface CatalogField { field?: string; count?: number; label?: string; sensitive?: boolean; [k: string]: unknown }
          interface CatalogEntry { name?: string; id?: string; rows?: number; breach_date?: string; upload_date?: string; hibp_id?: string; fields?: CatalogField[]; field_counts?: Record<string, number>; summary?: string; [k: string]: unknown }
          const all: CatalogEntry[] = Array.isArray((data as { breaches?: unknown })?.breaches)
            ? (data as { breaches: CatalogEntry[] }).breaches
            : Array.isArray(data) ? data as CatalogEntry[] : [];
          const f = (filter ?? "").trim().toLowerCase();
          const matched = f
            ? all.filter((b) => `${b.name ?? ""} ${b.id ?? ""}`.toLowerCase().includes(f))
            : all;
          const slice = matched.slice(0, limit ?? 100).map((b) => ({
            name: b.name ?? b.id ?? null,
            id: b.id ?? null,
            rows: typeof b.rows === "number" ? b.rows : null,
            breach_date: b.breach_date ?? null,
            hibp_id: b.hibp_id ?? null,
            fields: Array.isArray(b.fields)
              ? Array.from(new Set(b.fields.map((x) => x.label ?? x.field).filter(Boolean)))
              : (b.field_counts ? Object.keys(b.field_counts) : []),
            has_sensitive: Array.isArray(b.fields) ? b.fields.some((x) => x.sensitive === true) : false,
          }));
          return {
            ok: r.ok,
            status: r.status,
            source: "rapidapi.all_breaches",
            data: {
              total_in_corpus: all.length,
              matched: matched.length,
              returned: slice.length,
              filter: f || null,
              breaches: slice,
            },
          };
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
      // opts carries the per-tool timeout AbortSignal (Phase B3): forwarding it to
      // fetchRetry makes the 8s cap actually cancel the in-flight request instead
      // of abandoning the promise while the paid call runs on to fetchRetry's cap.
      execute: async ({ email }, opts) => {
        const KEY = Deno.env.get("DEEPFIND_API_KEY");
        if (!KEY) return { error: "DEEPFIND_API_KEY not configured" };
        const signal = (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
        try {
          const r = await fetchRetry(`https://deepfind.me/api/tools/reverse-email-check?email=${encodeURIComponent(email)}`, {
            headers: { "X-DFME-API-KEY": KEY, "Accept": "application/json" },
            signal,
          });
          const data = await r.json().catch(() => ({}));
          return { ok: r.ok, status: r.status, source: "deepfind.reverse_email", data };
        } catch (e) {
          const msg = String(e);
          const aborted = e instanceof Error && (e.name === "AbortError" || /abort/i.test(msg));
          return { error: msg, ...(aborted ? { aborted: true } : {}) };
        }
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
    deepfind_email_breach: tool({
      description:
        "DeepFind.Me email breach lookup (FREE) — checks an email against known public data breaches (HIBP-style). Returns per-breach name, date, PwnCount, and exposed DataClasses (passwords, phones, etc.). Use as a free corroborating breach source, especially as a fallback when paid breach tools (stolentax/oathnet/leakcheck) are rate-limited. Breach hits are verification leads, not confirmed identity facts.",
      inputSchema: z.object({ email: z.string().email() }),
      execute: async ({ email }) => {
        const KEY = Deno.env.get("DEEPFIND_API_KEY");
        if (!KEY) return { error: "DEEPFIND_API_KEY not configured" };
        try {
          const r = await fetchT(`https://deepfind.me/api/email-validator/${encodeURIComponent(email)}`, {
            headers: { "X-DFME-API-KEY": KEY, "Accept": "application/json" },
          });
          const data = await r.json().catch(() => ({}));
          const breaches = Array.isArray(data) ? data : [];
          return {
            ok: r.ok,
            status: r.status,
            source: "deepfind.email_breach",
            data: {
              breach_count: breaches.length,
              breaches: breaches.slice(0, 50).map((b: Record<string, unknown>) => ({
                name: b?.Title ?? b?.Name,
                domain: b?.Domain,
                breach_date: b?.BreachDate,
                pwn_count: b?.PwnCount,
                data_classes: b?.DataClasses,
                is_verified: b?.IsVerified,
                is_sensitive: b?.IsSensitive,
              })),
            },
          };
        } catch (e) { return { error: String(e) }; }
      },
    }),
    deepfind_transaction_viewer: tool({
      description:
        "DeepFind.Me blockchain transaction lookup by HASH (BTC / ETH / SOL). Returns sender, receiver, value (+ USD), fees, status, block, token transfers, and an explorer URL. Complements crypto_wallet (which inspects an ADDRESS) — use this when a transaction hash is the artifact. Auto-detects network from the hash format.",
      inputSchema: z.object({ hash: z.string().min(16).describe("Transaction hash. BTC: 64 hex chars; ETH: 0x + 64 hex; SOL: base58.") }),
      execute: async ({ hash }) => {
        const KEY = Deno.env.get("DEEPFIND_API_KEY");
        if (!KEY) return { error: "DEEPFIND_API_KEY not configured" };
        try {
          const r = await fetchT(`https://deepfind.me/api/transaction-viewer/${encodeURIComponent(hash.trim())}`, {
            headers: { "X-DFME-API-KEY": KEY, "Accept": "application/json" },
          });
          const data = await r.json().catch(() => ({}));
          return { ok: r.ok, status: r.status, source: "deepfind.transaction", data };
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
    ipqualityscore_lookup: tool({
      description:
        "IPQualityScore validity + fraud scoring (https://ipqualityscore.com). One tool, three identifier types: 'phone' | 'email' | 'ip'. Returns a `valid` flag, a 0-100 `fraud_score`, and type-specific signals: " +
        "phone → active, line_type (mobile/landline/voip), carrier, name (CNAM), recent_abuse, do_not_call, leaked; " +
        "email → deliverability, disposable, recent_abuse, leaked, first/last name, domain age; " +
        "ip → proxy, vpn, tor, bot_status, recent_abuse, connection_type, ISP/org. " +
        "USE THIS EARLY as a VALIDATION GATE before spending on deep lookups: if `valid:false` or fraud_score is high (>=85) for a phone/email seed, the identifier is reserved/fake/disposable — treat any attributions to it as low-confidence and STOP burning paid breach/people-search calls on it. Free tier ~5000/mo.",
      inputSchema: z.object({
        kind: z.enum(["phone", "email", "ip"]).describe("Which IPQS endpoint to hit."),
        value: z.string().min(3).describe("Phone (E.164 preferred), email, or IP address."),
        country: z.string().length(2).optional().describe("ISO2 country hint for phone validation (e.g. 'US'). Improves carrier/line-type accuracy."),
        strictness: z.number().int().min(0).max(3).optional().describe("Phone/email only: 0-3. Higher = stricter validation (more checks, may raise false positives). Default 0."),
      }),
      execute: async ({ kind, value, country, strictness }) => {
        const KEY = Deno.env.get("IPQUALITYSCORE_API_KEY");
        if (!KEY) return { error: "IPQUALITYSCORE_API_KEY not configured", code: "ipqs_key_missing", hint: "Set IPQUALITYSCORE_API_KEY in the Supabase edge function secrets and redeploy." };
        try {
          // Host + path per IPQS docs: /api/json/{kind}/{key}/{value}. Email
          // validation accepts a `timeout` (1-60s) that raises SMTP-probe
          // accuracy; pass 12s and give fetchT a slightly longer ceiling so
          // the HTTP client doesn't abort before IPQS replies.
          const base = `https://www.ipqualityscore.com/api/json/${kind}/${encodeURIComponent(KEY)}/${encodeURIComponent(value)}`;
          const params = new URLSearchParams();
          if (kind === "phone" && country) params.set("country[]", country);
          if (kind === "email") params.set("timeout", "12");
          if (strictness !== undefined && kind !== "ip") params.set("strictness", String(strictness));
          const qs = params.toString() ? `?${params.toString()}` : "";
          const httpTimeout = kind === "email" ? 18_000 : 15_000;
          const r = await fetchT(`${base}${qs}`, { headers: { Accept: "application/json" } }, httpTimeout);
          const data = await r.json().catch(() => ({})) as Record<string, unknown>;
          if (!r.ok || data.success === false) {
            return { ok: false, status: r.status, error: (data.message as string) ?? "IPQualityScore lookup failed", kind, value };
          }
          // Compact, decision-useful projection. The orchestrator mainly needs
          // validity + fraud_score + the strongest type-specific flags.
          const pick = (keys: string[]) => Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]));
          const common = pick(["valid", "fraud_score", "recent_abuse", "leaked"]);
          const detail =
            kind === "phone" ? pick(["active", "active_status", "formatted", "local_format", "line_type", "carrier", "name", "VOIP", "prepaid", "do_not_call", "risky", "spammer", "tcpa_blacklist", "sms_pumping", "country", "region", "city", "zip_code", "timezone", "dialing_code", "accurate_country_code", "user_activity", "associated_email_addresses"])
            : kind === "email" ? pick(["deliverability", "disposable", "smtp_score", "overall_score", "catch_all", "dns_valid", "honeypot", "spam_trap_score", "suspect", "frequent_complainer", "generic", "first_name", "domain_age", "first_seen", "suggested_domain", "sanitized_email", "timed_out"])
            : pick(["proxy", "vpn", "tor", "active_vpn", "active_tor", "bot_status", "connection_type", "ISP", "organization", "ASN", "country_code", "city", "is_crawler", "abuse_velocity"]);
          return { ok: true, source: "ipqualityscore.com", kind, value, ...common, ...detail };
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
          const r = await fetchRetry(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {});
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
          const r = await fetchRetry(`https://crt.sh/?q=%25.${encodeURIComponent(domain)}&output=json`, {}, { timeoutMs: 12_000 });
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
      description: "Resolve DNS records for a hostname via Cloudflare DoH. Real types: A, AAAA, MX, NS, TXT, CNAME, SOA, CAA. Virtual types are auto-translated to TXT queries: SPF (TXT @ host, filtered v=spf1), DMARC (TXT @ _dmarc.host, v=DMARC1), DKIM (TXT @ <dkimSelector>._domainkey.host — requires dkimSelector), BIMI (TXT @ default._bimi.host, v=BIMI1). SPF/DKIM/DMARC/BIMI are NOT real record types — never query them as-is; pass them here and they resolve correctly.",
      inputSchema: z.object({ host: z.string(), types: z.array(z.enum(DNS_TYPES)).default(["A","MX","NS","TXT"]), dkimSelector: z.string().optional() }),
      execute: async ({ host, types, dkimSelector }) => {
        try {
          const out: Record<string, unknown> = {};
          const errs: Record<string, string> = {};
          const statuses: number[] = [];
          await Promise.all(types.map(async (t) => {
            try {
              // Virtual types (SPF/DMARC/DKIM/BIMI) resolve to a TXT query at a
              // (possibly mutated) host, then filter answers by a content prefix.
              let queryHost = host;
              let queryType: string = t;
              let txtPrefix: string | null = null;
              if (isVirtualType(t)) {
                queryHost = resolveVirtualHost(t, host, dkimSelector); // throws for DKIM w/o selector
                queryType = "TXT";
                txtPrefix = VIRTUAL_TYPE_MAP[t].txtPrefix;
              }
              const r = await fetchT(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(queryHost)}&type=${queryType}`, { headers: { Accept: "application/dns-json" } }, 8_000);
              const j = await r.json().catch(() => ({})) as { Status?: number; Answer?: Array<{ data: string }> };
              if (typeof j.Status === "number") statuses.push(j.Status);
              const answers = j.Answer?.map((a) => a.data) ?? [];
              out[t] = txtPrefix !== null ? filterTxtByPrefix(answers, txtPrefix) : answers;
              // Distinguish a genuine empty result (NOERROR/NXDOMAIN) from a lookup
              // failure (HTTP error or SERVFAIL) so [] can't read as "no records".
              const dErr = dohTypeError(r.ok, r.status, j.Status);
              if (dErr) errs[t] = dErr;
            } catch (e) {
              // One record-type's network failure/timeout must not collapse the
              // whole DNS lookup (Promise.all would reject and lose the rest).
              // resolveVirtualHost throwing (DKIM without selector) is captured here too.
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
            fetchRetry(`https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&limit=10&from=20000101`, {}, { timeoutMs: 12_000 }).then((r) => r.ok ? r.json() : { error: `cdx ${r.status}` }).catch((e) => ({ error: String(e) })),
          ]);
          // archive.org is reliably flaky; a 5xx/timeout must not read as "no snapshots".
          const cdxOk = Array.isArray(cdx);
          return { ok: cdxOk, closest, recent: cdxOk ? cdx : [], ...(cdxOk ? {} : { error: (cdx as { error?: unknown })?.error ?? "wayback cdx failed" }) };
        } catch (e) { return { error: String(e) }; }
      },
    }),
    // ── Phase 1 free / no-required-key OSINT tools ──────────────────────────
    // Fetch-only corroboration sources. Each returns { error } on any failure
    // (never throws) and trims its payload before returning.
    ransomwarelive_lookup: tool({
      description:
        "Ransomware.live victim-exposure check — is a DOMAIN listed as a ransomware/extortion victim on a leak site? Input: { domain: string } (a registrable domain like 'acme.com', NOT a URL or email). Returns up to 25 victim entries (group, date, description). Uses api-pro.ransomware.live when RANSOMWARELIVE_API_KEY is set; without a key the tool returns { ok:false, degraded:true } because the free api.ransomware.live API has been retired. A real empty result means NOT listed → { ok:true, listed:false, victims:[] }.",
      inputSchema: z.object({ domain: z.string().min(1).describe("registrable domain, e.g. acme.com") }),
      execute: async ({ domain }) => {
        try {
          const d = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
          if (!RANSOMWARELIVE_API_KEY) {
            return { ok: false, degraded: true, domain: d, error: "ransomware.live free API retired; set RANSOMWARELIVE_API_KEY (api-pro.ransomware.live) to enable" };
          }
          const r = await fetchRetry(
            `https://api-pro.ransomware.live/victims/search?q=${encodeURIComponent(d)}`,
            { headers: { "X-API-KEY": RANSOMWARELIVE_API_KEY, "Accept": "application/json" } },
            { timeoutMs: 12_000 },
          );
          if (r.status === 404) { await r.body?.cancel().catch(() => {}); return { ok: true, domain: d, listed: false, count: 0, victims: [] }; }
          if (!r.ok) return { ok: false, status: r.status, error: `ransomware.live ${r.status}`, domain: d };
          const ct = r.headers.get("content-type") ?? "";
          if (!ct.includes("json")) { await r.body?.cancel().catch(() => {}); return { ok: false, degraded: true, domain: d, error: `non-JSON response (${ct || "unknown"})` }; }
          const data = await r.json().catch(() => null);
          const rows = Array.isArray(data)
            ? data
            : (Array.isArray((data as { victims?: unknown[] } | null)?.victims) ? (data as { victims: unknown[] }).victims : []);
          const victims = rows.slice(0, 25).map((v) => {
            const x = (v ?? {}) as Record<string, unknown>;
            const desc = x.description;
            return {
              victim: (x.victim ?? x.post_title ?? null) as string | null,
              group: (x.group_name ?? x.group ?? null) as string | null,
              date: (x.discovered ?? x.published ?? x.attackdate ?? null) as string | null,
              description: typeof desc === "string" ? desc.slice(0, 300) : null,
            };
          });
          return { ok: true, domain: d, listed: victims.length > 0, count: victims.length, victims };
        } catch (e) { return { error: String(e instanceof Error ? e.message : e) }; }
      },
    }),
    urlscanner_scan: tool({
      description:
        "URLScanner.online PRIVATE URL/domain/IP security scanner (sync endpoint). One call returns score (0-100), verdict (clean|low|medium|high|critical), DNS records, SSL cert chain, HTTP security-header analysis, WHOIS (incl. domainAge / registrar / expiry), threat-blocklist hits (URLhaus, Spamhaus, SURBL), and an AI risk summary (knownDomain, domainReputation, riskLevel, briefSummary, recommendations). Input: { url: string } (URL, domain, or IP). Requires URLSCANNER_API_KEY (free 10/day, solo 100/day). Scans are PRIVATE (never published). Typical latency 15-20s; modules that time out return null for that field — the response is always returned. Reserve for high-value suspicious artifacts.",
      inputSchema: z.object({
        url: z.string().min(1).describe("URL, registrable domain, or IP to scan"),
        rescan: z.boolean().optional().describe("Force a fresh scan, bypassing the 7-day cache"),
      }),
      execute: async ({ url, rescan }) => {
        if (!URLSCANNER_API_KEY) return { error: "URLSCANNER_API_KEY not configured", degraded: true };
        try {
          const r = await fetchRetry(
            "https://urlscanner.online/api/scan/sync",
            {
              method: "POST",
              headers: {
                "X-API-Key": URLSCANNER_API_KEY,
                "Content-Type": "application/json",
                "Accept": "application/json",
              },
              body: JSON.stringify(rescan ? { url, rescan: true } : { url }),
            },
            { timeoutMs: 45_000 },
          );
          if (!r.ok) {
            const body = await r.text().catch(() => "");
            return { ok: false, status: r.status, error: `urlscanner ${r.status}: ${body.slice(0, 300)}`, url };
          }
          const data = await r.json().catch(() => null) as Record<string, unknown> | null;
          if (!data) return { ok: false, error: "urlscanner returned non-JSON body", url };
          // Trim: drop heavy fields (screenshots are skipped server-side; raw
          // header arrays + AI full text can still be large). Keep what the
          // orchestrator can reason over without blowing the context window.
          const ai = (data.aiAnalysis ?? null) as Record<string, unknown> | null;
          const threats = (data.threats ?? null) as Record<string, unknown> | null;
          const dns = (data.dns ?? null) as Record<string, unknown> | null;
          const ssl = (data.ssl ?? null) as Record<string, unknown> | null;
          const http = (data.http ?? null) as Record<string, unknown> | null;
          const whois = (data.whois ?? null) as Record<string, unknown> | null;
          const trimSummary = (s: unknown) => typeof s === "string" ? s.slice(0, 600) : s ?? null;
          return {
            ok: true,
            url: (data.url ?? url) as string,
            hostname: data.hostname ?? null,
            cached: data.cached ?? false,
            score: data.score ?? null,
            verdict: data.verdict ?? null,
            scannedAt: data.scannedAt ?? null,
            scanDurationMs: data.scanDurationMs ?? null,
            remaining: data.remaining ?? null,
            dns: dns ? {
              resolvedIp: dns.resolvedIp ?? null,
              recordCount: Array.isArray(dns.records) ? (dns.records as unknown[]).length : null,
              records: Array.isArray(dns.records) ? (dns.records as unknown[]).slice(0, 25) : null,
            } : null,
            ssl: ssl ? {
              valid: ssl.valid ?? null,
              issuer: ssl.issuer ?? null,
              daysUntilExpiry: ssl.daysUntilExpiry ?? null,
              protocol: ssl.protocol ?? null,
              cipher: ssl.cipher ?? null,
            } : null,
            http: http ? {
              statusCode: http.statusCode ?? null,
              securityHeaders: Array.isArray(http.securityHeaders) ? (http.securityHeaders as unknown[]).slice(0, 30) : null,
            } : null,
            whois: whois ? {
              registrar: whois.registrar ?? null,
              domainAge: whois.domainAge ?? null,
              createdDate: whois.createdDate ?? null,
              expiryDate: whois.expiryDate ?? null,
            } : null,
            threats: threats ? {
              urlhaus: threats.urlhaus ?? null,
              dnsBlocklists: threats.dnsBlocklists ?? null,
            } : null,
            aiAnalysis: ai ? {
              knownDomain: ai.knownDomain ?? null,
              domainReputation: ai.domainReputation ?? null,
              domainCategory: ai.domainCategory ?? null,
              score: ai.score ?? null,
              riskLevel: ai.riskLevel ?? null,
              summary: trimSummary(ai.summary),
              briefSummary: trimSummary(ai.briefSummary),
              recommendations: Array.isArray(ai.recommendations) ? (ai.recommendations as unknown[]).slice(0, 10) : null,
            } : null,
          };
        } catch (e) { return { error: String(e instanceof Error ? e.message : e), url }; }
      },
    }),
    wayback_cdx_search: tool({
      description:
        "Wayback Machine CDX archive search — corroborate that a domain/URL existed and when. Input: { url: string } (a domain like 'acme.com' or a full URL). Returns ACCURATE earliest + latest capture timestamps (each queried separately so they are NOT understated by a capped page) and up to 25 sample capture rows (timestamp, original, statuscode). `sampled_count` is the number of SAMPLE rows returned (capped at 25) — it is NOT the total capture count; `capped:true` means more captures exist than were sampled. Empty archive → { ok:true, archived:false, captures:[] }. No API key.",
      inputSchema: z.object({ url: z.string().min(1).describe("domain or URL to look up in the archive") }),
      execute: async ({ url }, opts) => {
        // archive.org's CDX endpoint is chronically slow (p95 ~60s). The cache
        // wrapper's per-tool cap for wayback_cdx_search is raised to 25s
        // (TOOL_TIMEOUT_OVERRIDE_MS) so a legit-slow archive still resolves, and
        // the wrapper's AbortSignal is forwarded into every fetch so a hit on the
        // cap CANCELS the request cleanly instead of orphaning it (the prior null/
        // timeout bug: the 12s default cap fired while an un-signalled 15s fetch
        // kept running). retries:1 keeps worst-case wall-clock under the cap.
        const signal = (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
        try {
          const base = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json`;
          // Accurate bookends, NOT derived from the capped sample page: CDX
          // default order is chronological, so &limit=1 is the oldest capture and
          // &limit=-1 is the newest. Each is failure-tolerant (null on any error).
          const firstTs = async (limit: string): Promise<string | null> => {
            try {
              const r = await fetchRetry(`${base}&fl=timestamp&limit=${limit}`, { signal }, { timeoutMs: 12_000, retries: 1 });
              if (!r.ok) { await r.body?.cancel().catch(() => {}); return null; }
              const data = await r.json().catch(() => null);
              if (!Array.isArray(data) || data.length < 2) return null;
              const hdr = data[0] as string[];
              const idx = hdr.indexOf("timestamp");
              const row = data[1] as string[];
              return ((idx >= 0 ? row[idx] : row[0]) ?? null) as string | null;
            } catch { return null; }
          };
          // Small sample page for context (collapsed to unique urlkeys).
          const r = await fetchRetry(`${base}&limit=25&collapse=urlkey`, { signal }, { timeoutMs: 12_000, retries: 1 });
          if (!r.ok) return { ok: false, status: r.status, error: `wayback cdx ${r.status}`, url };
          const data = await r.json().catch(() => null);
          // CDX json: row[0] is the header (["urlkey","timestamp","original","statuscode",...]).
          if (!Array.isArray(data) || data.length < 2) {
            return { ok: true, url, archived: false, sampled_count: 0, capped: false, earliest: null, latest: null, captures: [] };
          }
          const header = data[0] as string[];
          const ti = header.indexOf("timestamp"), oi = header.indexOf("original"), si = header.indexOf("statuscode");
          const rows = (data.slice(1) as string[][]).map((row) => ({
            timestamp: ti >= 0 ? row[ti] ?? null : null,
            original: oi >= 0 ? row[oi] ?? null : null,
            statuscode: si >= 0 ? row[si] ?? null : null,
          }));
          const [earliest, latest] = await Promise.all([firstTs("1"), firstTs("-1")]);
          // Fall back to the sample's own min/max only if a bookend query failed.
          const sampleTs = rows.map((x) => x.timestamp).filter((t): t is string => !!t).sort();
          return {
            ok: true, url, archived: true,
            earliest: earliest ?? sampleTs[0] ?? null,
            latest: latest ?? sampleTs[sampleTs.length - 1] ?? null,
            sampled_count: rows.length,
            capped: rows.length >= 25,
            captures: rows.slice(0, 25),
          };
        } catch (e) {
          // Explicit timeout surface: an AbortError here is the tool cap / archive.org
          // being too slow, NOT a code error. Log it and return a clear reason so the
          // timeline shows "timed out" instead of a bare stack string.
          const isAbort = e instanceof DOMException && e.name === "AbortError";
          if (isAbort) {
            console.warn(`[wayback_cdx_search] timed out for ${url} (archive.org slow / tool cap)`);
            return { ok: false, error: "wayback_cdx_search timed out (archive.org slow)", _timeout: true, url };
          }
          return { error: String(e instanceof Error ? e.message : e) };
        }
      },
    }),
    crtsh_lookup: tool({
      description:
        "crt.sh certificate-transparency lookup — issued certs for a DOMAIN. Input: { domain: string }. Returns UNIQUE subdomains (parsed from name_value) and unique issuer names, each capped at 50, plus the total cert count. crt.sh is slow and can return a non-JSON error/overload page → that returns { error }. No API key. (crtsh_subdomains returns only the subdomain list; this also surfaces issuers + cert count.)",
      inputSchema: z.object({ domain: z.string().min(1).describe("registrable domain, e.g. acme.com") }),
      execute: async ({ domain }) => {
        try {
          const d = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
          const r = await fetchRetry(`https://crt.sh/?q=${encodeURIComponent(d)}&output=json`, {}, { timeoutMs: 15_000 });
          const data = (await r.json().catch(() => null)) as Array<{ name_value?: string; issuer_name?: string }> | null;
          if (!isCrtshOk(r.ok, data)) {
            return { ok: false, status: r.status, error: r.ok ? "crt.sh returned non-JSON (likely an error/overload page)" : `crt.sh ${r.status}`, domain: d };
          }
          const arr = data as Array<{ name_value?: string; issuer_name?: string }>;
          const subdomains = Array.from(new Set(arr.flatMap((c) => (c.name_value ?? "").split("\n")).map((s) => s.trim().toLowerCase()).filter(Boolean))).slice(0, 50);
          const issuers = Array.from(new Set(arr.map((c) => (c.issuer_name ?? "").trim()).filter(Boolean))).slice(0, 50);
          return { ok: true, domain: d, cert_count: arr.length, subdomain_count: subdomains.length, subdomains, issuers };
        } catch (e) { return { error: String(e instanceof Error ? e.message : e) }; }
      },
    }),
    census_geocode: tool({
      description:
        "US Census one-line address geocoder — does a US street ADDRESS exist, and where? Input: { address: string } (a one-line US street address). Returns the standardized matched address + coordinates (lon/lat) and matched:boolean. US addresses only. No API key.",
      inputSchema: z.object({ address: z.string().min(1).describe("one-line US street address") }),
      execute: async ({ address }) => {
        try {
          const r = await fetchT(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`, {}, 15_000);
          if (!r.ok) return { ok: false, status: r.status, error: `census ${r.status}`, address };
          const data = (await r.json().catch(() => null)) as { result?: { addressMatches?: Array<Record<string, unknown>> } } | null;
          const matches = data?.result?.addressMatches;
          if (!Array.isArray(matches) || matches.length === 0) return { ok: true, address, matched: false, count: 0, matches: [] };
          const out = matches.slice(0, 5).map((m) => {
            const coords = (m.coordinates ?? {}) as { x?: number; y?: number };
            return { matchedAddress: (m.matchedAddress ?? null) as string | null, lon: coords.x ?? null, lat: coords.y ?? null };
          });
          return { ok: true, address, matched: true, count: out.length, matches: out };
        } catch (e) { return { error: String(e instanceof Error ? e.message : e) }; }
      },
    }),
    nominatim_geocode: tool({
      description:
        "OpenStreetMap Nominatim geocoder — resolve any worldwide ADDRESS or place to coordinates. Input: { address: string }. Returns the top match: display_name, lat/lon, category/type, and a residential-vs-commercial hint when derivable. Rate-limited to 1 req/sec by OSM policy (sends a descriptive User-Agent). No API key.",
      inputSchema: z.object({ address: z.string().min(1).describe("free-form address or place name") }),
      execute: async ({ address }) => {
        try {
          const r = await fetchT(
            `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=jsonv2&addressdetails=1&limit=3`,
            { headers: { "User-Agent": "insight-finder-osint/1.0 (justindean785@gmail.com)" } },
            15_000,
          );
          if (!r.ok) return { ok: false, status: r.status, error: `nominatim ${r.status}`, address };
          const data = (await r.json().catch(() => null)) as Array<Record<string, unknown>> | null;
          if (!Array.isArray(data) || data.length === 0) return { ok: true, address, matched: false };
          const top = data[0];
          const cat = String(top.category ?? top.class ?? "").toLowerCase();
          const typ = String(top.type ?? top.addresstype ?? "").toLowerCase();
          const blob = `${cat} ${typ}`;
          const residential = /residential|house|apartment|dwelling|detached|terrace/.test(blob);
          const commercial = /commercial|office|retail|\bshop\b|industrial|company|business/.test(blob);
          const place_type = residential ? "residential" : (commercial ? "commercial" : null);
          return {
            ok: true, address, matched: true,
            display_name: (top.display_name ?? null) as string | null,
            lat: (top.lat ?? null) as string | null,
            lon: (top.lon ?? null) as string | null,
            category: (top.category ?? top.class ?? null) as string | null,
            type: (top.type ?? null) as string | null,
            place_type,
          };
        } catch (e) { return { error: String(e instanceof Error ? e.message : e) }; }
      },
    }),
    hibp_pwned_passwords_kanon: tool({
      description:
        "Have I Been Pwned k-anonymity password-exposure check (NO API key). Input: { password: string } OR { sha1: string } (a 40-hex SHA-1 of the password). PRIVACY GUARANTEE: only the first 5 chars of the SHA-1 hash ever leave this function — the password and the full hash are NEVER sent. Returns { ok, pwned:boolean, count:number } = how many breach corpora contain that password.",
      inputSchema: z.object({
        password: z.string().min(1).optional().describe("plaintext password (hashed locally with SHA-1; never transmitted)"),
        sha1: z.string().regex(/^[0-9a-fA-F]{40}$/).optional().describe("precomputed 40-hex SHA-1 of the password"),
      }),
      execute: async ({ password, sha1 }) => {
        try {
          let hashHex: string;
          if (sha1) {
            hashHex = sha1.toUpperCase();
          } else if (password) {
            const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(password));
            hashHex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
          } else {
            return { error: "provide either password or sha1" };
          }
          const prefix = hashHex.slice(0, 5);
          const suffix = hashHex.slice(5);
          // k-anonymity: ONLY the 5-char prefix is sent. Add-Padding hides the
          // real result-set size from the network.
          const r = await fetchRetry(`https://api.pwnedpasswords.com/range/${prefix}`, { headers: { "Add-Padding": "true" } }, { timeoutMs: 12_000 });
          if (!r.ok) return { ok: false, status: r.status, error: `pwnedpasswords ${r.status}` };
          const text = await r.text();
          let count = 0;
          for (const line of text.split("\n")) {
            const [suf, cnt] = line.trim().split(":");
            if (suf && suf.toUpperCase() === suffix) { count = parseInt(cnt, 10) || 0; break; }
          }
          return { ok: true, pwned: count > 0, count };
        } catch (e) { return { error: String(e instanceof Error ? e.message : e) }; }
      },
    }),
    gleif_lei_search: tool({
      description:
        "GLEIF Legal Entity Identifier registry search by NAME (NO API key). Input: { name: string } (org/company legal name). Returns up to 10 entities: lei, legalName, status, jurisdiction, legalAddress {city, country}, registrationStatus. COVERAGE CAVEAT: only entities that hold an LEI (financial-market participants — public companies, funds, many regulated/private orgs); small private companies may be ABSENT, so an EMPTY result does NOT mean the company doesn't exist. Falls back to fuzzy name suggestions when the exact filter returns nothing.",
      inputSchema: z.object({ name: z.string().min(1).describe("org / company legal name") }),
      execute: async ({ name }) => {
        try {
          const q = encodeURIComponent(name.trim());
          const accept = { headers: { Accept: "application/vnd.api+json" } };
          // The filter param keys contain `[`/`]` which MUST be percent-encoded.
          const r = await fetchRetry(
            `https://api.gleif.org/api/v1/lei-records?filter%5Bentity.legalName%5D=${q}&page%5Bsize%5D=10`,
            accept,
            { timeoutMs: 12_000 },
          );
          if (!r.ok) return { ok: false, status: r.status, error: `gleif ${r.status}`, name };
          const data = (await r.json().catch(() => null)) as { data?: Array<Record<string, unknown>> } | null;
          const rows = Array.isArray(data?.data) ? data!.data : [];
          const records = rows.slice(0, 10).map((rec) => {
            const a = (rec.attributes ?? {}) as Record<string, unknown>;
            const entity = (a.entity ?? {}) as Record<string, unknown>;
            const legalName = (entity.legalName ?? {}) as { name?: string };
            const legalAddr = (entity.legalAddress ?? {}) as { city?: string; country?: string };
            const reg = (a.registration ?? {}) as { status?: string };
            return {
              lei: (a.lei ?? rec.id ?? null) as string | null,
              legalName: (legalName.name ?? null) as string | null,
              status: (entity.status ?? null) as string | null,
              jurisdiction: (entity.jurisdiction ?? null) as string | null,
              legalAddress: { city: legalAddr.city ?? null, country: legalAddr.country ?? null },
              registrationStatus: (reg.status ?? null) as string | null,
            };
          });
          if (records.length > 0) return { ok: true, name, count: records.length, records };
          // Fuzzy fallback — surfaces near-name suggestions (value + LEI) so the
          // agent can refine, without claiming the entity does/doesn't exist.
          const fr = await fetchRetry(
            `https://api.gleif.org/api/v1/fuzzycompletions?field=entity.legalName&q=${q}`,
            accept,
            { timeoutMs: 12_000 },
          );
          if (fr.ok) {
            const fdata = (await fr.json().catch(() => null)) as { data?: Array<Record<string, unknown>> } | null;
            const suggestions = (Array.isArray(fdata?.data) ? fdata!.data : []).slice(0, 10).map((s) => {
              const attrs = (s.attributes ?? {}) as { value?: string };
              const rel = (s.relationships ?? {}) as { "lei-records"?: { data?: { id?: string } } };
              return { legalName: (attrs.value ?? null) as string | null, lei: (rel["lei-records"]?.data?.id ?? null) as string | null };
            }).filter((x) => x.legalName);
            if (suggestions.length > 0) {
              return { ok: true, name, count: 0, fuzzy: true, suggestions, note: "no exact legalName match — fuzzy name suggestions returned (entity may still exist without an LEI)" };
            }
          } else { await fr.body?.cancel().catch(() => {}); }
          return { ok: true, name, count: 0, records: [], note: "no LEI record matched — the entity may simply not hold an LEI (small private cos often don't)" };
        } catch (e) { return { error: String(e instanceof Error ? e.message : e) }; }
      },
    }),
    opencorporates_search: tool({
      description:
        "OpenCorporates company-registry search — find official company registrations by NAME. Input: { name: string } (company name). Returns up to 20 companies: name, jurisdiction_code, company_number, incorporation_date, current_status. REQUIRES OPENCORPORATES_API_KEY — the v0.4 endpoint now returns 401 'Invalid Api Token' for all keyless requests, so the tool self-skips when the key is unset. For keyless company-registry corroboration, use gleif_lei_search instead.",
      inputSchema: z.object({ name: z.string().min(1).describe("company / organization name") }),
      execute: async ({ name }) => {
        // OpenCorporates retired keyless access — every anonymous request now
        // 401s ("Invalid Api Token"). Self-skip BEFORE the doomed fetch, matching
        // the codebase's "tool self-skips when its key is missing" convention.
        if (!OPENCORPORATES_API_KEY) return { error: "OPENCORPORATES_API_KEY not configured", skipped: true };
        try {
          const url = `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(name)}&api_token=${encodeURIComponent(OPENCORPORATES_API_KEY)}`;
          const r = await fetchRetry(url, {}, { timeoutMs: 15_000 });
          if (!r.ok) {
            const gated = r.status === 401 || r.status === 403 || r.status === 429;
            return { ok: false, status: r.status, error: `opencorporates ${r.status}${gated ? " (rate-limited / invalid token)" : ""}`, name };
          }
          const data = (await r.json().catch(() => null)) as { results?: { companies?: Array<{ company?: Record<string, unknown> }> } } | null;
          const companies = data?.results?.companies;
          if (!Array.isArray(companies)) return { ok: true, name, count: 0, companies: [] };
          const out = companies.slice(0, 20).map((c) => {
            const co = (c.company ?? {}) as Record<string, unknown>;
            return {
              name: (co.name ?? null) as string | null,
              jurisdiction_code: (co.jurisdiction_code ?? null) as string | null,
              company_number: (co.company_number ?? null) as string | null,
              incorporation_date: (co.incorporation_date ?? null) as string | null,
              current_status: (co.current_status ?? null) as string | null,
            };
          });
          return { ok: true, name, count: out.length, companies: out };
        } catch (e) { return { error: String(e instanceof Error ? e.message : e) }; }
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
        "Generate copy-paste Google/Bing/DuckDuckGo/Yandex dork queries for a seed identifier. NO external API cost. Use once for the original seed or a corroborated high-value selector when the resulting query set supports a defined verification goal.",
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
            { category: "Legal/Court Records", query: `"${seed}" (site:unicourt.com OR site:trellis.law OR site:judyrecords.com OR site:plainsite.org OR site:courtlistener.com)`, url: `https://www.google.com/search?q=%22${e}%22+site:unicourt.com+OR+site:trellis.law+OR+site:judyrecords.com` },
            { category: "Legal/Court Records", query: `"${seed}" ("docket" OR "case no" OR "v." OR "plaintiff" OR "defendant" OR "indictment" OR "complaint") (filetype:pdf OR site:gov)`, url: `https://www.google.com/search?q=%22${e}%22+%22docket%22+OR+%22case+no%22+filetype:pdf` },
            { category: "Legal/Court Records", query: `"${seed}" ("arrested" OR "convicted" OR "sentenced" OR "pleaded guilty" OR "charged with" OR "booking" OR "felony" OR "misdemeanor")`, url: `https://www.google.com/search?q=%22${e}%22+%22arrested%22+OR+%22convicted%22+OR+%22sentenced%22` },
            { category: "Legal/Court Records", query: `"${seed}" (site:mugshots.com OR site:bustednewspaper.com OR site:arrests.org OR site:jailbase.com OR site:nsopw.gov)`, url: `https://www.google.com/search?q=%22${e}%22+site:bustednewspaper.com+OR+site:arrests.org+OR+site:jailbase.com` },
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
        "Execute the highest-yield document/leak dorks for a seed and AUTO-RECORD any PDFs, Office docs, CSV/SQL/log/env dumps, pastebin entries, and stealer-log URLs as artifacts (kind='document' for files, kind='leak_paste' for pastes). This is the way to turn google_dorks output into real evidence. Runs N targeted queries through Perplexity Sonar web search (with an Exa keyword fallback that honors site: domains), parses URLs from results, classifies them by extension/host, and inserts them directly into the case. Costs 1 Perplexity call per query.",
      inputSchema: z.object({
        seed: z.string(),
        kind: z.enum(["email", "username", "phone", "name", "person", "domain", "ip", "hash", "crypto_wallet"]),
        max_queries: z.number().int().min(1).max(12).default(5),
      }),
      execute: async ({ seed, kind: rawKind, max_queries }) => {
        const kind = rawKind === "person" ? "name" : rawKind;
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
            `"${seed}" ("deed" OR "property record" OR "assessor") (filetype:pdf OR filetype:html)`,
            `"${seed}" ("docket" OR "case no" OR "v." OR "indictment" OR "complaint" OR "judgment" OR "arrested" OR "convicted" OR "sentenced") (filetype:pdf OR site:courtlistener.com OR site:unicourt.com OR site:justia.com OR site:gov)`,
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

        // #8: append negative keywords (-"sample" -"template" -"example" …) so
        // resume/CV templates, sample directories, and example docs stop matching
        // `"<seed>" filetype:pdf` — the #1 source of the 78-100% dork false-positive
        // rate. (Per-URL content-relevance scoring via scoreDorkRelevance is the
        // remaining lever; it needs a fetch per hit + subject name/city plumbing.)
        const queries = (QUERIES[kind] ?? []).slice(0, max_queries).map(augmentDorkQuery);
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
          provider?: "perplexity_search" | "exa_search";
          status?: number;
          answer?: string;
          error?: string;
        }> = [];

        const extractUrls = (text: string): string[] =>
          Array.from(new Set((text.match(URL_RE) ?? []).map((u) => u.replace(/[).,;:]+$/, ""))));

        const exaSearchUrls = async (dork: string): Promise<{ ok: boolean; status: number; urls: string[]; note?: string }> => {
          if (!EXA_API_KEY) return { ok: false, status: 0, urls: [], note: "EXA_API_KEY not configured" };
          // Exa keyword search ignores dork operators, so translate first:
          // strip filetype:/ext:/intitle:/inurl:/quotes/OR-groups down to core
          // terms and lift site: domains into the structured includeDomains
          // filter Exa actually honors.
          const { query: exaQuery, includeDomains } = dorkToExaQuery(dork);
          const finalQuery = exaQuery || seed;
          try {
            const exaBody: Record<string, unknown> = { query: finalQuery, type: "keyword", numResults: 10, contents: false };
            if (includeDomains.length) exaBody.includeDomains = includeDomains;
            const r = await fetchRetry("https://api.exa.ai/search", {
              method: "POST",
              headers: {
                "x-api-key": EXA_API_KEY,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(exaBody),
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
            // Route every dork through the working search path (Perplexity
            // Sonar). MiniMax's chat API 400s on the web_search tool shape, so
            // minimaxChat({webSearch:true}) is NOT usable here.
            const r = await perplexitySearch({
              query: q,
              system:
                "You are an OSINT dork-harvester. Run the user's query and return ONLY a bullet list of every result URL you find (one URL per line, no commentary). Do not summarize. Do not editorialize. If nothing is found, reply with exactly: NONE.",
              maxTokens: 1200,
            });

            let provider: "perplexity_search" | "exa_search" = "perplexity_search";
            let status = r.status;
            // Perplexity returns grounded source URLs as `citations`; also parse
            // any URLs it listed in the answer body.
            let text = r.ok ? [r.answer, ...r.citations].join("\n") : "";
            let urls = r.ok ? Array.from(new Set([...r.citations, ...extractUrls(r.answer)])) : [];
            let providerError: string | undefined;

            // Perplexity may fail (auth/rate/5xx) or return nothing usable.
            // Fall back to Exa (with dork→keyword translation) so Google
            // Dorking remains available instead of surfacing as offline.
            if (!r.ok || urls.length === 0) {
              const exa = await exaSearchUrls(q);
              if (exa.ok && exa.urls.length > 0) {
                provider = "exa_search";
                status = exa.status;
                urls = exa.urls;
                text = `EXA_FALLBACK:${exa.urls.slice(0, 20).join("\n")}`;
              } else {
                providerError = !r.ok
                  ? (r.error ?? `perplexity_search HTTP ${r.status}`)
                  : (exa.note ? `fallback exa failed: ${exa.note}` : "no URLs returned by perplexity or exa");
              }
            }

            let hits = 0;
            for (const u of urls) {
              if (seen.has(u)) continue;
              let classify: "document" | "leak_paste" | null = null;
              if (PASTE_HOST_RE.test(u)) classify = "leak_paste";
              else if (DOC_EXT_RE.test(u)) classify = "document";
              if (!classify) continue;
              // Drop template/sample/example documents that slip past the
              // query-level negatives (Perplexity/Exa ignore `-"sample"`): a
              // `resume-sample.pdf` hit is never real evidence about the subject.
              // Pastes are exempt — the token gate is a document-path heuristic.
              if (classify === "document" && isTemplateOrSampleUrl(u)) { seen.add(u); continue; }
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
            const p = q.provider ?? "perplexity_search";
            if (p === "exa_search") acc.exa++;
            else acc.perplexity++;
            if (q.ok) acc.success++;
            else acc.failed++;
            return acc;
          },
          { perplexity: 0, exa: 0, success: 0, failed: 0 },
        );
        if (collected.length > 0) {
          const rows = collected.map((c) => {
            const built = buildAutoRecordedRow({
              kind: c.classify,
              value: c.url,
              source: "dork_harvest",
              rawConfidence: c.classify === "leak_paste" ? 55 : 60,
              metadata: {
                seed,
                seed_kind: kind,
                dork_query: c.via,
                discovered_via: "google_dork → perplexity sonar (exa keyword fallback)",
              },
            });
            return {
              thread_id: threadId,
              user_id: userId,
              ...built,
            };
          });
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
        "FALLBACK deep-dork via Gemini 2.5 Flash with native Google Search grounding. Use AFTER google_dorks + dork_harvest — ~46% success rate in production telemetry; do not lead with this. Gemini reasons about the seed, formulates targeted Google dork queries internally, executes them against real Google, and returns a synthesized writeup PLUS source URLs as grounding citations. Use when dork_harvest misses something or you need LLM-driven dork generation (tricky disambiguation, niche forum surfacing). AUTO-RECORDS every cited URL as an artifact (kind='url' or classified by extension as 'document'/'leak_paste'). Template/sample document URLs are dropped. 1 Gemini call ≈ $0.002.",
      inputSchema: z.object({
        seed: z.string(),
        kind: z.enum(["email","username","phone","name","person","domain","ip","hash","crypto_wallet","url","other"]),
        focus: z.string().optional().describe("Optional angle, e.g. 'breach exposure', 'resume/CV leaks', 'social handles', 'pastebin dumps', 'forum posts', 'court records'."),
      }),
      execute: async ({ seed, kind, focus }, opts) => {
        if (!GEMINI_API_KEY) return { ok: false, error: "GEMINI_API_KEY not configured" };
        const system =
          "You are an elite OSINT dork operator. For the given seed, design 5-8 high-yield Google dork queries (use site:, filetype:, intitle:, inurl:, exact-phrase quoting, boolean OR groups). EXECUTE them with the google_search tool. Then write a concise bulletized intelligence summary citing ONLY what your searches actually found. Be specific: name the platforms/leak sites/forums/document types you surfaced and quote any usernames, emails, phone fragments, or filenames discovered. If nothing material is found, say so plainly. Do not fabricate.";
        const user =
          `Seed (${kind}): ${seed}\n` +
          (focus ? `Focus: ${focus}\n` : "") +
          `Goal: deep-dork this seed across Google. Surface breach/leak exposure, document/file leaks (PDFs, CVs, dumps), pastebin/rentry/ghostbin pastes, forum mentions, social/profile traces, and any public-records or news hits. Prefer recent + high-signal results.`;
        const signal = (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
        const res = await geminiGroundedSearch({ prompt: user, system, signal });
        if (!res.ok) {
          markToolDegraded("gemini_deep_dork", `gemini_grounded_search HTTP ${res.status}`);
          return {
            ok: false,
            skipped: true,
            status: res.status,
            error: "gemini_grounded_search_failed",
            detail: String((res.raw as { error?: { message?: unknown } })?.error?.message ?? "").slice(0, 400),
            note: "Fallback dork only — prefer dork_harvest. Skipped for rest of this investigation after failure.",
          };
        }

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
            if (k === "document" && isTemplateOrSampleUrl(c.uri)) return null;
            const built = buildAutoRecordedRow({
              kind: k,
              value: c.uri,
              source: "gemini_deep_dork",
              rawConfidence: k === "leak_paste" ? 55 : k === "document" ? 60 : 50,
              metadata: {
                seed,
                seed_kind: kind,
                focus: focus ?? null,
                title: c.title ?? null,
                discovered_via: "gemini google_search grounding",
              },
            });
            return {
              thread_id: threadId,
              user_id: userId,
              ...built,
            };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);
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
    jina_reader_scrape: tool({
      description:
        "#1 PRIMARY scraper for ANY URL — free, unlimited, returns clean LLM-ready markdown. Always prefer this over firecrawl/exa_contents for single-page extraction. Use https://r.jina.ai/{url} under the hood. Works on articles, profile pages, forums, leak listings, dorks hits, Discord/Telegram links, PDFs (best-effort), etc. Pass a fully-qualified http(s) URL — do NOT pass relative paths or text snippets.",
      inputSchema: z.object({
        url: z.string().url(),
        maxChars: z.number().int().min(500).max(40000).default(18000),
      }),
      // opts carries the per-tool timeout AbortSignal (Phase B3): forwarding it to
      // fetchRetry makes the 8s cap truly cancel the scrape mid-flight rather than
      // abandon the promise while r.jina.ai keeps streaming.
      execute: async ({ url, maxChars }, opts) => {
        const signal = (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
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
        // Skip hosts that always 451/403 through Jina — save the ~8s dead round-trip.
        if (isJinaHardBlocked(parsed.hostname)) {
          return { error: "jina 451", status: 451, url: parsed.toString(), skipped: true, hint: "origin blocks Jina — try wayback_snapshots, socialfetch_lookup, or a direct-API tool" };
        }
        // Rebuild a clean URL; r.jina.ai expects the raw URL appended.
        const clean = parsed.toString();
        try {
          const headers: Record<string, string> = { Accept: "text/plain" };
          if (JINA_API_KEY) headers.Authorization = `Bearer ${JINA_API_KEY}`;
          const target = `https://r.jina.ai/${clean}`;
          const r = await fetchRetry(target, { headers, signal }, { retries: 2 });
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
        } catch (e) {
          // Include the URL on the timeout/abort path too — without it, a
          // failed scrape in the tool trace shows only "AbortError" with no
          // way to tell which page timed out, making failures undebuggable.
          const msg = String(e);
          const aborted = e instanceof Error && (e.name === "AbortError" || /abort/i.test(msg));
          return { error: msg, url: clean, ...(aborted ? { aborted: true, hint: "scrape timed out — try wayback_snapshots or a lighter source" } : {}) };
        }
      },
    }),
    exa_search: tool({
      description:
        "Exa /search — neural + keyword web search with optional inline contents (text, highlights, summary). Use when semantic or exact-string discovery has the highest expected value; do not automatically pair it with another search provider. Supports includeDomains/excludeDomains, startPublishedDate/endPublishedDate, and category ('company','research paper','news','pdf','github','tweet','personal site','linkedin profile','financial report').",
      inputSchema: z.object({
        query: z.string().min(2),
        type: z.enum(["auto", "neural", "keyword"]).default("auto"),
        numResults: z.number().int().min(1).max(25).default(10),
        includeDomains: z.array(z.string()).optional(),
        excludeDomains: z.array(z.string()).optional(),
        startPublishedDate: z.string().optional().describe("ISO date, e.g. 2024-01-01"),
        endPublishedDate: z.string().optional(),
        // Tolerant: accept any string so an out-of-enum value (e.g. "person")
        // does NOT reject the whole tool call at input validation. Invalid
        // categories are dropped inside execute (the search still runs, just
        // unfiltered) and surfaced in `dropped_category` for auditability.
        category: z.string().optional().describe(
          "One of: company, research paper, news, pdf, github, tweet, personal site, linkedin profile, financial report. Other values are ignored (search runs unfiltered).",
        ),
        contents: z.boolean().default(true).describe("If true, include text+highlights+summary for each result."),
      }),
      execute: async ({ query, type, numResults, includeDomains, excludeDomains, startPublishedDate, endPublishedDate, category, contents }) => {
        if (!EXA_API_KEY) return { error: "EXA_API_KEY not configured" };
        const EXA_CATEGORIES = new Set([
          "company", "research paper", "news", "pdf", "github", "tweet",
          "personal site", "linkedin profile", "financial report",
        ]);
        const normalizedCategory = typeof category === "string" ? category.trim().toLowerCase() : "";
        const validCategory = EXA_CATEGORIES.has(normalizedCategory) ? normalizedCategory : null;
        const droppedCategory = category && !validCategory ? category : null;
        try {
          const body: Record<string, unknown> = { query, type, numResults };
          if (includeDomains?.length) body.includeDomains = includeDomains;
          if (excludeDomains?.length) body.excludeDomains = excludeDomains;
          if (startPublishedDate) body.startPublishedDate = startPublishedDate;
          if (endPublishedDate) body.endPublishedDate = endPublishedDate;
          if (validCategory) body.category = validCategory;
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
          return { ok: r.ok, status: r.status, data: trimExaResults(data), ...(droppedCategory ? { dropped_category: droppedCategory } : {}) };
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
        // emailrep.io disabled its unauthenticated API in 2025 — keyless calls now
        // 429 with "the unauthenticated API is currently disabled; use an API key".
        // Without EMAILREP_API_KEY this is a config skip, not a tool failure.
        const KEY = Deno.env.get("EMAILREP_API_KEY");
        try {
          const headers: Record<string, string> = { "User-Agent": "Proximity-OSINT", Accept: "application/json" };
          if (KEY) headers["Key"] = KEY;
          const r = await fetchT(`https://emailrep.io/${encodeURIComponent(email)}`, { headers });
          if (!KEY && (r.status === 429 || r.status === 401)) {
            return {
              skipped: true,
              status: r.status,
              note: "EMAILREP_API_KEY not configured — emailrep.io disabled its unauthenticated API. Set the key to enable, or corroborate via gravatar_profile / hunter_* / breach_check.",
            };
          }
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
          // Gravatar v3 returns 404 ("Profile not found") for any email without a
          // profile — a legitimate negative, not a tool failure. Mark it ok with
          // found:false so it doesn't inflate the failure rate.
          const found = r.ok;
          return { ok: r.ok || r.status === 404, status: r.status, found, hash, avatar_url: `https://gravatar.com/avatar/${hash}`, data };
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
      execute: async ({ url }, opts) => {
        const signal = (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
        try {
          // archive.org's /save endpoint is fronted by Cloudflare and intermittently
          // returns 520/523 (origin down). fetchRetry retries once on 5xx (its retry
          // predicate covers 520/523), which recovers the transient failures the
          // prior one-shot fetchT surfaced as-is. The tool cap is raised to 25s
          // (TOOL_TIMEOUT_OVERRIDE_MS) and the wrapper signal is forwarded so a slow
          // save cancels cleanly. `url` is validated (z.string().url()) and
          // encoded so a query string in the evidence URL can't break the path.
          const r = await fetchRetry(`https://web.archive.org/save/${encodeURIComponent(url)}`, {
            method: "GET",
            headers: { "User-Agent": "Proximity-OSINT/1.0" },
            redirect: "manual",
            signal,
          }, { timeoutMs: 20_000, retries: 1 });
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
        artifacts: z.preprocess(coerceArtifactsInput, z.array(
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
          const effSources = [a.source ?? "", ...((a.metadata?.sources ?? []) as Iterable<unknown>)].filter(Boolean) as string[];
          const cap = applyEvidenceCaps({
            rawConfidence: a.confidence ?? 50,
            sources: effSources,
            kind: a.kind,
          });
          // Provenance guard (#131 follow-up): flag an artifact whose effective
          // source names a bare domain that is NOT a wired tool and NOT a recognized
          // provider — i.e. an LLM-asserted citation nothing actually fetched (the
          // menstoppingviolence.org incident). The seed domain (which whois/dns DO
          // fetch) is whitelisted so the legitimate seed never trips it.
          const seedRecognizedDomains = [triageState.seedDomain, triageState.seed]
            .filter((d): d is string => typeof d === "string" && d.length > 0);
          const llmAssertedProvenance = effSources.some((s) => isLlmAssertedDomainSource(s, seedRecognizedDomains));
          // Different-person / unrelated-entity gate: a namesake/collision that
          // does NOT belong to the seed is demoted to excluded_collision with a
          // hard-capped confidence so it can't roll up or read as a confirmed link.
          const unrelated = isUnrelatedEntity(a.metadata ?? null);
          // Same-surname-only "family" leads and real-estate listing agents are
          // NOT corroborated subject relations — suppress them as collisions so
          // they cannot hijack the planner (e.g. the "Karen De Young" listing agent).
          const isPerson = v.kind === "name" || v.kind === "person";
          const surnameOnly = !unrelated && isPerson && isSameSurnameOnlyLead(a.metadata ?? null);
          const listingAgent = isListingAgentLead(a.metadata ?? null);
          const collisionExcluded = unrelated || surnameOnly;
          // Bio-linked name gate: a name pulled out of a profile bio is an
          // unverified identity claim and can never anchor the case.
          const bioName = !collisionExcluded && isBioCrossLinkName(v.kind, a.metadata ?? null);
          const finalKind = collisionExcluded ? "excluded_collision" : v.kind;
          const finalConfidence = collisionExcluded
            ? Math.min(cap.confidence, EXCLUDED_COLLISION_CONFIDENCE)
            : bioName
              ? Math.min(cap.confidence, BIO_CROSS_LINK_NAME_CAP)
              : cap.confidence;
          // Resolve the confirmation gap, then DERIVE a coherent status from it
          // (status can never contradict reason_not_confirmed).
          const aReqRNC = typeof a.metadata?.reason_not_confirmed === "string" ? a.metadata.reason_not_confirmed : null;
          const resolvedReasonNotConfirmed = bioName
            ? "name appears only in a bio/linked-accounts block — confirm it is the subject, not a mentioned third party"
            : (aReqRNC ?? cap.reason_not_confirmed ?? null);
          const derivedStatus = collisionExcluded
            ? "excluded"
            : bioName
              ? "unverified_bio_link"
              : coerceCoherentStatus(
                  deriveStatus({
                    requested: typeof a.metadata?.status === "string" ? a.metadata.status : null,
                    reasonNotConfirmed: resolvedReasonNotConfirmed,
                    sourceClasses: cap.source_classes,
                    contradictions: Array.isArray(a.metadata?.contradictions) ? a.metadata.contradictions : [],
                    deadEnd: looksDeadEnd(a.metadata ?? null),
                  }),
                  resolvedReasonNotConfirmed,
                );
          // Deterministic date-sanity guard for harm-bearing records: flags a
          // genuinely-future date and neutralizes false model-authored
          // "future date" notes when the date is not actually future. Provenance
          // guard only — never promotes or changes status/confidence.
          const dateSanity = applyDateSanity(v.kind, v.value, a.metadata ?? null, new Date().toISOString());
          // Required-fields envelope — fill conservative defaults when the
          // agent didn't supply them.
          const meta: Record<string, unknown> = {
            ...(a.metadata ?? {}),
            ...(v.metaPatch ?? {}),
            ...(inferred.reclassified_from ? { reclassified_from: inferred.reclassified_from } : {}),
            source_category: cap.source_classes,
            query_types: queryTypesOf({ value: v.value, kind: v.kind, metadata: a.metadata ?? null }),
            status: derivedStatus,
            cluster_id: a.metadata?.cluster_id ?? null,
            reason_for_confidence: collisionExcluded
              ? (surnameOnly
                  ? "excluded: shared surname only — not a corroborated family/associate link"
                  : "excluded: flagged as unrelated/different entity than the seed")
              : bioName
                ? "bio-linked name — unverified identity claim, may be an associate/shoutout, not the subject"
                : cap.reason_for_confidence,
            reason_not_confirmed: resolvedReasonNotConfirmed,
            contradictions: a.metadata?.contradictions ?? [],
            next_verification_step: a.metadata?.next_verification_step ?? null,
            confidence_cap_applied: bioName ? Math.min(cap.cap, BIO_CROSS_LINK_NAME_CAP) : cap.cap,
            ...(collisionExcluded ? { excluded_collision: true, reclassified_from: a.kind } : {}),
            ...(surnameOnly ? { excluded_reason: "same_surname_only" } : {}),
            ...(listingAgent ? { contact_type: "real_estate_listing_agent" } : {}),
            ...(bioName ? { bio_cross_link: true } : {}),
            ...(llmAssertedProvenance ? { provenance: LLM_ASSERTED_PROVENANCE, provenance_verified: false } : {}),
            // Spread LAST so a corrected `note` overrides the model-supplied one.
            ...dateSanity.metaPatch,
          };
          rows.push({
            thread_id: threadId,
            user_id: userId,
            kind: finalKind,
            value: v.value,
            confidence: finalConfidence,
            source: a.source ?? null,
            metadata: meta,
          });
          accepted.push({ index: i, kind: finalKind, value: v.value });
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
        beginCycle(
          threadId,
          "Review newly recorded evidence and select the smallest justified verification batch.",
          safeRowsForFollowup.slice(-12).map((r) => `${String(r.kind)}:${String(r.value)}`),
        );
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
            // Chain-of-custody protection (#131 follow-up): never record an
            // LLM-asserted unverified domain as the authoritative tool/source — that
            // would launder a fabricated citation into the tamper-evident log. The
            // artifact value/kind stay intact; only the provenance label changes.
            const llmAsserted = meta.provenance === LLM_ASSERTED_PROVENANCE;
            const evToolName = llmAsserted ? LLM_ASSERTED_PROVENANCE : ((r.source as string) ?? "agent");
            const evSource = llmAsserted ? LLM_ASSERTED_PROVENANCE : ((r.source as string) ?? null);
            const { error: evErr } = await supabase.rpc("append_evidence", {
              _thread_id: threadId,
              _artifact_id: null,
              _tool_name: evToolName,
              _source: evSource,
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
        const effSources = [source ?? "", ...((metadata?.sources ?? []) as Iterable<unknown>)].filter(Boolean) as string[];
        const cap = applyEvidenceCaps({
          rawConfidence: confidence ?? 50,
          sources: effSources,
          kind: inferred.kind,
        });
        // Provenance guard (#131 follow-up) — mirrors record_artifacts. Flags a
        // bare-domain source that is neither a wired tool nor a known provider (the
        // LLM-asserted menstoppingviolence.org citation); seed domain whitelisted.
        const seedRecognizedDomains = [triageState.seedDomain, triageState.seed]
          .filter((d): d is string => typeof d === "string" && d.length > 0);
        const llmAssertedProvenance = effSources.some((s) => isLlmAssertedDomainSource(s, seedRecognizedDomains));
        // Gates mirror record_artifacts: unrelated / same-surname-only / listing
        // agent → excluded collision; bio-linked name → unverified claim.
        const unrelated = isUnrelatedEntity(metadata ?? null);
        const isPerson = v.kind === "name" || v.kind === "person";
        const surnameOnly = !unrelated && isPerson && isSameSurnameOnlyLead(metadata ?? null);
        const listingAgent = isListingAgentLead(metadata ?? null);
        const collisionExcluded = unrelated || surnameOnly;
        const bioName = !collisionExcluded && isBioCrossLinkName(v.kind, metadata ?? null);
        const finalKind = collisionExcluded ? "excluded_collision" : v.kind;
        const finalConfidence = collisionExcluded
          ? Math.min(cap.confidence, EXCLUDED_COLLISION_CONFIDENCE)
          : bioName
            ? Math.min(cap.confidence, BIO_CROSS_LINK_NAME_CAP)
            : cap.confidence;
        const reqRNC = typeof metadata?.reason_not_confirmed === "string" ? metadata.reason_not_confirmed : null;
        const resolvedReasonNotConfirmed = bioName
          ? "name appears only in a bio/linked-accounts block — confirm it is the subject, not a mentioned third party"
          : (reqRNC ?? cap.reason_not_confirmed ?? null);
        const derivedStatus = collisionExcluded
          ? "excluded"
          : bioName
            ? "unverified_bio_link"
            : coerceCoherentStatus(
                deriveStatus({
                  requested: typeof metadata?.status === "string" ? metadata.status : null,
                  reasonNotConfirmed: resolvedReasonNotConfirmed,
                  sourceClasses: cap.source_classes,
                  contradictions: Array.isArray(metadata?.contradictions) ? metadata.contradictions : [],
                  deadEnd: looksDeadEnd(metadata ?? null),
                }),
                resolvedReasonNotConfirmed,
              );
        const enrichedMeta = {
          ...(metadata ?? {}),
          ...(v.metaPatch ?? {}),
          ...(inferred.reclassified_from ? { reclassified_from: inferred.reclassified_from } : {}),
          source_category: cap.source_classes,
          query_types: queryTypesOf({ value: v.value, kind: v.kind, metadata: metadata ?? null }),
          status: derivedStatus,
          cluster_id: metadata?.cluster_id ?? null,
          reason_for_confidence: collisionExcluded
            ? (surnameOnly
                ? "excluded: shared surname only — not a corroborated family/associate link"
                : "excluded: flagged as unrelated/different entity than the seed")
            : bioName
              ? "bio-linked name — unverified identity claim, may be an associate/shoutout, not the subject"
              : cap.reason_for_confidence,
          reason_not_confirmed: resolvedReasonNotConfirmed,
          contradictions: metadata?.contradictions ?? [],
          next_verification_step: metadata?.next_verification_step ?? null,
          confidence_cap_applied: bioName ? Math.min(cap.cap, BIO_CROSS_LINK_NAME_CAP) : cap.cap,
          ...(collisionExcluded ? { excluded_collision: true, reclassified_from: kind } : {}),
          ...(surnameOnly ? { excluded_reason: "same_surname_only" } : {}),
          ...(listingAgent ? { contact_type: "real_estate_listing_agent" } : {}),
          ...(bioName ? { bio_cross_link: true } : {}),
          ...(llmAssertedProvenance ? { provenance: LLM_ASSERTED_PROVENANCE, provenance_verified: false } : {}),
        };
        const row = scrubArtifactRow({
          thread_id: threadId,
          user_id: userId,
          kind: finalKind,
          value: v.value,
          confidence: finalConfidence,
          source: source ?? null,
          metadata: enrichedMeta,
        });
        const { error } = await supabase.from("artifacts").insert([row]);
        if (error) return { ok: false, error: error.message };
        bumpArtifacts(1, [String(row.kind)]);
        beginCycle(
          threadId,
          "Review the newly recorded artifact and select the smallest justified verification batch.",
          [`${String(row.kind)}:${String(row.value)}`],
        );
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
        // Chain-of-custody protection (#131 follow-up): keep an LLM-asserted
        // unverified domain out of the authoritative tool/source fields.
        const llmAsserted = meta.provenance === LLM_ASSERTED_PROVENANCE;
        const evToolName = llmAsserted ? LLM_ASSERTED_PROVENANCE : ((row.source as string) ?? "agent");
        const evSource = llmAsserted ? LLM_ASSERTED_PROVENANCE : ((row.source as string) ?? null);
        await supabase.rpc("append_evidence", {
          _thread_id: threadId,
          _artifact_id: null,
          _tool_name: evToolName,
          _source: evSource,
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

  // Serus darkweb scan — imported from tools/serus.ts (was missing from inline tools).
  (tools as ToolRegistry).serus_darkweb_scan = serus_darkweb_scan;

  // Indicia (api.indicia.app) — 6 person/phone/email/address + web-DB breach tools,
  // imported from tools/indicia.ts. Gated on INDICIA_API_KEY via capabilities.ts;
  // face/geo/gmail/username endpoints are intentionally NOT wired (hard policy).
  (tools as ToolRegistry).indicia_email = indicia_email;
  (tools as ToolRegistry).indicia_phone = indicia_phone;
  (tools as ToolRegistry).indicia_person = indicia_person;
  (tools as ToolRegistry).indicia_address = indicia_address;
  (tools as ToolRegistry).indicia_web_dbs = indicia_web_dbs;
  (tools as ToolRegistry).indicia_hudsonrock = indicia_hudsonrock;

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
    ...(HUNTER_API_KEY ? ["hunter_combined", "hunter_email_verifier", "hunter_domain_search"] : []),
    ...(Deno.env.get("LEAKCHECK_API_KEY") ? ["leakcheck_lookup"] : []),
    // stolentax_footprint CUT 2026-07-05 (disabled in capabilities.ts) — breach_check
    // still uses STOLENTAX_API_KEY when present but falls back to keyless leakcheck.
    ...(Deno.env.get("STOLENTAX_API_KEY") ? ["breach_check"] : []),
    ...(INDICIA_API_KEY ? ["indicia_email","indicia_phone","indicia_person","indicia_address","indicia_web_dbs","indicia_hudsonrock"] : []),
    ...(Deno.env.get("DEEPFIND_API_KEY") ? ["deepfind_reverse_email","deepfind_disposable_email","deepfind_ssl_inspect","deepfind_tech_stack","deepfind_url_unshorten","deepfind_telegram_channel","deepfind_telegram_search","deepfind_vin_lookup","deepfind_aircraft_lookup","deepfind_vessel_lookup","deepfind_mac_lookup","deepfind_dark_web_link","deepfind_email_breach","deepfind_transaction_viewer"] : []),
    ...(Deno.env.get("VIRUSTOTAL_API_KEY") ? ["virustotal_lookup"] : []),
    ...(Deno.env.get("IPGEOLOCATION_API_KEY") ? ["ipgeolocation_lookup"] : []),
    // ipqualityscore_lookup CUT 2026-07-05 (dead key; disabled in capabilities.ts).
    ...(RAPIDAPI_KEY ? ["rapidapi_breach_search", "rapidapi_all_breaches"] : []),
    ...(Deno.env.get("EXA_API_KEY") ? ["exa_search","exa_get_contents","exa_find_similar"] : []),
    ...(Deno.env.get("GEMINI_API_KEY") ? ["gemini_deep_dork"] : []),
    // Free / always-on tools
    "whois_lookup","dns_records","crtsh_subdomains","wayback_snapshots","archive_url","http_fingerprint",
    "ip_intel","shodan_internetdb","hackertarget","urlscan_search","gravatar_profile","hibp_lookup",
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

  // Internal sink for the unknown-tool guard (Phase B4). streamText's
  // experimental_repairToolCall redirects any hallucinated / non-registry tool
  // name (e.g. exify, hackerone_lookup) here so it drops without executing the
  // invented tool and without surfacing the invented name. Not counted by the
  // coverage audit (absent from availableToolsForAudit). Do NOT call directly.
  // NB: the literal key MUST equal UNKNOWN_TOOL_SINK ("unknown_tool_ignored") in
  // unknown-tool-guard.ts — a literal (not a computed key) so the catalog↔runtime
  // contract parser can see it; unknown_tool_guard_test pins the constant.
  (tools as ToolRegistry).unknown_tool_ignored = tool({
    description:
      "Internal runtime sink — do NOT call. Hallucinated/unknown tool names are " +
      "redirected here and dropped. Use only the other tools listed in your schema.",
    inputSchema: z.object({
      requested: z.string().optional().describe("The unknown tool name that was dropped."),
    }),
    execute: ({ requested }: { requested?: string }) =>
      Promise.resolve({ ok: true, dropped: true, ignored_tool: requested ?? null, note: unknownToolNudge(requested) }),
  });

  (tools as ToolRegistry).coverage_audit = tool({
    description:
      "Advisory coverage audit. Returns gaps and missing opportunities but never blocks progress or reporting.",
    inputSchema: z.object({}).strict(),
    execute: async () => {
      const called = await callsForThread();
      const report = auditCoverage(detectedSeedType, called, availableToolsForAudit);
      return { ok: true, seed_type: detectedSeedType, ...report };
    },
  });

  (tools as ToolRegistry).detect_contradictions = tool({
    description:
      "Advisory contradiction analysis. Strongly recommended before high-confidence attribution, but never an execution prerequisite.",
    inputSchema: z.object({
      cluster_artifact_kinds: z.array(z.string()).optional()
        .describe("Optional. Restrict to specific artifact kinds (e.g. ['email','username','name','ip'])."),
    }),
    execute: async ({ cluster_artifact_kinds }) => {
      let q = supabase.from("artifacts").select("id,kind,value,source,metadata,created_at").eq("thread_id", threadId);
      if (cluster_artifact_kinds?.length) q = q.in("kind", cluster_artifact_kinds);
      const { data, error } = await q;
      if (error) return { ok: false, error: error.message };
      type Row = { id: string; kind: string; value: string; source: string | null; metadata: Record<string, unknown> | null };
      const rows = (data ?? []) as Row[];
      const findings = detectContradictions(rows as Parameters<typeof detectContradictions>[0]);

      // Persist explicit conflicts back onto the involved artifacts so the
      // contradiction is represented structurally in metadata.contradictions[]
      // instead of being buried in prose. This does NOT re-derive status on
      // these historical rows (deriveStatus only runs at record_artifacts
      // insert time), so labels/confidence of existing rows are unchanged; the
      // structured field is surfaced for the UI, detect helpers, and any
      // subsequent record_finding that naturally reacts to it.
      // Scope persistence to WITHIN each candidate cluster — never cross-mark
      // distinct hypotheses (different cluster_id, different locations/employers)
      // as contradicting each other. The advisory `findings` above stays
      // thread-wide; only the structural writes are cluster-scoped.
      const patches = clusterScopedContradictionPatches(rows as Parameters<typeof clusterScopedContradictionPatches>[0], new Date().toISOString());
      const byId = new Map<string, StructuredContradiction[]>();
      for (const p of patches) {
        // Prefer the exact artifact id carried by the patch. Falling back to a
        // value match would attach a cluster-c1 conflict to the first row with
        // the same value thread-wide — which can be a different cluster's row.
        const row = p.id ? rows.find((r) => r.id === p.id) : rows.find((r) => r.value === p.value);
        if (!row) continue;
        const list = byId.get(row.id) ?? [];
        list.push(p.entry);
        byId.set(row.id, list);
      }
      let persisted = 0;
      for (const [id, entries] of byId) {
        const row = rows.find((r) => r.id === id);
        if (!row) continue;
        const existing = Array.isArray(row.metadata?.contradictions) ? (row.metadata!.contradictions as unknown[]) : [];
        const merged = mergeStructuredContradictions(existing, entries);
        if (merged.length === existing.length) continue; // idempotent: nothing new
        const { error: upErr } = await supabase
          .from("artifacts")
          // Cast: the Supabase client has no generated DB types in this repo, so
          // .update()'s payload param resolves to `never` (the same pre-existing
          // type-graph state every .insert/.update here hits). Cast keeps the
          // deno-check baseline unchanged without altering runtime behavior.
          .update({ metadata: { ...(row.metadata ?? {}), contradictions: merged } } as never)
          .eq("id", id);
        if (!upErr) persisted++;
        else console.warn("[detect_contradictions] persist failed:", upErr.message);
      }
      return { ok: true, count: findings.length, contradictions: findings, persisted };
    },
  });

  (tools as ToolRegistry).tool_audit = tool({
    description:
      "Advisory tool health and utilization summary. Never a progress gate.",
    inputSchema: z.object({}).strict(),
    execute: async () => {
      const { data: rows } = await supabaseAdmin
        .from("tool_usage_log")
        .select("tool_name,ok,cached,cost_micro_usd,charged_micro_usd,duration_ms,error_msg,status_code")
        .eq("thread_id", threadId);
      const used = new Set<string>();
      const failures: Record<string, number> = {};
      const counts: Record<string, number> = {};
      // chargedMicro = credits actually consumed (success-only).
      // attributedMicro = list price of every paid call incl. failures; the
      // gap between them is wasted/avoided spend on failed calls.
      let chargedMicro = 0;
      let attributedMicro = 0;
      type UsageLogRow = { tool_name: string; ok?: boolean; cost_micro_usd?: number; charged_micro_usd?: number };
      for (const r of (rows ?? []) as UsageLogRow[]) {
        used.add(r.tool_name);
        counts[r.tool_name] = (counts[r.tool_name] ?? 0) + 1;
        chargedMicro += r.charged_micro_usd ?? (r.ok !== false ? r.cost_micro_usd ?? 0 : 0);
        attributedMicro += r.cost_micro_usd ?? 0;
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
        total_cost_usd: +(chargedMicro / 1_000_000).toFixed(5),
        attributed_cost_usd: +(attributedMicro / 1_000_000).toFixed(5),
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
      "Persist a source-backed analyst FINDING. Audit helpers are optional. Each finding must cite supporting artifacts, name drivers and reducers, and acknowledge contradictions. Confidence is computed server-side; Tier-C-only evidence is hard-capped at 50.",
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
      // Scope the contradiction / advisory penalty to the artifacts that
      // actually belong to THIS finding's identity candidate — its cited
      // artifacts plus their cluster(s) — so a finding for one candidate is not
      // docked for an UNRELATED candidate's location conflict / thin_name /
      // over_broad_username sitting elsewhere in the same multi-hypothesis
      // thread. When the finding cites nothing resolvable we can't attribute a
      // cluster, so fall back to the thread-wide set (conservative: keep the
      // penalty rather than inflate confidence).
      const allRows = (contraRows ?? []) as Parameters<typeof detectContradictions>[0];
      const scopedRows = artifactsForFinding(allRows, i.supporting_artifact_values ?? []);
      const contras = detectContradictions(scopedRows.length > 0 ? scopedRows : allRows);
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
      recordFindingSummary(threadId, i.conclusion);
      return { ok: true, id: data?.id ?? null, confidence_axes: axes, applied_label: i.label };
    },
  });

  return { tools, availableToolsForAudit };
}
