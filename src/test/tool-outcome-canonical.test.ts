import { describe, it, expect } from "vitest";
import {
  classifyDetailedOutcome,
  normalizeProviderError,
  needsAttention,
  CANONICAL_OUTCOME_META,
  type CanonicalOutcome,
} from "@/lib/tool-outcome";
import { aggregateToolHealth } from "@/hooks/useThreadToolHealth";

// Strings below are taken VERBATIM from the production tool_usage_log audit
// (2026-07) so the canonical classifier is pinned to real messages, not guesses.

describe("classifyDetailedOutcome — canonical taxonomy (Issue #1)", () => {
  it("coarse ok / empty short-circuit", () => {
    expect(classifyDetailedOutcome("ok", null, null)).toBe("success");
    expect(classifyDetailedOutcome("empty", "indicia web-dbs: no usable result", 200)).toBe("empty");
  });

  it("rescues governance skips that prod mis-stored as failed", () => {
    // These were recorded outcome=failed in prod but are dedup/guard governance.
    expect(classifyDetailedOutcome("failed", "premium 'oathnet_lookup' already ran for this entity this investigation", null)).toBe("skipped");
    expect(classifyDetailedOutcome("failed", "skipped: guard not met", null)).toBe("skipped");
    expect(classifyDetailedOutcome("failed", "provider 'oathnet' already has a call in-flight — waiting for its result", null)).toBe("skipped");
    expect(classifyDetailedOutcome("failed", "finalize window open; live lookup skipped", null)).toBe("skipped");
    expect(classifyDetailedOutcome("failed", "run tool-call cap reached", null)).toBe("skipped");
    expect(classifyDetailedOutcome("failed", "internal paid-call cap reached (12 this run) — internal throttle, not a provider limit", null)).toBe("skipped");
  });

  it("timeouts are TIMEOUT, not failed", () => {
    for (const s of [
      "minimax_correlate exceeded 30000ms tool timeout",
      "gemini_deep_dork exceeded 12000ms tool timeout",
      "jina_reader_scrape exceeded 8000ms tool timeout",
      "bosint_phone_timeout",
      "wayback_cdx_search timed out (archive.org slow)",
      "whois_lookup exceeded 20000ms tool timeout",
    ]) {
      expect(classifyDetailedOutcome("failed", s, null), s).toBe("timeout");
    }
  });

  it("a bare AbortError is CANCELLED (outer budget), distinct from a tool timeout", () => {
    expect(classifyDetailedOutcome("failed", "AbortError: The signal has been aborted", null)).toBe("cancelled");
  });

  it("429 is RATE_LIMITED", () => {
    expect(classifyDetailedOutcome("failed", "upstream returned HTTP 429", 429)).toBe("rate_limited");
    expect(classifyDetailedOutcome("failed", null, 429)).toBe("rate_limited");
  });

  it("451 is BLOCKED (legal), 403 is HTTP_DENIED", () => {
    expect(classifyDetailedOutcome("failed", "jina 451", 451)).toBe("blocked");
    expect(classifyDetailedOutcome("failed", "jina 403", 403)).toBe("http_denied");
    expect(classifyDetailedOutcome("failed", "reddit request failed (403)", 403)).toBe("http_denied");
  });

  it("401 / bad key / 402 are CONFIGURATION_ERROR (even at HTTP 200)", () => {
    expect(classifyDetailedOutcome("failed", "upstream returned HTTP 401", 401)).toBe("config_error");
    expect(classifyDetailedOutcome("failed", "Invalid or unauthorized key. Please check the API key and try again.", 200)).toBe("config_error");
    expect(classifyDetailedOutcome("failed", null, 402)).toBe("config_error");
  });

  it("genuine 5xx / 400 / 422 are FAILED", () => {
    expect(classifyDetailedOutcome("failed", "upstream returned HTTP 500", 500)).toBe("failed");
    expect(classifyDetailedOutcome("failed", "indicia web-dbs HTTP 400", 400)).toBe("failed");
    expect(classifyDetailedOutcome("failed", "upstream returned HTTP 400", 400)).toBe("failed");
    expect(classifyDetailedOutcome("failed", "jina 422", 422)).toBe("failed");
    expect(classifyDetailedOutcome("failed", null, 500)).toBe("failed");
  });

  it("opaque null-error/null-status failures are UNKNOWN, not scary failed", () => {
    // 137 such rows exist in prod; they should read honestly as 'unknown'.
    expect(classifyDetailedOutcome("failed", null, null)).toBe("unknown");
    expect(classifyDetailedOutcome("failed", "", null)).toBe("unknown");
  });

  it("legacy null coarse falls back sensibly", () => {
    expect(classifyDetailedOutcome(null, null, null)).toBe("success");
    expect(classifyDetailedOutcome(null, "upstream returned HTTP 500", 500)).toBe("failed");
  });
});

