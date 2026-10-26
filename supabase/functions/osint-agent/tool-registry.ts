import { BREACH_EXPOSURE_KINDS, breachExposureGuardDisabled, checkBreachExposureRow, loadRanBreachTools } from "./lib/breach-exposure-guard.ts";
import { guardUserSuppliedStatus } from "./lib/user-supplied-status.ts";
import { leakcheckGuard, readLeakcheckQuota, resolveLeakcheckLimits } from "./lib/leakcheck-guard.ts";
import { ANALYST_AUTHORITY_NOTE, stripAnalystAuthorityKeys } from "./lib/analyst-authority-keys.ts";
import { applyMemoryContext } from "./lib/memory-context.ts";
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
  contradictionClaimFilterDisabled,
  detectContradictions,
  clusterScopedContradictionPatches,
  artifactsForFinding,
  isExplicitContradiction,
  mergeStructuredContradictions,
  type StructuredContradiction,
} from "./contradictions.ts";
import { applyDateSanity } from "./date-sanity.ts";
import { computeAxes, sourceConfidence, isUnrelatedEntity, EXCLUDED_COLLISION_CONFIDENCE, isBioCrossLinkName, BIO_CROSS_LINK_NAME_CAP } from "./confidence.ts";
import { applyRecordingSourcePolicy, disclosedSourceLabels, resolveRecordingStatus } from "./recording-source-policy.ts";
import { buildFindingRow } from "./lib/finding-row.ts";
import { queryTypesOf } from "./query-type-router.ts";
import { isSameSurnameOnlyLead, isListingAgentLead } from "./collision-policy.ts";
import { STRICT_KINDS, inferKind, isStrictKind, classifySource, isLlmAssertedDomainSource, LLM_ASSERTED_PROVENANCE, countIndependentClasses } from "./artifact_types.ts";
import * as circuit from "./circuit.ts";
import { buildNodes } from "./graph.ts";
import { collisionPeerSignal, type CollisionPeer } from "./lib/quarantine.ts";
import { loadRefusedArtifacts, type QuarantineRow } from "./lib/dispatch-quarantine.ts";
import { inheritedNameQuarantine, quarantinedPersonNames, recordNameQuarantineEnabled, type QuarantinedName, type ThreadRow } from "./lib/record-name-quarantine.ts";
import {
  isQueuedPlaceholder,
  stripStatusAssertions,
  nullResultKey,
  artifactDedupKey,
  breachExposureCanonicalKey,
  collapseRecordArtifactsBatch,
} from "./lib/artifact-hygiene.ts";
import { canonicalPhoneValue } from "./lib/selector-normalize.ts";
import { inferEdges, clusterGraph } from "./graph_reasoning.ts";
import { selectPivots, proposedCallToCandidate, type PivotCandidate, type ProposedCall } from "./graph_pivots.ts";
import { renderPivotChecklistForPrompt } from "./pivot-checklists.ts";
import { loadReviewsForThread, dropRejectedAndDerived, dropRejectedArtifacts, enforcedRejectedRows, isRejectedByReview, type ReviewDb } from "./reviews.ts";
import { applyMemorySupersession, refuseConflictingMemoryWrites, rejectedSelectorsFromRows, type MemoryRow } from "./lib/memory-supersession.ts";
import { unknownToolNudge } from "./unknown-tool-guard.ts";
import { resolveCorrelateSeed } from "./lib/thread-seed.ts";

/**
 * TOOL_NAME_ALIASES — DeepSeek (and occasionally other providers) hallucinate a
 * plausible-sounding generic tool name instead of our actual registry name
 * (2026-07-25 production audit, thread d98deb37, build 6d76133: 7 calls hit
 * unknown_tool_ignored for names like this). Checked BEFORE the unknown-tool
 * sink so a known drift pattern is silently redirected to the real tool instead
 * of being dropped and burning a step. Genuinely-unknown names (not in this map)
 * still fall through to unknown_tool_ignored at zero cost — this map only
 * shortcuts KNOWN alias drift, it does not change the zero-cost guarantee for
 * truly novel hallucinations.
 *
 * Add more entries here as new alias drift is observed in production telemetry —
 * keep the right-hand side pointed at a real, currently-registered tool name.
 */
export const TOOL_NAME_ALIASES: Record<string, string> = {
  web_search: "minimax_web_search",
  google_search: "google_dorks",
  scrape_url: "jina_reader_scrape",
  fetch_url: "jina_reader_scrape",
};
import type { QueryType } from "./query-type-router.ts";
import { buildAddressDorks, canonicalizeDorks, harvestQueryFamily, resolveDorkKind, type Dork } from "./dork-queries.ts";
import { DNS_TYPES, VIRTUAL_TYPE_MAP, isVirtualType, resolveVirtualHost, filterTxtByPrefix } from "./tools/dns-virtual.ts";

import {
  MINIMAX_API_KEY, LOVABLE_API_KEY,
  OATHNET_API_KEY, OSINTNOVA_API_KEY, SOCIALFETCH_API_KEY,
  CORDCAT_API_KEY, HUNTER_API_KEY,
  HIBP_API_KEY, OPSIS_API_KEY, GITHUB_API_TOKEN, EXA_API_KEY, JINA_API_KEY,
  GEMINI_API_KEY, OSINT_NAVIGATOR_API_KEY, PERPLEXITY_API_KEY, SERUS_API_KEY, IPQUALITYSCORE_API_KEY,
  RAPIDAPI_KEY, INDICIA_API_KEY, PEOPLEDATALABS_API_KEY,
  OPENCORPORATES_API_KEY, RANSOMWARELIVE_API_KEY,
  URLSCANNER_API_KEY, REVEAL_BREACH_DATA,
  degradedTools,
  markToolDegraded, isDegraded, fetchRetry, fetchT,
  deadHosts, markHostDead, isHostDead,
} from "./env.ts";
import { buildLeakcheckUrl, buildOathnetUrl } from "./breach-request.ts";
import { opsisAccount, opsisDepsFromEnv, opsisKillSwitchOn, opsisResults, opsisSearch } from "./lib/opsis.ts";
import {
  oathnetBreachSearchUrl, oathnetStealerSearchUrl, oathnetVictimsSearchUrl,
  oathnetVictimManifestUrl, oathnetVictimFileUrl, oathnetVictimArchiveUrl,
  oathnetSubdomainUrl, oathnetDbnamesUrl, OATHNET_AI_FILTER_URL, OATHNET_SCANNER_URLS,
  noteOathnetQuota, oathnetQuotaLeft, oathnetExhausted,
  trimStealerItems, trimVictimItems, summarizeManifest, safeVictimFile,
} from "./oathnet.ts";
import {
  indicia_email, indicia_phone, indicia_person,
  indicia_address, indicia_web_dbs, indicia_hudsonrock,
} from "./tools/indicia.ts";
import { pdl_person_enrich } from "./tools/peopledatalabs.ts";
import { gemini_vision, runGeminiVision } from "./tools/gemini_vision.ts";
import { geoseer_geolocate } from "./tools/geoseer.ts";

import {
  validateArtifact, TTL_24H_MS, TOOL_TTL_MS, NO_CACHE_TOOLS,
  coerceArtifactsInput, detectSeedServer,
} from "./validation.ts";

import type { NavigatorQueryResponse, NavigatorSearchResponse, NavigatorTool, GitHubCodeSearchResponse, GitHubCodeMatch } from "./api_types.ts";

import {
  scrubArtifactRow, scrubArtifactRows, hashInput, normalizeForHash,
  sanitizeToolOutput, TOOL_CACHE_LRU, LRU, isPrivateHost, assertSafeUrl,
  type CacheEntry,
} from "./safety.ts";

import {
  guard, routingGuard, CONSUMER_DOMAINS, STAGE2_TOOLS,
  triageState, bumpArtifacts, skipStub, takeCorrelateHint, resetCorrelateCycle,
} from "./guard.ts";
import { reviewMemoryBatch, type MemoryEntry } from "./lib/memory_consolidate.ts";
import { normalizeMemoryEntry, parseStringArtifactElements, wrapFlatMemoryEntry } from "./lib/memory-input-normalization.ts";
import {
  applyInputCoercion, GENERIC_SELECTOR_SPEC, inferSelectorKind, inputCoercionDisabled, mergeInputSpecs, type InputCoercionSpec,
} from "./lib/tool-input-coercion.ts";
import { socialfetchCustomCoercion } from "./lib/socialfetch-input.ts";
import type { Artifact as ClusterArtifact } from "./lib/cluster.ts";

import { minimaxChat, minimaxChatWithFallback, safeJson, geminiGroundedSearch, perplexitySearch } from "./providers.ts";
import { dorkToExaQuery } from "./dork-translate.ts";
import { augmentDorkQuery, isTemplateOrSampleUrl, scoreDorkRelevance, applyDorkRelevance, DORK_RELEVANCE_FLOOR } from "./dork-relevance.ts";
import { buildAutoRecordedRow } from "./auto-record-integrity.ts";

import { TOOL_CATALOG, CATALOG_CACHE, FINDING_LABELS } from "./catalog.ts";
import { beginCycle, recordFindingSummary } from "./runtime-policy.ts";
import { serus_darkweb_scan } from "./tools/serus.ts";
import { okWithSuccessFlag, isHackertargetApiError, isCrtshOk, dohTypeError, blockchairError } from "./tool_response.ts";
import { enforceNameSeedPriority, enforceFallbackToolPolicy, NAME_SEED_PLANNER_RULES } from "./planner-guidance.ts";
import { sweepUsername } from "./sweeper.ts";
import { rdapLookup } from "./rdap.ts";
import { trimExaResults, archiveAttachment } from "./archiver.ts";
// Single source of truth for provider gating. list_tools derives its disabled
// set from this so a tool marked `disabled: true` cannot stay advertised to the
// model after the runtime has removed it.
import { PROVIDER_REQUIREMENTS } from "./capabilities.ts";
import { agentMemoryOrFilter } from "./pgrest.ts";
import { shapeShodanResponse, shapeJinaBody } from "./lib/negative-lookup.ts";
import { waybackCdxParallelDisabled, waybackCdxSearch, waybackCdxSearchLegacy } from "./lib/wayback-cdx.ts";

/**
 * The REAL tool vocabulary, for G1's queued-placeholder gate.
 *
 * G1 must recognise an actual tool name, never snake_case SHAPE — `2021_cv_01188`
 * is the same shape as `socialfetch_lookup`, so the shape test discarded genuine
 * court and immigration records phrased "(pending appeal)". Sourced from
 * TOOL_CATALOG because catalog.ts is already held in sync with this registry by
 * the catalog↔runtime contract test, so a new tool cannot silently fall out of
 * this set.
 */
const KNOWN_TOOL_SLUGS: ReadonlySet<string> = new Set(
  TOOL_CATALOG.tools.map((t) => t.name.toLowerCase()),
);

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
  /** The request's PERSON seed, normalized ("" when not a person seed). A getter
   *  because index.ts derives it after buildTools is called; tools only execute
   *  later. `triageState.seed` cannot stand in for it: triage_seed accepts only
   *  email/username. Optional so existing callers and tests keep working. */
  getSubjectSeedName?: () => string;
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
  "youtube.com",
  "youtu.be",
  // 2026-07-25 production audit (thread d98deb37, 100-call Jina sample across
  // 7 threads): pinterest.com timed out 3/3 attempts at the 18s cap — it's
  // JS-heavy and login-gated, so Jina hangs until the wrapper kills it. Same
  // failure-every-time pattern as the hosts above.
  "pinterest.com",
  // Oregon judicial/SOR portals are SPA/heavy-render and timed out or 422'd
  // every attempt in the same sample (webportal.courts.oregon.gov: 2 timeouts
  // + 1 422). Structured record lookups belong to a direct-API tool or manual
  // review, not a markdown scrape.
  "webportal.courts.oregon.gov",
];
/** Page size and hard ceiling for the thread-wide artifact identity scan.
 *  PostgREST silently caps an unbounded select at the server `max-rows`, and a
 *  silently truncated dedup set re-admits rows it should have declined — the
 *  same shape as the recovery incident that read 40 of 85 artifacts and closed a
 *  run on a minority of its own evidence. */
const THREAD_ARTIFACT_PAGE_SIZE = 1000;
const THREAD_ARTIFACT_SCAN_MAX = 5000;

/** One stored artifact's identity, as the dedup gate needs it. */
type PriorArtifact = { id: string; confidence: number };

/**
 * Every artifact identity already on this thread, keyed exactly as the write
 * path keys a new one (`artifactDedupKey`) so runtime and stored keys cannot
 * drift.
 *
 * `truncated` is surfaced to the model rather than swallowed: a partial set
 * means a duplicate may be admitted, and a dedup gate that quietly stops
 * deduping is worse than one that says so. Never selects `metadata` — it is
 * JSONB carrying a large per-row snapshot, and hauling the thread's worth of it
 * on every record call is the wrong cost.
 */
async function loadThreadArtifactIdentities(
  supabase: ReturnType<typeof createClient>,
  threadId: string,
  seed: string | null,
): Promise<{ keys: Map<string, PriorArtifact>; truncated: boolean }> {
  const keys = new Map<string, PriorArtifact>();
  let truncated = false;
  try {
    for (let from = 0; from < THREAD_ARTIFACT_SCAN_MAX; from += THREAD_ARTIFACT_PAGE_SIZE) {
      const to = Math.min(from + THREAD_ARTIFACT_PAGE_SIZE, THREAD_ARTIFACT_SCAN_MAX) - 1;
      const { data, error } = await supabase
        .from("artifacts")
        .select("id,kind,value,source,confidence")
        .eq("thread_id", threadId)
        .range(from, to);
      if (error || !Array.isArray(data)) { truncated = true; break; }
      for (const r of data as Array<Record<string, unknown>>) {
        const kind = typeof r.kind === "string" ? r.kind : "";
        const value = typeof r.value === "string" ? r.value : "";
        if (!kind || !value) continue;
        const source = typeof r.source === "string" ? r.source : null;
        const entry: PriorArtifact = {
          id: String(r.id ?? ""),
          confidence: typeof r.confidence === "number" ? r.confidence : 0,
        };
        // FIRST WRITER WINS. The earliest row is the one whose evidence-ledger
        // entry exists; a later duplicate must never displace it as the survivor.
        const index = (k: string | null) => { if (k && !keys.has(k)) keys.set(k, entry); };

        index(artifactDedupKey({ kind, value, source }));

        // LEGACY SPELLING. `validateArtifact` canonicalises a phone on write, so
        // a row stored before that change holds "9175550123" while the next
        // attempt keys on "+19175550123" — the lookup misses and re-inserts the
        // duplicate this gate exists to stop. `loadSeenArtifactKeys` already
        // registers both spellings on the auto-persist path; without this the
        // model-facing writers were the one path that did not, which is exactly
        // the asymmetry this change set out to close.
        if (kind.toLowerCase() === "phone") {
          const canonical = canonicalPhoneValue(value);
          if (canonical && canonical !== value) index(artifactDedupKey({ kind, value: canonical, source }));
        }

        // NULL RESULTS key through `nullResultKey`, not the literal key, so a
        // stored no-hit row indexed only literally can never be found by the
        // canonical lookup — and "no breach hits" repeated in three wordings
        // keeps writing three rows, which is what production shows. Indexed
        // under the seed selector, matching the common write-time case; a row
        // whose write-time selector came from metadata simply fails to match,
        // which is a miss, never a false collapse.
        index(nullResultKey({ kind, source, value, selector: seed ?? null }));

        const breachCanon = breachExposureCanonicalKey({ kind, value, source });
        if (breachCanon) index(breachCanon);
      }
      if (data.length < THREAD_ARTIFACT_PAGE_SIZE) break;
      if (to + 1 >= THREAD_ARTIFACT_SCAN_MAX) truncated = true;
    }
  } catch (e) {
    // Best-effort by contract: dedup must never cost a batch of evidence.
    console.warn("[record_artifacts] thread dedup scan failed:", (e as Error)?.message ?? e);
    truncated = true;
  }
  return { keys, truncated };
}

/**
 * Targeted twin of the above for the SINGULAR `record_artifact` shim, which
 * writes one row at a time. A full thread scan per single-artifact call would be
 * the wrong cost, so this filters in SQL and builds the key on the few rows that
 * come back — same `artifactDedupKey`, same semantics.
 */
async function findPriorThreadArtifact(
  supabase: ReturnType<typeof createClient>,
  threadId: string,
  kind: string,
  value: string,
  source: string | null,
): Promise<PriorArtifact | null> {
  try {
    // Match the LEGACY spelling too. The exact-value SQL filter is the singular
    // writer's twin of the loader gap above: a thread holding a pre-change
    // "9175550123" is invisible to a lookup for the canonical "+19175550123",
    // so re-running an existing thread recreates the very duplicate this gate
    // exists to stop.
    const spellings = [value];
    if (kind.toLowerCase() === "phone") {
      const canonical = canonicalPhoneValue(value);
      const bare = value.replace(/[^\d]/g, "");
      for (const alt of [canonical, bare]) if (alt && !spellings.includes(alt)) spellings.push(alt);
    }
    const { data, error } = await supabase
      .from("artifacts")
      .select("id,kind,value,source,confidence")
      .eq("thread_id", threadId)
      .eq("kind", kind)
      .in("value", spellings);
    if (error || !Array.isArray(data)) return null;
    // Every spelling of the incoming value is an acceptable match, for the same
    // reason the SQL filter widened: the stored row may predate canonicalisation.
    const wanted = new Set(spellings.map((s) => artifactDedupKey({ kind, value: s, source })));
    for (const r of data as Array<Record<string, unknown>>) {
      const k = artifactDedupKey({
        kind: typeof r.kind === "string" ? r.kind : "",
        value: typeof r.value === "string" ? r.value : "",
        source: typeof r.source === "string" ? r.source : null,
      });
      if (wanted.has(k)) {
        return { id: String(r.id ?? ""), confidence: typeof r.confidence === "number" ? r.confidence : 0 };
      }
    }
  } catch (e) {
    console.warn("[record_artifact] thread dedup lookup failed:", (e as Error)?.message ?? e);
  }
  return null;
}

function isJinaHardBlocked(hostname: string): boolean {
  return JINA_HARD_BLOCK_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`));
}

// Google SERP pages specifically (not all of google.com — docs/drive/maps etc.
// are different concerns) reliably time out through Jina: consent/interstitial
// walls make r.jina.ai churn until the 18s cap. 3/3 in the same 2026-07-25
// sample. SERP-style queries should go through minimax_web_search/exa_search
// instead of scraping Google directly.
function isJinaGoogleSearchDeadEnd(hostname: string, pathname: string): boolean {
  return (hostname === "google.com" || hostname.endsWith(".google.com")) && pathname === "/search";
}

// ---- SocialFetch web-read host policy (2026-09-08 performance audit) ----------
// socialfetch_web_read's own fetchRetry call carries an 18s internal timeout,
// deliberately raised (2026-08-28) against real success-duration data up to
// 15.9s — that global cap must stay, and this policy does NOT touch it for
// ordinary hosts. But two specific hosts do not share that success distribution
// at all, per the 2026-09-08 production audit:
//
//   - t.me (Telegram): systematically aborts through THIS tool (2 sampled
//     18.1-18.4s AbortErrors), while jina_reader_scrape read the SAME host
//     successfully 7/7 times in the identical window (avg 2.9s). A proven
//     working alternative already exists, so there is no reason to pay the
//     18s tax here at all — skip immediately and point at it.
//   - youtube.com / youtu.be: 100% of the sampled attempts (both /watch and
//     /channel paths) aborted at ~18.2s, and jina_reader_scrape hard-blocks
//     these same hosts (JINA_HARD_BLOCK_HOSTS above), so there is no
//     proven-working reader for them today. Dropping the attempt entirely
//     would give up the rare case that WOULD succeed (a channel "About" page
//     can carry a real bio/social-link/email), so this fast-fails instead of
//     skipping outright — cuts the tax from ~18s to a few seconds without
//     giving up the chance completely.
//
// SCOPE: this is specific to socialfetch_web_read's OWN internal timeout. It
// does not touch JINA_HARD_BLOCK_HOSTS, the wrapper's TOOL_TIMEOUT_OVERRIDE_MS,
// or any other tool's routing.
export const SOCIALFETCH_TELEGRAM_HOSTS = ["t.me"] as const;
export const SOCIALFETCH_YOUTUBE_HOSTS = ["youtube.com", "youtu.be"] as const;
export const SOCIALFETCH_YOUTUBE_FAST_TIMEOUT_MS = 6_000;
export const SOCIALFETCH_DEFAULT_TIMEOUT_MS = 18_000;

// ── 2026-09-30: three hosts move from fast_timeout/normal to SKIP ────────────
// The block above explains why youtube was fast_timeout rather than skip: "there
// is no proven-working reader for them today", so a few seconds bought the rare
// channel-About page that might carry a bio. That precondition no longer holds —
// youtube_oembed, roblox_user and steam_profile land the same identity facts
// keylessly in ~300ms. The 14-day record to 2026-09-30 says the rare case never
// arrived either: 0 of 10 real youtube reads completed, 0 of 3 roblox, and every
// steamcommunity attempt aborted at the 18s cap.
//
// What the replacements do NOT recover is a channel-About bio or contact email —
// oembed returns title/channel/author_url only. That is a real, narrow loss, set
// against a measured 0% success rate for the thing that was supposedly preserving
// it.
export const SOCIALFETCH_ROBLOX_HOSTS = ["roblox.com"] as const;
export const SOCIALFETCH_STEAM_HOSTS = ["steamcommunity.com"] as const;

// Hosts that hang to the 18s cap AND that jina_reader_scrape can actually read.
// The jina-reachability half is not optional: x.com and twitter.com hang on
// SocialFetch too and were proposed for this list, but both are in
// JINA_HARD_BLOCK_HOSTS, so routing them here would hand them to a reader that
// refuses them and leave them with no reader at all. They stay on the normal
// path — not because it works, but because removing the only attempt on a thin
// sample is worse than an 18s abort. Revisit when a reader exists for them.
// Mirrors TOOL_TIMEOUT_OVERRIDE_MS.socialfetch_web_read in cache.ts. Duplicated
// rather than imported to keep tool-registry.ts free of a cache.ts dependency;
// socialfetch_fallback_test.ts asserts the two never drift.
export const SOCIALFETCH_WRAPPER_BUDGET_MS = 22_000;
// A jina attempt needs enough runway to be worth starting. Below this we return
// the classified timeout rather than burn the remainder on a near-certain abort.
export const SOCIALFETCH_FALLBACK_MIN_BUDGET_MS = 4_000;
export const SOCIALFETCH_FALLBACK_MAX_MS = 10_000;

export const SOCIALFETCH_SLOW_HOSTS = [
  "chess.com",
  "namemc.com",
  "gofundme.com",
  "scamadviser.com",
  "threads.net",
] as const;

/** Characters of converted document returned per `markdown_extract` call.
 *  Bounded to protect the turn's context budget; `next_offset` pages past it. */
export const MARKDOWN_EXTRACT_WINDOW = 12_000;

export type SocialfetchHostDecision =
  | { action: "skip"; hint: string }
  | { action: "fast_timeout"; timeoutMs: number }
  | { action: "normal" };

function hostMatchesAny(hostname: string, list: readonly string[]): boolean {
  return list.some((h) => hostname === h || hostname.endsWith(`.${h}`));
}

/** Pure — hostname in, decision out. No I/O, no clock, so it is directly
 *  unit-testable without a live fetch. */
export function socialfetchHostPolicy(hostname: string): SocialfetchHostDecision {
  if (hostMatchesAny(hostname, SOCIALFETCH_TELEGRAM_HOSTS)) {
    return {
      action: "skip",
      hint:
        "t.me reads reliably abort through socialfetch_web_read (~18s, production audit 2026-09-08) — " +
        "use jina_reader_scrape instead, which reads Telegram pages successfully.",
    };
  }
  if (hostMatchesAny(hostname, SOCIALFETCH_YOUTUBE_HOSTS)) {
    return {
      action: "skip",
      hint:
        "socialfetch_web_read has never completed a youtube.com/youtu.be read " +
        "(0 of 10 real attempts, 14 days to 2026-09-30) — use youtube_oembed, " +
        "which returns the video title, channel name and channel URL keylessly.",
    };
  }
  if (hostMatchesAny(hostname, SOCIALFETCH_ROBLOX_HOSTS)) {
    return {
      action: "skip",
      hint:
        "socialfetch_web_read times out on roblox.com (0 of 3, 2026-09-30) — use " +
        "roblox_user { username } or { user_id } for the profile instead.",
    };
  }
  if (hostMatchesAny(hostname, SOCIALFETCH_STEAM_HOSTS)) {
    return {
      action: "skip",
      hint:
        "socialfetch_web_read aborts at the 18s cap on steamcommunity.com — use " +
        "steam_profile { url } / { steamid64 } / { vanity } instead.",
    };
  }
  if (hostMatchesAny(hostname, SOCIALFETCH_SLOW_HOSTS)) {
    return {
      action: "skip",
      hint:
        "this host hangs to socialfetch_web_read's 18s cap — use jina_reader_scrape, " +
        "which reads it and costs nothing.",
    };
  }
  return { action: "normal" };
}

/** A 2xx body shorter than this is a blank page, an interstitial or an error
 *  document — never a page read worth recording as evidence. */
export const SOCIALFETCH_MIN_BODY_CHARS = 200;

/** An abort (our own cap or the SDK cancelling the step) rather than a fault.
 *  Matched on name AND message because fetch implementations disagree: Deno
 *  throws DOMException("AbortError"), some paths surface a plain TimeoutError,
 *  and fetchRetry can wrap either in an Error whose name is lost. */
export function isAbortLikeError(e: unknown): boolean {
  const name = (e as { name?: unknown })?.name;
  if (name === "AbortError" || name === "TimeoutError") return true;
  return /\babort(ed)?\b|\btimed? ?out\b|signal (is|has been) aborted/i.test(String(e));
}

/**
 * One free jina attempt for a URL SocialFetch could not read.
 *
 * Returns null when there is no budget left or jina also fails — the caller then
 * reports its own classified failure. SocialFetch is NEVER retried here: a retry
 * would spend a second credit on a provider that just demonstrated it cannot read
 * this page.
 *
 * ⚠️ HONEST LIMIT. The wrapper allows 22s and the internal cap is 18s, so a FULL
 * timeout leaves ~4s and jina gets ~3s against a measured 4.2s average — it will
 * usually miss. This path earns its keep on the fast failures (5xx, an early
 * abort, a cancelled step), not on the full-cap case. Do not "fix" that by
 * raising the wrapper or lowering the internal cap: both are pinned, and
 * tool_timeout_caps_test.ts asserts the wrapper stays above the internal budget
 * so the tool fails cleanly before the wrapper orphans an un-signalled request.
 * The real remedy for the full-cap case is not sending those hosts here at all,
 * which is what socialfetchHostPolicy now does.
 */
export async function socialfetchJinaFallback(
  url: string,
  startedAt: number,
  outerSignal?: AbortSignal,
): Promise<Record<string, unknown> | null> {
  const remaining = SOCIALFETCH_WRAPPER_BUDGET_MS - (Date.now() - startedAt);
  if (remaining < SOCIALFETCH_FALLBACK_MIN_BUDGET_MS) return null;
  // Leave a second of headroom so the fallback cannot be the thing that trips
  // the wrapper — a wrapper kill loses the classified result too.
  const budget = Math.min(remaining - 1_000, SOCIALFETCH_FALLBACK_MAX_MS);
  if (budget <= 0) return null;
  try {
    let clean: string;
    try { const u = new URL(url); u.hash = ""; clean = u.toString(); } catch { return null; }
    // jina hard-blocks a known set outright; spending the remaining budget to be
    // refused is strictly worse than returning the classified timeout now.
    try { if (isJinaHardBlocked(new URL(clean).hostname)) return null; } catch { return null; }
    const headers: Record<string, string> = { Accept: "text/plain" };
    if (JINA_API_KEY) headers.Authorization = `Bearer ${JINA_API_KEY}`;
    const signals: AbortSignal[] = [AbortSignal.timeout(budget)];
    if (outerSignal) signals.push(outerSignal);
    const r = await fetch(`https://r.jina.ai/${clean}`, {
      headers,
      signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    });
    if (!r.ok) return null;
    const text = await r.text();
    if (text.trim().length < SOCIALFETCH_MIN_BODY_CHARS) return null;
    return {
      ok: true,
      status: r.status,
      url: clean,
      via: "jina_fallback",
      data: text.slice(0, 18_000),
      truncated: text.length > 18_000,
      fallback_budget_ms: budget,
    };
  } catch {
    // A failed fallback is not a new fault to report — the caller already has a
    // classified primary failure that describes what actually went wrong.
    return null;
  }
}

