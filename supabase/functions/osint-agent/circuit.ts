// Per-thread circuit breakers + call dedup for OSINT tools.
// Keeps an in-memory record of every tool call attempted on a thread, blocks
// retries that are demonstrably wasteful (402/403/timeouts/3+ failures), and
// surfaces dedup keys so the same tool+selector isn't re-run for free.

import { classifyToolOutcome } from "./tool-outcome.ts";

export type FailureKind =
  | "ok"
  | "http_400"
  | "http_401"
  | "http_402"
  | "http_403"
  | "http_404"
  | "http_422"
  | "http_429"
  | "http_451"
  | "http_500"
  | "http_502"
  | "http_504"
  | "timeout"
  | "other";

export type BreakerDecision =
  | { allow: true }
  | { allow: false; reason: string; until?: number; duplicateInFlight?: boolean; providerBusy?: boolean };

// ---- Investigation-level provider suppression (Phase 8) --------------------
// When a provider returns a 429 or times out, it's suppressed for the rest of
// the investigation (up to this window) so the orchestrator stops re-hitting an
// exhausted/unreachable upstream and re-billing failed calls. Keyed per
// investigation + provider; isolated from other investigations; reset at the
// run boundary (clearThread).
export const PROVIDER_SUPPRESS_MS = 10 * 60_000;

// ---- Authorization refusals (401 / 402) are for the WHOLE run ----------------
// A 401 (bad/expired key) or 402 (balance gone) cannot clear by waiting ten
// minutes inside one run, so the suppression for those is the run's lifetime
// (the ThreadState is released at end of run anyway). Measured 2026-10-18 on
// the step metrics: OathNet, mid-transition to crypto-only billing, was asked
// for 2-7 times per invocation after its first 401. Each later call was already
// a free breaker skip, but every one still burnt an LLM step; index.ts now also
// drops a suppressed provider's tools from the step's activeTools, and
// lib/provider-auth-prior.ts carries the refusal across the case's invocations.
export const AUTH_SUPPRESS_MS = 24 * 60 * 60_000;
/** Constant refusal phrase. `suppressed for investigation` keeps it inside tool-outcome.ts SKIP_RE. */
export const AUTH_REFUSAL_REASON = "provider refused authorization (401/402) earlier in run";

// Tools that share one upstream provider/quota — suppressing the provider
// suppresses all of them for the investigation. Tools not listed map to a
// provider equal to their own name.
const PROVIDER_TOOLS: Record<string, string[]> = {
  // All DeepFind.Me endpoints share one API key/base. They must ALL be in the
  // group so a provider suppression (any endpoint 4xx/5xx/timeout) stops the
  // whole family — otherwise a missing endpoint maps to its own name and keeps
  // firing (the 2026-06-13 trace burned profile_analyzer×4 404, telegram_search
  // ×2 403, ransomware_exposure 404 because they weren't listed here).
  deepfind: [
    "deepfind_reverse_email",
    "deepfind_disposable_email",
    "deepfind_ransomware_exposure",
    "deepfind_ssl_inspect",
    "deepfind_tech_stack",
    "deepfind_url_unshorten",
    "deepfind_profile_analyzer",
    "deepfind_telegram_channel",
    "deepfind_telegram_search",
    "deepfind_vin_lookup",
    "deepfind_aircraft_lookup",
    "deepfind_vessel_lookup",
    "deepfind_mac_lookup",
    "deepfind_dark_web_link",
  ],
  bosint: ["bosint_email_lookup", "bosint_phone_lookup"],
  // All OathNet tools share ONE api key + ONE 500/day pooled quota. Group them so a
  // 429 (pool exhausted) / 402 / timeout / 5xx on any one endpoint suppresses the whole
  // family for the run instead of each re-firing under its own name and burning the
  // depleted pool (same trap the deepfind/indicia groups close).
  oathnet: [
    "oathnet_lookup",
    "oathnet_stealer_search",
    "oathnet_victims_search",
    "oathnet_victim_manifest",
    "oathnet_victim_file",
    "oathnet_victim_archive",
    "oathnet_subdomains",
    "oathnet_breach_dbnames",
    "oathnet_ai_filter",
    "oathnet_scanner",
  ],
  hunter: ["hunter_domain_search", "hunter_email_finder", "hunter_email_verifier", "hunter_combined"],
  exa: ["exa_search", "exa_find_similar", "exa_get_contents"],
  // minimax_web_search hits Perplexity (a DIFFERENT upstream than the MiniMax
  // reasoning model — see #293), so a SEARCH timeout/429/5xx must not drag down
  // the reasoning tools. Keep the search worker on its own "minimax" key.
  minimax: ["minimax_web_search"],
  // The MiniMax reasoning endpoints share one upstream model/key, so a quota/auth
  // failure on one should suppress the family. minimax_correlate is the identity-
  // merge step; grouping it with minimax_extract lets a 402/429 on either suppress
  // both (correct) WITHOUT a search-worker failure touching it.
  // minimax_plan_pivots is DELIBERATELY excluded (maps to its own provider): in the
  // live tool-health data it times out on ~9 of 10 calls, and a timeout suppresses
  // the whole provider group — so keeping it here would let the broken planner
  // suppress minimax_correlate on nearly every run, re-creating the exact report
  // fragmentation this split fixes. Ungrouped, its timeouts stay isolated to itself.
  minimax_reason: ["minimax_correlate", "minimax_extract"],
  // All six Indicia endpoints share ONE api key + one prepaid balance. A depleted
  // balance (402) or rate-limit (429) on any one endpoint means every sibling is
  // equally dead for the run — group them so one suppression stops the family
  // instead of each endpoint re-firing under its own name (the same trap the
  // deepfind group above closed).
  indicia: [
    "indicia_email",
    "indicia_phone",
    "indicia_person",
    "indicia_address",
    "indicia_web_dbs",
    "indicia_hudsonrock",
  ],
  // Both Context.dev tools share one key and one credit balance: a 402/429 on one
  // means the other is equally dead for the run.
  contextdev: ["contextdev_scrape", "contextdev_people_search"],
  // All SocQ endpoints share one key and one credit balance.
  socq: ["socq_instagram_profile", "socq_x_profile", "socq_linkedin_profile", "socq_instagram_posts", "socq_instagram_post_info", "socq_instagram_followers_count", "socq_x_user_posts", "socq_linkedin_company", "socq_linkedin_posts", "socq_instagram_search", "socq_x_search", "socq_task_result"],
};
const TOOL_PROVIDER = new Map<string, string>();
for (const [provider, tools] of Object.entries(PROVIDER_TOOLS)) {
  for (const t of tools) TOOL_PROVIDER.set(t, provider);
}