describe("needsAttention — only genuine problems", () => {
  it("config/failed/unknown need attention; the rest do not", () => {
    const attn: CanonicalOutcome[] = ["config_error", "failed", "unknown"];
    const calm: CanonicalOutcome[] = ["success", "empty", "skipped", "cancelled", "timeout", "rate_limited", "http_denied", "blocked"];
    for (const c of attn) expect(needsAttention(c), c).toBe(true);
    for (const c of calm) expect(needsAttention(c), c).toBe(false);
  });
});

describe("normalizeProviderError — meaningful, never a bare HTTP code (Issue #2)", () => {
  it("translates each class into an analyst message", () => {
    expect(normalizeProviderError("jina_reader_scrape", "jina 403", 403)).toMatch(/access denied/i);
    expect(normalizeProviderError("jina_reader_scrape", "jina 451", 451)).toMatch(/legally unavailable/i);
    expect(normalizeProviderError("emailrep", "upstream returned HTTP 429", 429)).toMatch(/rate-limited/i);
    expect(normalizeProviderError("minimax_correlate", "minimax_correlate exceeded 30000ms tool timeout", null)).toMatch(/timed out|time budget/i);
    expect(normalizeProviderError("stolentax_footprint", "upstream returned HTTP 401", 401)).toMatch(/key|authentication/i);
    expect(normalizeProviderError("indicia_web_dbs", "indicia web-dbs HTTP 400", 400)).toMatch(/unsupported selector|malformed|rejected the request/i);
    expect(normalizeProviderError("synapsint_lookup", null, 500)).toMatch(/server error|upstream/i);
    expect(normalizeProviderError("github_user", null, null)).toMatch(/without reporting|logs/i);
  });

  // Production, thread e66255da: markdown_extract was surfaced in the Tool-Health
  // panel as "Provider server error (HTTP 500) — an upstream outage on the
  // provider's side. Retry later." The actual stored error_msg was
  // "markdown.new 500: File too large (17MB). Maximum size is 10MB" — a
  // deterministic input-size rejection that will fail identically forever. The
  // generic sentence both hid the cause and gave the analyst false hope.
  it("a 5xx carrying a non-retryable input problem is not sold as an outage", () => {
    const msg = normalizeProviderError(
      "markdown_extract",
      "markdown.new 500: File too large (17MB). Maximum size is 10MB",
      500,
    );
    expect(msg).toMatch(/File too large \(17MB\)/);
    expect(msg).toMatch(/Maximum size is 10MB/);
    expect(msg).not.toMatch(/upstream outage/i);
    expect(msg).not.toMatch(/retry later/i);
    expect(msg).toMatch(/retrying the same input will fail the same way/i);
  });

  it("a 5xx with a genuine upstream message keeps the provider's words AND the retry advice", () => {
    const msg = normalizeProviderError("synapsint_lookup", "upstream returned HTTP 502 bad gateway", 502);
    expect(msg).toMatch(/bad gateway/i);
    expect(msg).toMatch(/retry later/i);
  });

  it("a 5xx with no message at all still falls back to the generic outage sentence", () => {
    const msg = normalizeProviderError("synapsint_lookup", null, 500);
    expect(msg).toMatch(/upstream outage/i);
    expect(msg).toMatch(/retry later/i);
  });

  it("a 400 keeps the provider's explanation instead of guessing at 'unsupported selector'", () => {
    const msg = normalizeProviderError(
      "hunter_email_finder",
      "hunter 400: domain parameter is required",
      400,
    );
    expect(msg).toMatch(/domain parameter is required/);
    expect(msg).not.toMatch(/upstream outage/i);
    expect(msg).not.toMatch(/unsupported selector/i);
  });

  // The taxonomy is unchanged — this fix is about wording, not classification.
  it("classification of these rows is unchanged", () => {
    expect(classifyDetailedOutcome("failed", "markdown.new 500: File too large (17MB). Maximum size is 10MB", 500)).toBe("failed");
    expect(classifyDetailedOutcome("failed", "hunter 400: domain parameter is required", 400)).toBe("failed");
  });
});

