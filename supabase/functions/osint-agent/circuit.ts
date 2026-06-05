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
  | "http_429"
  | "http_500"
  | "timeout"
  | "other";

export type BreakerDecision =
  | { allow: true }
  | { allow: false; reason: string; until?: number };

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
}

const THREADS = new Map<string, ThreadState>();

function state(threadId: string): ThreadState {
  let s = THREADS.get(threadId);
  if (!s) {
    s = { breakers: new Map(), calls: new Map() };
    THREADS.set(threadId, s);
  }
  return s;
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
    if (prior && prior.status === "ok" && prior.artifactCount > 0) {
      return { allow: false, reason: "duplicate call: prior run already produced artifacts" };
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
      if (selector) b.deadSelectors.add(selector);
      break;
    case "http_429": {
      const backoff = Math.min(2 ** Math.min(b.consecutive, 6) * 5_000, 5 * 60_000);
      b.disabledUntil = Date.now() + backoff;
      b.disabledReason = `429 backoff ${Math.round(backoff / 1000)}s`;
      break;
    }
    case "timeout":
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
    if (status === 429) return "http_429";
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