// ---------------------------------------------------------------------------
// PERF-3 (#69): per-isolate schema cache.
// buildTools() runs on EVERY request, but the zod inputSchemas it constructs
// are pure and identical across requests — none of the 84 inline defs reads
// ctx (verified). Each schema is therefore built once per isolate (lazily, on
// the first request) and reused, instead of re-running ~84 z.object()
// constructions per request. Zod schemas are immutable, so sharing one
// instance across requests is safe.
// NOTE: keys MUST stay unique per call site (use the tool name) — a duplicate
// key would silently hand the second tool the first tool's schema.
const SCHEMA_CACHE = new Map<string, unknown>();
function memoSchema<T>(key: string, build: () => T): T {
  let cached = SCHEMA_CACHE.get(key);
  if (cached === undefined) {
    const built = build();
    // Every plain object schema gets the GENERIC selector rules (trim, enclosing quotes, number→string on selector
    // fields, a stringified-JSON root) — see lib/tool-input-coercion.ts. A schema that is already a preprocess (the
    // explicitly coerced tools, memory_save) is left to its own wrapper, which merges the generic rules itself.
    cached = built instanceof z.ZodObject ? coercedSchema(key, {}, built) : built;
    SCHEMA_CACHE.set(key, cached);
  }
  return cached as T;
}

// Near-miss input coercion (lib/tool-input-coercion.ts). Wraps an UNCHANGED object schema in a root z.preprocess — the
// same shape memory_save already uses — so the model-facing JSON schema is the inner object's. The coerced value is
// re-validated against `inner`; if it would still fail, the RAW input goes through and is rejected exactly as before.
// Kill switch INPUT_COERCION_DISABLED=true, read at call time inside applyInputCoercion.
function coercedSchema<T extends z.ZodTypeAny>(tool: string, spec: InputCoercionSpec, inner: T) {
  const merged = mergeInputSpecs(GENERIC_SELECTOR_SPEC, spec);
  return z.preprocess((raw) => applyInputCoercion(tool, raw, merged, (v) => inner.safeParse(v).success), inner);
}

// "address" was added to gemini_deep_dork / dork_harvest kind enums together with input coercion; under the kill switch
// it is refused again so INPUT_COERCION_DISABLED=true restores the pre-change strict schema in full.
const ADDRESS_KIND_GATE = (k: string) => k !== "address" || !inputCoercionDisabled();
const ADDRESS_KIND_GATE_MSG = { message: "kind \"address\" is not accepted while INPUT_COERCION_DISABLED=true" };
const QUERY_TO_SEED = [{ to: "seed", from: "query", coercion: "seed_from_query" as const }];
// A missing google_dorks `kind` is read off the seed's SHAPE (free tool, so a bare token may read as a username).
// NOT a person name: measured 2026-10-21 (thread 0ea52455) `{query: "<two-word name>"}` was renamed to `seed`, no
// kind could be inferred, the coerced value failed validation and the RAW input was rejected — the log read "seed
// undefined" although the rename had run. That rejection is the designed outcome, kept: detectSeedServer labels ANY
// few-word prose `person` ("look into this for me" included), so mapping it to the `name` kind would route prose
// into the name dork family. Pinned by input_kind_inference_test.ts ("a name is not guessed from prose").
const DORK_KIND_FROM_SEED = {
  kind: {
    from: "seed",
    infer: (v: string) => {
      const k = inferSelectorKind(v, detectSeedServer, { allowUsername: true });
      return k === "crypto" ? "crypto_wallet" : k;
    },
  },
};
// serus_darkweb_scan is PAID: only unambiguous shapes are inferred, never a bare-token username.
export const SERUS_INPUT_SPEC: InputCoercionSpec = {
  enumFields: { identifierType: ["email", "phone", "username", "domain", "keyword", "origin", "password"] },
  renames: [
    { to: "identifierValue", from: "identifier", coercion: "field_alias" },
    { to: "identifierValue", from: "value", coercion: "field_alias" },
    { to: "identifierType", from: "type", coercion: "field_alias" },
  ],
  stringFields: ["identifierValue"],
  trimFields: ["identifierValue"],
  infer: {
    identifierType: {
      from: "identifierValue",
      infer: (v: string) => {
        const k = inferSelectorKind(v, detectSeedServer);
        return k === "ip" ? "origin" : k === "crypto" ? null : k;
      },
    },
  },
};

/**
 * Canonicalize a SocialFetch platform argument.
 *
 * SocialFetch's four structured platforms are keyed 'tiktok' | 'instagram' |
 * 'twitter' | 'facebook', but the model reaches for the name the site actually
 * uses today ('x') or for the host it found the profile on ('x.com',
 * 'instagram.com'). Previously the value was only lowercased, so every one of
 * those spellings missed the SUPPORTED set and returned the unsupported no-op —
 * a silent miss on a corroborated handle, not an error the model could react to.
 *
 * Deliberately narrow: this maps spellings of the SAME four supported platforms.
 * It must never map an unsupported host (youtube, reddit, twitch) onto a
 * supported key — those genuinely are not SocialFetch profile routes and must
 * keep falling through to the no-op that redirects to socialfetch_web_read.
 */