describe("aggregateToolHealth — honest per-tool rollup (Issue #1)", () => {
  const at = (tool: string, outcome: string | null, error_msg: string | null, status_code: number | null, ok: boolean | null, created_at: string) =>
    ({ tool_name: tool, outcome, error_msg, status_code, ok, created_at });

  it("a tool that only timed out is NOT flagged needs-attention", () => {
    const { rows, attention, totals } = aggregateToolHealth([
      at("minimax_correlate", "failed", "minimax_correlate exceeded 30000ms tool timeout", null, false, "2026-07-01T00:00:00Z"),
      at("minimax_correlate", "failed", "minimax_correlate exceeded 30000ms tool timeout", null, false, "2026-07-01T00:01:00Z"),
      at("minimax_correlate", "ok", null, null, true, "2026-07-01T00:02:00Z"),
    ]);
    expect(attention).toHaveLength(0);
    const row = rows.find((r) => r.toolName === "minimax_correlate")!;
    expect(row.counts.timeout).toBe(2);
    expect(row.counts.success).toBe(1);
    expect(row.needsAttention).toBe(false);
    expect(totals.timeout).toBe(2);
  });

  it("a governance 'already ran' skip is counted skipped, never failed", () => {
    const { totals, attention } = aggregateToolHealth([
      at("oathnet_lookup", "failed", "premium 'oathnet_lookup' already ran for this entity this investigation", null, false, "2026-07-01T00:00:00Z"),
    ]);
    expect(totals.skipped).toBe(1);
    expect(totals.failed).toBe(0);
    expect(attention).toHaveLength(0);
  });

  it("a real config/key error IS flagged with a normalized message", () => {
    const { attention } = aggregateToolHealth([
      at("ipqualityscore_lookup", "failed", "Invalid or unauthorized key. Please check the API key and try again.", 200, false, "2026-07-01T00:00:00Z"),
    ]);
    expect(attention).toHaveLength(1);
    expect(attention[0].lastIssue?.category).toBe("config_error");
    expect(attention[0].lastIssue?.message).toMatch(/key/i);
  });

  it("attention tools sort ahead of healthy ones", () => {
    const { rows } = aggregateToolHealth([
      at("healthy_tool", "ok", null, null, true, "2026-07-01T00:00:00Z"),
      at("broken_tool", "failed", "upstream returned HTTP 500", 500, false, "2026-07-01T00:01:00Z"),
    ]);
    expect(rows[0].toolName).toBe("broken_tool");
  });

  it("every canonical category has display metadata", () => {
    const cats: CanonicalOutcome[] = ["success", "empty", "skipped", "cancelled", "timeout", "rate_limited", "http_denied", "blocked", "config_error", "failed", "unknown"];
    for (const c of cats) {
      expect(CANONICAL_OUTCOME_META[c], c).toBeTruthy();
      expect(CANONICAL_OUTCOME_META[c].label.length).toBeGreaterThan(0);
    }
  });
});

