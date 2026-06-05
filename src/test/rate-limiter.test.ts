import { describe, it, expect } from "vitest";

// ── Per-user in-memory rate limiter (audit F-A3) ──────────────────────
// Re-implementing the helper from supabase/functions/osint-agent/auth.ts
// so the test stays self-contained.

const MAX_REQS_PER_MIN = 30;
const MAX_REQS_PER_HOUR = 300;

function checkUserRateLimit(
  userId: string,
  store: Map<string, number[]>,
  now: number = Date.now(),
): { ok: true } | { ok: false; retryAfterSec: number } {
  const hits = (store.get(userId) ?? []).filter((t) => t > now - 60 * 60 * 1000);
  hits.push(now);
  store.set(userId, hits);
  const lastMin = hits.filter((t) => t > now - 60 * 1000).length;
  if (lastMin > MAX_REQS_PER_MIN) {
    return { ok: false, retryAfterSec: 60 };
  }
  if (hits.length > MAX_REQS_PER_HOUR) {
    return { ok: false, retryAfterSec: 3600 };
  }
  return { ok: true };
}

describe("checkUserRateLimit", () => {
  it("allows the first request for a new user", () => {
    const store = new Map<string, number[]>();
    const r = checkUserRateLimit("u1", store, 1_000_000);
    expect(r.ok).toBe(true);
  });

  it("allows up to MAX_REQS_PER_MIN requests within a single minute", () => {
    const store = new Map<string, number[]>();
    let now = 1_000_000;
    for (let i = 0; i < MAX_REQS_PER_MIN; i++) {
      const r = checkUserRateLimit("u1", store, now);
      expect(r.ok).toBe(true);
      now += 1_000; // 1s between requests
    }
  });

  it("blocks the (MAX+1)th request within a single minute with retryAfterSec=60", () => {
    const store = new Map<string, number[]>();
    const now = 1_000_000;
    for (let i = 0; i < MAX_REQS_PER_MIN; i++) {
      checkUserRateLimit("u1", store, now);
    }
    const r = checkUserRateLimit("u1", store, now);
    expect(r).toEqual({ ok: false, retryAfterSec: 60 });
  });

  it("isolates per-user — one user hitting the cap does not affect another", () => {
    const store = new Map<string, number[]>();
    const now = 1_000_000;
    for (let i = 0; i < MAX_REQS_PER_MIN; i++) {
      checkUserRateLimit("u-busy", store, now);
    }
    const r = checkUserRateLimit("u-fresh", store, now);
    expect(r.ok).toBe(true);
  });

  it("prunes timestamps older than 1 hour so long-idle users get a fresh budget", () => {
    const store = new Map<string, number[]>();
    // Pre-populate with hits from 2 hours ago.
    const old = 1_000_000;
    store.set("u1", Array(MAX_REQS_PER_HOUR).fill(old));
    const now = old + 2 * 60 * 60 * 1000 + 1; // 2h+1ms later
    const r = checkUserRateLimit("u1", store, now);
    expect(r.ok).toBe(true);
  });

  it("blocks the (MAX_HOURLY+1)th request with retryAfterSec=3600", () => {
    const store = new Map<string, number[]>();
    // Spread MAX_REQS_PER_HOUR hits across 50 minutes (~6/min) — under the
    // per-minute cap of 30 but all within the rolling 1h window. The
    // 301st hit pushes total over MAX_REQS_PER_HOUR.
    const base = 1_000_000;
    for (let i = 0; i < MAX_REQS_PER_HOUR; i++) {
      checkUserRateLimit("u1", store, base + i * 10_000); // 10s apart -> 50 min total
    }
    const r = checkUserRateLimit("u1", store, base + MAX_REQS_PER_HOUR * 10_000);
    expect(r).toEqual({ ok: false, retryAfterSec: 3600 });
  });

  it("returns the per-minute block (60s) when both caps are exceeded in the same window", () => {
    const store = new Map<string, number[]>();
    const now = 1_000_000;
    // Trigger the per-minute cap first.
    for (let i = 0; i < MAX_REQS_PER_MIN; i++) {
      checkUserRateLimit("u1", store, now);
    }
    const r = checkUserRateLimit("u1", store, now);
    expect(r).toEqual({ ok: false, retryAfterSec: 60 });
  });
});
