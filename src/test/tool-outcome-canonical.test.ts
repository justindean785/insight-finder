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