describe("aggregateToolHealth — repeated failure on one case is attention-worthy", () => {
  const at = (tool: string, outcome: string | null, error_msg: string | null, status_code: number | null, ok: boolean | null, created_at: string) =>
    ({ tool_name: tool, outcome, error_msg, status_code, ok, created_at });

  it("three cancelled attempts with no data back flag the tool, whatever the category", () => {
    // Production 2026-09-20: socialfetch_web_read aborted 7× on one YouTube
    // channel and Health showed "Cancelled 3 · Needs attention 0".
    const { attention, rows } = aggregateToolHealth([
      at("socialfetch_web_read", "failed", "AbortError: The signal has been aborted", null, false, "2026-09-20T11:58:43Z"),
      at("socialfetch_web_read", "failed", "AbortError: The signal has been aborted", null, false, "2026-09-20T11:59:13Z"),
      at("socialfetch_web_read", "failed", "AbortError: The signal has been aborted", null, false, "2026-09-20T11:59:39Z"),
    ]);
    expect(attention.map((r) => r.toolName)).toEqual(["socialfetch_web_read"]);
    expect(rows[0].lastIssue?.message).toMatch(/3 attempts on this case, none returned data/);
  });

  it("two attempts, or one success among them, do not trip it", () => {
    const two = aggregateToolHealth([
      at("socialfetch_web_read", "failed", "AbortError: The signal has been aborted", null, false, "2026-09-20T11:58:43Z"),
      at("socialfetch_web_read", "failed", "AbortError: The signal has been aborted", null, false, "2026-09-20T11:59:13Z"),
    ]);
    expect(two.attention).toHaveLength(0);
    const mixed = aggregateToolHealth([
      at("jina_reader_scrape", "failed", "jina_reader_scrape exceeded 12000ms tool timeout", null, false, "2026-09-20T11:58:43Z"),
      at("jina_reader_scrape", "failed", "jina_reader_scrape exceeded 12000ms tool timeout", null, false, "2026-09-20T11:59:13Z"),
      at("jina_reader_scrape", "empty", "no usable result", 200, true, "2026-09-20T11:59:39Z"),
    ]);
    expect(mixed.attention).toHaveLength(0);
  });
});

