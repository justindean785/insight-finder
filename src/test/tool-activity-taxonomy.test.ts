import { describe, it, expect } from "vitest";
import { classifyActivityRow } from "@/hooks/useThreadToolActivity";
import { aggregateToolHealth } from "@/hooks/useThreadToolHealth";

/**
 * Activity and Health must bucket every call the same way.
 *
 * History. The two views ran different classifiers over the same
 * tool_usage_log rows. First they disagreed on failed-vs-not-failed ("goran
 * kvothe": Activity "Failed 5", Health "Needs attention 0"); that fix aligned
 * only the failed boundary. On a 2026-09-11 live case (116 calls) they still
 * disagreed on skipped-vs-degraded — Activity "Degraded 3 · Skipped 15", Health
 * "Degraded 2 · Skipped 16" — because a provider circuit-breaker suppression read
 * Degraded in one and Skipped in the other. Activity now derives its status FROM
 * the canonical category, and the parity test below drives both counters.
 *
 * The strings are verbatim from production.
 */
describe("classifyActivityRow — Activity/Health taxonomy parity", () => {
  const c = (err: string, outcome = "failed", code: number | null = null) =>
    classifyActivityRow(outcome, false, err, code).status;

  it("treats our own paid-call cap as a policy skip, never a failure", () => {
    expect(c("internal paid-call cap reached (12 this run) — internal throttle, not a provider limit")).toBe("skipped");
  });

  it("treats the per-investigation run cap as a policy skip, never a failure", () => {
    expect(c("internal run cap reached (30 calls this investigation) — internal throttle, not a provider limit")).toBe("skipped");
  });

  it("treats an upstream refusal as degraded (Health calls this Denied)", () => {
    expect(c("reddit request failed (403)")).toBe("degraded");
    expect(c("reddit request failed", "failed", 403)).toBe("degraded");
  });

  it("treats rate limiting and timeouts as degraded", () => {
    expect(c("429 Too Many Requests")).toBe("degraded");
    expect(c("timeout after 15000ms")).toBe("degraded");
    expect(c("request timed out")).toBe("degraded");
  });

  it("still classifies a missing key as gated", () => {
    expect(c("SERUS_API_KEY not configured")).toBe("gated");
    expect(c("provider disabled")).toBe("gated");
  });

  it("still reports a genuine fault as failed", () => {
    expect(c("Internal Server Error (500)")).toBe("failed");
    expect(c("unexpected token < in JSON at position 0")).toBe("failed");
    expect(c("")).toBe("failed");
    // An internal write bug is a real fault, not a provider's.
    expect(c('duplicate key value violates unique constraint "agent_memory_dedup_idx"')).toBe("failed");
  });

  it("a hostname with no DNS address is a successful negative, not a fault", () => {
    // http_fingerprint on an email-only domain (MX, no A record). It sat under
    // "Needs attention — config or provider faults" beside a real bug.
    const dns = "error sending request for url (https://bencaleb.com/): client error (Connect): dns error: failed to lookup address information: No address associated with hostname";
    expect(classifyActivityRow("failed", false, dns).status).toBe("succeeded");
    expect(classifyActivityRow("failed", false, dns).category).toBe("empty");
    // A transient resolver failure is NOT a negative and stays a failure.
    expect(c("dns error: Temporary failure in name resolution")).toBe("failed");
  });

  it("leaves successful and empty outcomes untouched", () => {
    expect(classifyActivityRow("ok", true, null).status).toBe("succeeded");
    expect(classifyActivityRow("empty", true, null).status).toBe("succeeded");
  });

  it("keeps a bare skipped row skipped when nothing else matches", () => {
    expect(classifyActivityRow("skipped", false, "deduplicated no-op").status).toBe("skipped");
  });

  it("reproduces the goran kvothe run: 5 'failures' resolve to 0 genuine faults", () => {
    const rows = [
      "internal paid-call cap reached (12 this run) — internal throttle, not a provider limit",
      "internal paid-call cap reached (12 this run) — internal throttle, not a provider limit",
      "internal run cap reached (30 calls this investigation) — internal throttle, not a provider limit",
      "reddit request failed (403)",
      "internal paid-call cap reached (12 this run) — internal throttle, not a provider limit",
    ];
    const statuses = rows.map((r) => c(r));
    expect(statuses.filter((s) => s === "failed")).toHaveLength(0);
    expect(statuses).toEqual(["skipped", "skipped", "skipped", "degraded", "skipped"]);
  });
});

