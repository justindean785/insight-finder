// Per-thread circuit breakers + call dedup for OSINT tools.
// Keeps an in-memory record of every tool call attempted on a thread, blocks
// retries that are demonstrably wasteful (402/403/timeouts/3+ failures), and
// surfaces dedup keys so the same tool+selector isn't re-run for free.

export type FailureKind =
  | "ok"
  | "http_400"
  | "http_401"
  | "http_402"
  | "http_403"
  | "http_404"
  | "http_422"
  | "http_429"
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
  deepfind: [
    "deepfind_reverse_email",
    "deepfind_disposable_email",
    "deepfind_telegram_channel",
    "deepfind_ssl_inspect",
    "deepfind_tech_stack",
  ],
  bosint: ["bosint_email_lookup", "bosint_phone_lookup"],
  hunter: ["hunter_domain_search", "hunter_email_finder", "hunter_email_verifier", "hunter_combined"],
  exa: ["exa_search", "exa_find_similar", "exa_get_contents"],
  firecrawl: ["firecrawl_search", "firecrawl_scrape", "firecrawl_map"],
  minimax: ["minimax_web_search", "minimax_correlate", "minimax_plan_pivots", "minimax_extract"],
};
const TOOL_PROVIDER = new Map<string, string>();
for (const [provider, tools] of Object.entries(PROVIDER_TOOLS)) {
  for (const t of tools) TOOL_PROVIDER.set(t, provider);
}

/** The upstream provider a tool belongs to (defaults to the tool itself). */
export function providerForTool(tool: string): string {
  return TOOL_PROVIDER.get(tool) ?? tool;
}

interface Suppression {
  reason: string;
  until: number;
  since: number;
}

interface BreakerState {
  consecutive: number;
  total: number;
  lastAt: number;
  disabledReason?: string;
  disabledUntil?: number;
  /** map of normalized selectors that should never be re-tried */
  deadSelectors: Set<string>;
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
}

const THREADS = new Map<string, ThreadState>();

function state(threadId: string): ThreadState {
  let s = THREADS.get(threadId);
  if (!s) {
    s = { breakers: new Map(), calls: new Map(), suppressions: new Map() };
    THREADS.set(threadId, s);
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
    b = { consecutive: 0, total: 0, lastAt: 0, deadSelectors: new Set() };
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

/** Record outcome of a tool call and update breaker. */
export function recordResult(
  threadId: string,
  tool: string,
  selector: string,
  purpose: string,
  outcome: { status: FailureKind; artifactCount?: number },
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
    b.lastAt = Date.now();
    return;
  }
  b.consecutive++;
  b.total++;
  b.lastAt = Date.now();
  switch (outcome.status) {
    case "http_402":
      b.disabledReason = "402 payment required — disabled for thread";
      break;
    case "http_403":
    case "http_401":
      b.disabledReason = "403/401 unauthorized — disabled for thread";
      break;
    case "http_400":
    case "http_404":
    case "http_422":
      // Deterministic per-selector failure (bad request / unprocessable input)
      // — negative-cache the selector so it isn't immediately retried.
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
      // A timed-out upstream wastes the full fetch window on every retry —
      // suppress the provider for the investigation on the first timeout.
      suppressProvider(threadId, tool, `timeout — provider '${providerForTool(tool)}' suppressed for investigation`);
      if (b.consecutive >= 2 && selector) b.deadSelectors.add(selector);
      break;
    case "http_500":
      if (b.consecutive >= 2 && selector) b.deadSelectors.add(selector);
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
    if (status === 502) return "http_502";
    if (status === 504) return "http_504";
    if (status >= 500) return "http_500";
    const err = String(r.error ?? "").toLowerCase();
    if (err.includes("timeout")) return "timeout";
    if (err.includes("disabled") || err.includes("not configured")) return "ok"; // free-call
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
export function applyBaselineDisables(threadId: string): void {
  // Pre-disable tools known to be unreliable / out-of-budget from past audits.
  const b1 = breakerFor(threadId, "firecrawl_search");
  b1.disabledReason = "firecrawl credits exhausted";
  const b2 = breakerFor(threadId, "firecrawl_scrape");
  b2.disabledReason = "firecrawl credits exhausted";
  const b3 = breakerFor(threadId, "firecrawl_map");
  b3.disabledReason = "firecrawl credits exhausted";
  const b4 = breakerFor(threadId, "intelbase_email_lookup");
  b4.disabledReason = "intelbase gated";
}

export function clearThread(threadId: string): void {
  THREADS.delete(threadId);
}

/** Disable a tool for this investigation (used by startup capability gating).
 *  A disabled tool's breaker reports allow:false from shouldRun, which cache.ts
 *  turns into a free, un-billed skip before any live call. */
export function disableTool(threadId: string, tool: string, reason: string): void {
  breakerFor(threadId, tool).disabledReason = reason;
}
