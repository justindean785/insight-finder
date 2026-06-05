/**
 * tools/meta.ts — Meta-tools: list_tools (catalog) and triage_seed (Stage-1 gating).
 * Extracted from index.ts (lines 1753–1927).
 */

import { tool } from "npm:ai@6";
import { z } from "npm:zod@3";
import { createClient } from "npm:@supabase/supabase-js@2";
import { INTELBASE_ENABLED, SUPABASE_URL, SERVICE_KEY } from "../env.ts";
import {
  triageState,
  bumpArtifacts,
  STAGE2_TOOLS,
  CONSUMER_DOMAINS,
} from "../guard.ts";
import { TOOL_CATALOG, CATALOG_CACHE } from "../catalog.ts";

/** Loose shape for a stolen.tax v2 parsed response (only fields we read). */
interface StolenTaxParsed {
  data?: { results?: unknown; [k: string]: unknown };
  [k: string]: unknown;
}

/** Loose shape for a Stage-1 tool result ({ ok, status, data } or { error }). */
interface Stage1Result {
  status?: number;
  data?: Record<string, unknown>;
  [k: string]: unknown;
}

// ---- list_tools -------------------------------------------------------------

export const list_tools = tool({
  description:
    "Returns the OSINT tool catalog (names, descriptions, when-to-use, input shape) plus per-seed fan-out recipes and finding-label rules, FILTERED to what's currently allowed in this investigation. If triage_seed has run, Stage-2 tools that did NOT clear the gate are hidden from `tools` and listed in `disabled_tools` with the reason — do NOT call them, they will be skipped. Call this once at the start, and OPTIONALLY again immediately after `triage_seed` to refresh the allowed set.",
  inputSchema: z.object({
    thread_id: z.string().optional().describe("Thread/investigation ID for cache key (best-effort)"),
  }),
  execute: async ({ thread_id }) => {
    const threadId = thread_id ?? "unknown";
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
});

// ---- triage_seed ------------------------------------------------------------
// Stage-1 gating tool. Calls emailrep.io, Gravatar, and stolen.tax directly
// (inlined from the emailrep / gravatar_profile / breach_check tools to avoid
// circular imports before those tools are extracted).

async function callEmailrep(email: string) {
  try {
    const r = await fetch(`https://emailrep.io/${encodeURIComponent(email)}`, {
      headers: { "User-Agent": "Proximity-OSINT", Accept: "application/json" },
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, data };
  } catch (e) { return { error: String(e) }; }
}

async function callGravatar(email: string) {
  try {
    const enc = new TextEncoder().encode(email.trim().toLowerCase());
    const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", enc)))
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    const r = await fetch(`https://api.gravatar.com/v3/profiles/${hash}`, {
      headers: { Accept: "application/json", "User-Agent": "Proximity-OSINT" },
    });
    const data = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, hash, avatar_url: `https://gravatar.com/avatar/${hash}`, data };
  } catch (e) { return { error: String(e) }; }
}

async function callBreachCheck(query: string) {
  const STOLENTAX_API_KEY = Deno.env.get("STOLENTAX_API_KEY");
  if (!STOLENTAX_API_KEY) {
    try {
      const r = await fetch(`https://leakcheck.io/api/public?check=${encodeURIComponent(query)}`);
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, data };
    } catch (e) { return { error: String(e) }; }
  }
  const callStolen = async (path: string, body: Record<string, unknown>) => {
    try {
      const r = await fetch(
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
      );
      const text = await r.text();
      let parsed: unknown;
      try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 4000) }; }
      return { ok: r.ok, status: r.status, parsed };
    } catch (e) {
      return { ok: false, status: 0, parsed: { error: String(e) } };
    }
  };
  const [dbSearch, snus, breachLegacy] = await Promise.all([
    callStolen("osintcat", { query, osintcat_mode: "database-search" }),
    callStolen("snusbase", { query }),
    callStolen("osintcat", { query, osintcat_mode: "breach" }),
  ]);
  const dbResults = (dbSearch.parsed as StolenTaxParsed)?.data?.results;
  const dbHits = Array.isArray(dbResults) ? dbResults.length : 0;
  const snusRoot = (snus.parsed as StolenTaxParsed)?.data ?? {};
  const snusResultsObj = snusRoot.results ?? {};
  let snusHits = 0;
  if (snusResultsObj && typeof snusResultsObj === "object") {
    for (const rows of Object.values(snusResultsObj)) {
      if (Array.isArray(rows)) snusHits += rows.length;
    }
  }
  const totalHits = dbHits + snusHits;
  const sources = [
    { name: "osintcat:database-search", hits: dbHits },
    { name: "snusbase", hits: snusHits },
  ];
  return {
    ok: true,
    found: totalHits > 0 || breachLegacy.ok,
    data: {
      hit_count: totalHits,
      sources,
      raw: { dbSearch: dbSearch.parsed, snus: snus.parsed, breachLegacy: breachLegacy.parsed },
    },
  };
}

export const triage_seed = tool({
  description:
    "MANDATORY first step for email or username seeds. Runs the cheap Stage-1 tools (emailrep, gravatar_profile, breach_check) in parallel, then decides which expensive Stage-2 tools (oathnet_lookup, github_code_search, google_dorks, minimax_web_search, urlscan_search) are allowed to run. Stage-2 tools are blocked at the orchestrator level until this runs and clears them. Records a `triage_decision` artifact.",
  inputSchema: z.object({
    seed: z.string().min(1),
    type: z.enum(["email", "username"]),
    thread_id: z.string().optional().describe("Thread ID for artifact persistence"),
    user_id: z.string().optional().describe("User ID for artifact persistence"),
  }),
  execute: async ({ seed, type, thread_id, user_id }) => {
    const normalized = seed.trim();
    const threadId = thread_id ?? "unknown";
    const userId = user_id ?? "unknown";
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
        callEmailrep(normalized).catch((e: unknown) => ({ error: String(e) })),
        callGravatar(normalized).catch((e: unknown) => ({ error: String(e) })),
        callBreachCheck(normalized).catch((e: unknown) => ({ error: String(e) })),
      ]);
      stage1.emailrep = emailrepRes;
      stage1.gravatar = gravatarRes;
      stage1.breach = breachRes;
    }

    // ---- Evaluate gate signals ----
    const erData = (stage1.emailrep as Stage1Result)?.data ?? {};
    const gvData = (stage1.gravatar as Stage1Result)?.data ?? {};
    const brData = (stage1.breach as Stage1Result)?.data ?? {};

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
      (stage1.gravatar as Stage1Result)?.status === 200 &&
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
    const stage2Open = true;
    if (reasons.length === 0) reasons.push("triage ran (gate permissive)");

    triageState.cleared.clear();
    triageState.skipped = [];
    triageState.reasons = reasons;

    const blockedReasonGlobal = "";

    for (const t of STAGE2_TOOLS) {
      const allow = stage2Open;
      if (allow) triageState.cleared.add(t);
      else triageState.skipped.push({ tool: t, reason: blockedReasonGlobal });
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
      const supabase = createClient(SUPABASE_URL, SERVICE_KEY);
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
});