describe("Activity tiles and Health tiles add up to the same figures", () => {
  type Row = { tool_name: string; outcome: string | null; ok: boolean | null; error_msg: string | null; status_code: number | null; created_at: string };
  let t = 0;
  const row = (tool: string, outcome: string | null, ok: boolean | null, err: string | null = null, code: number | null = null): Row =>
    ({ tool_name: tool, outcome, ok, error_msg: err, status_code: code, created_at: new Date(1_789_000_000_000 + ++t * 1000).toISOString() });

  // The shapes seen on the 2026-09-11 case, plus the classic edge rows.
  const rows: Row[] = [
    ...Array.from({ length: 5 }, () => row("exa_search", "ok", true)),
    row("oathnet_lookup", "empty", true, "no record found"),
    row("breach_check", "failed", false, "not found (0 hits)"),
    row("minimax_web_search", "failed", false, "exceeded 12000ms tool timeout"),
    row("indicia_person", "failed", false, "request timed out"),
    row("minimax_web_search", "skipped", false, "provider minimax suppressed for investigation (circuit open)"),
    row("rapidapi_breach_search", "skipped", false, "finalize window open — skipping new paid calls"),
    row("serus_darkweb_scan", "skipped", false, "SERUS_API_KEY not configured"),
    row("jina_reader_scrape", "skipped", false, "burst limit reached for jina_reader_scrape"),
    row("reddit_search", "failed", false, "reddit request failed", 403),
    row("emailrep", "failed", false, "upstream returned HTTP 429", 429),
    row("memory_save", "failed", false, 'duplicate key value violates unique constraint "agent_memory_dedup_idx"'),
    row("http_fingerprint", "failed", false, "dns error: failed to lookup address information: No address associated with hostname"),
    row("markdown_new", "failed", false, "markdown.new 500: File too large (17MB). Maximum size is 10MB", 500),
    row("legacy_tool", null, null, null),
    row("legacy_tool", null, false, "boom"),
  ];

  it("Succeeded = success + no record; Failed = Needs attention; Degraded and Skipped match exactly", () => {
    const activity = { succeeded: 0, failed: 0, degraded: 0, skipped: 0 };
    for (const r of rows) {
      const s = classifyActivityRow(r.outcome, r.ok, r.error_msg, r.status_code).status;
      if (s === "succeeded") activity.succeeded++;
      else if (s === "failed") activity.failed++;
      else if (s === "degraded") activity.degraded++;
      else activity.skipped++; // skipped + gated — the Activity "Skipped / Gated" tile
    }
    const { totals } = aggregateToolHealth(rows);
    const health = {
      succeeded: totals.success + totals.empty,
      failed: totals.config_error + totals.failed + totals.unknown,
      degraded: totals.timeout + totals.rate_limited + totals.http_denied + totals.blocked,
      skipped: totals.skipped + totals.cancelled,
    };
    expect(activity).toEqual(health);
    expect(activity.succeeded + activity.failed + activity.degraded + activity.skipped).toBe(rows.length);
    // And the specific calls land where an analyst would expect.
    expect(health).toEqual({ succeeded: 9, failed: 3, degraded: 4, skipped: 4 });
  });
});

describe("Health reads the shared store's events — no second read, no reclassification", () => {
  it("toolHealthFromEvents counts each event by the category the store gave it", async () => {
    const { toolHealthFromEvents } = await import("@/hooks/useThreadToolHealth");
    const raw = [
      { tool_name: "minimax_web_search", outcome: "skipped", ok: false, error_msg: "provider minimax suppressed for investigation (circuit open)", status_code: null, created_at: "2026-09-11T12:00:01Z" },
      { tool_name: "minimax_web_search", outcome: "failed", ok: false, error_msg: "exceeded 12000ms tool timeout", status_code: null, created_at: "2026-09-11T12:00:02Z" },
      { tool_name: "http_fingerprint", outcome: "failed", ok: false, error_msg: "dns error: No address associated with hostname", status_code: null, created_at: "2026-09-11T12:00:03Z" },
      { tool_name: "memory_save", outcome: "failed", ok: false, error_msg: 'duplicate key value violates unique constraint "agent_memory_dedup_idx"', status_code: null, created_at: "2026-09-11T12:00:04Z" },
      { tool_name: "exa_search", outcome: "ok", ok: true, error_msg: null, status_code: null, created_at: "2026-09-11T12:00:05Z" },
    ];
    // The store's event shape, built the way `toEvent` builds it.
    const events = raw.map((r, i) => {
      const c = classifyActivityRow(r.outcome, r.ok, r.error_msg, r.status_code);
      return {
        id: `e${i}`, toolName: r.tool_name, displayName: r.tool_name, actionLabel: r.tool_name,
        tone: c.tone, status: c.status, category: c.category, errorMsg: r.error_msg, statusCode: r.status_code,
        at: r.created_at, durationMs: null, cached: false, chargedMicroUsd: null, effectiveChargedMicroUsd: 0, stage: null,
      };
    });
    const fromEvents = toolHealthFromEvents(events);
    const fromRows = aggregateToolHealth(raw);
    expect(fromEvents.totals).toEqual(fromRows.totals);
    expect(fromEvents.attention.map((r) => r.toolName)).toEqual(["memory_save"]);
    expect(fromEvents.totals.skipped).toBe(1);
    expect(fromEvents.totals.timeout).toBe(1);
    expect(fromEvents.totals.empty).toBe(1);
  });
});