/** The upstream provider a tool belongs to (defaults to the tool itself). */
export function providerForTool(tool: string): string {
  return TOOL_PROVIDER.get(tool) ?? tool;
}

// General multi-origin fan-out tools: unlike a single-upstream paid API, these
// hit MANY unrelated hosts across a run (jina scrapes arbitrary URLs;
// socialfetch_web_read renders arbitrary pages). One slow page is a PER-URL
// problem, not a dead provider — suppressing the whole tool on the first timeout
// takes the reader offline for every remaining host, and gating parallel reads of
// different URLs behind the single-provider in-flight lock drops legitimate
// sibling scrapes. For these, a `timeout` dead-lists only the offending URL and
// suppresses the tool ONLY after >= TIMEOUT_SUPPRESS_CONSECUTIVE consecutive
// timeouts (see recordResult), and the in-flight gate is bypassed (see shouldRun).
export const GENERAL_MULTI_ORIGIN_TOOLS = new Set<string>([
  "jina_reader_scrape",
  "socialfetch_web_read",
]);

/** Uninterrupted TIMEOUT outcomes (no success or other-failure in between) a
 *  general multi-origin tool must hit before its whole provider is suppressed.
 *  Single-upstream providers still suppress on the first timeout (oathnet: two). */
export const TIMEOUT_SUPPRESS_CONSECUTIVE = 3;

function timeoutSuppressionThreshold(tool: string): number {
  // OathNet has a legitimate 20s internal fetch budget; one outer timeout can be
  // latency noise, not proof the whole quota-shared provider is dead. Require a
  // second timeout before suppressing the family for the rest of the run.
  // (jina_reader_scrape / socialfetch_web_read are multi-origin fan-out tools
  // handled by the GENERAL_MULTI_ORIGIN_TOOLS path in recordResult, not here.)
  return providerForTool(tool) === "oathnet" ? 2 : 1;
}

interface Suppression {
  reason: string;
  until: number;
  since: number;
}

interface BreakerState {
  /** Consecutive NON-OK outcomes of ANY type (400/404/451/429/5xx/timeout).
   *  Drives the generic 3-failure global guard — NOT timeout suppression. */
  consecutive: number;
  /** Consecutive TIMEOUT outcomes only — reset by success OR any non-timeout
   *  failure. Drives multi-origin timeout suppression so a mixed failure run
   *  (e.g. 404 → 451 → timeout) never counts as "3 consecutive timeouts". */
  consecutiveTimeouts: number;
  total: number;
  lastAt: number;
  disabledReason?: string;
  disabledUntil?: number;
  /** map of normalized selectors that should never be re-tried */
  deadSelectors: Set<string>;
  /** distinct selectors that returned 404 — 2+ implies the endpoint is gone */
  notFound: Set<string>;
}

