/**
 * tools/minimax.ts — MiniMax reasoning tools: web search, extract, correlate, plan.
 * Extracted from index.ts (lines 1928–2140).
 */

import { tool } from "npm:ai@6";
import { z } from "npm:zod@3";
import { PERPLEXITY_API_KEY, fetchRetry } from "../env.ts";
import { gateStage2, guard } from "../guard.ts";
import { minimaxChat, safeJson } from "../providers.ts";
import { MODELS } from "../models.ts";
import { detectSeedServer } from "../validation.ts";
import { enforceNameSeedPriority, NAME_SEED_PLANNER_RULES } from "../planner-guidance.ts";

// ---- minimax_web_search (Perplexity Sonar) ----------------------------------

export const minimax_web_search = tool({
  description:
    "Live web search powered by Perplexity Sonar (grounded, real-time, with citations). Use early on the seed and on every new email/handle/name/domain/phone you discover. Returns a concise synthesized answer plus the list of cited source URLs.",
  inputSchema: z.object({
    query: z.string().min(2).describe('Search query, e.g. "alice@example.com" leak OR breach'),
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
});

// ---- minimax_extract --------------------------------------------------------

export const minimax_extract = tool({
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
});

// ---- minimax_correlate ------------------------------------------------------

export const minimax_correlate = tool({
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
});

// ---- minimax_plan_pivots ----------------------------------------------------

export const minimax_plan_pivots = tool({
  description:
    "Ask MiniMax to plan the next pivot batch. Pass the seed plus what you've found so far; it returns a prioritized list of {tool, args, reason} for the next tool calls. Use when stuck or to avoid repeating work.",
  inputSchema: z.object({
    seed: z.string(),
    already_queried: z.array(z.string()).max(200).default([]),
    artifacts: z.array(z.object({ kind: z.string(), value: z.string() })).max(200),
    budget_remaining: z.number().int().min(0).max(100).default(30),
  }),
  execute: async ({ seed, already_queried, artifacts, budget_remaining }) => {
    try {
      const baseToolList = [
        "breach_check","leakcheck_lookup","hibp_lookup","oathnet_lookup",
        "intelbase_email_lookup","bosint_email_lookup","bosint_phone_lookup",
        "stolentax_footprint",
        "deepfind_reverse_email","deepfind_disposable_email","deepfind_ransomware_exposure",
        "deepfind_ssl_inspect","deepfind_tech_stack","deepfind_url_unshorten",
        "deepfind_profile_analyzer","deepfind_telegram_channel","deepfind_telegram_search",
        "deepfind_vin_lookup","deepfind_aircraft_lookup","deepfind_vessel_lookup",
        "deepfind_mac_lookup","deepfind_dark_web_link",
        "socialfetch_lookup","cordcat_discord_lookup","github_user","github_code_search",
        "hackernews_user","reddit_user","gravatar_profile","emailrep",
        "username_sweep","username_search",
        "hunter_domain_search","hunter_email_finder","hunter_email_verifier","hunter_combined",
        "whois_lookup","dns_records","crtsh_subdomains","http_fingerprint",
        "ip_intel","ipgeolocation_lookup","shodan_internetdb","hackertarget",
        "urlscan_search","virustotal_lookup","synapsint_lookup",
        "jina_reader_scrape","exa_search","exa_get_contents","exa_find_similar",
        "minimax_web_search","google_dorks","dork_harvest","gemini_deep_dork",
        "wayback_snapshots","archive_url","crypto_wallet",
        "osint_navigator_query","osint_navigator_search",
        "minimax_extract","minimax_correlate",
        "record_artifacts","record_artifact","record_evidence",
      ];
      const PERMANENT_BLOCK = new Set([
        "firecrawl_search","firecrawl_scrape","firecrawl_map",
        "intelbase_email_lookup",
      ]);
      const toolList = baseToolList.filter((name) => {
        if (PERMANENT_BLOCK.has(name)) return false;
        return true;
      });
      const r = await minimaxChat({
        model: MODELS.smart,
        system:
          `You plan OSINT pivots. ONLY propose tools from this EXACT list (names must match verbatim — do not invent or rename): ${toolList.join(", ")}.\n\n${NAME_SEED_PLANNER_RULES}\n\nExpected value and weak-lead status are advisory ranking signals, never prerequisites. Keep weak results [VERIFY] until corroborated. Return JSON: {pivots:[{tool:string, args:Record<string,unknown>, reason:string, priority:number}]}. Priority 1=highest. Max 8 pivots.`,
        user: `Seed: ${seed}\nBudget remaining: ${budget_remaining}\nAlready queried: ${JSON.stringify(already_queried).slice(0,4000)}\nArtifacts so far: ${JSON.stringify(artifacts).slice(0,8000)}`,
        json: true,
        maxTokens: 1500,
      });
      const parsed = enforceNameSeedPriority(
        safeJson<Record<string, unknown>>(r.content) ?? { raw: r.content },
        {
          seedType: detectSeedServer(seed)?.kind,
          alreadyQueried: already_queried,
        },
      );
      return { ok: r.ok, status: r.status, plan: parsed };
    } catch (e) { return { error: String(e) }; }
  },
});