describe("the Faulted tile and the Needs attention list count different things", () => {
  // Production 2026-09-30, screenshotted by the operator: a Complete case with
  // 175 tool calls rendered a "0 — Needs attention" stat tile directly above a
  // red "Needs attention (1)" card for rapidapi_breach_search (Denied 3). Both
  // numbers were correct for what they measured and both were labelled "Needs
  // attention", so the panel contradicted itself on one screen.
  //
  // These pin the two quantities apart. The tile is a member of a five-way
  // partition of CALLS; the list counts TOOLS and escalates on repetition.
  const at = (tool: string, outcome: string | null, error_msg: string | null, status_code: number | null, ok: boolean | null, created_at: string) =>
    ({ tool_name: tool, outcome, error_msg, status_code, ok, created_at });

  const faultedCalls = (t: Record<string, number>) => t.config_error + t.failed + t.unknown;

  it("a tool denied every time has ZERO faulted calls and still needs attention", () => {
    const { totals, attention } = aggregateToolHealth([
      at("rapidapi_breach_search", "failed", "upstream returned HTTP 403", 403, false, "2026-09-30T00:35:32Z"),
      at("rapidapi_breach_search", "failed", "upstream returned HTTP 403", 403, false, "2026-09-30T01:56:06Z"),
      at("rapidapi_breach_search", "failed", "upstream returned HTTP 403", 403, false, "2026-09-30T03:23:34Z"),
    ]);
    expect(totals.http_denied).toBe(3);
    expect(faultedCalls(totals)).toBe(0);      // the tile
    expect(attention).toHaveLength(1);          // the list
    expect(attention[0].toolName).toBe("rapidapi_breach_search");
  });

  it("a single hard fault puts the same tool in both", () => {
    const { totals, attention } = aggregateToolHealth([
      at("ip_intel", "failed", "HTTP 200 ip-api lookup failed", 500, false, "2026-09-30T02:10:00Z"),
    ]);
    expect(faultedCalls(totals)).toBe(1);
    expect(attention.map((r) => r.toolName)).toEqual(["ip_intel"]);
  });

  it("the five tiles stay a partition of every call", () => {
    const { totals } = aggregateToolHealth([
      at("a", "ok", null, 200, true, "2026-09-30T00:00:01Z"),
      at("b", "empty", "no record found", 200, true, "2026-09-30T00:00:02Z"),
      at("c", "skipped", "duplicate call", null, true, "2026-09-30T00:00:03Z"),
      at("d", "failed", "AbortError: the signal was aborted", null, false, "2026-09-30T00:00:04Z"),
      at("e", "failed", "exceeded 18000ms tool timeout", null, false, "2026-09-30T00:00:05Z"),
      at("f", "failed", "upstream returned HTTP 403", 403, false, "2026-09-30T00:00:06Z"),
      at("g", "failed", "upstream returned HTTP 503", 503, false, "2026-09-30T00:00:07Z"),
    ]);
    const succeeded = totals.success;
    const empty = totals.empty;
    const skipped = totals.skipped + totals.cancelled;
    const degraded = totals.timeout + totals.rate_limited + totals.http_denied + totals.blocked;
    expect(succeeded + empty + skipped + degraded + faultedCalls(totals)).toBe(totals.total);
    expect(totals.total).toBe(7);
  });
});

describe("normalizeProviderError — a plan/quota 403 is not bot protection (LeakCheck, 2026-10-06)", () => {
  // LeakCheck's own docs give 403 exactly two meanings: "Active plan required" and "Limit reached". The row
  // the edge writes for a refused lookup carries only the status, so the tool name is what identifies it.
  it("leakcheck_lookup 403 says plan/quota and never 'bot protection or IP reputation'", () => {
    const m = normalizeProviderError("leakcheck_lookup", "upstream returned HTTP 403", 403);
    expect(m).toMatch(/subscription is inactive or the daily lookup quota is used up/i);
    expect(m).toMatch(/Check the plan and quota/);
    expect(m).not.toMatch(/IP reputation/i);
    expect(m).not.toMatch(/upstream returned HTTP 403/); // bare transport text is not quoted back
  });

  it("quotes the provider's own plan/quota words when the row carries them", () => {
    expect(normalizeProviderError("leakcheck_lookup", "Active plan required", 403)).toContain('"Active plan required"');
    expect(normalizeProviderError("leakcheck_lookup", "Limit reached", 403)).toContain('"Limit reached"');
  });

  it("any other provider that says plan/quota in its own words gets the honest reading too", () => {
    const m = normalizeProviderError("some_paid_api", "403 Active plan required", 403);
    expect(m).toMatch(/plan or quota limit on the provider's side/i);
    expect(m).not.toMatch(/IP reputation/i);
  });

  it("NEGATIVE CONTROL — an ordinary 403 keeps the bot-protection wording", () => {
    expect(normalizeProviderError("jina_reader_scrape", "jina 403", 403)).toMatch(/bot protection or IP reputation/i);
    expect(normalizeProviderError("reddit_user", "reddit 403 Blocked", 403)).toMatch(/bot protection or IP reputation/i);
    expect(normalizeProviderError("nominatim_geocode", "nominatim 403", 403)).toMatch(/bot protection or IP reputation/i);
  });

  it("does not change the category: it is still http_denied (the calm bucket), only the wording moves", () => {
    expect(classifyDetailedOutcome("failed", "Active plan required", 403)).toBe("http_denied");
  });
});