interface CallRecord {
  callKey: string;
  status: FailureKind;
  /** any artifact ids produced by this call */
  artifactCount: number;
  ts: number;
}

interface ThreadState {
  breakers: Map<string, BreakerState>;
  calls: Map<string, CallRecord>;
  /** provider name → active suppression for this investigation */
  suppressions: Map<string, Suppression>;
  /** Providers with at least one call currently executing (started, not yet
   *  recorded via recordResult). Used to prevent a same-step parallel burst
   *  from dispatching multiple calls to the same provider before any of them
   *  returns — the scenario where parallel_tool_calls:false is ignored by the
   *  model/gateway and several calls race past shouldRun simultaneously. */
  inFlight: Set<string>;
  /** Exact (tool + normalized-selector + purpose) call keys currently executing.
   *  Finer-grained than `inFlight` (which is provider-level and also blocks
   *  legitimate different-selector siblings on the same provider). Used so an
   *  identical duplicate call — e.g. two same-step minimax_web_search calls for
   *  the same query — is recognized as a TRUE duplicate and given an explicit
   *  "don't retry" signal, instead of the generic provider-busy reason that
   *  DeepSeek was observed retrying into a collision loop (2026-07-25 audit,
   *  thread d98deb37: 23 skipped in-flight collisions). */
  inFlightCalls: Set<string>;
  /** Number of in-flight runs that have acquire()'d this thread. The shared
   *  state is only torn down by release() once this returns to 0, so an
   *  overlapping run (double-submit / retry — setupRequest verifies ownership
   *  but does not lock out an active run) can't have its suppressions, premium
   *  dedup, and capability disables wiped while it is still streaming. */
  active: number;
}

// Upper bound on threads tracked in-memory. clearThread(threadId) is the
// primary, explicit release path — but on a warm/long-running Supabase isolate
// it can be missed (error path, timeout, unhandled rejection, isolate reuse),
// leaving ThreadState (breakers/calls/suppressions Maps) to accumulate forever
// → memory pressure → OOM-kills → silent investigation failures. This LRU cap
// is the safety net: the most-recently-touched threads are retained and the
// least-recently-used is evicted once the cap is exceeded. Sized well above any
// realistic count of concurrent investigations on a single isolate so an
// actively-running thread is never evicted out from under itself.
export const MAX_TRACKED_THREADS = 256;

const THREADS = new Map<string, ThreadState>();

function state(threadId: string): ThreadState {
  const existing = THREADS.get(threadId);
  if (existing) {
    // Touch: bump to the most-recently-used position. A Map preserves insertion
    // order, so delete + re-set moves this thread to the end of the eviction
    // queue (true LRU rather than plain FIFO).
    THREADS.delete(threadId);
    THREADS.set(threadId, existing);
    return existing;
  }
  const s: ThreadState = { breakers: new Map(), calls: new Map(), suppressions: new Map(), inFlight: new Set(), inFlightCalls: new Set(), active: 0 };
  THREADS.set(threadId, s);
  // Evict the least-recently-used thread(s) when over the cap. Iterate in LRU
  // order (oldest first) and drop the oldest entries until back under the cap,
  // but NEVER evict a thread with an in-flight run (active > 0) or the one we
  // just inserted — pulling state out from under an active run would lose its
  // suppressions/dedup/disables mid-investigation, the same hazard this
  // refcount guards against on the clear path.
  if (THREADS.size > MAX_TRACKED_THREADS) {
    for (const key of THREADS.keys()) {
      if (THREADS.size <= MAX_TRACKED_THREADS) break;
      if (key === threadId) continue;
      const st = THREADS.get(key);
      if (st && st.active > 0) continue;
      THREADS.delete(key);
    }
  }
  return s;
}

/** Suppress a tool's provider for this investigation. The window only extends,
 *  never shrinks, if the provider fails again. */
function suppressProvider(threadId: string, tool: string, reason: string, ms: number = PROVIDER_SUPPRESS_MS): void {
  const provider = providerForTool(tool);
  const s = state(threadId);
  const now = Date.now();
  const existing = s.suppressions.get(provider);
  s.suppressions.set(provider, {
    reason,
    until: Math.max(existing?.until ?? 0, now + ms),
    since: existing?.since ?? now,
  });
}

/** The run-wide refusal text for a 401/402/403, naming the provider and the status that caused it. */
export function authRefusalReason(tool: string, status: 401 | 402 | 403, source: "run" | "prior" = "run"): string {
  const what = status === 402 ? "402 payment required" : status === 401 ? "401 unauthorized" : "403 forbidden";
  const when = source === "prior" ? "in an earlier run of this case" : "earlier in run";
  return `${AUTH_REFUSAL_REASON} — ${what} ${when} — provider '${providerForTool(tool)}' suppressed for investigation`;
}

