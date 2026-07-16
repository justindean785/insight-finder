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
  | { allow: false; reason: string; until?: number };

// ---- Investigation-level provider suppression (Phase 8) --------------------
// When a provider returns a 429 or times out, it's suppressed for the rest of
// the investigation (up to this window) so the orchestrator stops re-hitting an
// exhausted/unreachable upstream and re-billing failed calls. Keyed per
// investigation + provider; isolated from other investigations; reset at the
// run boundary (clearThread).
export const PROVIDER_SUPPRESS_MS = 10 * 60_000;

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
  bosint: ["bosint_email_lookup"],
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
  // reasoning model — see #293), so a SEARCH timeout/429/5xx must not drag down the
  // reasoning tools. Keep the search worker on its own "minimax" key; group the
  // three reasoning tools under "minimax_reason" so they still share suppression
  // with EACH OTHER (one reasoning key) but are decoupled from the search worker.
  // Without this, a single minimax_web_search timeout suppressed minimax_correlate
  // (the identity-merge step) for the whole run, fragmenting the report.
  minimax: ["minimax_web_search"],
  minimax_reason: ["minimax_correlate", "minimax_plan_pivots", "minimax_extract"],
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
// takes the reader offline for every remaining host. For these, a `timeout`
// dead-lists only the offending URL and suppresses the tool ONLY after
// >= TIMEOUT_SUPPRESS_CONSECUTIVE consecutive timeouts (see recordResult).
export const GENERAL_MULTI_ORIGIN_TOOLS = new Set<string>([
  "jina_reader_scrape",
  "socialfetch_web_read",
]);

/** Uninterrupted TIMEOUT outcomes (no success or other-failure in between) a
 *  general multi-origin tool must hit before its whole provider is suppressed.
 *  Single-upstream providers still suppress on the first timeout. */
export const TIMEOUT_SUPPRESS_CONSECUTIVE = 3;

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
  const s: ThreadState = { breakers: new Map(), calls: new Map(), suppressions: new Map(), inFlight: new Set(), active: 0 };
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
  if (s && s.inFlight.has(provider)) {
    return { allow: false, reason: `provider '${provider}' already has a call in-flight — waiting for its result` };
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
  b.consecutive++;
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
      b.disabledReason = "402 payment required — disabled for thread";
      suppressProvider(threadId, tool, `402 payment required — provider '${providerForTool(tool)}' suppressed for investigation`);
      break;
    case "http_403":
    case "http_401":
      // An auth rejection is provider-wide: the API key/credential is bad or
      // revoked for EVERY endpoint on that provider, not just this tool. Disable
      // the tool AND suppress the whole provider for the run so sibling
      // endpoints on the same dead key stop firing (deepfind_telegram_search
      // 403 should kill the rest of the deepfind family, not just itself).
      b.disabledReason = "403/401 unauthorized — disabled for thread";
      suppressProvider(threadId, tool, `401/403 unauthorized — provider '${providerForTool(tool)}' suppressed for investigation`);
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
        // Distinct reason strings so the audit shows which path fired: a dead-listed
        // selector surfaces as "selector blacklisted for <tool>" on retry, vs. the
        // consecutive-timeout provider suppression below.
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
        // window on every retry — suppress the provider on the FIRST timeout.
        suppressProvider(threadId, tool, `timeout — provider '${providerForTool(tool)}' suppressed for investigation`);
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
  // Global guard: 3 thread-wide failures of ANY type → disable. This is a
  // SEPARATE, generic reliability backstop — distinct from the multi-origin
  // timeout suppression above (which keys off b.consecutiveTimeouts). A tool that
  // fails 3 times in a row for mixed reasons (e.g. 404 → 451 → timeout) is
  // genuinely unhealthy and is still disabled here by design; unchanged.
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