export function normalizeSocialPlatform(platform: unknown): string {
  const raw = String(platform ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
  const ALIASES: Record<string, string> = {
    x: "twitter",
    "x.com": "twitter",
    "twitter.com": "twitter",
    tweet: "twitter",
    ig: "instagram",
    "instagram.com": "instagram",
    "tiktok.com": "tiktok",
    tt: "tiktok",
    fb: "facebook",
    "facebook.com": "facebook",
    "fb.com": "facebook",
  };
  return ALIASES[raw] ?? raw;
}

/** The most recent `quota` LeakCheck reported, shared by every investigation on this isolate: the
 *  quota belongs to the ACCOUNT, so any run's last reading is valid for all of them. Null = unknown,
 *  which the guard treats as "allow" (see lib/leakcheck-guard.ts). */
let lastLeakcheckQuota: number | null = null;

export function buildTools(ctx: ToolContext) {
  const { supabase, supabaseAdmin, userId, threadId, archiveEnabled, detectedSeedType, messages, manualOverrideSelector } = ctx;

  // ── record-name-quarantine: request-local state + one loader for BOTH writers ──
  // Quarantined findings extracted in THIS request, noted synchronously by
  // index.ts's onStepFinish BEFORE the detached auto-persist write lands. Without
  // it, a record_artifacts call in the very next step races that insert, reads no
  // quarantined name, and writes the same-name rows at full authority.
  const pendingQuarantineRows: ThreadRow[] = [];
  const noteQuarantinedFindings = (
    findings: ReadonlyArray<{ kind: string; value: string; context?: Record<string, unknown> }>,
  ): void => {
    for (const f of findings ?? []) {
      if (f?.context?.subject_unlinked === true) {
        pendingQuarantineRows.push({ kind: f.kind, value: f.value, metadata: f.context });
      }
    }
  };
  /** The seed the exemption compares against: the request's PERSON seed, or none.
   *  Never triageState.seed: that is whatever email/username the model passed to
   *  triage_seed, and tokens() splits "jordan.vale@…" into the name "Jordan Vale",
   *  so a namesake escaped. The auto-persist gate exempts a person seed only. */
  const quarantineSeed = (): string | null => ctx.getSubjectSeedName?.() || null;
  /** Thread + pending quarantined person names. Fails OPEN on a read error: an
   *  authority stamp must not turn a DB blip into stamping every row. */
  const loadQuarantinedNames = async (): Promise<QuarantinedName[]> => {
    let rows: ThreadRow[] = [];
    try {
      const res = await loadRefusedArtifacts(
        async (from, to) => {
          const { data, count, error } = await supabase
            .from("artifacts")
            .select("kind,value,metadata", { count: "exact" })
            .eq("thread_id", threadId)
            .in("kind", ["name", "person", "source_person"])
            .order("created_at", { ascending: true })
            .order("id", { ascending: true })
            .range(from, to);
          return { data: (data ?? null) as QuarantineRow[] | null, count, error };
        },
        () => "",
      );
      rows = res.rows;
      if (!res.complete) {
        console.warn(JSON.stringify({ event: "record_name_quarantine_read_incomplete", thread_id: threadId, rows: res.rows.length, reason: res.reason }));
      }
    } catch (e) {
      console.warn(JSON.stringify({ event: "record_name_quarantine_read_failed", thread_id: threadId, error: String(e).slice(0, 200) }));
    }
    return quarantinedPersonNames([...rows, ...pendingQuarantineRows]);
  };

  const tools = {
    list_tools: tool({
      description:
        "Returns the OSINT tool catalog, per-seed fan-out recipes, finding-label rules, and tools disabled by provider configuration. Triage and expected-value signals never hide otherwise available tools.",
      inputSchema: memoSchema("list_tools", () => z.object({}).strict()),
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
        // Parity (Fix #4): the schema readiness gate (capabilities.ts) and the
        // planner filter both strip these when their key is absent, but list_tools
        // was still advertising them — so the agent saw a tool the runtime had
        // deleted. Gate them here too, matching the HIBP treatment above.
        if (!INDICIA_API_KEY) {
          for (const n of ["indicia_email","indicia_phone","indicia_person","indicia_address","indicia_web_dbs","indicia_hudsonrock"]) {
            disabled.push({ name: n, reason: "INDICIA_API_KEY not configured — Indicia person/phone/email/address + web-DB lookups are unavailable." });
          }
        }
        if (!PEOPLEDATALABS_API_KEY) {
          disabled.push({
            name: "pdl_person_enrich",
            reason: "PEOPLEDATALABS_API_KEY not configured — People Data Labs Person Enrichment is unavailable.",
          });
        }
        if (!GEMINI_API_KEY) {
          disabled.push({
            name: "gemini_vision",
            reason: "GEMINI_API_KEY not configured — image/document reading (vision) is unavailable; record attachments as URLs only.",
          });
        }
        if (!Deno.env.get("GEOSEER_API_KEY")) {
          disabled.push({
            name: "geoseer_geolocate",
            reason: "GEOSEER_API_KEY not configured — AI image geolocation is unavailable; do not attempt to infer capture locations from photos.",
          });
        }
        if (!OPSIS_API_KEY || opsisKillSwitchOn()) {
          for (const n of ["opsis_search", "opsis_results", "opsis_balance", "opsis_status"]) {
            disabled.push({ name: n, reason: "Opsis is not configured or is switched off — use username_sweep for account enumeration." });
          }
        }
        // Config-disabled providers (`disabled: true` in capabilities.ts's
        // PROVIDER_REQUIREMENTS) were NEVER gated here — only the key-presence
        // checks above were, so the "Fix #4" parity note applies to exactly half
        // the problem. A tool the runtime had deliberately removed stayed in the
        // catalog the model reads, complete with its `when_to_use` instruction, so
        // the model kept calling it; the name is absent from the live registry, so
        // repairUnknownTool redirected it to the sink, which returned ok:true.
        //
        // Measured before this fix: dork_harvest, deepfind_reverse_email and
        // ipqualityscore_lookup were all disabled AND still advertised, and
        // unknown_tool_ignored logged 127 calls between 2026-07-09 (hours after
        // dork_harvest was disabled) and 2026-07-30 — 127 of 127 recorded ok. Each
        // burned a step, was cached, and surfaced in the evidence export as e.g.
        // "dork_harvest(completed)", telling an analyst that document/leak dorking
        // had run when it never executed.
        //
        // Deriving the list rather than hand-maintaining it means the next tool
        // disabled in config is gated here for free.
        for (const [name, req] of Object.entries(PROVIDER_REQUIREMENTS)) {
          if (req.disabled && !disabled.some((d) => d.name === name)) {
            disabled.push({ name, reason: "disabled in provider configuration — do not call it." });
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
        "Optional early classification for email or username seeds. Records a `triage_decision` artifact but never unlocks or blocks other tools.",
      inputSchema: memoSchema("triage_seed", () => z.object({
        seed: z.string().min(1),
        type: z.enum(["email", "username"]),
      })),
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
      inputSchema: memoSchema("minimax_web_search", () => z.object({
        query: z.string().min(2).describe("Search query, e.g. \"alice@example.com\" leak OR breach"),
        focus: z.string().optional().describe("Optional steering hint, e.g. 'find social profiles', 'find leaks'"),
      })),
      execute: async ({ query, focus }) => {
        // Absent key → skip the Perplexity sub-path silently (log-only). Return a
        // clean, empty result (NOT an error string) so the orchestrator falls
        // through to its other search tools (exa_search, google_dorks, …) instead
        // of surfacing "PERPLEXITY_API_KEY not configured" into tool output.
        if (!PERPLEXITY_API_KEY) {
          console.warn("[minimax_web_search] PERPLEXITY_API_KEY not configured — skipping web-search provider");
          return { ok: false, skipped: true, provider_unavailable: true, answer: "", citations: [] };
        }
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
            // Dead/unauthorized key (401) or forbidden (403): the Perplexity
            // sub-path adds no value and its raw upstream error body must NOT
            // leak into tool output (testers were seeing `perplexity 401: {...}`,
            // 5× in live logs 2026-07-09). Log the body internally for ops, then
            // return a clean, empty "skipped" result so the orchestrator falls
            // through to its other search tools. Non-auth failures (429/5xx) keep
            // the existing surfaced-status behavior — they are transient, not a
            // dead key, and the planner uses the status to decide on retry.
            if (r.status === 401 || r.status === 403) {
              console.warn(`[minimax_web_search] perplexity ${r.status} (auth) — skipping provider for query="${query.slice(0,120)}": ${body.slice(0, 300)}`);
              return { ok: false, skipped: true, provider_unavailable: true, answer: "", citations: [] };
            }
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
      inputSchema: memoSchema("minimax_extract", () => z.object({
        text: z.string().min(1).max(20000),
        context: z.string().optional().describe("What the blob is, e.g. 'github bio for handle xyz'"),
      })),
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
        "Have MiniMax correlate and rescore a batch of artifacts. Pass the relevant artifacts gathered so far; it returns identity clusters, dedup mapping, confidence rescoring, and contradiction flags. Run after at least three meaningful new artifacts or before final verification. A repeat call after a successful pass is skipped (no cost) if fewer than three new artifacts have been recorded since — keep gathering evidence first.",
      inputSchema: memoSchema("minimax_correlate", () => coercedSchema("minimax_correlate", { stringFields: ["seed"], trimFields: ["seed"], jsonFields: ["artifacts"] }, z.object({
        // Optional at the SCHEMA so a call that omits it is not rejected before execute (measured
        // 2026-10-21: `{artifacts}` alone). execute resolves it from the request (lib/thread-seed.ts)
        // or returns the uncharged skip below saying what was tried.
        seed: z.string().optional().describe("Original seed identifier. If omitted, the request's own seed is used."),
        // Models frequently pass `artifacts` as a JSON STRING; coerce to an
        // array before validating (same as record_artifacts) so a stringified
        // batch doesn't fail correlation and lose the run's findings.
        // …and an array whose ELEMENTS are JSON strings parses element by element (lib/memory-input-normalization.ts).
        artifacts: z.preprocess((raw) => parseStringArtifactElements(coerceArtifactsInput(raw)), z.array(z.object({
          kind: z.string(),
          value: z.string(),
          source: z.string().optional(),
          confidence: z.number().optional(),
          metadata: z.unknown().optional(),
        })).max(200)),
      }))),
      execute: async ({ seed: seedIn, artifacts }, opts) => {
        // Input guard: never spend a paid MiniMax call on an empty/invalid
        // payload. The counter check below tracks how many NEW artifacts were
        // recorded, but the model can still invoke this with no seed or an
        // empty / malformed `artifacts` array — correlating nothing is pure
        // waste. Gate on the actual inputs, not just the counter.
        // A missing seed is resolved from the REQUEST (lib/thread-seed.ts): the person seed,
        // then the first user message's selector. Disclosed in the result as `seed_source`.
        const resolved = resolveCorrelateSeed({
          seed: seedIn,
          subjectName: ctx.getSubjectSeedName?.() ?? "",
          messages: messages as unknown as Array<{ role?: string; parts?: Array<{ type?: string; text?: string }> }>,
          detect: detectSeedServer,
        });
        const seed = resolved.seed;
        const cleanSeed = seed;
        if (resolved.source && resolved.source !== "input") {
          console.log(JSON.stringify({ event: "correlate_seed_defaulted", thread_id: threadId, source: resolved.source }));
        }
        const validArtifacts = Array.isArray(artifacts)
          ? artifacts.filter((a) => a && typeof a.value === "string" && a.value.trim().length > 0)
          : [];
        if (!cleanSeed || validArtifacts.length === 0) {
          const seedWord = cleanSeed
            ? "present"
            : `missing — not sent, and no fallback resolved (tried: ${resolved.tried.join(", ") || "none"})`;
          return skipStub(
            "minimax_correlate",
            `no valid inputs to correlate (seed ${seedWord}; ${validArtifacts.length} valid artifacts). Pass \`seed\` (the investigation's seed value) and \`artifacts\` as an ARRAY of {kind, value, …} objects.`,
            { seedProvided: !!cleanSeed, seedSource: resolved.source, validArtifactCount: validArtifacts.length },
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
            // Best-effort: forward the wrapper's per-tool timeout AbortSignal (#284
            // kept the 30s cap so a legitimately-slow ~22.5s completion is still USED).
            // Without this the correlate model call was orphaned — it kept running
            // past the cap and could cascade an off-ledger fallback LLM. Forwarding
            // the signal cancels the in-flight fetch AT the cap and suppresses that
            // fallback (providers.ts guards on opts.signal?.aborted). Clustering does
            // not depend on this tool — the deterministic local union-find (index.ts)
            // runs regardless — so a cancelled correlate costs the run nothing.
            signal: (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal,
          });
          const parsed = safeJson<Record<string, unknown>>(r.content) ?? { raw: r.content };
          resetCorrelateCycle();
          return { ok: r.ok, status: r.status, analysis: parsed, ...(resolved.source && resolved.source !== "input" ? { seed_source: resolved.source } : {}) };
        } catch (e) { return { error: String(e) }; }
      },
    }),
    minimax_plan_pivots: tool({
      description:
        "Plan the next bounded investigation cycle. Returns structured JSON with stage, goal, current_findings, proposed_calls[], and calls_rejected[]. Use it before any non-planner pivot batch so the investigation stays budgeted, cache-aware, and evidence-led.",
      // Payload caps lowered from 200/200 (2026-07-30 production audit). The
      // planner's latency scales with how much context it has to read, and at the
      // old ceilings it structurally ran 15-25s against a 12s wrapper cap. The
      // timeout override in cache.ts is half the fix; this is the other half —
      // raising the cap alone would just pay for an oversized prompt. A pivot
      // planner does not need the entire artifact set to choose the next batch:
      // it needs enough context to avoid re-querying and to see the current shape
      // of the evidence, which 60/80 covers. Keeping the payload bounded is also
      // what keeps the 45s override honest calibration rather than a blank cheque.
      inputSchema: memoSchema("minimax_plan_pivots", () => z.object({
        seed: z.string(),
        already_queried: z.array(z.string()).max(80).default([]),
        artifacts: z.preprocess(coerceArtifactsInput, z.array(z.object({ kind: z.string(), value: z.string() })).max(60)),
        budget_remaining: z.number().int().min(0).max(100).default(30),
      })),
      execute: async ({ seed, already_queried, artifacts, budget_remaining }) => {
        try {
          const baseToolList = [
            // Breach + identity
            "rapidapi_breach_search","rapidapi_all_breaches",
            "breach_check","leakcheck_lookup","hibp_lookup","oathnet_lookup",
            // OathNet v2 expansion — stealer logs, victim manifests, domain subdomains,
            // and breach-efficiency helpers (shared 500/day pool). Archive is manual-only.
            "oathnet_stealer_search","oathnet_victims_search","oathnet_victim_manifest",
            "oathnet_victim_file","oathnet_subdomains","oathnet_breach_dbnames","oathnet_ai_filter",
            "oathnet_scanner",
            "bosint_email_lookup",
            "serus_darkweb_scan",
            // Indicia — US person/phone/email/address + web-DB breach aggregator.
            "indicia_email","indicia_phone","indicia_person","indicia_address",
            "indicia_web_dbs","indicia_hudsonrock",
            // People Data Labs Person Enrichment — ~3B profile enrichment API.
            "pdl_person_enrich",
            // DeepFind suite (shared 1000/day pool).
            "deepfind_reverse_email","deepfind_disposable_email",
            "deepfind_ssl_inspect","deepfind_tech_stack","deepfind_url_unshorten",
            "deepfind_telegram_channel","deepfind_telegram_search",
            "deepfind_vin_lookup","deepfind_aircraft_lookup","deepfind_vessel_lookup",
            "deepfind_mac_lookup","deepfind_dark_web_link",
            "deepfind_email_breach","deepfind_transaction_viewer",
            // Profile / social
            "socialfetch_lookup","socialfetch_web_read","cordcat_discord_lookup","github_user","github_code_search",
            "hackernews_user","reddit_user","gravatar_profile",
            // Free keyless profile readers. These MUST be here, not only in the
            // system prompt: `socialfetch_web_read` now skips youtube / roblox /
            // steamcommunity and its hint names these as the replacement, so a
            // planner menu without them routes the pivot nowhere. (The copy in
            // tools/minimax.ts is dead code — nothing imports it. This inline
            // list is the one `buildTools()` actually ships.)
            "youtube_oembed","roblox_user","steam_profile",
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
          //   hackernews_user       0% ok
          //   gravatar_profile     14% ok (404s; already demoted in #171)
          //   ipqualityscore_lookup 0/28 ok — dead key ("Invalid or unauthorized
          //                        key" for 30d); cut 2026-07-05.
          // NB: hibp_lookup (0%) stays on its API-key gate (valuable once keyed) and
          // is NOT hard-blocked. ipqualityscore is now hard-cut (dead key) and is
          // ALSO hard-disabled in capabilities.ts (disabled:true) so the readiness
          // gate deletes it from the tool schema entirely; keeping it here is
          // belt-and-suspenders for the planner menu. (The permanently-dead
          // stolentax_footprint / synapsint_lookup / emailrep tools were removed
          // from the codebase entirely in the dead-tool cull.)
          const PERMANENT_BLOCK = new Set([
            "hackernews_user",
            "gravatar_profile","ipqualityscore_lookup",
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
            // People Data Labs Person Enrichment — keep off the planner menu
            // until PEOPLEDATALABS_API_KEY is set (same gate as Indicia).
            if (name === "pdl_person_enrich" && !PEOPLEDATALABS_API_KEY) return false;
            // Gemini vision/document reader — only works with GEMINI_API_KEY; keep
            // it off the planner menu when unkeyed (same gate as gemini_deep_dork).
            if (name === "gemini_vision" && !GEMINI_API_KEY) return false;
            // GeoSeer image geolocation — paid per call; keep it off the planner
            // menu when unkeyed.
            if (name === "geoseer_geolocate" && !Deno.env.get("GEOSEER_API_KEY")) return false;
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

          // ---------------------------------------------------------------
          // ANALYST AUTHORITY BOUNDARY. Everything below feeds MODEL REASONING —
          // the relationship graph, the per-kind pivot hints, and the artifact
          // list serialized into the planner prompt. It is therefore subject to
          // the analyst's verdicts, and it was NOT: this block read artifacts raw
          // while `lib/cluster.ts` (the persisted-cluster path, ~:477) has always
          // loaded reviews and called `dropRejectedArtifacts` before clustering.
          //
          // Live consequence, thread b74049ad (2026-09-08): the analyst rejected
          // an entire breach-derived identity branch, and the planner kept
          // receiving it as "Connected identity clusters" — so rejected evidence
          // continued to steer tool selection and "most likely identity"
          // reasoning, which is exactly what the analyst had just refused.
          //
          // FAILS CLOSED. Unavailable review state is not "nothing rejected": on
          // an unreadable verdict the graph/pivot evidence is omitted rather than
          // published unfiltered. Same posture `dropRejectedArtifacts` already
          // takes, for the same reason.
          const reviewLoad = await loadReviewsForThread(supabaseAdmin as unknown as ReviewDb, threadId, userId);
          // The thin {kind,value} list is supplied by the MODEL, so it can name a
          // rejected selector even when the table read is clean. Keyed on
          // kind|value like every other rejection check — never on value alone.
          const plannerArtifacts = reviewLoad.ok
            ? (artifacts as Array<{ kind: string; value: string }>).filter(
              (a) => !isRejectedByReview(reviewLoad, a?.kind, a?.value),
            )
            : [];
          console.log(JSON.stringify({
            event: "analyst_decisions_applied",
            thread_id: threadId,
            surface: "planner",
            review_state_ok: reviewLoad.ok,
            decisions: reviewLoad.byId.size,
            rejected_keys: reviewLoad.rejectedKeys.size,
            input_artifacts_in: Array.isArray(artifacts) ? artifacts.length : 0,
            input_artifacts_kept: plannerArtifacts.length,
          }));

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
                // subject + related_values are what supersession keys on.
                .select("kind,subject,related_values,content,confidence")
                .eq("user_id", userId)
                .or(agentMemoryOrFilter(seedNorm))
                .order("confidence", { ascending: false })
                .limit(12);
              // A human ruling outranks a model memory. Before this, the agent's own
              // pre-review theory ("belonged to X, handle transferred", 74) and the
              // analyst's later FALSE lesson about the same selector (95) both reached
              // the planner, ordered by confidence — contradictory instructions in
              // one prompt (live: thread b74049ad). Superseded rows are withheld
              // here, not deleted; they remain in agent_memory for audit.
              const { active, superseded } = applyMemorySupersession(
                (mem ?? []) as MemoryRow[],
                enforcedRejectedRows(reviewLoad),
              );
              if (superseded.length) {
                console.log(JSON.stringify({
                  event: "memory_superseded",
                  thread_id: threadId,
                  surface: "planner",
                  active: active.length,
                  superseded: superseded.length,
                  by_thread_review: superseded.filter((x) => x.source === "thread_review").length,
                  by_analyst_lesson: superseded.filter((x) => x.source === "analyst_lesson").length,
                }));
              }
              const rows = active.slice(0, 8);
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
              // `id` is REQUIRED: dropRejectedAndDerived matches artifact_reviews
              // by id, so omitting it leaves the verdict half-blind (only
              // DB-resolved value keys would filter).
              .select("id,kind,value,confidence,source,metadata")
              .eq("thread_id", threadId)
              .order("created_at", { ascending: true });
            const arts = dropRejectedAndDerived(
              (fullArts ?? []) as Array<Record<string, unknown>>,
              reviewLoad,
            ) as unknown as Parameters<typeof buildNodes>[0];
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
            for (const a of (plannerArtifacts as Array<{ kind?: string }>)) {
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
              `You are the execution planner for a forensic OSINT runtime. ONLY propose tools from this EXACT list (names must match verbatim — do not invent or rename): ${toolList.join(", ")}.\n\n${NAME_SEED_PLANNER_RULES}\n\nRUNTIME RULES:\n- Stage choices: TRIAGE, REVIEW, TARGETED_PIVOT, VERIFY, REPORT.\n- Propose the FEWEST pivots that can advance the investigation — at most 3 per cycle, ordered by expected value. Breadth is not progress: a cycle that runs 20 tools and learns nothing is worse than one that runs 2 and resolves a question. Prefer ONE decisive pivot on the strongest selector over a wide sweep across weak ones. Only propose a second or third when it is genuinely INDEPENDENT (different source class, different question) — not the same question asked of another provider. Serialize whenever a pivot's value depends on what a prior pivot returns.\n- Respect the hard total-call and concurrency ceilings enforced by the runtime.\n- Weak-lead and expected-value signals are advisory. Do not turn them into prerequisites or retry loops.\n- Prefer the cheapest tool that can answer the current question: run FREE/LOW-cost validation before spending on EXPENSIVE/premium tools (see TOOL COST TIERS in the context below). Cost is advisory — never drop a uniquely high-value lead just because it is expensive.\n- When a finding is breach-derived or otherwise confidence-capped, propose ONE independent, trusted NON-infrastructure source to corroborate it and lift the cap, rather than re-running the same breach source.\n- Cached results NEVER count as corroboration. If a fresh cache hit would satisfy the question, prefer it over a live call.\n- If evidence is weak, explain that in the reason and keep the result [VERIFY].\n\nReply ONLY with JSON matching this exact shape:\n{\n  "stage":"TRIAGE|REVIEW|TARGETED_PIVOT|VERIFY|REPORT",\n  "goal":"string",\n  "current_findings":["string"],\n  "proposed_calls":[{\n    "tool_name":"exact_tool_name",\n    "selector":"string",\n    "selector_type":"string",\n    "params_preview":{},\n    "expected_value":0,\n    "cost_tier":"free|low|expensive",\n    "reason":"string",\n    "stop_condition":"string",\n    "cache_status":"thread|user|stale|miss"\n  }],\n  "calls_rejected":[{\n    "tool_name":"exact_tool_name",\n    "selector":"string",\n    "selector_type":"string",\n    "expected_value":0,\n    "reason":"string",\n    "cost_tier":"free|low|expensive",\n    "weak_lead":true,\n    "stale_cache":false,\n    "manual_override":false\n  }]\n}\nOrder proposed_calls by expected_value descending. Respect budget_remaining as the max number of proposed_calls.`,
            user: `Seed: ${seed}\nBudget remaining: ${budget_remaining}\nAlready queried: ${JSON.stringify(already_queried).slice(0,4000)}\nArtifacts so far: ${JSON.stringify(plannerArtifacts).slice(0,8000)}${reviewLoad.ok ? "" : "\n(Analyst review state could not be read this cycle — prior artifacts are withheld rather than shown unfiltered. Re-derive from the seed.)"}\n\n${costGuide}${relationshipHint}${pivotHint}${memoryHint}`,
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
                const nodes = buildNodes(plannerArtifacts as Array<{ kind: string; value: string }>);
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
      inputSchema: memoSchema("osint_navigator_query", () => z.object({
        query: z.string().describe("Natural-language question, e.g. 'tools to find who registered a domain' or 'image verification tools'"),
        skip_cache: z.boolean().optional().default(false),
      })),
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
      inputSchema: memoSchema("osint_navigator_search", () => z.object({
        query: z.string().describe("Keyword(s), e.g. 'whois', 'archive', 'vessel tracking'"),
        category: z.string().optional().describe("Optional category slug; omit to broaden"),
        limit: z.number().int().min(1).max(25).optional().default(10),
      })),
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
      inputSchema: memoSchema("oathnet_lookup", () => coercedSchema("oathnet_lookup", {
        enumFields: { type: ["email", "username", "phone", "ip", "domain", "name"] },
        // The Serus spelling of the same two fields: measured 2026-10-21 (thread 0ea52455), three parallel
        // `{identifierType, value}` calls rejected on `type`. Spelling only; the value still has to be one of
        // the enum values above and is re-validated.
        renames: [
          { to: "type", from: "identifierType", coercion: "field_alias" },
          { to: "value", from: "identifierValue", coercion: "field_alias" },
          { to: "value", from: "identifier", coercion: "field_alias" },
        ],
        stringFields: ["value"],
        trimFields: ["value"],
      }, z.object({
        type: z.enum(["email", "username", "phone", "ip", "domain", "name"]),
        value: z.string(),
        dbnames: z.array(z.string()).max(20).optional().describe("Optional v2 breach DB scoping (names from oathnet_breach_dbnames) to narrow the corpus."),
        filter_id: z.string().optional().describe("Optional 24-char AI/manual filter context from oathnet_ai_filter to reuse."),
      }))),
      execute: async ({ type, value, dbnames, filter_id }, opts) => {
        if (!OATHNET_API_KEY) return { error: "OATHNET_API_KEY not configured" };
        if (oathnetExhausted()) return skipStub("oathnet_lookup", `OathNet pooled daily quota exhausted (${oathnetQuotaLeft()} left today) — the oathnet_* family is soft-disabled for this run.`, { quota_left: oathnetQuotaLeft() });
        try {
          // ip → ip-info; domain → email_domain breach; the free-text q-types use the
          // richer v2 builder only when dbname/filter scoping is requested (else the
          // existing, unit-tested buildOathnetUrl path is preserved byte-for-byte).
          const url = (type !== "ip" && type !== "domain" && ((dbnames && dbnames.length) || filter_id))
            ? oathnetBreachSearchUrl(value, { dbnames, filter_id })
            : buildOathnetUrl(type, value);
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
          noteOathnetQuota(data);
          // HTTP 200 with an empty breach payload is a successful negative — not a
          // provider failure (inflated the 23% "failure" rate in beta telemetry).
          if (r.ok) return { ok: true, status: r.status, data, quota_left: oathnetQuotaLeft() };
          return { ok: false, status: r.status, data, quota_left: oathnetQuotaLeft() };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),
    // ── OathNet v2 expansion (stealer / victims / domain / efficiency) ─────────
    // Shared 500/day POOLED quota: every oathnet_* tool gates on oathnetExhausted()
    // and updates the pool from each response's echoed remaining-count. Stealer/victim
    // payloads carry raw credentials/cookies — trimmers in oathnet.ts strip/mask them so
    // no plaintext secret enters model context or an artifact (see oathnet_test.ts).
    oathnet_stealer_search: tool({
      description:
        "OathNet v2 STEALER-LOG credential search — the highest-value infostealer surface. Query an email/username/domain/IP/discord_id selector; returns credential records (log id, captured url/domain/subdomain/path, username, email, dates). Raw PASSWORDS/COOKIES are redacted by design — you get a `credential_present` boolean, not the secret. Set has_log_id=true to keep only rows that pivot into a victim log (then use oathnet_victims_search / oathnet_victim_manifest). Every hit is a LEAD until corroborated; label [VERIFY]. Shares the 500/day OathNet pool.",
      inputSchema: memoSchema("oathnet_stealer_search", () => z.object({
        value: z.string().describe("Selector: email / username / domain / ip / discord_id"),
        has_log_id: z.boolean().optional().describe("Keep only rows that can pivot into a victim log"),
        domains: z.array(z.string()).max(10).optional().describe("Scope to captured host domains, e.g. ['google.com']"),
        filter_id: z.string().optional().describe("Reuse an oathnet_ai_filter context id"),
      })),
      execute: async ({ value, has_log_id, domains, filter_id }, opts) => {
        if (!OATHNET_API_KEY) return { error: "OATHNET_API_KEY not configured" };
        if (oathnetExhausted()) return skipStub("oathnet_stealer_search", `OathNet pooled daily quota exhausted (${oathnetQuotaLeft()} left today).`, { quota_left: oathnetQuotaLeft() });
        try {
          const url = oathnetStealerSearchUrl(value, { hasLogId: has_log_id, domains, filter_id });
          const signal = (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
          const r = await fetchRetry(url, { headers: { "x-api-key": OATHNET_API_KEY }, signal }, { retries: 1, timeoutMs: 20_000 });
          const text = await r.text();
          let data: unknown;
          try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 2000) }; }
          noteOathnetQuota(data);
          if (!r.ok) return { ok: false, status: r.status, error: `oathnet stealer ${r.status}`, quota_left: oathnetQuotaLeft() };
          const d = (data as { data?: { items?: unknown; meta?: { total?: number } } })?.data;
          const items = Array.isArray(d?.items) ? d!.items : [];
          return {
            ok: true, status: r.status,
            count: items.length, total: d?.meta?.total ?? items.length,
            items: trimStealerItems(items, 25, REVEAL_BREACH_DATA),
            quota_left: oathnetQuotaLeft(),
            note: REVEAL_BREACH_DATA
              ? "Stealer rows are LEADS until corroborated. Account-authorized full reveal is ON — raw passwords/cookies ARE included; record every concrete credential value found. Label identity pivots [VERIFY]."
              : "Stealer rows are LEADS until corroborated. Passwords/cookies are redacted — do NOT record raw credentials; record identity pivots (log_id, domains, username/email) as [VERIFY].",
          };
        } catch (e) { return { error: String(e) }; }
      },
    }),
    oathnet_victims_search: tool({
      description:
        "OathNet v2 VICTIM-manifest search — find compromised hosts (stealer-log victims) tied to a selector. Returns victim device metadata keyed by log_id: device usernames, HWIDs, device IPs, device emails, linked discord_ids, doc counts, dates. " +
        (REVEAL_BREACH_DATA
          ? "Account-authorized full reveal is ON: raw credential fields carried on a victim row ARE returned — record every concrete value found. " +
            "Pivot a returned log_id into oathnet_victim_manifest (file tree) → oathnet_victim_file, which returns UNMASKED file content under the same reveal policy — that is where the bulk of the captured credentials live, so pivot there and record what it returns. "
          : "No raw credentials. " +
            "Pivot a returned log_id into oathnet_victim_manifest (file tree) → oathnet_victim_file (redacted content). ") +
        "total_docs_min filters to richer logs. Every hit is a LEAD; label [VERIFY]. Shares the 500/day OathNet pool.",
      inputSchema: memoSchema("oathnet_victims_search", () => z.object({
        value: z.string().describe("Selector: email / username / ip / discord_id / domain"),
        total_docs_min: z.number().int().min(0).optional().describe("Only logs with at least N documents"),
        filter_id: z.string().optional(),
      })),
      execute: async ({ value, total_docs_min, filter_id }, opts) => {
        if (!OATHNET_API_KEY) return { error: "OATHNET_API_KEY not configured" };
        if (oathnetExhausted()) return skipStub("oathnet_victims_search", `OathNet pooled daily quota exhausted (${oathnetQuotaLeft()} left today).`, { quota_left: oathnetQuotaLeft() });
        try {
          const url = oathnetVictimsSearchUrl(value, { totalDocsMin: total_docs_min, filter_id });
          const signal = (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
          const r = await fetchRetry(url, { headers: { "x-api-key": OATHNET_API_KEY }, signal }, { retries: 1, timeoutMs: 20_000 });
          const text = await r.text();
          let data: unknown;
          try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 2000) }; }
          noteOathnetQuota(data);
          if (!r.ok) return { ok: false, status: r.status, error: `oathnet victims ${r.status}`, quota_left: oathnetQuotaLeft() };
          const d = (data as { data?: { items?: unknown; meta?: { total?: number } } })?.data;
          const items = Array.isArray(d?.items) ? d!.items : [];
          return {
            ok: true, status: r.status,
            count: items.length, total: d?.meta?.total ?? items.length,
            items: trimVictimItems(items, 25, REVEAL_BREACH_DATA),
            quota_left: oathnetQuotaLeft(),
            note: REVEAL_BREACH_DATA
              ? "Victim rows are LEADS until corroborated. Account-authorized full reveal is ON — raw passwords/cookies ARE included; record every concrete credential value found. Pivot a log_id via oathnet_victim_manifest. Label device identifiers [VERIFY]."
              : "Victim rows are LEADS until corroborated. Passwords/cookies are redacted — do NOT record raw credentials. Pivot a log_id via oathnet_victim_manifest. Label device identifiers [VERIFY].",
          };
        } catch (e) { return { error: String(e) }; }
      },
    }),
    oathnet_victim_manifest: tool({
      description:
        "OathNet v2 — retrieve one victim log's MANIFEST (file tree: names, types, sizes only; NO file contents). Pass a log_id from oathnet_victims_search / oathnet_stealer_search (has_log_id). Use it to decide which file to read via oathnet_victim_file. Shares the 500/day OathNet pool.",
      inputSchema: memoSchema("oathnet_victim_manifest", () => z.object({
        log_id: z.string().describe("Victim log id, e.g. vic_002_gamer_dragonslayer"),
      })),
      execute: async ({ log_id }, opts) => {
        if (!OATHNET_API_KEY) return { error: "OATHNET_API_KEY not configured" };
        if (oathnetExhausted()) return skipStub("oathnet_victim_manifest", `OathNet pooled daily quota exhausted (${oathnetQuotaLeft()} left today).`, { quota_left: oathnetQuotaLeft() });
        try {
          const url = oathnetVictimManifestUrl(log_id);
          const signal = (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
          const r = await fetchRetry(url, { headers: { "x-api-key": OATHNET_API_KEY }, signal }, { retries: 1, timeoutMs: 20_000 });
          const text = await r.text();
          let data: unknown;
          try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 2000) }; }
          noteOathnetQuota(data);
          if (!r.ok) return { ok: false, status: r.status, error: `oathnet manifest ${r.status}`, quota_left: oathnetQuotaLeft() };
          // Manifest is raw JSON (no envelope) — summarize to structure only.
          return { ok: true, status: r.status, manifest: summarizeManifest(data), quota_left: oathnetQuotaLeft() };
        } catch (e) { return { error: String(e) }; }
      },
    }),
    oathnet_victim_file: tool({
      description:
        "OathNet v2 — read ONE file from a victim log, returned REDACTED: metadata (size, line count, SHA-256 for chain-of-custody) plus a masked preview with passwords/cookies/tokens stripped. Raw credentials are NEVER returned. Pass log_id + file_id from oathnet_victim_manifest. Use for triage ('is there a wallet/session/keepass file?'), NOT to harvest secrets. Shares the 500/day OathNet pool.",
      inputSchema: memoSchema("oathnet_victim_file", () => z.object({
        log_id: z.string(),
        file_id: z.string().describe("File id from the victim manifest"),
      })),
      execute: async ({ log_id, file_id }, opts) => {
        if (!OATHNET_API_KEY) return { error: "OATHNET_API_KEY not configured" };
        if (oathnetExhausted()) return skipStub("oathnet_victim_file", `OathNet pooled daily quota exhausted (${oathnetQuotaLeft()} left today).`, { quota_left: oathnetQuotaLeft() });
        try {
          const url = oathnetVictimFileUrl(log_id, file_id);
          const signal = (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
          const r = await fetchRetry(url, { headers: { "x-api-key": OATHNET_API_KEY }, signal }, { retries: 1, timeoutMs: 20_000 });
          const text = await r.text();
          if (!r.ok) return { ok: false, status: r.status, error: `oathnet file ${r.status}`, quota_left: oathnetQuotaLeft() };
          // Chain-of-custody hash over the RAW bytes; the raw text is masked before return
          // and never persisted or echoed.
          let sha256: string | undefined;
          try {
            const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
            sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
          } catch { sha256 = undefined; }
          return { ok: true, status: r.status, file: safeVictimFile({ logId: log_id, fileId: file_id, text, sha256, reveal: REVEAL_BREACH_DATA }), quota_left: oathnetQuotaLeft() };
        } catch (e) { return { error: String(e) }; }
      },
    }),
    oathnet_victim_archive: tool({
      description:
        "OathNet v2 — reference the FULL victim-log ZIP archive. MANUAL-CONSENT ONLY: this tool NEVER downloads or streams archive bytes into the investigation (raw dumps must not enter context/artifacts). Without confirm:true it refuses. With explicit user authorization (confirm:true) it returns the authenticated archive endpoint + log_id for out-of-band retrieval by the operator. Use only when the user explicitly asks to pull a full log.",
      inputSchema: memoSchema("oathnet_victim_archive", () => z.object({
        log_id: z.string(),
        confirm: z.boolean().optional().describe("Must be true AND user-authorized; without it the tool refuses."),
      })),
      execute: async ({ log_id, confirm }) => {
        if (!OATHNET_API_KEY) return { error: "OATHNET_API_KEY not configured" };
        if (!confirm) {
          return skipStub("oathnet_victim_archive", "Refused: full-archive download is manual-consent only. It requires explicit user authorization (confirm:true) and is retrieved out-of-band — raw archive bytes are never pulled into the investigation.", { manual_consent_required: true, log_id });
        }
        // Deliberately does NOT fetch — returns a reference for operator-side retrieval.
        return {
          ok: true,
          manual_action_required: true,
          log_id,
          archive_endpoint: oathnetVictimArchiveUrl(log_id),
          note: "Authenticated ZIP endpoint. Retrieve out-of-band with the x-api-key header; do NOT ingest raw archive contents into artifacts/memory/prompt. Store only a reference + hash per evidence-integrity rules.",
          quota_left: oathnetQuotaLeft(),
        };
      },
    }),
    oathnet_subdomains: tool({
      description:
        "OathNet v2 — extract SUBDOMAINS observed in stealer records for a domain (independent of crt.sh/hackertarget: overlap = corroboration, unique hits = new coverage). Returns the host list + count. Run on any domain seed/pivot alongside crtsh_subdomains. Shares the 500/day OathNet pool.",
      inputSchema: memoSchema("oathnet_subdomains", () => z.object({
        domain: z.string().describe("Root domain, e.g. example.com"),
      })),
      execute: async ({ domain }, opts) => {
        if (!OATHNET_API_KEY) return { error: "OATHNET_API_KEY not configured" };
        if (oathnetExhausted()) return skipStub("oathnet_subdomains", `OathNet pooled daily quota exhausted (${oathnetQuotaLeft()} left today).`, { quota_left: oathnetQuotaLeft() });
        try {
          const url = oathnetSubdomainUrl(domain);
          const signal = (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
          const r = await fetchRetry(url, { headers: { "x-api-key": OATHNET_API_KEY }, signal }, { retries: 1, timeoutMs: 20_000 });
          const text = await r.text();
          let data: unknown;
          try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 2000) }; }
          noteOathnetQuota(data);
          if (!r.ok) return { ok: false, status: r.status, error: `oathnet subdomain ${r.status}`, quota_left: oathnetQuotaLeft() };
          const d = (data as { data?: { domain?: string; subdomains?: unknown; count?: number } })?.data ?? {};
          const subsRaw = Array.isArray(d.subdomains) ? d.subdomains : [];
          // Entries may be plain strings OR objects with alive metadata — normalize to strings.
          const subdomains = subsRaw.slice(0, 200).map((s) => (typeof s === "string" ? s : (s as { subdomain?: string; host?: string })?.subdomain ?? (s as { host?: string })?.host ?? String(s)));
          return {
            ok: true, status: r.status,
            domain: d.domain ?? domain,
            count: typeof d.count === "number" ? d.count : subdomains.length,
            subdomains,
            source: "oathnet_stealer_subdomain",
            quota_left: oathnetQuotaLeft(),
            note: "Independent subdomain source — corroborate against crtsh_subdomains / hackertarget.",
          };
        } catch (e) { return { error: String(e) }; }
      },
    }),
    oathnet_breach_dbnames: tool({
      description:
        "OathNet v2 helper — autocomplete breach DATABASE NAMES for scoping. Pass a fragment (e.g. 'link') → matching db names + record counts + available fields. Use the returned names as `dbnames` on oathnet_lookup to narrow a breach query. Cheap. Shares the 500/day OathNet pool.",
      inputSchema: memoSchema("oathnet_breach_dbnames", () => z.object({
        q: z.string().describe("DB-name fragment, e.g. 'link' → linkedin_2012"),
      })),
      execute: async ({ q }, opts) => {
        if (!OATHNET_API_KEY) return { error: "OATHNET_API_KEY not configured" };
        if (oathnetExhausted()) return skipStub("oathnet_breach_dbnames", `OathNet pooled daily quota exhausted (${oathnetQuotaLeft()} left today).`, { quota_left: oathnetQuotaLeft() });
        try {
          const url = oathnetDbnamesUrl(q);
          const signal = (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
          const r = await fetchRetry(url, { headers: { "x-api-key": OATHNET_API_KEY }, signal }, { retries: 1, timeoutMs: 15_000 });
          const text = await r.text();
          let data: unknown;
          try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 2000) }; }
          noteOathnetQuota(data);
          if (!r.ok) return { ok: false, status: r.status, error: `oathnet dbnames ${r.status}`, quota_left: oathnetQuotaLeft() };
          const items = Array.isArray((data as { items?: unknown }).items) ? (data as { items: unknown[] }).items.slice(0, 40) : [];
          return { ok: true, status: r.status, items, quota_left: oathnetQuotaLeft() };
        } catch (e) { return { error: String(e) }; }
      },
    }),
    oathnet_ai_filter: tool({
      description:
        "OathNet v2 — translate a NATURAL-LANGUAGE breach query into a structured filter, returning a reusable `filter_id`. Pass that filter_id to oathnet_lookup (or stealer search) to collapse multi-selector queries into fewer, cheaper calls. Example query: 'US banking users with gmail addresses'. Shares the 500/day OathNet pool.",
      inputSchema: memoSchema("oathnet_ai_filter", () => z.object({
        query: z.string().describe("Natural-language description of the breach records to match"),
        index: z.enum(["breach", "stealer", "victims"]).default("breach"),
      })),
      execute: async ({ query, index }, opts) => {
        if (!OATHNET_API_KEY) return { error: "OATHNET_API_KEY not configured" };
        if (oathnetExhausted()) return skipStub("oathnet_ai_filter", `OathNet pooled daily quota exhausted (${oathnetQuotaLeft()} left today).`, { quota_left: oathnetQuotaLeft() });
        try {
          const signal = (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
          const r = await fetchRetry(OATHNET_AI_FILTER_URL, {
            method: "POST",
            headers: { "x-api-key": OATHNET_API_KEY, "content-type": "application/json" },
            body: JSON.stringify({ index, query }),
            signal,
          }, { retries: 1, timeoutMs: 20_000 });
          const text = await r.text();
          let data: unknown;
          try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 2000) }; }
          noteOathnetQuota(data);
          if (!r.ok) return { ok: false, status: r.status, error: `oathnet ai_filter ${r.status}`, quota_left: oathnetQuotaLeft() };
          return { ok: true, status: r.status, data, quota_left: oathnetQuotaLeft() };
        } catch (e) { return { error: String(e) }; }
      },
    }),
    oathnet_scanner: tool({
      description:
        "OathNet SCANNERS — automated monitoring for newly-indexed breach/stealer exposure. action:'quota' (remaining scanner slots) and action:'list' (existing monitors) are read-only. action:'create' sets up a PERSISTENT monitor with notifications and requires confirm:true + explicit user authorization (a side-effecting subscription, not a lookup) — do NOT create scanners autonomously. Shares the 500/day OathNet pool.",
      inputSchema: memoSchema("oathnet_scanner", () => z.object({
        action: z.enum(["quota", "list", "create"]),
        name: z.string().optional().describe("create: monitor name"),
        scanner_type: z.enum(["breach", "stealer"]).optional().describe("create: what to watch"),
        query: z.string().optional().describe("create: the selector/query to monitor"),
        notification_type: z.enum(["email", "discord", "webhook"]).optional(),
        confirm: z.boolean().optional().describe("create only: must be true AND user-authorized"),
      })),
      execute: async ({ action, name, scanner_type, query, notification_type, confirm }, opts) => {
        if (!OATHNET_API_KEY) return { error: "OATHNET_API_KEY not configured" };
        if (oathnetExhausted()) return skipStub("oathnet_scanner", `OathNet pooled daily quota exhausted (${oathnetQuotaLeft()} left today).`, { quota_left: oathnetQuotaLeft() });
        const signal = (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
        const headers = { "x-api-key": OATHNET_API_KEY } as Record<string, string>;
        try {
          if (action === "quota" || action === "list") {
            const url = action === "quota" ? OATHNET_SCANNER_URLS.quota : OATHNET_SCANNER_URLS.list;
            const r = await fetchRetry(url, { headers, signal }, { retries: 1, timeoutMs: 15_000 });
            const text = await r.text();
            let data: unknown;
            try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 2000) }; }
            noteOathnetQuota(data);
            if (!r.ok) return { ok: false, status: r.status, error: `oathnet scanner ${action} ${r.status}`, quota_left: oathnetQuotaLeft() };
            return { ok: true, status: r.status, action, data, quota_left: oathnetQuotaLeft() };
          }
          // create — gated
          if (!confirm) {
            return skipStub("oathnet_scanner", "Refused: creating a scanner is a persistent, notifying subscription and requires explicit user authorization (confirm:true). Do not create scanners autonomously.", { manual_consent_required: true });
          }
          if (!name || !scanner_type || !query) {
            return { ok: false, error: "create requires name, scanner_type, and query" };
          }
          const body = {
            name, scanner_type,
            query_config: { q: query },
            notification_type: notification_type ?? "email",
            notify_on_zero_results: false,
          };
          const r = await fetchRetry(OATHNET_SCANNER_URLS.create, {
            method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify(body), signal,
          }, { retries: 0, timeoutMs: 20_000 });
          const text = await r.text();
          let data: unknown;
          try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 2000) }; }
          noteOathnetQuota(data);
          if (!r.ok) return { ok: false, status: r.status, error: `oathnet scanner create ${r.status}`, quota_left: oathnetQuotaLeft() };
          return { ok: true, status: r.status, action: "create", data, quota_left: oathnetQuotaLeft() };
        } catch (e) { return { error: String(e) }; }
      },
    }),
    socialfetch_lookup: tool({
      description:
        "Query SocialFetch for normalized public social PROFILES and their content. SUPPORTED platforms: 'tiktok' | 'instagram' | 'twitter' | 'facebook'. kind='profile' (default) = profile metadata; 'videos' (tiktok) / 'posts' (instagram) / 'tweets' (twitter) = a profile's content collection; 'video' (tiktok) = one video by URL/id (pass it as `handle`). Use platform='facebook' with a full profile URL; otherwise pass a bare handle. Returns { ok, found, status, lookupStatus, data, meta, error }; on profile routes lookupStatus is 'found'|'private'|'not_found' — treat 'private'/'not_found' as a NORMAL negative, not an error. For a HARD-BLOCKED host that is NOT one of these four structured platforms (youtube, twitch, reddit, or an arbitrary evidence page), use `socialfetch_web_read` — it fetches server-side, unlike `jina_reader_scrape`, which those origins block. Jina remains the reader for non-blocked hosts. SocialFetch quota is LOW — don't re-burn calls on a nothing-result. Unsupported platforms return an informative no-op instead of crashing.",
      // Strict near-miss repair (lib/socialfetch-input.ts): username/identifier/url → handle, platform read off an exact
      // supported host; conflicting aliases or a platform that disagrees with the URL host are rejected.
      inputSchema: memoSchema("socialfetch_lookup", () => coercedSchema("socialfetch_lookup", { custom: socialfetchCustomCoercion }, z.object({
        platform: z.string(),
        handle: z.string().describe("Username/handle, full URL for facebook, or video URL/id for tiktok kind='video'"),
        kind: z.enum(["profile", "videos", "posts", "tweets", "video"]).default("profile"),
      }))),
      execute: async ({ platform, handle, kind }) => {
        // Normalize common aliases BEFORE the support check. Without this, the
        // single most likely spelling of the platform — `x`, the site's actual
        // current name — fell straight through to the unsupported no-op, so a
        // corroborated X/Twitter handle silently produced nothing and burned the
        // step. Also accepts bare domains, since the model frequently passes the
        // host it found the profile on rather than the platform key.
        const p = normalizeSocialPlatform(platform);
        const SUPPORTED = new Set(["tiktok", "instagram", "twitter", "facebook"]);
        if (!SUPPORTED.has(p)) {
          return {
            ok: false,
            skipped: true,
            reason: `socialfetch_lookup does not support platform='${platform}'. For a blocked host (youtube/twitch/reddit/arbitrary page) use socialfetch_web_read; otherwise http_fingerprint, wayback_snapshots, or minimax_web_search.`,
            supported: Array.from(SUPPORTED),
          };
        }
        if (!SOCIALFETCH_API_KEY) return { error: "SOCIALFETCH_API_KEY not configured" };
        try {
          const h = encodeURIComponent(handle);
          let url: string;
          if (p === "facebook") {
            url = `https://api.socialfetch.dev/v1/facebook/profiles?url=${h}`;
          } else if (p === "tiktok" && kind === "videos") {
            url = `https://api.socialfetch.dev/v1/tiktok/profiles/${h}/videos`;
          } else if (p === "tiktok" && kind === "video") {
            url = `https://api.socialfetch.dev/v1/tiktok/videos/${h}`;
          } else if (p === "instagram" && kind === "posts") {
            url = `https://api.socialfetch.dev/v1/instagram/profiles/${h}/posts`;
          } else if (p === "twitter" && kind === "tweets") {
            url = `https://api.socialfetch.dev/v1/twitter/profiles/${h}/tweets`;
          } else {
            url = `https://api.socialfetch.dev/v1/${p}/profiles/${h}`;
          }
          // fetchRetry retries transient 5xx but returns 4xx (401/402/404/etc.)
          // without retry — the right policy for a low-quota paid API.
          const r = await fetchRetry(url, { headers: { "x-api-key": SOCIALFETCH_API_KEY } }, { retries: 1 });
          // 402 = credits exhausted. Surface distinctly and never retry so the
          // agent stops burning quota and the operator can refill.
          if (r.status === 402) {
            return { ok: false, status: 402, found: false, error: "SOCIALFETCH_CREDITS_EXHAUSTED", message: "Social Fetch credit balance is zero. Check /v1/balance." };
          }
          const text = await r.text();
          // Envelope is { data, meta }. meta = { requestId, creditsCharged, version }.
          let env: { data?: Record<string, unknown> | null; meta?: unknown; error?: unknown };
          try { env = JSON.parse(text) as typeof env; } catch { env = { data: { raw: text.slice(0, 4000) } }; }
          const payload = (env?.data ?? null) as Record<string, unknown> | null;
          // Profile routes carry data.lookupStatus ('found'|'private'|'not_found').
          // Collection routes (videos/posts/tweets) have NO lookupStatus — infer
          // success from the presence of the returned array instead.
          const lookupStatus = (payload && typeof payload === "object" ? (payload.lookupStatus ?? null) : null) as string | null;
          const isCollection = kind === "videos" || kind === "posts" || kind === "tweets";
          const collectionHit = Array.isArray(payload?.videos) || Array.isArray(payload?.posts) || Array.isArray(payload?.tweets);
          const found = r.ok && (
            lookupStatus === "found" ||
            (lookupStatus == null && isCollection && collectionHit) ||
            (lookupStatus == null && !isCollection && !env?.error && r.status !== 404)
          );
          // A 404 with no error body is a legitimate "no such profile" negative,
          // not a tool failure — mark ok so it doesn't inflate the failure rate.
          const ok = r.status === 404 && !env?.error ? true : r.ok;
          return { ok, status: r.status, found, lookupStatus, data: payload, meta: env?.meta ?? null, error: env?.error ?? null };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),
    socialfetch_web_read: tool({
      description:
        "Read ANY web URL as clean markdown via SocialFetch's SERVER-SIDE fetch (/v1/web/markdown). Use it for hosts r.jina.ai HARD-BLOCKS — x/twitter, twitch, reddit, instagram — and for arbitrary evidence pages Jina can't reach: SocialFetch fetches server-side so origin 403/451 blocks don't apply. SKIPPED FOR FREE, use the named tool instead: youtube.com/youtu.be -> youtube_oembed, roblox.com -> roblox_user, steamcommunity.com -> steam_profile, t.me / chess.com / namemc.com / gofundme.com / scamadviser.com / threads.net -> jina_reader_scrape. It has never once completed a read on those hosts. Costs ~1 credit per URL and quota is LOW — call it for a specific blocked/important URL, NEVER as a bulk crawler. Returns { ok, status, data (markdown), meta, error }.",
      inputSchema: memoSchema("socialfetch_web_read", () => z.object({
        url: z.string().describe("Fully-qualified http(s) URL to read"),
      })),
      execute: async ({ url }, opts) => {
        // The AI SDK's own abort signal. Combined with the per-call timeout below
        // so a cancelled STEP actually cancels the in-flight upstream request
        // instead of leaving it streaming into a run nobody is reading.
        const outerSignal = (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
        const startedAt = Date.now();
        if (!SOCIALFETCH_API_KEY) return { error: "SOCIALFETCH_API_KEY not configured" };
        // Host policy (2026-09-08 audit): t.me and youtube.com/youtu.be do not
        // share the success distribution the 18s cap below is calibrated
        // against — see socialfetchHostPolicy's own comment for the measured
        // evidence. Checked BEFORE the fetch so a doomed t.me read costs 0s
        // instead of ~18s, and a youtube.com read fails fast instead of slow.
        let policy: ReturnType<typeof socialfetchHostPolicy> = { action: "normal" };
        try {
          policy = socialfetchHostPolicy(new URL(url).hostname);
        } catch {
          // Unparseable URL: fall through to "normal" and let the fetch itself
          // surface the real error, exactly as it would have before this policy.
        }
        if (policy.action === "skip") {
          // A classified skip, not an error: `skipped:true` keeps it out of the
          // failure metrics (tool-outcome.ts reads it), `failure_class` says WHY
          // for the trace, and no request is issued so no credit is spent.
          return {
            ok: false,
            skipped: true,
            status: "skipped",
            failure_class: "host_unsupported",
            // THE SLOT, not just the seconds. `startCall` reserves a paid-call
            // slot at admission and `cache.ts` releases it ONLY on this
            // structural marker (runtime-policy.ts:isPreProviderGate) — never on
            // `skipped`, which also covers rate-limits, 5xx and timeouts that
            // really did spend. Without it this skip still burned one of the
            // run's 12 paid calls on a lookup it never performed, which would
            // have left the headline saving of this commit at wall-clock only.
            provider_attempted: false,
            url,
            hint: policy.hint,
          };
        }
        try {
          // Single attempt, no retry: retrying a timeout would just double the
          // wait past the outer tool budget (see cache.ts).
          //
          // ⚠️ CORRECTED 2026-08-28: briefly cut to 12_000 on a report of "zero
          // successes ever observed". tool_usage_log says otherwise — 127 calls
          // over 30 days, 76 successful, successes averaging 5.4s and reaching
          // 15,908ms. 18s clears every observed success with headroom; 12s would
          // have severed three of them. Raise or lower this ONLY against a fresh
          // query of the success-duration distribution, and move cache.ts's
          // wrapper with it so the wrapper stays above. youtube.com/youtu.be are
          // the one exception (fast_timeout above) — they never cleared this
          // window in the audited sample, so the shorter cap costs no real success.
          const timeoutMs = policy.action === "fast_timeout" ? policy.timeoutMs : SOCIALFETCH_DEFAULT_TIMEOUT_MS;
          const r = await fetchRetry(
            `https://api.socialfetch.dev/v1/web/markdown?url=${encodeURIComponent(url)}`,
            { headers: { "x-api-key": SOCIALFETCH_API_KEY }, signal: outerSignal },
            { retries: 0, timeoutMs },
          );
          if (r.status === 402) {
            return { ok: false, status: 402, error: "SOCIALFETCH_CREDITS_EXHAUSTED", message: "Social Fetch credit balance is zero. Check /v1/balance." };
          }
          // A 5xx is the provider failing, not the page refusing. Worth one free
          // jina attempt — and unlike a full timeout it leaves real budget.
          if (r.status >= 500) {
            const fb = await socialfetchJinaFallback(url, startedAt, outerSignal);
            if (fb) return { ...fb, primary_failure: "upstream_5xx", primary_status: r.status };
            return { ok: false, status: r.status, failure_class: "upstream_5xx", url, error: `socialfetch ${r.status}` };
          }
          const text = await r.text();
          let env: { data?: unknown; meta?: unknown; error?: unknown };
          try { env = JSON.parse(text) as typeof env; } catch { env = { data: text.slice(0, 8000) }; }
          // A 2xx carrying nothing is not a read. Recording it as one lets a blank
          // page or an error envelope enter the case as page evidence.
          const body = env?.data ?? null;
          const bodyText = typeof body === "string" ? body : body == null ? "" : JSON.stringify(body);
          if (r.ok && (env?.error != null || bodyText.trim().length < SOCIALFETCH_MIN_BODY_CHARS)) {
            const trimmed = bodyText.trim();
            // A thin 2xx is the ONLY failure class that leaves the whole budget
            // intact — nothing timed out, the provider answered fast. That makes
            // it the best position the free reader ever gets, the opposite of the
            // full-timeout path where it has ~3s and usually misses.
            const fb = await socialfetchJinaFallback(url, startedAt, outerSignal);
            if (fb) return { ...fb, primary_failure: "empty_body", primary_chars: trimmed.length };
            return {
              ok: false,
              status: r.status,
              failure_class: "empty_body",
              url,
              chars: trimmed.length,
              // Never discard what the credit already bought. The floor exists so
              // a blank page or an interstitial cannot enter the case AS a page
              // read — `ok:false` already secures that. Throwing the characters
              // away as well is a separate, unintended loss: a legitimately short
              // page (a stub profile, a one-line bio) is rare but real, and a bare
              // char count gives the model nothing to judge it by. Returned under
              // `thin_body`, deliberately NOT `data`, so no caller that keys on a
              // successful read can mistake it for one.
              ...(trimmed ? { thin_body: trimmed.slice(0, SOCIALFETCH_MIN_BODY_CHARS) } : {}),
              error: env?.error ?? "socialfetch returned 2xx with no usable page content",
            };
          }
          return { ok: r.ok, status: r.status, data: env?.data ?? env, meta: env?.meta ?? null, error: env?.error ?? null };
        } catch (e) {
          // An abort is a TIMEOUT, which is a different fact from a failure: the
          // host was slow, not broken, and the failed-tools panel should not read
          // the two the same way.
          if (isAbortLikeError(e)) {
            const fb = await socialfetchJinaFallback(url, startedAt, outerSignal);
            if (fb) return { ...fb, primary_failure: "timeout" };
            return {
              ok: false,
              status: "timed_out",
              failure_class: "timeout",
              url,
              elapsed_ms: Date.now() - startedAt,
              error: String(e),
            };
          }
          return { error: String(e) };
        }
      },
    }),
    socialfetch_whoami: tool({
      description:
        "Validate the SocialFetch API key and return account info (/v1/whoami). FREE — zero credits consumed. Use to confirm the key is active before running paid SocialFetch lookups.",
      inputSchema: memoSchema("socialfetch_whoami", () => z.object({})),
      execute: async () => {
        if (!SOCIALFETCH_API_KEY) return { error: "SOCIALFETCH_API_KEY not configured" };
        try {
          const r = await fetchRetry("https://api.socialfetch.dev/v1/whoami", { headers: { "x-api-key": SOCIALFETCH_API_KEY } }, { retries: 1 });
          const text = await r.text();
          let env: { data?: unknown; meta?: unknown };
          try { env = JSON.parse(text) as typeof env; } catch { env = { data: text.slice(0, 2000) }; }
          return { ok: r.ok, status: r.status, data: env?.data ?? env, meta: env?.meta ?? null };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),
    socialfetch_balance: tool({
      description:
        "Return the current SocialFetch credit balance/status (healthy|grace|exhausted) via /v1/balance. FREE — zero credits consumed. Call before a batch of paid lookups to confirm sufficient quota.",
      inputSchema: memoSchema("socialfetch_balance", () => z.object({})),
      execute: async () => {
        if (!SOCIALFETCH_API_KEY) return { error: "SOCIALFETCH_API_KEY not configured" };
        try {
          const r = await fetchRetry("https://api.socialfetch.dev/v1/balance", { headers: { "x-api-key": SOCIALFETCH_API_KEY } }, { retries: 1 });
          const text = await r.text();
          let env: { data?: unknown; meta?: unknown };
          try { env = JSON.parse(text) as typeof env; } catch { env = { data: text.slice(0, 2000) }; }
          return { ok: r.ok, status: r.status, data: env?.data ?? env, meta: env?.meta ?? null };
        } catch (e) {
          return { error: String(e) };
        }
      },
    }),
    bosint_email_lookup: tool({
      description:
        "OSINTNova (Bosint) email exposure check. Surface-level breach + exposure indicators for an email address. Shared 1000 calls/day quota across Bosint endpoints, 120/min. Use for an original or independently corroborated email when the planner needs exposure context. Returns {success, data, api_metadata}.",
      inputSchema: memoSchema("bosint_email_lookup", () => z.object({ email: z.string().describe("Email address to check") })),
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
      inputSchema: memoSchema("cordcat_discord_lookup", () => z.object({
        discord_id: z.string().regex(/^\d{17,20}$/, "Must be a 17-20 digit Discord snowflake ID"),
      })),
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
      inputSchema: memoSchema("breach_check", () => z.object({
        email: z.string().min(1).optional(),
        value: z.string().min(1).optional(),
      }).refine((v) => !!(v.email || v.value), { message: "Provide `email` or `value`" })),
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
    leakcheck_lookup: tool({
      description:
        "LeakCheck Pro v2 breach lookup (https://leakcheck.io/api/v2). SECONDARY breach source — the account holds a FIXED POOL of queries (200 in total, NOT per day); every lookup spends one and nothing refills it, and at most 3 run per investigation. Returns leak sources, breach dates, and (where present) passwords/usernames for an email, username, phone, hash, or domain. Pass a phone in any format (E.164 ok — it's normalized to digits). For a person's full NAME, use oathnet_lookup type:'name' instead — LeakCheck v2 /query does not support keyword/name search and 400s on it. Use to corroborate breach_check on confirmed emails and high-value handles, and to surface password/source detail. Do NOT spend it on low-value handles.",
      inputSchema: memoSchema("leakcheck_lookup", () => z.object({
        value: z.string().min(1),
        // NOTE: no 'keyword' — LeakCheck v2 /query 400s on keyword/name searches
        // (verified in prod). Names go to oathnet_lookup type:'name'.
        type: z.enum(["auto","email","username","phone","hash","domain"]).optional().default("auto"),
      })),
      execute: async ({ value, type }) => {
        const LEAKCHECK_API_KEY = Deno.env.get("LEAKCHECK_API_KEY");
        if (!LEAKCHECK_API_KEY) return { error: "LEAKCHECK_API_KEY not configured" };
        const q = value.trim();
        if (!q) return { error: "missing value" };
        // LeakCheck v2 /query 400s on keyword/name searches. A multi-word value
        // with no @ is a person name — skip cleanly (avoid the guaranteed 400)
        // and route the caller to the tool that DOES support name search.
        if (!q.includes("@") && /\s/.test(q) && (type === "auto" || type === "username")) {
          return { ok: false, skipped: true, source: "leakcheck.v2", reason: "name/keyword not supported by LeakCheck v2 — use oathnet_lookup type:'name'", value: q };
        }
        // Quota guard (lib/leakcheck-guard.ts): the account has a fixed pool of queries, not a daily
        // allowance. Count the quota-spending calls this investigation already made (cached replays and
        // skips spend nothing) and read the provider's last-reported `quota`. Every read fails OPEN.
        {
          const limits = resolveLeakcheckLimits(
            Deno.env.get("LEAKCHECK_MAX_PER_INVESTIGATION"),
            Deno.env.get("LEAKCHECK_QUOTA_RESERVE"),
          );
          let priorCalls: number | null = null;
          try {
            const { count, error } = await supabaseAdmin
              .from("tool_usage_log")
              .select("id", { count: "exact", head: true })
              .eq("thread_id", threadId)
              .eq("tool_name", "leakcheck_lookup")
              .eq("cached", false)
              .in("outcome", ["ok", "empty", "failed"]);
            priorCalls = error || typeof count !== "number" ? null : count;
          } catch { priorCalls = null; }
          const decision = leakcheckGuard(priorCalls, lastLeakcheckQuota, limits);
          if (!decision.allow) {
            console.log(JSON.stringify({
              event: "leakcheck_guard_skip", thread_id: threadId, code: decision.code,
              prior_calls: priorCalls, last_quota: lastLeakcheckQuota,
              max_per_investigation: limits.maxPerInvestigation, quota_reserve: limits.quotaReserve,
            }));
            return { ok: false, skipped: true, provider_attempted: false, source: "leakcheck.v2", reason: decision.reason, value: q };
          }
        }
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
          const seenQuota = readLeakcheckQuota(d);
          if (seenQuota != null) lastLeakcheckQuota = seenQuota; // feeds the guard on the next call
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
      inputSchema: memoSchema("hibp_lookup", () => z.object({
        email: z.string().email(),
        include_pastes: z.boolean().optional().default(false),
        truncate: z.boolean().optional().default(false).describe("If true, only breach names are returned (smaller payload)."),
      })),
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
      inputSchema: memoSchema("rapidapi_breach_search", () => coercedSchema("rapidapi_breach_search", { trimFields: ["email"] }, z.object({ email: z.string().email() }))),
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
            // exposed_fields above keeps only the LABEL of each exposed field and
            // discarded the concrete value the API actually returned — the #1 reason
            // real breach data (a captured password, IP, DOB) never reached the UI.
            // exposed_values keeps every real value present on the hit so it can be
            // recorded. Empty when the upstream row carried only labels (masked).
            exposed_values: Array.isArray(e.found)
              ? e.found
                  .filter((f) => f.value != null && String(f.value).trim() !== "")
                  .map((f) => ({ field: f.label ?? f.field ?? null, value: f.value, sensitive: f.sensitive === true }))
              : [],
            has_sensitive: Array.isArray(e.found) ? e.found.some((f) => f.sensitive === true) : false,
          }));
          const names = breaches.map((b) => b.name).filter(Boolean).slice(0, 50);
          // Flatten every concrete value across all hits into one explicit list so
          // the model cannot miss them and records ALL of them, not one sample.
          const concreteValues = breaches.flatMap((b) =>
            (b.exposed_values ?? []).map((v) => ({ breach: b.name, field: v.field, value: v.value, sensitive: v.sensitive })),
          );
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
              ...(concreteValues.length
                ? {
                    concrete_values: concreteValues,
                    concrete_values_note:
                      "Every entry in concrete_values is a REAL captured value (password, IP, DOB, etc.), not a category label. Record EVERY one into the breach artifact's metadata — do not summarize down to a single example.",
                  }
                : {}),
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
      inputSchema: memoSchema("rapidapi_all_breaches", () => z.object({
        filter: z.string().optional().describe("case-insensitive substring to match against breach name or id"),
        limit: z.number().int().min(1).max(500).optional().default(100),
      })),
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
      inputSchema: memoSchema("deepfind_reverse_email", () => z.object({ email: z.string().email() })),
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
      inputSchema: memoSchema("deepfind_disposable_email", () => z.object({ email: z.string().email() })),
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
      inputSchema: memoSchema("deepfind_ssl_inspect", () => z.object({ domain: z.string().min(3) })),
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
      inputSchema: memoSchema("deepfind_tech_stack", () => z.object({ url: z.string().min(3) })),
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
      inputSchema: memoSchema("deepfind_url_unshorten", () => z.object({ url: z.string().min(3) })),
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
      inputSchema: memoSchema("deepfind_telegram_channel", () => z.object({ handle: z.string().min(1) })),
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
      inputSchema: memoSchema("deepfind_telegram_search", () => z.object({ query: z.string().min(2) })),
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
      inputSchema: memoSchema("deepfind_vin_lookup", () => z.object({ vin: z.string().length(17) })),
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
      inputSchema: memoSchema("deepfind_aircraft_lookup", () => z.object({ nNumber: z.string().min(2) })),
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
      inputSchema: memoSchema("deepfind_vessel_lookup", () => z.object({ identifier: z.string().min(7).max(9) })),
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
      inputSchema: memoSchema("deepfind_mac_lookup", () => z.object({ macAddress: z.string().min(6) })),
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
      inputSchema: memoSchema("deepfind_dark_web_link", () => z.object({ url: z.string().min(6) })),
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
      inputSchema: memoSchema("deepfind_email_breach", () => z.object({ email: z.string().email() })),
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
      inputSchema: memoSchema("deepfind_transaction_viewer", () => z.object({ hash: z.string().min(16).describe("Transaction hash. BTC: 64 hex chars; ETH: 0x + 64 hex; SOL: base58.") })),
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
      inputSchema: memoSchema("virustotal_lookup", () => z.object({
        kind: z.enum(["file", "url", "domain", "ip"]),
        value: z.string().min(3),
      })),
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
    fofa_search: tool({
      description:
        "FOFA (en.fofa.info) internet-asset search — attacker-surface / infra discovery by query syntax. Supports fields like domain=\"x.com\", ip=\"1.2.3.4\", host=\"sub.x.com\", cert=\"x.com\", title=\"...\", body=\"...\", icon_hash=\"...\", org=\"...\", asn=\"...\". Returns host, ip, port, title, domain, server, country. Use to enumerate hosts/ports/certs tied to a domain, IP, or favicon hash — a stronger infra pivot than crt.sh alone. Consumes FOFA points per result: keep size small (default 20).",
      inputSchema: memoSchema("fofa_search", () => z.object({
        // .max(512) is a correctness bound, not a style choice: the qbase64 encoder
        // below spreads the encoded bytes into String.fromCharCode, which throws
        // RangeError past roughly 150k chars. A FOFA query is a short field
        // expression; 512 is generous for the documented syntax.
        query: z.string().min(3).max(512).describe('FOFA query syntax, e.g. domain="example.com" or icon_hash="-247388890"'),
        // Capped at 25, not 100, because cost is charged FLAT per call
        // (costForTool takes only a name — see costs.ts) while FOFA meters
        // fpoints PER RETURNED ROW against a finite prepaid pool. At size 100 a
        // call really costs ~5x its 4000 micro-USD ledger entry, so the budget
        // under-reports spend exactly when a run is burning the most. 25 keeps
        // the gap to ~1.25x and matches the "keep size small" guidance that until
        // now lived only in the description string, where nothing enforced it.
        size: z.number().int().min(1).max(25).optional(),
      })),
      execute: async ({ query, size }) => {
        const KEY = Deno.env.get("FOFA_API_KEY");
        if (!KEY) return { error: "FOFA_API_KEY not configured" };
        const fields = "host,ip,port,protocol,domain,title,server,country_name,as_organization";
        try {
          const qbase64 = btoa(String.fromCharCode(...new TextEncoder().encode(query)));
          const url = `https://en.fofa.info/api/v1/search/all?key=${encodeURIComponent(KEY)}` +
            `&qbase64=${encodeURIComponent(qbase64)}&size=${size ?? 20}&fields=${fields}`;
          const r = await fetchT(url, { headers: { Accept: "application/json" } }, 20_000);
          const data = await r.json().catch(() => ({})) as {
            error?: boolean; errmsg?: string; size?: number; results?: string[][];
          };
          // FOFA signals failure with {"error":true,"errmsg":"..."} at HTTP 200 —
          // never let that masquerade as "0 assets found".
          if (!r.ok || data?.error) {
            return { error: `fofa ${r.status}: ${data?.errmsg ?? "request failed"}`, status: r.status };
          }
          const cols = fields.split(",");
          const results = (data.results ?? []).map((row) =>
            // `?? null` because FOFA can return a row shorter than the requested
            // field list; without it those keys carry `undefined`, which JSON.stringify
            // DROPS entirely, so a partial row silently reads as a complete one.
            Object.fromEntries(cols.map((c, i) => [c, row[i] ?? null]))
          );
          return { ok: true, source: "fofa.v1", query, total: data.size ?? results.length, results };
        } catch (e) { return { error: String(e) }; }
      },
    }),
    markdown_extract: tool({
      description:
        "markdown.new converter — turns a remote document/page URL into clean Markdown text (no auth, 500/day). Handles .pdf .docx .odt .xlsx .xls .ods .csv .json .xml .txt .md .html and images (.jpg/.png/.webp/.svg via AI summarization). Use as the PREFERRED reader for document URLs (PDF/Office/spreadsheet) and as the FALLBACK when jina_reader_scrape fails or returns junk. Do NOT use it on login-walled social platforms (instagram/x/tiktok/linkedin/youtube) — they return nothing.",
      inputSchema: memoSchema("markdown_extract", () => z.object({
        // z.string().url() accepts ANY parseable scheme — file:, ftp:, data: — and
        // this URL is handed to a third-party converter that performs the fetch on
        // our behalf. Constrain to http/https so the only thing we can ask it to
        // retrieve is a web document.
        url: z.string().url()
          .refine((u) => /^https?:$/.test(new URL(u).protocol), {
            message: "url must be http or https",
          })
          .describe("Public http(s) URL of the document or page to convert"),
        // Character offset into the converted document. The window is capped so
        // one call cannot flood the turn's context; `next_offset` in the result
        // is how you read the rest. See MARKDOWN_EXTRACT_WINDOW.
        offset: z.number().int().min(0).optional()
          .describe("Character offset to read from (default 0). Use next_offset from the previous call to page through a long document."),
      })),
      execute: async ({ url, offset }) => {
        try {
          const r = await fetchT("https://markdown.new/", {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ url }),
          }, 30_000);
          const data = await r.json().catch(() => ({})) as {
            success?: boolean; title?: string; content?: string; error?: string; tokens?: number;
          };
          if (!r.ok || data?.success === false) {
            return { error: `markdown.new ${r.status}: ${data?.error ?? "conversion failed"}`, status: r.status };
          }
          const content = String(data.content ?? "");
          // PAGINATE, don't silently truncate. This used to return
          // `content.slice(0, 12000)` with a bare `truncated: true` and no way
          // to reach the rest — a 41,842-char upload arrived as 29% of itself
          // and the model had no signal that the other 71% was retrievable, so
          // it reasoned over a fragment as though it were the document.
          //
          // The window stays 12k ON PURPOSE. Raising it would trade a
          // truncation bug for a context-growth bug, and context growth is the
          // measured cause of the 180s invocation ceiling (27 of 54
          // invocations forced-finalize at ~182s). Windowing gives full
          // document access at a bounded per-turn cost; the model asks for
          // more only when the first window justifies it.
          const start = Math.min(Math.max(0, offset ?? 0), content.length);
          const slice = content.slice(start, start + MARKDOWN_EXTRACT_WINDOW);
          const end = start + slice.length;
          return {
            ok: true,
            source: "markdown.new",
            url,
            title: data.title,
            tokens: data.tokens,
            total_chars: content.length,
            offset: start,
            returned_chars: slice.length,
            // Null when this window reached the end — the model's signal to stop.
            next_offset: end < content.length ? end : null,
            // Retained for back-compat with anything reading the old shape:
            // true whenever this response is not the whole document.
            truncated: content.length > end || start > 0,
            content: slice,
          };
        } catch (e) { return { error: String(e) }; }
      },
    }),
    ipgeolocation_lookup: tool({
      description:
        "IPGeolocation.io enrichment for an IP (https://api.ipgeolocation.io). Returns geo, ISP, organization, ASN, connection type (residential/mobile/dch/etc), currency, timezone, calling code. Use as a SECONDARY corroborating source after ip_intel — they agree → high confidence; they disagree → flag VPN/proxy. Free tier: 1000/day.",
      inputSchema: memoSchema("ipgeolocation_lookup", () => z.object({ ip: z.string().min(3) })),
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
      inputSchema: memoSchema("ipqualityscore_lookup", () => z.object({
        kind: z.enum(["phone", "email", "ip"]).describe("Which IPQS endpoint to hit."),
        value: z.string().min(3).describe("Phone (E.164 preferred), email, or IP address."),
        country: z.string().length(2).optional().describe("ISO2 country hint for phone validation (e.g. 'US'). Improves carrier/line-type accuracy."),
        strictness: z.number().int().min(0).max(3).optional().describe("Phone/email only: 0-3. Higher = stricter validation (more checks, may raise false positives). Default 0."),
      })),
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
      inputSchema: memoSchema("ip_intel", () => z.object({ ip: z.string() })),
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
      description:
        "RDAP registration lookup for a domain (registrar, statuses, events, nameservers). Tries the rdap.org aggregator, then falls back to the registry IANA says owns the TLD — rdap.org does not route every ccTLD, so its 404 alone does not mean the domain is unregistered. Outcomes are explicit: `found`, `measured_empty` (the registry answered: no such domain), or `failed` (nobody answered). A registry that withholds contact detail under GDPR returns redacted:true and is still a successful lookup.",
      inputSchema: memoSchema("whois_lookup", () => z.object({ domain: z.string() })),
      execute: async ({ domain }) => {
        // fetchT, NOT fetchRetry — this is load-bearing.
        //
        // fetchRetry defaults to retries:2 (three attempts) and retries exactly
        // the class rdapLookup also retries: 429 and 5xx. Composed, a failing
        // registry would get three attempts from fetchRetry MULTIPLIED by
        // rdapLookup's own retry — six requests, from a module documenting
        // "exactly one retry". fetchT is one-shot and timeout-bounded, so retry
        // policy lives solely in rdapLookup, which is the layer that knows a
        // 404 is a measured answer worth no retry while a 5xx is an unanswered
        // question worth exactly one.
        //
        // Pinned by rdap_wiring_test.ts. A unit test CANNOT catch this: it
        // injects its own stub in place of this exact expression, so the
        // composition is invisible to it. The assertion has to read the source.
        return await rdapLookup(domain, (url) => fetchT(url, {}, 12_000));
      },
    }),
    username_sweep: tool({
      // Until then this is the edge-native built-in sweep.
      description:
        "Built-in Username Sweep: parallel HTTP existence check across ~95 platforms for a handle. Returns the list of sites where the handle resolves. Only call this on a handle with NO spaces. Do NOT call it on a full name or name+location seed — derive candidate handles first.",
      inputSchema: memoSchema("username_sweep", () => z.object({ username: z.string().min(1) })),
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
      inputSchema: memoSchema("username_search", () => z.object({ username: z.string().min(1) })),
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
    // Opsis OSINT API (lib/opsis.ts): account enumeration across ~700 platforms.
    // opsis_search is PAID per call; the other three are free reads. All four are
    // removed from the schema when OPSIS_API_KEY is unset (capabilities.ts), and
    // OPSIS_DISABLED=true stops every call at call time. The wrapper's timeout
    // signal is forwarded so its cap can end a poll early.
    opsis_search: tool({
      description:
        "Opsis: find accounts for a username, email or domain across ~700 platforms. PAID (1 credit). Start searches EARLY in a turn: a search is refused (free) while 2 runs from this thread are still un-read, or when the run cannot read it before the report — read pending runs with opsis_results first. Returns within ~25s; a run still going returns partial results plus a run_id, so fetch the rest with opsis_results and never search the same selector again. Hits are unverified account leads.",
      inputSchema: memoSchema("opsis_search", () => z.object({
        kind: z.enum(["username", "email", "domain"]),
        value: z.string().min(1),
      })),
      // No `premium` input: a premium username search costs 2 credits and
      // costs.ts prices per tool name, so exposing it would under-report spend
      // (Codex P2 on #659). It returns as its own costed tool if wanted.
      execute: async ({ kind, value }, opts) =>
        await opsisSearch({ kind, value }, opsisDepsFromEnv((opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal)),
    }),
    opsis_results: tool({
      description: "Opsis: fetch the rest of a still-running opsis_search by its run_id (free). Pass the kind and value that search used.",
      inputSchema: memoSchema("opsis_results", () => z.object({
        kind: z.enum(["username", "email", "domain"]),
        value: z.string().min(1),
        run_id: z.string().min(1),
      })),
      execute: async ({ kind, value, run_id }, opts) =>
        await opsisResults({ kind, value, run_id }, opsisDepsFromEnv((opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal)),
    }),
    opsis_balance: tool({
      description: "Opsis: API credit balance (free). Diagnostics only; do not call before routine searches.",
      inputSchema: memoSchema("opsis_balance", () => z.object({})),
      execute: async (_input, opts) =>
        await opsisAccount("balance", opsisDepsFromEnv((opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal)),
    }),
    opsis_status: tool({
      description: "Opsis: API key, plan and rate-limit self-check (free). Diagnostics only.",
      inputSchema: memoSchema("opsis_status", () => z.object({})),
      execute: async (_input, opts) =>
        await opsisAccount("status", opsisDepsFromEnv((opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal)),
    }),
    crtsh_subdomains: tool({
      description: "Enumerate subdomains for a domain via crt.sh certificate transparency logs.",
      inputSchema: memoSchema("crtsh_subdomains", () => z.object({ domain: z.string() })),
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
      inputSchema: memoSchema("dns_records", () => z.object({ host: z.string(), types: z.array(z.enum(DNS_TYPES)).default(["A","MX","NS","TXT"]), dkimSelector: z.string().optional() })),
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
      inputSchema: memoSchema("github_user", () => z.object({ username: z.string() })),
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
      inputSchema: memoSchema("wayback_snapshots", () => z.object({ url: z.string() })),
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
      inputSchema: memoSchema("ransomwarelive_lookup", () => z.object({ domain: z.string().min(1).describe("registrable domain, e.g. acme.com") })),
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
      inputSchema: memoSchema("urlscanner_scan", () => z.object({
        url: z.string().min(1).describe("URL, registrable domain, or IP to scan"),
        rescan: z.boolean().optional().describe("Force a fresh scan, bypassing the 7-day cache"),
      })),
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
      inputSchema: memoSchema("wayback_cdx_search", () => z.object({ url: z.string().min(1).describe("domain or URL to look up in the archive") })),
      execute: async ({ url }, opts) => {
        // archive.org's CDX endpoint is chronically slow (p95 ~60s). The cache
        // wrapper's per-tool cap is 25s (TOOL_TIMEOUT_OVERRIDE_MS), and its
        // AbortSignal is forwarded into every fetch so a hit on the cap cancels
        // the requests cleanly. The four archive.org queries run in parallel and
        // a partial answer is kept — see lib/wayback-cdx.ts.
        const signal = (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
        return waybackCdxParallelDisabled()
          ? await waybackCdxSearchLegacy(url, signal)
          : await waybackCdxSearch(url, { signal });
      },
    }),
    crtsh_lookup: tool({
      description:
        "crt.sh certificate-transparency lookup — issued certs for a DOMAIN. Input: { domain: string }. Returns UNIQUE subdomains (parsed from name_value) and unique issuer names, each capped at 50, plus the total cert count. crt.sh is slow and can return a non-JSON error/overload page → that returns { error }. No API key. (crtsh_subdomains returns only the subdomain list; this also surfaces issuers + cert count.)",
      inputSchema: memoSchema("crtsh_lookup", () => z.object({ domain: z.string().min(1).describe("registrable domain, e.g. acme.com") })),
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
      inputSchema: memoSchema("census_geocode", () => z.object({ address: z.string().min(1).describe("one-line US street address") })),
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
    // ---- Free, keyless replacements for hosts socialfetch_web_read cannot read ----
    // Measured 2026-09-30 over 14 days of tool_usage_log: socialfetch_web_read
    // completed ZERO of 10 real youtube.com reads and 0 of 3 roblox.com reads,
    // and every steamcommunity.com attempt aborted at the 18s cap. Each of those
    // hosts publishes a free, keyless, sub-second structured endpoint instead.
    // These three exist so socialfetchHostPolicy can SKIP those hosts outright
    // rather than spending 6-18s per call to fail. They return profile metadata
    // for the queried handle only: they prove an account exists and what it
    // says about itself, never who controls it.
    youtube_oembed: tool({
      description:
        "YouTube oEmbed metadata for a video URL — title, author_name (channel), author_url, thumbnail. FREE, keyless, sub-second. Use this INSTEAD of socialfetch_web_read for youtube.com / youtu.be, which has never once read a YouTube page (0 of 10 real attempts, 2026-09-30 audit). A 401/404 means private or deleted — a genuine negative about the URL, returned as { ok: true, found: false }, not a tool fault.",
      inputSchema: memoSchema("youtube_oembed", () => z.object({
        url: z.string().min(1).describe("youtube.com or youtu.be video URL"),
      })),
      execute: async ({ url }) => {
        try {
          const r = await fetchT(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`, {}, 8_000);
          // oEmbed answers 401 for a private video and 404 for a deleted or
          // never-existent one. Both are real facts about the URL, so they are
          // successes that found nothing — never `ok: false`.
          if (r.status === 401 || r.status === 404) {
            return { ok: true, url, found: false, status: r.status, reason: r.status === 401 ? "private" : "not_found" };
          }
          if (!r.ok) return { ok: false, status: r.status, error: `youtube oembed ${r.status}`, url };
          const d = (await r.json().catch(() => null)) as
            { title?: string; author_name?: string; author_url?: string; thumbnail_url?: string } | null;
          if (!d) return { ok: false, status: r.status, error: "youtube oembed returned non-JSON", url };
          return {
            ok: true, url, found: true,
            title: d.title ?? null,
            author_name: d.author_name ?? null,
            author_url: d.author_url ?? null,
            thumbnail_url: d.thumbnail_url ?? null,
          };
        } catch (e) { return { error: String(e instanceof Error ? e.message : e) }; }
      },
    }),
    roblox_user: tool({
      description:
        "Roblox public profile lookup by username or numeric user id — id, name, displayName, created, isBanned, description, profile_url. FREE, keyless, official users.roblox.com API. Use this INSTEAD of socialfetch_web_read for roblox.com, which timed out on every attempt (3 of 3, 2026-09-30 audit). Proves the account exists and what its profile says — never who owns it.",
      inputSchema: memoSchema("roblox_user", () => z.object({
        username: z.string().min(1).optional().describe("Roblox username"),
        user_id: z.union([z.string(), z.number()]).optional().describe("numeric Roblox user id"),
      })),
      execute: async ({ username, user_id }) => {
        try {
          let id = user_id == null ? null : String(user_id).trim();
          if (!id && !username) return { error: "roblox_user needs username or user_id" };
          if (!id && username) {
            const lookup = await fetchT("https://users.roblox.com/v1/usernames/users", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ usernames: [username], excludeBannedUsers: false }),
            }, 8_000);
            if (!lookup.ok) return { ok: false, status: lookup.status, error: `roblox usernames ${lookup.status}`, username };
            const ld = (await lookup.json().catch(() => null)) as { data?: Array<{ id?: number }> } | null;
            const hit = ld?.data?.[0]?.id;
            // An unknown username returns 200 with an EMPTY data array, so a
            // 200 alone is not a hit.
            if (hit == null) return { ok: true, username, found: false };
            id = String(hit);
          }
          const r = await fetchT(`https://users.roblox.com/v1/users/${encodeURIComponent(id!)}`, {}, 8_000);
          if (r.status === 404) return { ok: true, username: username ?? null, user_id: id, found: false };
          if (!r.ok) return { ok: false, status: r.status, error: `roblox users ${r.status}`, user_id: id };
          const d = (await r.json().catch(() => null)) as
            { id?: number; name?: string; displayName?: string; created?: string; isBanned?: boolean; description?: string } | null;
          if (!d) return { ok: false, status: r.status, error: "roblox returned non-JSON", user_id: id };
          return {
            ok: true, found: true,
            id: d.id ?? Number(id),
            name: d.name ?? null,
            displayName: d.displayName ?? null,
            created: d.created ?? null,
            isBanned: d.isBanned ?? null,
            // Bounded: a Roblox bio is free text and the whole result is
            // re-serialized into the prompt on every later step.
            description: typeof d.description === "string" ? d.description.slice(0, 500) : null,
            profile_url: `https://www.roblox.com/users/${d.id ?? id}/profile`,
          };
        } catch (e) { return { error: String(e instanceof Error ? e.message : e) }; }
      },
    }),
    steam_profile: tool({
      description:
        "Steam community profile by profile URL, steamID64 or vanity name — steamID64, display name, realname, location, memberSince, privacyState. FREE, keyless (the public ?xml=1 endpoint). Use this INSTEAD of socialfetch_web_read for steamcommunity.com, which aborts at the 18s cap there (2026-09-30 audit). A private profile returns privacyState 'private' with no detail — that is the account's own setting, not a failure.",
      inputSchema: memoSchema("steam_profile", () => z.object({
        url: z.string().min(1).optional().describe("full steamcommunity.com profile URL"),
        steamid64: z.string().min(1).optional().describe("17-digit steamID64"),
        vanity: z.string().min(1).optional().describe("vanity /id/<name> segment"),
      })),
      execute: async ({ url, steamid64, vanity }) => {
        try {
          let target: string | null = null;
          if (steamid64) target = `https://steamcommunity.com/profiles/${encodeURIComponent(steamid64.trim())}`;
          else if (vanity) target = `https://steamcommunity.com/id/${encodeURIComponent(vanity.trim())}`;
          else if (url) {
            const m = url.match(/steamcommunity\.com\/(profiles|id)\/([^/?#]+)/i);
            if (m) target = `https://steamcommunity.com/${m[1].toLowerCase()}/${m[2]}`;
          }
          if (!target) return { error: "steam_profile needs url, steamid64 or vanity" };
          const r = await fetchT(`${target}?xml=1`, {}, 8_000);
          if (!r.ok) return { ok: false, status: r.status, error: `steam ${r.status}`, profile_url: target };
          const xml = await r.text();
          const pick = (tag: string): string | null => {
            const m = xml.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, "i"));
            return m ? (m[1].trim() || null) : null;
          };
          // The ?xml=1 endpoint answers HTTP 200 with an <error> document for an
          // unknown vanity or id, so a 200 is not on its own a hit.
          const err = pick("error");
          if (err) return { ok: true, found: false, profile_url: target, reason: err.slice(0, 200) };
          const steamID64 = pick("steamID64");
          if (!steamID64) {
            // ⚠️ NOT a negative. Steam answers 200 with a maintenance page, an
            // age/consent interstitial, a rate-limit notice or a truncated body,
            // and none of those carry an <error> element. Reporting "no such
            // account" for one MANUFACTURES EVIDENCE: it is an operational fault
            // dressed as a fact about the target, and the cache would then serve
            // that fabricated negative for the whole TTL. A recognized <error>
            // document is the only successful negative; anything else is a tool
            // fault, so `ok:false` — which keeps it out of the case and out of
            // the cache.
            return {
              ok: false,
              status: r.status,
              failure_class: "malformed_response",
              error: "steam ?xml=1 returned 200 with neither <steamID64> nor <error> — not a profile document",
              profile_url: target,
              chars: xml.length,
              body_head: xml.trim().slice(0, 200) || null,
            };
          }
          return {
            ok: true, found: true,
            steamID64,
            steamID: pick("steamID"),
            realname: pick("realname"),
            location: pick("location"),
            memberSince: pick("memberSince"),
            privacyState: pick("privacyState"),
            profile_url: target,
          };
        } catch (e) { return { error: String(e instanceof Error ? e.message : e) }; }
      },
    }),
    nominatim_geocode: tool({
      description:
        "OpenStreetMap Nominatim geocoder — resolve any worldwide ADDRESS or place to coordinates. Input: { address: string }. Returns the top match: display_name, lat/lon, category/type, and a residential-vs-commercial hint when derivable. Rate-limited to 1 req/sec by OSM policy (sends a descriptive User-Agent). No API key.",
      inputSchema: memoSchema("nominatim_geocode", () => z.object({ address: z.string().min(1).describe("free-form address or place name") })),
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
      inputSchema: memoSchema("hibp_pwned_passwords_kanon", () => z.object({
        password: z.string().min(1).optional().describe("plaintext password (hashed locally with SHA-1; never transmitted)"),
        sha1: z.string().regex(/^[0-9a-fA-F]{40}$/).optional().describe("precomputed 40-hex SHA-1 of the password"),
      })),
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
      inputSchema: memoSchema("gleif_lei_search", () => z.object({ name: z.string().min(1).describe("org / company legal name") })),
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
      inputSchema: memoSchema("opencorporates_search", () => z.object({ name: z.string().min(1).describe("company / organization name") })),
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
      inputSchema: memoSchema("http_fingerprint", () => z.object({ url: z.string().url() })),
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
      inputSchema: memoSchema("crypto_wallet", () => z.object({ chain: z.enum(["btc", "eth"]), address: z.string() })),
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
        "Generate copy-paste Google/Bing/DuckDuckGo/Yandex dork queries for a seed identifier. NO external API cost. Use once for the original seed or a corroborated high-value selector when the resulting query set supports a defined verification goal. " +
        "PICK THE KIND FROM THE SELECTOR, not from convenience: a street address is kind:\"address\" (exact-address, parcel/assessor/recorder, deed/ownership, address+person, address+business, public records, documents, archives, real estate). " +
        "kind:\"domain\" is ONLY for a valid hostname such as example.com — it emits site:, wildcard-subdomain, certificate and secret-exposure templates that are meaningless for anything else. A non-hostname seed sent as kind:\"domain\" is refused with error:'kind_mismatch' (or re-routed to the address family when it is recognisably an address); it does NOT silently return domain queries.",
      inputSchema: memoSchema("google_dorks", () => coercedSchema("google_dorks", {
        enumFields: { kind: ["email", "username", "phone", "name", "person", "address", "domain", "ip", "hash", "crypto_wallet"] },
        renames: QUERY_TO_SEED,
        infer: DORK_KIND_FROM_SEED,
        stringFields: ["seed"],
        trimFields: ["seed"],
      }, z.object({
        seed: z.string(),
        // Accept legacy/alias "person" → mapped to "name" in execute().
        kind: z.enum(["email", "username", "phone", "name", "person", "address", "domain", "ip", "hash", "crypto_wallet"]),
      }))),
      execute: async ({ seed, kind: rawKind }) => {
        const aliasedKind = rawKind === "person" ? "name" : rawKind;
        // The model-supplied `kind` is UNTRUSTED input, not a routing decision.
        // The domain family blindly interpolates the seed into host-shaped
        // operators (site:, site:*., %., certificate/secret/admin templates);
        // production emitted `site:79 Waverly Ave Cincinnati OH 45215` because
        // nothing checked that the seed was actually a hostname.
        const resolvedKind = resolveDorkKind(seed, aliasedKind);
        if (!resolvedKind.ok) return resolvedKind;
        const kind = resolvedKind.kind;
        // google_dorks is intentionally ungated — it only emits search URLs.
        const e = encodeURIComponent(seed);
        const map: Record<string, Dork[]> = {
          address: buildAddressDorks(seed),
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
        // Every URL is regenerated from its own displayed query through ONE
        // encoder, so the link a user clicks executes exactly what is shown.
        // The hand-written urls above encoded only a prefix of their query.
        const dorks = canonicalizeDorks(map[kind] ?? []);
        return {
          seed,
          kind,
          ...(resolvedKind.corrected ? { kind_corrected: resolvedKind.corrected } : {}),
          dorks,
        };
      },
    }),
    dork_harvest: tool({
      description:
        "Execute the highest-yield document/leak dorks for a seed and record the RELEVANT PDFs, Office docs, CSV/SQL/log/env dumps, pastebin entries, and stealer-log URLs as artifacts (kind='document' / 'leak_paste'). A URL is recorded ONLY if the seed appears in its path OR a bounded Gemini read (top few docs) finds the seed in the document text — irrelevant hits (resume templates, unrelated court/SEC/FEC filings) are held in `candidate_links_unread`, NOT recorded, so the evidence table stays clean. Runs N targeted Perplexity Sonar queries (Exa keyword fallback honors site: domains). Costs 1 Perplexity call per query plus up to 3 Gemini reads.",
      inputSchema: memoSchema("dork_harvest", () => coercedSchema("dork_harvest", {
        enumFields: { kind: ["email", "username", "phone", "name", "person", "address", "domain", "ip", "hash", "crypto_wallet"] },
        renames: QUERY_TO_SEED,
        stringFields: ["seed"],
        trimFields: ["seed"],
        numberFields: ["max_queries"],
      }, z.object({
        seed: z.string(),
        // "address" runs the NAME query family (dork-queries.ts harvestQueryFamily — this tool has no address family of
        // its own); provenance keeps seed_kind "address". Refused again under INPUT_COERCION_DISABLED.
        kind: z.enum(["email", "username", "phone", "name", "person", "address", "domain", "ip", "hash", "crypto_wallet"])
          .refine(ADDRESS_KIND_GATE, ADDRESS_KIND_GATE_MSG),
        max_queries: z.number().int().min(1).max(12).default(5),
      }))),
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
        const queries = (QUERIES[harvestQueryFamily(kind)] ?? []).slice(0, max_queries).map(augmentDorkQuery);
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
        // --- Relevance gate (Fix #5c) -------------------------------------------
        // The old path recorded EVERY document/leak URL blind — the live case
        // shows the cost: a poultry-science paper, PNC SEC filings, FEC legal
        // PDFs, and resume-writing guides all landed as confidence-55 artifacts
        // because the seed appeared in a Perplexity *result*, not in the document.
        // A URL is now recorded ONLY if it passes a seed relevance check (seed in
        // the URL path) OR is READ by Gemini and the seed is found in the extracted
        // text. Everything else goes to `candidate_links_unread` — surfaced for the
        // agent, but NOT inserted into the artifact table.
        const seedNorm = String(seed).toLowerCase().replace(/[^a-z0-9]/g, "");
        const GEMINI_READ_BUDGET = 3; // bounded reads per harvest (latency/cost)
        // Read the key at call time so the read-branch is decoupled from module
        // load order (prod sets it at boot; this keeps env.ts's fallback selection
        // unpolluted when a test enables vision).
        const geminiKeyForRead = Deno.env.get("GEMINI_API_KEY");
        let geminiReads = 0;
        const candidateUnread: Array<{ url: string; via: string; classify: string; reason: string }> = [];
        const toRecord: Array<{
          url: string; via: string; classify: "document" | "leak_paste";
          confidence: number; relevance: number; read: boolean; selectors?: string[];
        }> = [];

        for (const c of collected) {
          // 1) Cheap URL-level seed match — a URL whose path carries the seed/
          //    selector is self-evidently about it (a paste/profile with the handle
          //    in the path). Keyless, no fetch.
          const urlNorm = c.url.toLowerCase().replace(/[^a-z0-9]/g, "");
          if (seedNorm.length >= 4 && urlNorm.includes(seedNorm)) {
            toRecord.push({ ...c, confidence: c.classify === "leak_paste" ? 55 : 60, relevance: 1, read: false });
            continue;
          }
          // 2) Bounded Gemini document read — actually READ the doc and score seed
          //    presence in the real text. This is what finally reads harvested PDFs
          //    instead of recording the URL blind.
          if (geminiKeyForRead && geminiReads < GEMINI_READ_BUDGET) {
            geminiReads++;
            let text: string | null = null;
            let selectors: string[] = [];
            try {
              const vis = await runGeminiVision({ mode: "document", url: c.url }, undefined);
              if (vis?.ok && vis.result && typeof vis.result === "object") {
                const res = vis.result as Record<string, unknown>;
                text = typeof res.extracted_text === "string" ? res.extracted_text : null;
                selectors = Array.isArray(res.selectors) ? (res.selectors as unknown[]).map(String) : [];
              }
            } catch { /* read failure → treated as unread below */ }
            const rel = scoreDorkRelevance({ text, seed: String(seed), url: c.url });
            if (rel.relevance >= DORK_RELEVANCE_FLOOR) {
              toRecord.push({
                ...c,
                confidence: applyDorkRelevance(c.classify === "leak_paste" ? 55 : 60, rel),
                relevance: rel.relevance,
                read: true,
                selectors,
              });
            } else {
              candidateUnread.push({ url: c.url, via: c.via, classify: c.classify, reason: rel.reason });
            }
            continue;
          }
          // 3) Unread + no URL seed match → candidate link, NOT an artifact.
          candidateUnread.push({
            url: c.url, via: c.via, classify: c.classify,
            reason: geminiKeyForRead ? "gemini read budget exhausted — unread, seed not in URL" : "not read (no GEMINI_API_KEY) and seed not in URL",
          });
        }

        if (toRecord.length > 0) {
          const rows = toRecord.map((c) => {
            const built = buildAutoRecordedRow({
              kind: c.classify,
              value: c.url,
              source: "dork_harvest",
              rawConfidence: c.confidence,
              metadata: {
                seed,
                seed_kind: kind,
                dork_query: c.via,
                discovered_via: "google_dork → perplexity sonar (exa keyword fallback)",
                relevance: c.relevance,
                ...(c.read
                  ? { provenance: "extracted_from_document", read_by: "gemini_vision" }
                  : { relevance_basis: "seed present in URL path" }),
                ...(c.selectors && c.selectors.length ? { extracted_selectors: c.selectors.slice(0, 40) } : {}),
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
          gemini_reads: geminiReads,
          // Unverified URLs — surfaced as leads, NOT recorded as artifacts. The
          // agent may read a specific one via gemini_vision (mode='document') if it
          // looks promising; they are deliberately kept out of the evidence table.
          candidate_links_unread: candidateUnread.slice(0, 30),
          candidate_links_unread_count: candidateUnread.length,
          sample: toRecord.slice(0, 20).map((c) => c.url),
          per_query: queryResults,
          provider_stats: providerStats,
          degraded: providerStats.exa > 0,
          note: inserted > 0
            ? `Recorded ${inserted} RELEVANT document/leak artifact(s) (seed matched in URL or read text). ${candidateUnread.length} unverified URL(s) held in candidate_links_unread — NOT recorded; do NOT re-record them via record_artifacts.${providerStats.exa > 0 ? ` Fallback engaged: Exa handled ${providerStats.exa}/${queryResults.length} query(ies).` : ""}`
            : `No RELEVANT document/leak URLs this pass — ${candidateUnread.length} unverified candidate(s) held in candidate_links_unread (seed not found in URL${GEMINI_API_KEY ? "/read text" : "; no GEMINI_API_KEY to read them"}). Nothing recorded.${providerStats.exa > 0 ? ` Fallback engaged: Exa handled ${providerStats.exa}/${queryResults.length} query(ies).` : ""}`,
        };
      },
    }),
    gemini_deep_dork: tool({
      description:
        "FALLBACK deep-dork via Gemini 2.5 Flash with native Google Search grounding. Use AFTER google_dorks + dork_harvest — ~46% success rate in production telemetry; do not lead with this. Gemini reasons about the seed, formulates targeted Google dork queries internally, executes them against real Google, and returns a synthesized writeup PLUS source URLs as grounding citations. Use when dork_harvest misses something or you need LLM-driven dork generation (tricky disambiguation, niche forum surfacing). AUTO-RECORDS every cited URL as an artifact (kind='url' or classified by extension as 'document'/'leak_paste'). Template/sample document URLs are dropped. 1 Gemini call ≈ $0.002.",
      inputSchema: memoSchema("gemini_deep_dork", () => coercedSchema("gemini_deep_dork", {
        enumFields: { kind: ["email","username","phone","name","person","address","domain","ip","hash","crypto_wallet","url","other"] },
        // A missing kind is the catch-all "other" the enum already offered; an UNKNOWN kind is not (it stays rejected).
        defaults: { kind: "other" },
        renames: QUERY_TO_SEED,
        stringFields: ["seed"],
        trimFields: ["seed"],
      }, z.object({
        seed: z.string(),
        // "address": Gemini drafts its own dorks from `Seed (<kind>): <seed>`, so an address needs no tool-side query
        // family — the kind is only the label in the prompt. Refused again under INPUT_COERCION_DISABLED.
        kind: z.enum(["email","username","phone","name","person","address","domain","ip","hash","crypto_wallet","url","other"])
          .refine(ADDRESS_KIND_GATE, ADDRESS_KIND_GATE_MSG),
        focus: z.string().optional().describe("Optional angle, e.g. 'breach exposure', 'resume/CV leaks', 'social handles', 'pastebin dumps', 'forum posts', 'court records'."),
      }))),
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
      inputSchema: memoSchema("shodan_internetdb", () => z.object({ ip: z.string() })),
      execute: async ({ ip }) => {
        try {
          const r = await fetchT(`https://internetdb.shodan.io/${encodeURIComponent(ip)}`, {}, 12_000);
          const data = await r.json().catch(() => ({}));
          // 404 = "no InternetDB record for this IP": a proven negative, not a dead
          // endpoint (see lib/negative-lookup.ts). Every other status is unchanged.
          return shapeShodanResponse(r.status, r.ok, data, ip);
        } catch (e) { return { error: String(e) }; }
      },
    }),
    jina_reader_scrape: tool({
      description:
        "#1 PRIMARY scraper for ANY URL — free, unlimited, returns clean LLM-ready markdown. Always prefer this over firecrawl/exa_contents for single-page extraction. Use https://r.jina.ai/{url} under the hood. Works on articles, profile pages, forums, leak listings, dorks hits, Discord/Telegram links, PDFs (best-effort), etc. Pass a fully-qualified http(s) URL — do NOT pass relative paths or text snippets.",
      inputSchema: memoSchema("jina_reader_scrape", () => coercedSchema("jina_reader_scrape", {
        numberFields: ["maxChars"],
        trimFields: ["url"],
      }, z.object({
        url: z.string().url(),
        maxChars: z.number().int().min(500).max(40000).default(18000),
      }))),
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
        // Malformed-selector guard (2026-07-25 production audit, thread d98deb37):
        // the model occasionally passes a natural-language search query — not a
        // real URL path — in the pathname/query (e.g. a DeepSeek hallucination like
        // "https://r.jina.ai/find John Smith twitter account" or a query string
        // whose value is a full sentence). z.string().url() lets these through
        // because they're still syntactically valid URLs; Jina then wastes a live
        // round-trip and 422s. Reject locally, zero-cost, BEFORE the provider call:
        // decode the pathname + query and flag it if it reads like prose (several
        // whitespace-separated words, no path-like punctuation) rather than a
        // selector/slug/query-param fragment.
        const decodedTail = decodeURIComponent(`${parsed.pathname}${parsed.search}`).replace(/[+]/g, " ");
        const words = decodedTail.trim().split(/\s+/).filter(Boolean);
        const looksLikePath = /[/._-]/.test(decodedTail.replace(/^\/+/, "").split(/[?=&\s]/)[0] ?? "");
        if (words.length >= 4 && !looksLikePath) {
          return {
            error: "malformed_selector",
            skipped: true,
            url: raw,
            hint: "this looks like a natural-language search query, not a URL path/selector — use google_dorks or minimax_web_search to find the real page URL first, then scrape that",
          };
        }
        // Skip a host already proven dead (NXDOMAIN) this investigation.
        if (isHostDead(parsed.hostname)) return { skipped: true, reason: "host does not resolve (NXDOMAIN) — skipped", url: raw };
        // Skip hosts that always 451/403 through Jina — save the ~8s dead round-trip.
        if (isJinaHardBlocked(parsed.hostname)) {
          return { error: "jina 451", status: 451, url: parsed.toString(), skipped: true, hint: "origin hard-blocks Jina — use socialfetch_web_read (server-side markdown) for this host, or wayback_snapshots / a direct-API tool" };
        }
        // Google SERP pages reliably time out through Jina (consent walls) rather
        // than fail fast — skip instantly instead of eating the full 18s cap.
        if (isJinaGoogleSearchDeadEnd(parsed.hostname, parsed.pathname)) {
          return {
            error: "jina search dead-end",
            skipped: true,
            url: parsed.toString(),
            hint: "r.jina.ai cannot reliably render Google SERPs (consent/interstitial walls) — use minimax_web_search or exa_search for search-style queries instead of scraping a Google search URL",
          };
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
          // A 200 can wrap an ORIGIN error ("Warning: Target URL returned error 404").
          // shapeJinaBody keeps that out of the evidence stream — see lib/negative-lookup.ts.
          return shapeJinaBody(clean, text, maxChars);
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
      inputSchema: memoSchema("exa_search", () => z.object({
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
      })),
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
      inputSchema: memoSchema("exa_find_similar", () => z.object({
        url: z.string().url(),
        numResults: z.number().int().min(1).max(25).default(10),
        excludeSourceDomain: z.boolean().default(true),
        contents: z.boolean().default(true),
      })),
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
      inputSchema: memoSchema("exa_get_contents", () => z.object({
        urls: z.array(z.string().url()).min(1).max(10),
        text: z.boolean().default(true),
        highlights: z.boolean().default(true),
        summary: z.boolean().default(true),
        livecrawl: z.enum(["never","fallback","auto","always"]).default("auto"),
        maxCharacters: z.number().int().min(200).max(8000).default(3000),
      })),
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
    gravatar_profile: tool({
      description:
        "Look up a Gravatar profile by email. Returns display name, bio, linked social accounts, avatar URL — and confirms the email is real. Always run on any email seed.",
      inputSchema: memoSchema("gravatar_profile", () => z.object({ email: z.string().email() })),
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
      inputSchema: memoSchema("hackertarget", () => z.object({
        mode: z.enum(["reverseiplookup", "hostsearch", "dnslookup", "aslookup", "geoip", "reversedns"]),
        query: z.string(),
      })),
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
      inputSchema: memoSchema("urlscan_search", () => z.object({ query: z.string().describe('Lucene query, e.g. domain:example.com or ip:1.2.3.4 or page.url:"keyword"') })),
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
      inputSchema: memoSchema("hackernews_user", () => z.object({ username: z.string() })),
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
      inputSchema: memoSchema("reddit_user", () => z.object({ username: z.string() })),
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
      inputSchema: memoSchema("github_code_search", () => z.object({ query: z.string() })),
      execute: async ({ query }) => {
        try {
          const url = `https://api.github.com/search/code?q=${encodeURIComponent(query)}&per_page=20`;
          const call = async (authed: boolean) => {
            const headers: Record<string, string> = {
              "User-Agent": "Proximity-OSINT",
              Accept: "application/vnd.github.v3.text-match+json",
            };
            if (authed && GITHUB_API_TOKEN) headers.Authorization = `Bearer ${GITHUB_API_TOKEN}`;
            const res = await fetchT(url, { headers });
            const body = await res.text();
            let parsed: GitHubCodeSearchResponse = {};
            try { parsed = JSON.parse(body); } catch { parsed = { raw: body.slice(0, 500) }; }
            return { res, body, parsed };
          };

          let authenticated = !!GITHUB_API_TOKEN;
          let { res: r, body: text, parsed: data } = await call(authenticated);

          // A CONFIGURED-BUT-REJECTED token must not make this tool worse than
          // no token at all. This tool's own description promises an
          // unauthenticated fallback (60 req/hr), but that fallback only ever
          // covered "no token set" — a stale or revoked GITHUB_API_TOKEN 401ed
          // and the call was simply lost. Observed on the 2026-09-12
          // `baig_azhar` case: `github_code_search` reported "Config 1 — HTTP
          // 401" on the Health tab and persisted a `weak_lead` artifact saying
          // the search FAILED, while the same query unauthenticated would have
          // answered. Retry ONCE, without the credential, and report which
          // mode produced the result.
          let staleToken = false;
          if (!r.ok && (r.status === 401 || r.status === 403) && authenticated) {
            console.warn(`[github_code_search] token rejected (HTTP ${r.status}) — retrying unauthenticated`);
            staleToken = true;
            authenticated = false;
            ({ res: r, body: text, parsed: data } = await call(false));
          }

          if (!r.ok) {
            const remaining = r.headers.get("x-ratelimit-remaining");
            const reset = r.headers.get("x-ratelimit-reset");
            console.warn(`[github_code_search] HTTP ${r.status} authed=${authenticated} stale_token=${staleToken} remaining=${remaining} reset=${reset} msg=${(data?.message ?? "").slice(0, 200)}`);
            return { error: `github ${r.status}`, status: r.status, authenticated, token_rejected: staleToken, rate_remaining: remaining, message: data?.message, snippet: text.slice(0, 300) };
          }
          const items = (data?.items ?? []).map((i: GitHubCodeMatch) => {
            const textMatches = Array.isArray(i.text_matches) ? (i.text_matches as Array<{ fragment?: unknown }>) : [];
            return {
              repo: i.repository?.full_name, path: i.path, url: i.html_url,
              matches: textMatches.map((m) => m.fragment).slice(0, 3),
            };
          });
          return { ok: true, authenticated, token_rejected: staleToken || undefined, total: data?.total_count, items };
        } catch (e) { return { error: String(e) }; }
      },
    }),
    hunter_domain_search: tool({
      description:
        "Hunter.io domain-search. Returns emails associated with a domain, plus organization, pattern, department/seniority breakdown, and per-email sources. Premium signal — use on any non-consumer domain.",
      inputSchema: memoSchema("hunter_domain_search", () => z.object({
        domain: z.string(),
        limit: z.number().int().min(1).max(100).optional(),
        department: z.string().optional().describe("executive, it, finance, management, sales, legal, support, hr, marketing, communication, education, design, health, operations"),
        seniority: z.string().optional().describe("junior, senior, executive"),
        type: z.enum(["personal", "generic"]).optional(),
      })),
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
      inputSchema: memoSchema("hunter_email_finder", () => z.object({
        domain: z.string(),
        first_name: z.string().optional(),
        last_name: z.string().optional(),
        full_name: z.string().optional(),
      })),
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
      inputSchema: memoSchema("hunter_email_verifier", () => z.object({ email: z.string().email() })),
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
      inputSchema: memoSchema("hunter_combined", () => z.object({ email: z.string().email() })),
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
      inputSchema: memoSchema("archive_url", () => z.object({ url: z.string().url() })),
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
      // Root coercion: a stringified-JSON root (`"{\"artifacts\":[…]}"`) or a stringified `artifacts` field is parsed
      // before validation (lib/tool-input-coercion.ts); coerceArtifactsInput below still handles the fenced/embedded
      // shapes and a single object.
      inputSchema: memoSchema("record_artifacts", () => coercedSchema("record_artifacts", { jsonFields: ["artifacts"] }, z.object({
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
      }))),
      execute: async ({ artifacts: rawArtifactsIn }) => {
        // A1: a model cannot write the analyst's keys. `reviewed`, `linkage_confirmed` and
        // `false_positive` are read downstream as analyst attestation / quarantine release /
        // dismissal, and the metadata below is otherwise persisted as the model wrote it. Stripped
        // BEFORE the batch collapse (which can merge metadata) and before anything else reads it.
        // Disclosed by key NAME on the row, in the log and in this result — never the values.
        const authorityStripped = new Set<string>();
        const rawArtifacts = rawArtifactsIn.map((item) => {
          const s = stripAnalystAuthorityKeys(item.metadata);
          s.stripped.forEach((k) => authorityStripped.add(k));
          return s.stripped.length > 0 ? { ...item, metadata: s.metadata } : item;
        });
        const authorityStrippedList = [...authorityStripped].sort();
        if (authorityStrippedList.length > 0) {
          console.warn(JSON.stringify({
            event: "analyst_authority_stripped",
            thread_id: threadId,
            tool: "record_artifacts",
            keys: authorityStrippedList,
          }));
        }
        const authorityNotice = authorityStrippedList.length > 0
          ? { analyst_authority_stripped: authorityStrippedList, analyst_authority_note: ANALYST_AUTHORITY_NOTE }
          : {};
        const artifacts = collapseRecordArtifactsBatch(rawArtifacts);
        const accepted: Array<{ index: number; kind: string; value: string }> = [];
        const rejected: Array<{ index: number; reason: string; kind: string; value: string }> = [];
        const rows: Array<Record<string, unknown>> = [];
        // In-process dedup: a single batch sometimes carries the same
        // (kind, value) twice (model repeats itself, or two sources agree).
        // Skip exact repeats so we don't write duplicate artifact rows. This is
        // a non-destructive, in-memory-only guard — no DB change.
        const seenInBatch = new Set<string>();
        // THREAD-WIDE dedup (2026-08-28) — the bound the note below used to
        // describe as open. `seenInBatch` only ever caught a repeat inside ONE
        // call, and the duplicates measured in production were seconds apart in
        // DIFFERENT calls: `Example Holdings 1110 LLC` persisted as three
        // `organization` rows (55/75/75), `Sam Whitfield` as three, one address
        // as four. An Evidence count of 88 that is not a count of distinct facts.
        //
        // Closed at RUNTIME, deliberately. #305's dedup migration would have
        // deleted ~120 genuinely distinct rows and orphaned 53 analyst reviews;
        // #307, which existed to fix that, was closed unmerged. Nothing here
        // deletes, migrates or backfills anything — it only declines to write a
        // row the thread already has.
        const { keys: priorByKey, truncated: threadDedupPartial } =
          await loadThreadArtifactIdentities(supabase, threadId, triageState.seed ?? null);
        // Write-path linkage gate for MODEL-AUTHORED rows (lib/record-name-quarantine.ts):
        // a row naming a person this thread has ACTIVELY quarantined inherits that
        // quarantine. `loadQuarantinedNames` reads the thread completely and merges
        // quarantines extracted earlier in THIS request (see its definition).
        let quarantinedNames: QuarantinedName[] = [];
        let nameQuarantineStamped = 0;
        const nameQuarantineOn = recordNameQuarantineEnabled();
        if (nameQuarantineOn) quarantinedNames = await loadQuarantinedNames();
        /** Confidence differences on rows declined as thread-wide duplicates.
         *  DISCLOSED, never applied — see the note at the rejection site. */
        const confidenceDeltasSuppressed: Array<{
          kind: string;
          value: string;
          recorded_confidence: number;
          attempted_confidence: number;
        }> = [];
        // breach_exposure source guard (lib/breach-exposure-guard.ts): loaded once, only when
        // the batch carries a breach row. null = read failed → guard fails open for this batch.
        const breachGuardOn = !breachExposureGuardDisabled() &&
          artifacts.some((x) => /breach/i.test(String(x?.kind ?? "")));
        const ranBreachTools = breachGuardOn ? await loadRanBreachTools(supabase, threadId) : null;
        artifacts.forEach((aRaw, i) => {
          // E3: recalled memory is context, never a source (lib/memory-context.ts).
          const memCtx = applyMemoryContext(aRaw.source, aRaw.metadata as Record<string, unknown> | undefined);
          const a = memCtx.memory ? { ...aRaw, source: memCtx.source, metadata: memCtx.metadata } : aRaw;
          // A QUEUED tool call is not an observation. Ten rows like
          // "hawkcapo - socialfetch_lookup (pending Instagram)" were persisted
          // on a measured run BEFORE their tool returned, each carrying
          // status:"observed", each later shadowed by the real result — false
          // when written, duplicated once answered, and joined to the subject
          // cluster where they feed promoteConfidence's peer set.
          if (isQueuedPlaceholder(a.value, KNOWN_TOOL_SLUGS)) {
            rejected.push({
              index: i,
              reason:
                "queued-tool placeholder, not an observation — record the RESULT after the tool returns. " +
                "A pending call has observed nothing and would duplicate its own result.",
              kind: a.kind,
              value: a.value,
            });
            return;
          }
          // An analyst label asserted INSIDE the value outranks the number
          // stored beside it: "Instagram @hawkcapo - CONFIRMED active profile"
          // shipped at confidence 40 with reason_not_confirmed "needs second
          // independent class of evidence". The value is rendered verbatim by
          // the evidence table, the graph, export and any generated findings
          // table, so the word survives every downstream control built to stop
          // that claim. Removed here, once, for all of them. ALL-CAPS only, so
          // quoted source text is evidence and is left intact.
          const hygienic = stripStatusAssertions(a.value);
          // Infer strict kind from value patterns (LAPD → law_enforcement_unit,
          // People v X → court_case, wallet hex → crypto_wallet, etc.).
          const inferred = inferKind(a.kind, hygienic.value);
          const v = validateArtifact(inferred.kind, hygienic.value);
          if (!v.ok) {
            rejected.push({ index: i, reason: v.reason, kind: a.kind, value: a.value });
            return;
          }
          if (ranBreachTools && BREACH_EXPOSURE_KINDS.has(v.kind)) {
            const verdict = checkBreachExposureRow({
              value: v.value,
              sourceLabels: disclosedSourceLabels(a.source, a.metadata ?? null),
              metadata: (a.metadata ?? null) as Record<string, unknown> | null,
              ranTools: ranBreachTools,
            });
            if (!verdict.ok) {
              console.log(JSON.stringify({ event: "breach_exposure_rejected", code: verdict.code, source: a.source ?? null }));
              rejected.push({ index: i, reason: verdict.reason, kind: a.kind, value: a.value });
              return;
            }
          }
          // Apply conservative confidence caps based on source class.
          const disclosedSources = disclosedSourceLabels(a.source, a.metadata ?? null);
          const { effective: cap } = applyRecordingSourcePolicy({
            rawConfidence: a.confidence ?? 50,
            source: a.source,
            kind: a.kind,
            metadata: (a.metadata ?? null) as Record<string, unknown> | null,
          });
          // Provenance guard (#131 follow-up): flag an artifact whose effective
          // source names a bare domain that is NOT a wired tool and NOT a recognized
          // provider — i.e. an LLM-asserted citation nothing actually fetched (the
          // menstoppingviolence.org incident). The seed domain (which whois/dns DO
          // fetch) is whitelisted so the legitimate seed never trips it.
          const seedRecognizedDomains = [triageState.seedDomain, triageState.seed]
            .filter((d): d is string => typeof d === "string" && d.length > 0);
          const llmAssertedProvenance = disclosedSources.some((s) => isLlmAssertedDomainSource(s, seedRecognizedDomains));
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
          // NOTE — the legal_record demotion (G3 in #460) is deliberately NOT
          // here. It decided authority from the TOOL name, and a measured run
          // (1720 Sea Pine Circle, 2026-08-16) produced two legal_record rows
          // from the SAME tool at the SAME confidence where the right answer
          // differs: an Anne Arundel County police press release (a genuine
          // law-enforcement record) and a Gun Violence Archive incident (an
          // independent aggregator). classifySource cannot separate them —
          // aacounty.org and maryland.gov both classify as `unknown` — so the
          // authority signal lives in the URL host, not the tool. Shipping the
          // tool-keyed version would have systematically mis-filed real LE
          // records as media_report. Deferred until that is designed properly.
          const finalKind = collisionExcluded ? "excluded_collision" : v.kind;
          const finalConfidence = collisionExcluded
            ? Math.min(cap.confidence, EXCLUDED_COLLISION_CONFIDENCE)
            : bioName
              ? Math.min(cap.confidence, BIO_CROSS_LINK_NAME_CAP)
              : cap.confidence;
          // Resolve the confirmation gap, then DERIVE a coherent status from it
          // (status can never contradict reason_not_confirmed).
          // E2: pasted is not checked — analyst-supplied-only rows never reach verified/confirmed.
          const ordinaryStatus = guardUserSuppliedStatus(
            resolveRecordingStatus(cap, a.metadata ?? null),
            a.source,
            a.metadata as Record<string, unknown> | null | undefined,
          );
          const resolvedReasonNotConfirmed = bioName
            ? "name appears only in a bio/linked-accounts block — confirm it is the subject, not a mentioned third party"
            : ordinaryStatus.reasonNotConfirmed;
          const derivedStatus = collisionExcluded
            ? "excluded"
            : bioName
              ? "unverified_bio_link"
              : ordinaryStatus.status;
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
            // G2 is DISCLOSURE, not a silent rewrite. stripStatusAssertions
            // mutates the stored value, and `stripped` had no consumer — so an
            // ALL-CAPS quotation ("POLICE CONFIRMED SUSPECT IN CUSTODY" ->
            // "POLICE SUSPECT IN CUSTODY") was altered with no audit trail. The
            // pre-hygiene value is retained so chain of custody survives the edit.
            ...(hygienic.stripped
              ? { status_assertion_stripped: true, value_before_hygiene: a.value }
              : {}),
            source_category: cap.source_classes,
            query_types: queryTypesOf({ value: v.value, kind: v.kind, metadata: a.metadata ?? null }),
            status: derivedStatus,
            ...(ordinaryStatus.userSuppliedUnreviewed ? { user_supplied_unreviewed: true } : {}),
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
          if (nameQuarantineOn && !collisionExcluded) {
            const inherited = inheritedNameQuarantine(v.value, quarantinedNames, quarantineSeed());
            if (inherited) {
              Object.assign(meta, inherited);
              // Release is an ANALYST decision (src/lib/quarantine-release.ts). The
              // model cannot pre-release its own row by writing the flag.
              delete meta.linkage_confirmed;
              nameQuarantineStamped++;
            }
          }
          // One observation is identified only by its authority-bearing surface.
          // Model-authored metadata labels remain persisted for disclosure, but
          // cannot manufacture another observation row or corroboration.
          const authoritativeSource = typeof a.source === "string"
            ? a.source.trim().toLowerCase()
            : "";
          // A null result is identified by WHAT WAS CHECKED, not by how it was
          // worded. The measured run wrote breach_check's single zero-hit result
          // twice — "no breach hits (breach_check)" and "0 hits (breach_check)" —
          // because the key below is the exact value string, and paraphrase
          // defeats it. The tool stays in the key: four corpora returning zero is
          // four coverage facts, and collapsing those would erase breadth (the
          // data-loss shape flagged on #189's migration).
          //
          // It keys on `authoritativeSource`, NOT on the disclosed metadata
          // labels. #460 wrote this against `effSources`, which #463 deleted —
          // and keying on model-authored labels would let a relabelled row split
          // one observation into several, the exact laundering #463 closed.
          //
          // NOTE the bound: `seenInBatch` is per-BATCH, so this catches a
          // paraphrase repeated within one record_artifacts call. The two rows
          // measured on the live run were 33s apart in DIFFERENT batches;
          // closing that needs the thread-wide dedup tracked in #307.
          const canonicalNullKey = nullResultKey({
            kind: finalKind,
            source: authoritativeSource || (a.source ?? null),
            value: v.value,
            selector: typeof a.metadata?.username === "string"
              ? a.metadata.username
              : (typeof a.metadata?.email === "string" ? a.metadata.email : (triageState.seed ?? null)),
          });
          const dedupKey = canonicalNullKey
            ?? breachExposureCanonicalKey({ kind: finalKind, value: v.value, source: authoritativeSource || (a.source ?? null) })
            ?? artifactDedupKey({
            kind: finalKind,
            value: v.value,
            source: authoritativeSource,
          });
          if (seenInBatch.has(dedupKey)) {
            rejected.push({ index: i, reason: "duplicate (kind,value,authoritative source) already in this batch", kind: finalKind, value: v.value });
            return;
          }
          // Already on the thread from an EARLIER call. Declined, and disclosed
          // through the same `rejected[]` channel every other gate uses, so a
          // refusal stays legible as a refusal.
          const prior = priorByKey.get(dedupKey);
          if (prior) {
            // ⛔ THE STORED CONFIDENCE IS NOT RAISED. #307 merged with GREATEST
            // and that is unsafe here: `scrubArtifactRow` (safety.ts:107-112)
            // caps confidence to 25/35 on a possible-minor row AFTER
            // finalConfidence is computed and BEFORE insert. A
            // max(stored, attempted) update would read the capped 25 and raise
            // it back to the model's number, silently undoing the minor-safety
            // downgrade. Re-running the whole scrub pipeline in an update path
            // means reimplementing the write path; declining is correct.
            //
            // Nor does the duplicate carry new evidence: the key includes the
            // authoritative source, so the SAME value from a DIFFERENT source
            // has a different key and is accepted as real corroboration. A
            // delta on an identical key is the same claim from the same source
            // scored differently by the model — and #477 already settled that a
            // model-asserted number is disclosure, never authority.
            //
            // So the delta is DISCLOSED rather than applied. The model can read
            // it and re-record under the source that actually corroborated,
            // which does not collide.
            if (finalConfidence !== prior.confidence) {
              confidenceDeltasSuppressed.push({
                kind: finalKind,
                value: v.value,
                recorded_confidence: prior.confidence,
                attempted_confidence: finalConfidence,
              });
            }
            rejected.push({
              index: i,
              reason: "duplicate (kind, value, authoritative source) already recorded on this thread — " +
                "re-recording an observation does not make it two observations",
              kind: finalKind,
              value: v.value,
            });
            return;
          }
          seenInBatch.add(dedupKey);
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
          // A batch can end empty for two DIFFERENT reasons, and saying the
          // wrong one sends the model to fix a schema problem it does not have.
          // When every item was already on the thread, the disclosure fields
          // below are the whole point of the gate — dropping them here loses the
          // recorded-versus-attempted confidence delta in the single most common
          // case the gate fires.
          const allDuplicates = rejected.length > 0 &&
            rejected.every((r) => r.reason.includes("already recorded on this thread"));
          return {
            ok: false,
            count: 0,
            accepted,
            rejected,
            hint: allDuplicates
              ? "Every item is already recorded on this thread — re-recording an observation does not make it two. " +
                "Nothing was lost; read `confidence_deltas_suppressed` if you were raising a score."
              : "All items failed validation — re-check kinds/values against the rules in the tool description.",
            ...(confidenceDeltasSuppressed.length > 0
              ? { confidence_deltas_suppressed: confidenceDeltasSuppressed }
              : {}),
            ...(threadDedupPartial ? { thread_dedup_partial: true } : {}),
            ...authorityNotice,
          };
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
            // Quarantined peers are skipped — both counts are corroboration
            // measures, and an unlinked row can corroborate nothing. Shared with
            // the recovery/graph readers so the flag binds one predicate, not four.
            const { sources, clusters } = collisionPeerSignal(
              (peers ?? []) as CollisionPeer[],
            );
            if (sources.length >= 3 || clusters.length >= 2) {
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
                  sources,
                  clusters,
                  severity: clusters.length >= 2 ? "high" : "medium",
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
            // One review read for the whole fan-out; superseded memories are dropped
            // from the auto-recall the same way memory_recall drops them.
            let autoRecallRejected: Array<{ value?: unknown }> = [];
            try {
              const rl = await loadReviewsForThread(supabaseAdmin as unknown as ReviewDb, threadId, userId);
              if (rl.ok) autoRecallRejected = enforcedRejectedRows(rl);
            } catch { /* analyst lessons among the rows still supersede */ }
            const recalled = await Promise.all(
              recallSubjects.map(async (subj) => {
                const { data } = await supabase
                  .from("agent_memory")
                  .select("id,kind,subject,subject_kind,related_values,content,confidence,hit_count")
                  .eq("user_id", userId)
                  .or(agentMemoryOrFilter(subj))
                  .order("confidence", { ascending: false })
                  .limit(5);
                const { active } = applyMemorySupersession((data ?? []) as MemoryRow[], autoRecallRejected);
                return { subject: subj, count: active.length, memories: active };
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
          // A confidence delta on a thread-wide duplicate is disclosed, never
          // applied — the stored row is authoritative. If the higher number
          // reflects genuinely new corroboration, record it under the source
          // that produced it; that key does not collide.
          ...(confidenceDeltasSuppressed.length > 0
            ? { confidence_deltas_suppressed: confidenceDeltasSuppressed }
            : {}),
          // A dedup gate that quietly stopped deduping would be worse than one
          // that says so: a partial scan means a duplicate may have been let in.
          ...(threadDedupPartial ? { thread_dedup_partial: true } : {}),
          // A1: told, not hidden — reserved analyst keys in the call were ignored.
          ...authorityNotice,
          // Told, not hidden: the model must not re-assert these as the subject's.
          ...(nameQuarantineStamped > 0
            ? {
                name_quarantined: nameQuarantineStamped,
                name_quarantine_note:
                  "Some rows name a person this investigation has NOT linked to the subject (a quarantined same-name identity). " +
                  "They were recorded with subject_unlinked and carry no subject authority. Do not describe them as the subject; " +
                  "link the name with an independent selector (shared handle, email, photo, location) before relying on it.",
              }
            : {}),
          ...(memory_hits.length > 0
            ? {
                memory_hits,
                memory_hint:
                  "Prior memory found for some of the artifacts you just recorded. Read `memory_hits` — incorporate confirmed connections/lessons and cite them as [MEMORY] in the final report. Do NOT re-investigate values already covered.",
              }
            : {}),
          // Audit F1: once enough new artifacts have accrued since the last correlate,
          // surface a hint so the orchestrator actually runs minimax_correlate (it never
          // fired in the audited run). Empty object when not yet due.
          //
          // Takes through the SAME latch as the fan-out delivery path. This used to
          // call the unlatched `correlateNudge()`, which meant the hint could be
          // delivered twice in one cycle — once on a live tool result and again
          // here — because the latch did not govern this surface. One directive per
          // cycle, whichever surface reaches the model first.
          ...takeCorrelateHint(),
        };
      },
    }),
    record_artifact: tool({
      description:
        "Backwards-compatible shim. PREFER record_artifacts with an array. This wraps a single item into a one-element batch.",
      inputSchema: memoSchema("record_artifact", () => z.object({
        kind: z.string(),
        value: z.string(),
        confidence: z.number().min(0).max(100).optional(),
        source: z.string().optional(),
        metadata: z.record(z.unknown()).optional(),
      })),
      execute: async ({ kind, value, confidence, source: sourceIn, metadata: metadataRaw }) => {
        // A1: same boundary as record_artifacts — this shim is advertised in the catalog, so
        // gating only the plural tool would leave the bypass one spelling away.
        const authority = stripAnalystAuthorityKeys(metadataRaw);
        const metadataIn = authority.metadata;
        if (authority.stripped.length > 0) {
          console.warn(JSON.stringify({
            event: "analyst_authority_stripped",
            thread_id: threadId,
            tool: "record_artifact",
            keys: authority.stripped,
          }));
        }
        // E3: recalled memory is context, never a source (lib/memory-context.ts).
        const memCtx = applyMemoryContext(sourceIn, metadataIn);
        const source = memCtx.source;
        const metadata = memCtx.metadata;
        // G1/G2 apply HERE TOO. This shim is advertised in catalog.ts, so the
        // model may call it, and it wrote artifacts with none of the write-path
        // gates the plural tool enforces — an open bypass of the entire #466
        // cleanup. "Prefer record_artifacts" is guidance, not a control.
        if (isQueuedPlaceholder(value, KNOWN_TOOL_SLUGS)) {
          return {
            ok: false,
            rejected: true,
            reason:
              "queued-tool placeholder, not an observation — record the RESULT after the tool returns. " +
              "A pending call has observed nothing and would duplicate its own result.",
          };
        }
        const rawValueBeforeHygiene = value;
        const hygienic = stripStatusAssertions(value);
        value = hygienic.value;
        const inferred = inferKind(kind, value);
        const v = validateArtifact(inferred.kind, value);
        if (!v.ok) return { ok: false, rejected: true, reason: v.reason };
        const disclosedSources = disclosedSourceLabels(source, metadata ?? null);
        const { effective: cap } = applyRecordingSourcePolicy({
          rawConfidence: confidence ?? 50,
          source,
          kind: inferred.kind,
          metadata: (metadata ?? null) as Record<string, unknown> | null,
        });
        // Provenance guard (#131 follow-up) — mirrors record_artifacts. Flags a
        // bare-domain source that is neither a wired tool nor a known provider (the
        // LLM-asserted menstoppingviolence.org citation); seed domain whitelisted.
        const seedRecognizedDomains = [triageState.seedDomain, triageState.seed]
          .filter((d): d is string => typeof d === "string" && d.length > 0);
        const llmAssertedProvenance = disclosedSources.some((s) => isLlmAssertedDomainSource(s, seedRecognizedDomains));
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
        // E2: pasted is not checked — analyst-supplied-only rows never reach verified/confirmed.
        const ordinaryStatus = guardUserSuppliedStatus(
          resolveRecordingStatus(cap, metadata ?? null),
          source,
          metadata as Record<string, unknown> | null | undefined,
        );
        const resolvedReasonNotConfirmed = bioName
          ? "name appears only in a bio/linked-accounts block — confirm it is the subject, not a mentioned third party"
          : ordinaryStatus.reasonNotConfirmed;
        const derivedStatus = collisionExcluded
          ? "excluded"
          : bioName
            ? "unverified_bio_link"
            : ordinaryStatus.status;
        const enrichedMeta = {
          ...(metadata ?? {}),
          ...(v.metaPatch ?? {}),
          ...(inferred.reclassified_from ? { reclassified_from: inferred.reclassified_from } : {}),
          // Same disclosure contract as record_artifacts — never a silent edit.
          ...(hygienic.stripped
            ? { status_assertion_stripped: true, value_before_hygiene: rawValueBeforeHygiene }
            : {}),
          source_category: cap.source_classes,
          query_types: queryTypesOf({ value: v.value, kind: v.kind, metadata: metadata ?? null }),
          status: derivedStatus,
          ...(ordinaryStatus.userSuppliedUnreviewed ? { user_supplied_unreviewed: true } : {}),
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
        } as Record<string, unknown>;
        // Same write-path linkage gate as record_artifacts: this shim is a full
        // duplicate implementation and is advertised in the catalog, so gating only
        // the plural tool would leave the bypass one spelling away.
        let singleNameQuarantined = false;
        if (!collisionExcluded && recordNameQuarantineEnabled()) {
          const inherited = inheritedNameQuarantine(v.value, await loadQuarantinedNames(), quarantineSeed());
          if (inherited) {
            Object.assign(enrichedMeta, inherited);
            delete enrichedMeta.linkage_confirmed;
            singleNameQuarantined = true;
          }
        }
        // THREAD-WIDE dedup, same gate as record_artifacts (2026-08-28). This
        // shim is a full duplicate implementation, not a delegation, and it is
        // advertised in the catalog — so deduping only the plural tool would
        // leave the bypass advertised. Targeted lookup rather than a whole-thread
        // scan because this path writes exactly one row.
        const priorSingle = await findPriorThreadArtifact(
          supabase, threadId, finalKind, v.value, source ?? null,
        );
        if (priorSingle) {
          return {
            ok: false,
            rejected: true,
            reason: "duplicate (kind, value, authoritative source) already recorded on this thread — " +
              "re-recording an observation does not make it two observations",
            kind: finalKind,
            value: v.value,
            // Disclosed, never applied — see the note in record_artifacts.
            ...(finalConfidence !== priorSingle.confidence
              ? {
                confidence_delta_suppressed: {
                  recorded_confidence: priorSingle.confidence,
                  attempted_confidence: finalConfidence,
                },
              }
              : {}),
          };
        }
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
        return {
          ok: true,
          kind: row.kind,
          value: row.value,
          ...(authority.stripped.length > 0
            ? { analyst_authority_stripped: authority.stripped, analyst_authority_note: ANALYST_AUTHORITY_NOTE }
            : {}),
          ...(minor ? { minor_safety_flag: true } : {}),
          ...(singleNameQuarantined
            ? {
                name_quarantined: 1,
                name_quarantine_note:
                  "This row names a person this investigation has NOT linked to the subject (a quarantined same-name identity). " +
                  "It was recorded with subject_unlinked and carries no subject authority.",
              }
            : {}),
        };
      },
    }),
    record_evidence: tool({
      description:
        "Append one tamper-evident row to the investigation's chain-of-custody log. Use for high-stakes findings that need provenance (a Hard claim with an archived URL, a court/government record, a verified breach hit). Each call appends a hashed row whose chain_hash depends on the prior row — the UI can verify the whole chain. Classification: 'hard' = official record or first-party verified source. 'soft' = social/inferred/pattern-match.",
      inputSchema: memoSchema("record_evidence", () => z.object({
        classification: z.enum(["hard", "soft"]),
        kind: z.string().describe("artifact kind this evidence relates to (email/phone/ip/username/domain/breach/name/other)"),
        value: z.string(),
        source: z.string().describe("tool or human-readable provider name, e.g. 'hunter.io', 'archive.org', 'whois'"),
        source_url: z.string().url().optional().describe("Canonical or archived URL of the evidence — prefer archive.org / archive.is link"),
        confidence: z.number().min(0).max(100).optional(),
        notes: z.string().max(2000).optional().describe("Free-text collection notes / extraction context"),
        metadata: z.record(z.unknown()).optional(),
      })),
      execute: async ({ classification, kind, value, source, source_url, confidence, notes, metadata }) => {
        // A1 (defense in depth): the same boundary as record_artifacts / record_artifact. This writes the
        // model's metadata to evidence_log._metadata (and its JSON into the content snapshot); nothing reads
        // the reserved keys there today, but a custody row is the one place a forged "reviewed" would read
        // as an attestation if a reader ever appeared. Stripped before the snapshot is built; disclosed by
        // key NAME on the row, in the log and in this result — never the values.
        const authority = stripAnalystAuthorityKeys(metadata);
        if (authority.stripped.length > 0) {
          console.warn(JSON.stringify({
            event: "analyst_authority_stripped",
            thread_id: threadId,
            tool: "record_evidence",
            keys: authority.stripped,
          }));
        }
        const meta = { ...(authority.metadata ?? {}), ...(notes ? { notes } : {}) };
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
        return {
          ok: true,
          id: row?.id,
          seq: row?.seq,
          chain_hash: row?.chain_hash,
          ...(archived ? { archived } : {}),
          ...(authority.stripped.length > 0
            ? { analyst_authority_stripped: authority.stripped, analyst_authority_note: ANALYST_AUTHORITY_NOTE }
            : {}),
        };
      },
    }),
  };

  // Serus darkweb scan — imported from tools/serus.ts (was missing from inline tools).
  (tools as ToolRegistry).serus_darkweb_scan = serus_darkweb_scan;
  // Then its schema is wrapped in input coercion (SERUS_INPUT_SPEC): `{identifier, identifierType}` was rejected in
  // production. A fresh object — the imported tool is never mutated. (The plain assignment above stays: the timeout
  // contract test reads it to attach serus's measured budget.)
  (tools as ToolRegistry).serus_darkweb_scan = {
    ...serus_darkweb_scan,
    inputSchema: memoSchema("serus_darkweb_scan", () => coercedSchema("serus_darkweb_scan", SERUS_INPUT_SPEC, serus_darkweb_scan.inputSchema as z.ZodTypeAny)),
  } as typeof serus_darkweb_scan;

  // Indicia (api.indicia.app) — 6 person/phone/email/address + web-DB breach tools,
  // imported from tools/indicia.ts. Gated on INDICIA_API_KEY via capabilities.ts;
  // face/geo/gmail/username endpoints are intentionally NOT wired (hard policy).
  (tools as ToolRegistry).indicia_email = indicia_email;
  (tools as ToolRegistry).indicia_phone = indicia_phone;
  (tools as ToolRegistry).indicia_person = indicia_person;
  (tools as ToolRegistry).indicia_address = indicia_address;
  (tools as ToolRegistry).indicia_web_dbs = indicia_web_dbs;
  (tools as ToolRegistry).indicia_hudsonrock = indicia_hudsonrock;

  // People Data Labs Person Enrichment — imported from tools/peopledatalabs.ts.
  // Gated on PEOPLEDATALABS_API_KEY via capabilities.ts (readiness gate drops the
  // tool from the schema on keyless deploys); classed `breach` in
  // source-classification.ts so a single hit is a LEAD, never Confirmed alone.
  (tools as ToolRegistry).pdl_person_enrich = pdl_person_enrich;

  // Gemini vision/document reader (tools/gemini_vision.ts) — the multimodal eyes
  // MiniMax-M2.7 lacks. Gated on GEMINI_API_KEY via capabilities.ts; classed
  // ai_summary in source-classification.ts (lead-tier, capped ≤55).
  (tools as ToolRegistry).gemini_vision = gemini_vision;

  // GeoSeer image geolocation (tools/geoseer.ts) — GEO-OSINT pivot only. Gated on
  // GEOSEER_API_KEY via capabilities.ts; classed ai_summary in
  // source-classification.ts (lead-tier, capped ≤55). The tool's own
  // geolocatability gate hard-skips non-geolocatable imagery before any paid call.
  (tools as ToolRegistry).geoseer_geolocate = geoseer_geolocate;

  // Inject memory tools (cross-investigation learning) into the registry.
  //
  // Late-injected registry tools, written as `(tools as ToolRegistry).X =
  // tool(...)`. The catalog↔runtime contract test
  // (src/test/tool-catalog-contract.test.ts) discovers these by grepping this
  // file for that assignment pattern, so keep the notation consistent.
  (tools as ToolRegistry).memory_recall = tool({
    description:
      "Recall prior agent memory for this user (lessons learned, identity links, recurring patterns, known false positives). Call EARLY in any investigation with the seed value AND with each newly confirmed high-value artifact (email, username, domain, wallet). Returns up to 20 most-relevant memory entries.",
    inputSchema: memoSchema("memory_recall", () => z.object({
      subject: z.string().describe("The value to recall around — the seed, an email, a handle, a domain, a wallet, etc."),
      kind: z.enum(["pattern", "connection", "lesson", "identity", "any"]).optional().default("any"),
      limit: z.number().int().min(1).max(50).optional().default(20),
    })),
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
        .or(agentMemoryOrFilter(subj))
        .order("confidence", { ascending: false })
        .limit(limit ?? 20);
      if (kind && kind !== "any") q = supabase
        .from("agent_memory")
        .select("id,kind,subject,subject_kind,related_values,content,confidence,source_thread_id,hit_count,last_used_at,created_at")
        .eq("user_id", userId)
        .eq("kind", kind)
        .or(agentMemoryOrFilter(subj))
        .order("confidence", { ascending: false })
        .limit(limit ?? 20);
      const { data, error } = await q;
      if (error) return { ok: false, error: error.message };
      // Supersession: a positive memory the analyst has since overruled (a FALSE
      // lesson in memory, or a Wrong/Dismiss in THIS thread) is returned tagged
      // as superseded rather than as a live memory. Review state is best-effort
      // here — the analyst lessons among the rows still supersede on their own.
      let threadRejected: Array<{ value?: unknown }> = [];
      try {
        const rl = await loadReviewsForThread(supabaseAdmin as unknown as ReviewDb, threadId, userId);
        if (rl.ok) threadRejected = enforcedRejectedRows(rl);
        else console.warn("[memory_recall] review state unavailable; superseding by analyst lessons only:", rl.error);
      } catch (e) {
        console.warn("[memory_recall] review load threw; superseding by analyst lessons only:", String(e));
      }
      const { active, superseded } = applyMemorySupersession((data ?? []) as MemoryRow[], threadRejected);
      // Best-effort: mark surfaced memories as recently used so they bubble up
      // next time and so stale unused ones can be pruned. ACTIVE rows only — a
      // superseded theory must not keep earning recency.
      if (active.length > 0) {
        const ids = active.map((m) => m.id);
        // Atomic hit_count + last_used_at bump (no read-modify-write race).
        supabase.rpc("bump_memory_hits", { _ids: ids }).then(() => {}, () => {});
      }
      return {
        ok: true,
        count: active.length,
        memories: active,
        ...(superseded.length
          ? {
            superseded_count: superseded.length,
            superseded: superseded.map((x) => ({
              id: x.row.id, kind: x.row.kind, subject: x.row.subject,
              superseded_by: x.selector, source: x.source,
              note: "Overruled by analyst review. Retained for audit; carries no authority — do not act on it.",
            })),
          }
          : {}),
      };
    },
  });

  (tools as ToolRegistry).memory_save = tool({
    description:
      "Persist a durable cross-investigation memory: a learned pattern, a confirmed connection between artifacts, an analyst lesson, or an identity cluster. Call AT THE END of an investigation with the strongest connections + any lessons (e.g. \"this domain is always parked\", \"this handle resolves to person X\", \"breach DB Y has stale phones\"). Idempotent: calling with the same kind+subject+content updates the existing entry.",
    // Root preprocess: entry fields sent at the TOP LEVEL (no `entries`) are wrapped into `entries` — only when that is
    // unambiguous (lib/memory-input-normalization.ts). Valid input is returned untouched.
    // A bare top-level array `[{kind,subject,content}]` is wrapped as `{entries:[…]}` and a stringified-JSON root is
    // parsed (lib/tool-input-coercion.ts) before the flat-entry wrapper and the `entries` string parser below run.
    inputSchema: memoSchema("memory_save", () => coercedSchema("memory_save", { wrapArrayAs: "entries", jsonFields: ["entries"] }, z.preprocess(wrapFlatMemoryEntry, z.object({
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
            // Field-name aliases / a sentence list for `content`, only when unambiguous (lib/memory-input-normalization.ts).
            .map(normalizeMemoryEntry)
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
    })))),
    execute: async ({ entries, scope }) => {
      // C-2: gate every entry through the deterministic C-1-subject consolidation
      // check BEFORE it can reach agent_memory. agent_memory's own upsert ratchets
      // confidence with GREATEST(old,new) — it never goes back down — so this is the
      // only safe interception point. An entry whose claim spans 2+ C-1 subjects (or
      // whose cross-selector claim is unverifiable while minimax_correlate failed
      // this cycle) is never written as a confident merge; it's logged to
      // memory_merge_candidates for review instead (never silently dropped).
      let toPersist: MemoryEntry[] = entries as unknown as MemoryEntry[];
      let candidates: Array<{ entry: MemoryEntry; reason: string; subjectIds: string[]; verdict?: "blocked" | "unresolved" }> = [];
      // ANALYST GATE — runs FIRST. agent_memory's upsert ratchets confidence with
      // GREATEST(old,new), so a positive identity theory that contradicts a Wrong /
      // Dismiss the analyst has already entered in this thread can never be walked
      // back once written. Refuse it here; log it as `blocked` so nothing is
      // silently dropped. Fails OPEN on an unreadable review state (the C-2 gate
      // below still runs), loudly.
      try {
        const rl = await loadReviewsForThread(supabaseAdmin as unknown as ReviewDb, threadId, userId);
        if (rl.ok) {
          const gate = refuseConflictingMemoryWrites(toPersist, rejectedSelectorsFromRows(enforcedRejectedRows(rl)));
          toPersist = gate.toPersist;
          for (const r of gate.refused) {
            candidates.push({ entry: r.entry, reason: r.reason, subjectIds: [], verdict: "blocked" });
          }
          console.log(JSON.stringify({
            event: "analyst_decisions_applied",
            thread_id: threadId,
            surface: "memory_save",
            decisions: rl.byId.size,
            rejected_rows: rl.rejectedRows.length,
            entries_in: (entries as unknown[]).length,
            entries_refused: gate.refused.length,
          }));
        } else {
          console.warn("[memory_save] review state unavailable; analyst gate skipped this write:", rl.error);
        }
      } catch (e) {
        console.warn("[memory_save] analyst gate threw (continuing to C-2 review):", String(e));
      }
      try {
        const { data: artRows } = await supabase
          .from("artifacts")
          .select("kind,value,source,confidence,metadata")
          .eq("thread_id", threadId);
        if (Array.isArray(artRows) && artRows.length > 0) {
          const clusterArts: ClusterArtifact[] = artRows.map((r) => {
            const row = r as { kind: string; value: string; source?: string; confidence?: number; metadata?: unknown };
            return {
              kind: row.kind ?? "", value: row.value ?? "", source: row.source ?? "",
              confidence: Number(row.confidence) || 0,
              metaRaw: typeof row.metadata === "string" ? row.metadata : JSON.stringify(row.metadata ?? {}),
            };
          });
          const correlateFailed = guard.lastCorrelateOutcome === "failed";
          const reviewed = reviewMemoryBatch(toPersist, clusterArts, correlateFailed);
          toPersist = reviewed.toPersist;
          candidates = [...candidates, ...reviewed.candidates];
        }
      } catch (e) {
        // Fail OPEN on the review step itself (never let a bug here block the
        // orchestrator), but never fail open on a caught cross-subject merge — that
        // check already ran inside reviewMemoryBatch before this catch could fire.
        console.warn("[memory_save] C-2 consolidation review threw (persisting as-is):", String(e));
      }
      if (candidates.length > 0) {
        const rows = candidates.map((c) => ({
          user_id: userId, thread_id: threadId, subject: c.entry.subject, kind: c.entry.kind,
          content: c.entry.content, proposed_confidence: c.entry.confidence,
          verdict: c.verdict ?? (c.subjectIds.length >= 2 ? "blocked" : "unresolved"),
          reason: c.reason, subject_ids: c.subjectIds, related_values: c.entry.related_values ?? [],
        }));
        const { error: candErr } = await supabaseAdmin.from("memory_merge_candidates").insert(rows);
        if (candErr) console.warn("[memory_save] candidate log insert failed:", candErr.message);
      }
      if (toPersist.length === 0) {
        return {
          ok: true, scope: scope ?? "global", saved: 0, entries: [],
          blocked: candidates.length,
          note: candidates.length > 0
            ? "Every proposed entry was blocked as a cross-subject merge or an unverifiable claim (correlate failed this cycle). Logged for review, not saved. Re-investigate with a narrower, single-subject claim."
            : undefined,
        };
      }
      // Upserts on (user_id, kind, subject, md5(content)) — re-saving the same
      // lesson bumps hit_count + last_used_at instead of duplicating rows.
      try {
        const { data, error } = await supabase.rpc("save_agent_memories", {
          _user_id: userId,
          _thread_id: threadId,
          _entries: toPersist as unknown as Record<string, unknown>[],
          _scope: scope ?? "global",
        });
        if (error) {
          console.warn("[memory_save] rpc error:", error.message);
          return { ok: false, error: error.message, scope: scope ?? "global" };
        }
        return {
          ok: true, scope: scope ?? "global", saved: data?.length ?? 0, entries: data ?? [],
          ...(candidates.length > 0 ? { blocked: candidates.length, blocked_note: "Some entries were blocked as cross-subject merges — see memory_merge_candidates." } : {}),
        };
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
  // PERF-3 (#69): env is frozen for the life of an isolate, so this capability
  // set is identical on every request — built once (lazily) at module scope
  // via memoSchema and shared. It is read-only everywhere (coverage_audit /
  // tool_audit only call .has() / spread it); do not mutate it per-request.
  const availableToolsForAudit = memoSchema("__availableToolsForAudit", () => new Set<string>([
    ...(OATHNET_API_KEY ? ["oathnet_lookup"] : []),
    ...(SERUS_API_KEY ? ["serus_darkweb_scan"] : []),
    ...(OSINTNOVA_API_KEY ? ["osintnova_lookup", "osintnova_email_lookup", "osintnova_phone_lookup"] : []),
    ...(SOCIALFETCH_API_KEY ? ["socialfetch_lookup", "socialfetch_web_read"] : []),
    ...(HUNTER_API_KEY ? ["hunter_combined", "hunter_email_verifier", "hunter_domain_search"] : []),
    ...(Deno.env.get("LEAKCHECK_API_KEY") ? ["leakcheck_lookup"] : []),
    // breach_check uses STOLENTAX_API_KEY when present but falls back to keyless
    // leakcheck (the standalone stolentax_footprint tool was removed in the cull).
    ...(Deno.env.get("STOLENTAX_API_KEY") ? ["breach_check"] : []),
    ...(INDICIA_API_KEY ? ["indicia_email","indicia_phone","indicia_person","indicia_address","indicia_web_dbs","indicia_hudsonrock"] : []),
    ...(PEOPLEDATALABS_API_KEY ? ["pdl_person_enrich"] : []),
    ...(Deno.env.get("DEEPFIND_API_KEY") ? ["deepfind_reverse_email","deepfind_disposable_email","deepfind_ssl_inspect","deepfind_tech_stack","deepfind_url_unshorten","deepfind_telegram_channel","deepfind_telegram_search","deepfind_vin_lookup","deepfind_aircraft_lookup","deepfind_vessel_lookup","deepfind_mac_lookup","deepfind_dark_web_link","deepfind_email_breach","deepfind_transaction_viewer"] : []),
    ...(Deno.env.get("VIRUSTOTAL_API_KEY") ? ["virustotal_lookup"] : []),
    ...(Deno.env.get("FOFA_API_KEY") ? ["fofa_search"] : []),
    ...(Deno.env.get("IPGEOLOCATION_API_KEY") ? ["ipgeolocation_lookup"] : []),
    // ipqualityscore_lookup CUT 2026-07-05 (dead key; disabled in capabilities.ts).
    ...(RAPIDAPI_KEY ? ["rapidapi_breach_search", "rapidapi_all_breaches"] : []),
    ...(Deno.env.get("EXA_API_KEY") ? ["exa_search","exa_get_contents","exa_find_similar"] : []),
    ...(Deno.env.get("GEMINI_API_KEY") ? ["gemini_deep_dork", "gemini_vision"] : []),
    ...(Deno.env.get("GEOSEER_API_KEY") ? ["geoseer_geolocate"] : []),
    // Free / always-on tools
    "whois_lookup","dns_records","crtsh_subdomains","wayback_snapshots","archive_url","http_fingerprint",
    "ip_intel","shodan_internetdb","hackertarget","urlscan_search","gravatar_profile","hibp_lookup",
    "google_dorks","dork_harvest","username_sweep","github_user","reddit_user","hackernews_user",
    "minimax_web_search","jina_reader_scrape","markdown_extract",
  ]));

  async function callsForThread(): Promise<string[]> {
    const { data } = await supabaseAdmin
      .from("tool_usage_log")
      .select("tool_name")
      .eq("thread_id", threadId)
      .eq("ok", true);
    return [...new Set((data ?? []).map((r: { tool_name: string }) => r.tool_name))];
  }

  // Internal finalize decision tools. These are exposed only by prepareStep during
  // their matching forced-finalize phase. They give `toolChoice: required` a safe,
  // non-fabricating escape when there is nothing valid to persist or remember.
  (tools as ToolRegistry).finalize_no_findings = tool({
    description:
      "Finalize-only decision: declare that every tool-supported finding is already persisted. " +
      "Never call during normal investigation work.",
    inputSchema: memoSchema("finalize_no_findings", () => z.object({
      reason: z.enum(["all_supported_findings_already_persisted", "no_tool_supported_findings"]),
    }).strict()),
    execute: ({ reason }: { reason: string }) =>
      Promise.resolve({ ok: true, decision: "no_additional_supported_findings", reason }),
  });

  (tools as ToolRegistry).finalize_skip_memory = tool({
    description:
      "Finalize-only decision: skip memory_save because no evidence-supported durable lesson is safe to persist. " +
      "Never call during normal investigation work.",
    inputSchema: memoSchema("finalize_skip_memory", () => z.object({
      reason: z.enum(["no_durable_lesson", "evidence_too_weak_or_conflicted"]),
    }).strict()),
    execute: ({ reason }: { reason: string }) =>
      Promise.resolve({ ok: true, decision: "memory_skipped", reason }),
  });

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
    inputSchema: memoSchema("unknown_tool_ignored", () => z.object({
      requested: z.string().optional().describe("The unknown tool name that was dropped."),
    })),
    execute: ({ requested }: { requested?: string }) =>
      Promise.resolve({ ok: true, dropped: true, ignored_tool: requested ?? null, note: unknownToolNudge(requested) }),
  });

  (tools as ToolRegistry).coverage_audit = tool({
    description:
      "Advisory coverage audit. Returns gaps and missing opportunities but never blocks progress or reporting.",
    inputSchema: memoSchema("coverage_audit", () => z.object({}).strict()),
    execute: async () => {
      const called = await callsForThread();
      const report = auditCoverage(detectedSeedType, called, availableToolsForAudit);
      return { ok: true, seed_type: detectedSeedType, ...report };
    },
  });

  (tools as ToolRegistry).detect_contradictions = tool({
    description:
      "Advisory contradiction analysis. Strongly recommended before high-confidence attribution, but never an execution prerequisite.",
    inputSchema: memoSchema("detect_contradictions", () => z.object({
      cluster_artifact_kinds: z.array(z.string()).optional()
        .describe("Optional. Restrict to specific artifact kinds (e.g. ['email','username','name','ip'])."),
    })),
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
    inputSchema: memoSchema("tool_audit", () => z.object({}).strict()),
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
    inputSchema: memoSchema("record_finding", () => z.object({
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
      // Advisory only — NOT read for scoring. The real corroboration count is
      // derived server-side from supporting_sources (see F06 below). Kept
      // accepted so an older/uninstructed model call still validates.
      corroboration_count: z.number().min(1).default(1),
      label: z.enum(["CONFIRMED","CORROBORATED","INFERRED","VERIFY","LOW","DISMISSED"]).default("INFERRED"),
    })),
    execute: async (i) => {
      const { data: threadRows } = await supabase
        .from("artifacts")
        .select("id,kind,value,source,metadata,created_at")
        .eq("thread_id", threadId);
      // Rows the analyst DISMISSED stop testifying about the subject, exactly as
      // on the synthesis path (finding-synthesis-sweep.ts), which already scored
      // the same row shape on review-filtered rows while this path did not. These
      // rows only feed the contradiction check, so an unreadable verdict set keeps
      // every row: a missed dismissal costs a penalty, never invents confidence.
      let contraRows = threadRows ?? null;
      if (contraRows && !contradictionClaimFilterDisabled()) {
        const reviews = await loadReviewsForThread(supabaseAdmin as unknown as ReviewDb, threadId, userId);
        if (reviews.ok) contraRows = dropRejectedArtifacts(contraRows, reviews);
        else console.warn(JSON.stringify({ event: "record_finding_review_state_unavailable", thread_id: threadId, error: reviews.error }));
      }
      // Scoring + row construction live in ONE place — see lib/finding-row.ts.
      // This block used to be 161 lines inline here; it was MOVED, not rewritten,
      // because finding synthesis needs the identical chain and two copies of a
      // scorer is how the two silently diverge. `finding_row_equivalence_test.ts`
      // pins that this path and the synthesis path build the same row.
      const { row, axes, status: findingStatus } = buildFindingRow(i, {
        threadId,
        userId,
        contraRows,
      });
      const { data, error } = await supabase.from("artifacts").insert([row]).select("id").maybeSingle();
      if (error) return { ok: false, error: error.message };
      recordFindingSummary(threadId, i.conclusion);
      // `applied_label` must report what the SERVER applied. Echoing i.label here
      // told the model its own guess had been ratified.
      return { ok: true, id: data?.id ?? null, confidence_axes: axes, applied_label: findingStatus, model_label: i.label };
    },
  });

  return { tools, availableToolsForAudit, noteQuarantinedFindings };
}