/**
 * Carry a 401/402 observed in an EARLIER invocation of this case into this run
 * (lib/provider-auth-prior.ts). Same effect as recordResult's own 401/402 branch:
 * the tool is disabled and its whole provider suppressed for the run's lifetime.
 */
export function suppressProviderAuthPrior(threadId: string, tool: string, status: 401 | 402): void {
  const reason = authRefusalReason(tool, status, "prior");
  breakerFor(threadId, tool).disabledReason = reason;
  suppressProvider(threadId, tool, reason, AUTH_SUPPRESS_MS);
}

/**
 * The subset of `toolNames` whose provider is suppressed for this run right now
 * — what prepareStep removes from a step's activeTools so the model is never
 * offered a tool that can only answer with a refusal. ALWAYS-ALLOW recording
 * tools map to their own name and are never suppressed, so they never appear.
 */
export function suppressedToolsOf(threadId: string, toolNames: readonly string[]): string[] {
  const s = THREADS.get(threadId);
  if (!s || s.suppressions.size === 0) return [];
  const now = Date.now();
  return toolNames.filter((t) => {
    const sup = s.suppressions.get(providerForTool(t));
    return !!sup && now < sup.until;
  });
}

/** Observable: is the tool's provider currently suppressed for this run? */
export function isProviderSuppressed(
  threadId: string,
  tool: string,
): { suppressed: boolean; provider: string; reason?: string; until?: number } {
  const provider = providerForTool(tool);
  const sup = THREADS.get(threadId)?.suppressions.get(provider);
  if (sup && Date.now() < sup.until) {
    return { suppressed: true, provider, reason: sup.reason, until: sup.until };
  }
  return { suppressed: false, provider };
}

/** Snapshot of active provider suppressions for logs / the audit panel. */
export function suppressionSnapshot(
  threadId: string,
): Array<{ provider: string; reason: string; until: number }> {
  const s = THREADS.get(threadId);
  if (!s) return [];
  const now = Date.now();
  return [...s.suppressions.entries()]
    .filter(([, sup]) => now < sup.until)
    .map(([provider, sup]) => ({ provider, reason: sup.reason, until: sup.until }));
}

function breakerFor(threadId: string, tool: string): BreakerState {
  const s = state(threadId);
  let b = s.breakers.get(tool);
  if (!b) {
    b = { consecutive: 0, consecutiveTimeouts: 0, total: 0, lastAt: 0, deadSelectors: new Set(), notFound: new Set() };
    s.breakers.set(tool, b);
  }
  return b;
}

/** Normalize a selector value per kind so dedup collapses obvious variants. */
export function normalizeSelector(kind: string, raw: unknown): string {
  if (raw == null) return "";
  const s = typeof raw === "string" ? raw : JSON.stringify(raw);
  const v = s.trim();
  const k = (kind ?? "").toLowerCase();
  if (!v) return "";
  if (k === "email" || k === "domain" || k === "subdomain") return v.toLowerCase();
  if (k === "username" || k === "social" || k === "handle") return v.replace(/^@+/, "").toLowerCase();
  if (k === "phone") return v.replace(/[^\d+]/g, "");
  if (k === "url") {
    try {
      const u = new URL(v);
      return `${u.protocol}//${u.hostname.toLowerCase()}${u.pathname.replace(/\/$/, "")}`;
    } catch { return v.toLowerCase(); }
  }
  return v.toLowerCase();
}

/** Build a deterministic call key for dedup. */
export function callKey(tool: string, selector: string, purpose: string = "default"): string {
  return `${tool}::${selector}::${purpose}`;
}

/** Expensive providers that should run at most once per normalized entity in an
 *  investigation. After one successful call for an entity, a repeat (same
 *  normalized selector) is a free skip — the structural fix for the duplicate
 *  premium charges (leakcheck ×2, oathnet ×2, breach ×3) in the trace audit. */
export const PREMIUM_TOOLS = new Set<string>([
  "pdl_person_enrich",
  "oathnet_lookup",
  "leakcheck_lookup",
  "breach_check",
  "exa_search",
  "exa_find_similar",
  "exa_get_contents",
  "hunter_combined",
  // One Opsis search per entity per investigation: each POST costs a credit, and a
  // run that outlived its poll deadline is finished with the FREE opsis_results,
  // never by searching again (lib/opsis.ts). The tool description asks for this;
  // this is what enforces it.
  "opsis_search",
]);

export function isPremiumTool(tool: string): boolean {
  return PREMIUM_TOOLS.has(tool);
}

