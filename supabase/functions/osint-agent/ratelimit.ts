/**
 * ratelimit.ts — Distributed per-user rate limiter (Upstash Redis).
 *
 * Replaces the in-memory cap from audit F-A3 with one that holds across
 * Supabase edge function instances. Cheap (~$0 / mo at small scale via
 * Upstash free tier) and one HTTP round-trip per request.
 *
 * Architecture
 * ────────────
 *   - Two counters per user, both written via Upstash's `pipeline` endpoint
 *     (single HTTP call, atomic):
 *       rl:m:<userId>:<minute>  INCR + EXPIRE 70s   → per-minute cap
 *       rl:h:<userId>:<hour>    INCR + EXPIRE 3700s → per-hour cap
 *   - Pure decision logic (window math, threshold check) is split into
 *     `decide()` so it can be unit-tested without an HTTP boundary.
 *   - On any Upstash error the function FAILS OPEN — we drop to the
 *     in-memory fallback so a Redis outage doesn't 500 every scan. This
 *     is deliberate: the cost of letting one extra request through is
 *     < the cost of blocking the user during an infrastructure incident.
 *
 * Set the following secrets (see .env.example):
 *   UPSTASH_REDIS_REST_URL    https://<instance>.upstash.io
 *   UPSTASH_REDIS_REST_TOKEN  ...
 *
 * If either is missing, the function silently uses the in-memory fallback
 * (which is what audit F-A3 shipped with). That makes the upgrade
 * strictly opt-in for new deployments.
 */

import { fetchRetry } from "./env.ts";

// ---- Tunables (exported so tests can mutate them) ---------------------
export const MAX_REQS_PER_MIN = 30;
export const MAX_REQS_PER_HOUR = 300;
// 70s/3700s TTL = window size + 10s grace so a clock skew between
// edge function and Upstash can't cause a 1-tick window leak.
const MIN_TTL_SEC = 70;
const HOUR_TTL_SEC = 3700;
const UPSTASH_TIMEOUT_MS = 500; // 0.5s — Redis must be fast or we fall back

// ---- Pure decision logic ----------------------------------------------

export type Decision = { ok: true } | { ok: false; retryAfterSec: number; reason: "per_min" | "per_hour" };

/** Pure: takes the two counter values, returns a decision. No I/O. */
export function decide(minCount: number, hourCount: number): Decision {
  if (minCount > MAX_REQS_PER_MIN) return { ok: false, retryAfterSec: 60, reason: "per_min" };
  if (hourCount > MAX_REQS_PER_HOUR) return { ok: false, retryAfterSec: 3600, reason: "per_hour" };
  return { ok: true };
}

// ---- In-memory fallback (audit F-A3) ----------------------------------
// Used when Upstash is unset, unreachable, or times out. Same semantics
// as the old checkUserRateLimit so the user experience doesn't change
// if Redis goes down — they just lose the cross-instance protection.
type FallbackStore = Map<string, number[]>;
const _fallbackStore: FallbackStore = new Map();

export function inMemoryCheck(userId: string, now: number = Date.now()): Decision {
  const hits = (_fallbackStore.get(userId) ?? []).filter((t) => t > now - 60 * 60 * 1000);
  hits.push(now);
  _fallbackStore.set(userId, hits);
  return decide(hits.filter((t) => t > now - 60 * 1000).length, hits.length);
}

// ---- Upstash HTTP transport -------------------------------------------

const URL_KEY = "UPSTASH_REDIS_REST_URL";
const TOKEN_KEY = "UPSTASH_REDIS_REST_TOKEN";

function upstashConfigured(): boolean {
  return !!(Deno.env.get(URL_KEY) && Deno.env.get(TOKEN_KEY));
}

type UpstashResult = { result: number | string | null };

/** Single pipeline call: INCR + EXPIRE for both windows. */
async function upstashPipeline(userId: string, now: number): Promise<{ minCount: number; hourCount: number }> {
  const base = Deno.env.get(URL_KEY)!.replace(/\/+$/, "");
  const token = Deno.env.get(TOKEN_KEY)!;

  const minKey = `rl:m:${userId}:${Math.floor(now / 60_000)}`;
  const hourKey = `rl:h:${userId}:${Math.floor(now / 3_600_000)}`;

  // Upstash REST pipeline: POST /pipeline with a 2D array of [cmd, ...args].
  // Atomic server-side; single network round-trip.
  const body = [
    ["INCR", minKey], ["EXPIRE", minKey, MIN_TTL_SEC],
    ["INCR", hourKey], ["EXPIRE", hourKey, HOUR_TTL_SEC],
  ];

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), UPSTASH_TIMEOUT_MS);
  let r: Response;
  try {
    r = await fetchRetry(`${base}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    }, { retries: 0 }); // we already have a 500ms timeout + abort — no inner retries
  } finally {
    clearTimeout(timer);
  }
  if (!r.ok) throw new Error(`upstash HTTP ${r.status}`);
  const json = (await r.json()) as UpstashResult[];
  // Pipeline returns results in the same order: [INCR min, EXPIRE min, INCR hour, EXPIRE hour]
  const minCount = Number(json[0]?.result ?? 0);
  const hourCount = Number(json[2]?.result ?? 0);
  if (!Number.isFinite(minCount) || !Number.isFinite(hourCount)) {
    throw new Error(`upstash returned non-numeric counts: min=${minCount} hour=${hourCount}`);
  }
  return { minCount, hourCount };
}

// ---- Public entry point -----------------------------------------------

/**
 * Check the rate limit for a user. Returns ok=true on allow, ok=false on block.
 * Never throws — falls through to the in-memory check on any error.
 */
export async function checkRateLimit(userId: string, now: number = Date.now()): Promise<Decision> {
  if (!upstashConfigured()) {
    return inMemoryCheck(userId, now);
  }
  try {
    const { minCount, hourCount } = await upstashPipeline(userId, now);
    return decide(minCount, hourCount);
  } catch (e) {
    // Fail open: log to console (per the F-B1 logging policy we log the
    // error TYPE, not the user id, so logs don't become a PII sink).
    console.warn(`[ratelimit] upstash unavailable, falling back to in-memory: ${e instanceof Error ? e.message : String(e)}`);
    return inMemoryCheck(userId, now);
  }
}

/** Test-only: clear the in-memory fallback store. */
export function _resetInMemoryForTests(): void {
  _fallbackStore.clear();
}