/** Should this call run? */
export function shouldRun(
  threadId: string,
  tool: string,
  selector: string,
  purpose: string = "default",
  opts: { force?: boolean } = {},
): BreakerDecision {
  const b = breakerFor(threadId, tool);
  const now = Date.now();
  // Investigation-level provider suppression takes precedence: a provider that
  // 429'd or timed out earlier this run is skipped (and not re-billed).
  const sup = isProviderSuppressed(threadId, tool);
  if (sup.suppressed) {
    return { allow: false, reason: sup.reason ?? `provider ${sup.provider} suppressed`, until: sup.until };
  }
  // In-flight provider gate: if a call for this provider is already executing
  // (started but not yet returned), block same-step siblings. This is the
  // defensive layer against a same-step parallel burst when parallel_tool_calls
  // is ignored by the gateway (e.g. Lovable fallback). Without this, several
  // calls race past shouldRun simultaneously, all making live requests before
  // the first 401/suppression is recorded. ALWAYS_ALLOW_TOOLS bypass this gate
  // (they bypass timeouts too — evidence writes must never be blocked).
  const provider = providerForTool(tool);
  const s = THREADS.get(threadId);
  // Exact-duplicate gate: an IDENTICAL (tool, normalized-selector, purpose) call
  // is already executing. This is a TRUE duplicate (not just same-provider
  // contention), so it gets its own reason with duplicateInFlight:true — the
  // caller (cache.ts) uses this to tag the skip distinctly and to avoid
  // encouraging a retry. Checked before the coarser provider-level gate below.
  if (selector && s && isCallInFlight(threadId, tool, selector, purpose)) {
    return {
      allow: false,
      duplicateInFlight: true,
      reason: `duplicate call: an identical '${tool}' call for this selector is already in flight this step — its result will be used, do not retry`,
    };
  }
  // Multi-origin fan-out tools (jina, socialfetch_web_read) legitimately run
  // several reads of DIFFERENT URLs in the same step. They don't share a single
  // upstream quota, so the in-flight provider lock — meant to stop a same-step
  // burst racing past a PAID provider's suppression — would instead drop valid
  // sibling scrapes. Exempt them; same-URL repeats are still caught by the dedup
  // gate below (callKey includes the selector).
  if (s && s.inFlight.has(provider) && !GENERAL_MULTI_ORIGIN_TOOLS.has(tool)) {
    return { allow: false, providerBusy: true, reason: `provider '${provider}' already has a call in-flight — waiting for its result` };
  }
  if (b.disabledUntil && now < b.disabledUntil) {
    return { allow: false, reason: b.disabledReason ?? "backoff", until: b.disabledUntil };
  }
  if (b.disabledReason && !b.disabledUntil) {
    return { allow: false, reason: b.disabledReason };
  }
  if (selector && b.deadSelectors.has(selector)) {
    return { allow: false, reason: `selector blacklisted for ${tool}` };
  }
  if (!opts.force && selector) {
    const key = callKey(tool, selector, purpose);
    const prior = state(threadId).calls.get(key);
    if (prior && prior.status === "ok") {
      // Premium providers run once per entity regardless of artifact count
      // (the wrapper records artifactCount: 0). Cheaper tools only dedup once
      // they've actually produced an artifact for this selector.
      if (isPremiumTool(tool)) {
        return { allow: false, reason: `premium '${tool}' already ran for this entity this investigation` };
      }
      if (prior.artifactCount > 0) {
        return { allow: false, reason: "duplicate call: prior run already produced artifacts" };
      }
    }
    if (prior && prior.status !== "ok") {
      // Re-run only if last failure was a 500/429 (transient). All other
      // failures are treated as deterministic.
      const transient = prior.status === "http_500" || prior.status === "http_429" || prior.status === "timeout";
      if (!transient) {
        return { allow: false, reason: `duplicate call: prior ${prior.status}` };
      }
    }
  }
  return { allow: true };
}

/** Record outcome of a tool call and update breaker.
 *  @param errorMessage — optional raw error text for quota/limit detection. */
export function recordResult(
  threadId: string,
  tool: string,
  selector: string,
  purpose: string,
  outcome: { status: FailureKind; artifactCount?: number; errorMessage?: string },
): void {
  const b = breakerFor(threadId, tool);
  const s = state(threadId);
  const key = callKey(tool, selector || "_", purpose);
  s.calls.set(key, {
    callKey: key,
    status: outcome.status,
    artifactCount: outcome.artifactCount ?? 0,
    ts: Date.now(),
  });
  if (outcome.status === "ok") {
    b.consecutive = 0;
    b.consecutiveTimeouts = 0;
    b.lastAt = Date.now();
    return;
  }
  // http_400/http_422 are deterministic PER-SELECTOR outcomes (bad/unprocessable
  // input for this exact URL) — the switch below already dead-lists just that
  // selector rather than touching provider health. They must NOT also feed the
  // shared `b.consecutive` streak: the global "disabled after 3 consecutive
  // failures" guard further down doesn't distinguish failure kind, so 3
  // unrelated malformed URLs in a row (e.g. jina_reader_scrape fed 3 different
  // bad court-portal links) would silently disable the tool for the rest of the
  // run even though nothing about the tool/provider itself is unhealthy. 2026-
  // 07-25 audit (thread d98deb37) mixed 1×422 with 7 timeouts — one selector
  // away from tripping exactly this. `b.total` still counts it for telemetry.
  const isPerSelectorDeterministic = outcome.status === "http_400" || outcome.status === "http_422";
  if (!isPerSelectorDeterministic) b.consecutive++;
  b.total++;
  b.lastAt = Date.now();
  // Maintain the dedicated timeout streak: a timeout extends it, ANY non-timeout
  // failure (400/404/451/429/5xx) breaks it. This is what multi-origin timeout
  // suppression checks — NOT b.consecutive, which counts all failure types and
  // would let a mixed run (404 → 451 → timeout) masquerade as 3 timeouts.
  if (outcome.status === "timeout") b.consecutiveTimeouts++;
  else b.consecutiveTimeouts = 0;
  switch (outcome.status) {
    case "http_402":
      // A 402 is a depleted prepaid balance — provider-wide, not endpoint-local.
      // Every sibling on the same shared key/balance is equally out of credit, so
      // suppress the whole provider for the run (mirrors 429/timeout/5xx). Without
      // this, one indicia_* endpoint's 402 leaves the other five firing into the
      // same empty balance, each burning a step to return the same 402.
      b.disabledReason = `402 payment required — ${AUTH_REFUSAL_REASON} — disabled for thread`;
      suppressProvider(threadId, tool, authRefusalReason(tool, 402), AUTH_SUPPRESS_MS);
      break;
    case "http_403":
    case "http_401":
      // An auth rejection is provider-wide: the API key/credential is bad or
      // revoked for EVERY endpoint on that provider, not just this tool. Disable
      // the tool AND suppress the whole provider for the run so sibling
      // endpoints on the same dead key stop firing (deepfind_telegram_search
      // 403 should kill the rest of the deepfind family, not just itself).
      b.disabledReason = `403/401 unauthorized — ${AUTH_REFUSAL_REASON} — disabled for thread`;
      suppressProvider(threadId, tool, authRefusalReason(tool, outcome.status === "http_401" ? 401 : 403), AUTH_SUPPRESS_MS);
      break;
    case "http_404":
      // A single 404 is often "this resource isn't on this site" (legit
      // per-selector). But 404s across MULTIPLE distinct selectors mean the
      // endpoint path itself is gone — disable the tool for the run so an
      // aggregator that 404s on every query (deepfind_profile_analyzer ×4)
      // stops re-firing across a parallel fan-out.
      if (selector) {
        b.deadSelectors.add(selector);
        b.notFound.add(selector);
      }
      if (b.notFound.size >= 2 && !b.disabledReason) {
        b.disabledReason = `endpoint returned 404 on ${b.notFound.size} distinct inputs — disabled for thread`;
      }
      break;
    case "http_400":
    case "http_422":
      // Deterministic per-selector failure (bad request / unprocessable input)
      // — negative-cache the selector so it isn't immediately retried.
      if (selector) b.deadSelectors.add(selector);
      break;
    case "http_451":
      // Legal-policy blocks are deterministic for the exact URL/selector.
      // Preserve the provider for unrelated public sources.
      if (selector) b.deadSelectors.add(selector);
      break;
    case "http_429": {
      const backoff = Math.min(2 ** Math.min(b.consecutive, 6) * 5_000, 5 * 60_000);
      b.disabledUntil = Date.now() + backoff;
      b.disabledReason = `429 backoff ${Math.round(backoff / 1000)}s`;
      // Investigation-level: rate-limited providers are exhausted for the run,
      // not just for `backoff` seconds — stop retrying for the whole run.
      suppressProvider(threadId, tool, `429 rate-limited — provider '${providerForTool(tool)}' suppressed for investigation`);
      break;
    }
    case "http_502":
    case "http_504":
      // Gateway error — the upstream provider is down/unreachable. Fail fast:
      // disable it for the rest of the run on the FIRST occurrence so the agent
      // doesn't spam retries (each can hang for the full fetch timeout) or burn
      // credits re-hitting a dead provider.
      b.disabledReason = `${outcome.status === "http_504" ? "504 gateway timeout" : "502 bad gateway"} — disabled for thread`;
      if (selector) b.deadSelectors.add(selector);
      break;
    case "timeout":
      if (GENERAL_MULTI_ORIGIN_TOOLS.has(tool)) {
        // Multi-origin fan-out: one slow page is a PER-URL problem. Dead-list only
        // this URL so other hosts still run, and suppress the whole tool ONLY after
        // >= TIMEOUT_SUPPRESS_CONSECUTIVE UNINTERRUPTED timeouts. We check the
        // dedicated b.consecutiveTimeouts (maintained above) — NOT b.consecutive,
        // which also counts 4xx/5xx and would falsely trip on a mixed failure run.
        if (selector) b.deadSelectors.add(selector);
        if (b.consecutiveTimeouts >= TIMEOUT_SUPPRESS_CONSECUTIVE) {
          suppressProvider(
            threadId,
            tool,
            `provider '${providerForTool(tool)}' suppressed — ${b.consecutiveTimeouts} consecutive timeouts`,
          );
        }
        // else: selector dead-listed (timeout) — tool stays available for other URLs.
      } else {
        // Single-upstream provider: a timed-out upstream wastes the full fetch
        // window on every retry. Most providers suppress on the FIRST timeout;
        // OathNet gets one retry (timeoutSuppressionThreshold) because its normal
        // latency sits near the wrapper budget.
        if (b.consecutive >= timeoutSuppressionThreshold(tool)) {
          suppressProvider(threadId, tool, `timeout — provider '${providerForTool(tool)}' suppressed for investigation`);
        }
        if (b.consecutive >= 2 && selector) b.deadSelectors.add(selector);
      }
      break;
    case "http_500":
      // A 5xx is a server-side fault: retrying the same provider mid-run rarely
      // recovers within the run and, for paid tools, burns credits. The trace
      // showed synapsint 500 ×6 before the old `consecutive >= 3` guard tripped.
      // Suppress the provider for the investigation on the FIRST 500 — the same
      // fail-fast policy already applied to 429 / timeout / 502 / 504. Coverage
      // trade-off accepted: an unhealthy provider is not worth re-hitting.
      suppressProvider(threadId, tool, `5xx — provider '${providerForTool(tool)}' suppressed for investigation`);
      if (selector) b.deadSelectors.add(selector);
      break;
    default:
      break;
  }
  // Global guard: 3 thread-wide failures → disable.
  if (b.consecutive >= 3 && !b.disabledReason) {
    b.disabledReason = `disabled after ${b.consecutive} consecutive failures`;
  }
}

/** Classify a tool result into a FailureKind. */
export function classifyResult(result: unknown, threw: unknown): FailureKind {
  if (threw) {
    const m = String((threw as Error)?.message ?? threw).toLowerCase();
    if (m.includes("abort") || m.includes("timeout") || m.includes("timed out")) return "timeout";
    return "other";
  }
  if (!result || typeof result !== "object") return "ok";
  const r = result as Record<string, unknown>;
  // A result the TOOL ITSELF marked `skipped: true` never reached the provider —
  // it's a local admission/validation decision (malformed input, host known-dead,
  // hard-blocked origin, etc.), not an observed provider outcome. It must not
  // count toward this tool's consecutive-failure/degradation score even when it
  // also carries an HTTP-shaped `status` (e.g. the Jina hard-block skip reuses
  // 451 as a hint code). This is checked BEFORE the status-code branch below so
  // a locally-skipped result can never fall through to a `http_*` FailureKind.
  // Real provider responses never set `skipped` themselves (see jina_reader_scrape:
  // only its local preflight checks do) so this cannot mask a genuine failure.
  if (r.skipped === true) return "ok";
  // An ORIGIN error relayed by a multi-origin reader (jina: "Target URL returned error
  // 403") is a failed READ of one page, not an observed outcome of the provider — the
  // provider answered correctly. It is logged `failed` (the page was not read) but must
  // not feed the breaker: three blocked pages in a row would otherwise trip the global
  // "disabled after 3 consecutive failures" guard and take the reader offline for every
  // remaining host. See lib/negative-lookup.ts.
  if (r.origin_error === true) return "ok";
  if (r.ok === false || typeof r.error === "string") {
    const status = typeof r.status === "number" ? r.status
      : typeof r.status_code === "number" ? r.status_code
      : 0;
    if (status === 400) return "http_400";
    if (status === 401) return "http_401";
    if (status === 402) return "http_402";
    if (status === 403) return "http_403";
    if (status === 404) return "http_404";
    if (status === 422) return "http_422";
    if (status === 429) return "http_429";
    if (status === 451) return "http_451";
    if (status === 502) return "http_502";
    if (status === 504) return "http_504";
    if (status >= 500) return "http_500";
    const err = String(r.error ?? "").toLowerCase();
    if (err.includes("timeout")) return "timeout";
    if (err.includes("disabled") || err.includes("not configured")) return "ok"; // free-call
    // Governance / gating / suppression / degraded skips are intentional no-ops,
    // not provider failures — they must NOT increment the consecutive-failure
    // counter (which would auto-disable an otherwise-healthy tool).
    if (classifyToolOutcome(r.error as string, null) === "skipped") return "ok";
    return "other";
  }
  return "ok";
}

/** Tiny snapshot of breaker state for the audit panel. */
export function snapshot(threadId: string): Array<{ tool: string; consecutive: number; total: number; disabledReason?: string; dead: number }> {
  const s = state(threadId);
  return Array.from(s.breakers.entries()).map(([tool, b]) => ({
    tool,
    consecutive: b.consecutive,
    total: b.total,
    disabledReason: b.disabledReason,
    dead: b.deadSelectors.size,
  }));
}

/** Bootstrap tool-specific defaults at thread start. */
export function applyBaselineDisables(_threadId: string): void {
  // No baseline disables at present. The firecrawl_* and intelbase_email_lookup
  // tools that used to be pre-disabled here have been removed from the runtime
  // entirely, so there is nothing to pre-disable. Kept as a hook for future
  // baseline circuit-breaker defaults (called once per thread in index.ts).
}

/** Register the start of a run for this thread, incrementing its active-run
 *  count. Pair every acquire() with exactly one release() at end-of-run so the
 *  shared ThreadState is only released once the LAST overlapping run finishes. */
export function acquire(threadId: string): void {
  state(threadId).active++;
}

/** End-of-run teardown for a thread acquired via acquire(): decrement the
 *  active-run count and only delete the ThreadState once it hits 0. When two
 *  runs for the same threadId overlap, the first run's release() leaves the
 *  state intact for the still-running second run. */
export function release(threadId: string): void {
  const s = THREADS.get(threadId);
  if (!s) return;
  s.active = Math.max(0, s.active - 1);
  if (s.active === 0) THREADS.delete(threadId);
}

/** Forcefully drop a thread's state regardless of active-run count. Reserved for
 *  test cleanup; the production end-of-run path uses release() so it can't wipe
 *  state shared by an overlapping run. */
export function clearThread(threadId: string): void {
  THREADS.delete(threadId);
}

/** Disable a tool for this investigation (used by startup capability gating).
 *  A disabled tool's breaker reports allow:false from shouldRun, which cache.ts
 *  turns into a free, un-billed skip before any live call. */
export function disableTool(threadId: string, tool: string, reason: string): void {
  breakerFor(threadId, tool).disabledReason = reason;
}

/** Mark a provider as having an in-flight call for this investigation.
 *  Call this immediately after shouldRun returns allow:true, before the live
 *  request is dispatched. Pair with clearProviderInFlight() on completion. */
export function markProviderInFlight(threadId: string, tool: string): void {
  state(threadId).inFlight.add(providerForTool(tool));
}

/** Clear the in-flight marker for a provider once its call has returned
 *  (success or error). Call this before or alongside recordResult(). */
export function clearProviderInFlight(threadId: string, tool: string): void {
  THREADS.get(threadId)?.inFlight.delete(providerForTool(tool));
}

/** Build the exact-call dedup key used by markCallInFlight/isCallInFlight. */
export function inFlightCallKey(tool: string, selector: string, purpose: string): string {
  return `${tool}::${selector}::${purpose}`;
}

/** True if an IDENTICAL (tool, normalized-selector, purpose) call is already
 *  executing for this investigation. Distinct from the coarser provider-level
 *  `inFlight` gate — this catches genuine duplicates (same query fired twice
 *  in one step) so they can be suppressed locally with a clear "already
 *  running, don't retry" signal instead of the generic provider-busy reason. */
export function isCallInFlight(threadId: string, tool: string, selector: string, purpose: string): boolean {
  return THREADS.get(threadId)?.inFlightCalls.has(inFlightCallKey(tool, selector, purpose)) ?? false;
}

/** Mark an exact call as in-flight. Pair with clearCallInFlight() on completion. */
export function markCallInFlight(threadId: string, tool: string, selector: string, purpose: string): void {
  state(threadId).inFlightCalls.add(inFlightCallKey(tool, selector, purpose));
}

/** Clear the exact-call in-flight marker once the call has returned. */
export function clearCallInFlight(threadId: string, tool: string, selector: string, purpose: string): void {
  THREADS.get(threadId)?.inFlightCalls.delete(inFlightCallKey(tool, selector, purpose));
}
