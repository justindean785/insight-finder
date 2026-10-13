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

describe("normalizeProviderError — LeakCheck's documented 403 meanings (and only LeakCheck's)", () => {
  // LeakCheck's docs (docs.leakcheck.io/errors) give 403 exactly two meanings: "Active plan required" and
  // "Limit reached". The row the edge writes for a refused lookup usually carries only the status — cache.ts
  // extractToolError synthesises "upstream returned HTTP 403" — so the tool name identifies it, and the status
  // alone cannot say WHICH of the two. The account-limit reading is keyed on the tool name AND the 403 status,
  // never on keywords: a 403 from a website, a CDN or a scraping tool is the target's, not a provider plan problem.
  const GENERIC = "Access denied (HTTP 403) — the provider blocked this request, usually bot protection or IP reputation, not a bad key.";

  it("leakcheck_lookup 403 with only transport text says 'either', says it was not told which, and drops 'bot protection'", () => {
    for (const raw of ["upstream returned HTTP 403", null, ""]) {
      const m = normalizeProviderError("leakcheck_lookup", raw, 403);
      expect(m.startsWith("Refused (HTTP 403).")).toBe(true);
      expect(m).toMatch(/documents 403 as either an inactive plan or a reached usage quota, and the response did not say which/i);
      expect(m).toMatch(/Check the plan and remaining quota on the LeakCheck account/);
      expect(m).not.toMatch(/IP reputation|bot protection|account grounds/i);
      expect(m).not.toMatch(/upstream returned HTTP 403/); // bare transport text is not quoted back
    }
  });

  it("names WHICH only when LeakCheck's own documented words did, and quotes them", () => {
    const plan = normalizeProviderError("leakcheck_lookup", "Active plan required", 403);
    expect(plan.startsWith('Refused (HTTP 403) — "Active plan required".')).toBe(true);
    expect(plan).toMatch(/no active plan/i);
    expect(plan).not.toMatch(/usage quota/i);
    const lim = normalizeProviderError("leakcheck_lookup", "Limit reached", 403);
    expect(lim.startsWith('Refused (HTTP 403) — "Limit reached".')).toBe(true);
    expect(lim).toMatch(/usage quota is used up/i);
    expect(lim).not.toMatch(/no active plan/i);
    expect(normalizeProviderError("leakcheck_lookup", "active plan required", 403)).toMatch(/no active plan/i);
  });

  it("the headline is exactly the refusal; the cause sentence is separate and only ever hedged or quoted", () => {
    expect(normalizeProviderError("leakcheck_lookup", null, 403).split(". ")[0]).toBe("Refused (HTTP 403)");
    expect(normalizeProviderError("leakcheck_lookup", "upstream returned HTTP 403", 403).split(". ")[0]).toBe("Refused (HTTP 403)");
    expect(normalizeProviderError("leakcheck_lookup", "Active plan required", 403).split(". ")[0]).toBe('Refused (HTTP 403) — "Active plan required"');
  });

  it("the documented message is accepted only as the WHOLE text (quotes / final period tolerated)", () => {
    for (const raw of ['"Active plan required"', "Active plan required.", "ACTIVE PLAN REQUIRED"]) {
      expect(normalizeProviderError("leakcheck_lookup", raw, 403)).toMatch(/no active plan/i);
    }
    expect(normalizeProviderError("leakcheck_lookup", "Limit reached.", 403)).toMatch(/usage quota is used up/i);
  });

  it("text that merely CONTAINS a documented phrase is not read as LeakCheck's message", () => {
    for (const raw of [
      "Forbidden: Limit reached",
      "HTTP 403 — Cloudflare: Limit reached for your IP",
      "Daily limit reached",
      "Error: Active plan required for this endpoint",
      "Active plan required / Limit reached",
      "x".repeat(200) + " Limit reached",
    ]) {
      expect(normalizeProviderError("leakcheck_lookup", raw, 403)).toBe(GENERIC);
    }
  });

  it("transport text for a DIFFERENT status than the one being read is not 'status only'", () => {
    expect(normalizeProviderError("leakcheck_lookup", "upstream returned HTTP 404", 403, "http_denied")).toBe(GENERIC);
  });

  it("provider text that is NOT one of the two documented messages keeps the generic wording", () => {
    expect(normalizeProviderError("leakcheck_lookup", "Attention Required! | Cloudflare", 403)).toBe(GENERIC);
  });

  it("a LeakCheck refusal with no 403 status is not read through the 403 documentation", () => {
    // Category is http_denied only because the text said "forbidden"; the docs' claim is about the 403 status.
    expect(classifyDetailedOutcome("failed", "forbidden", null)).toBe("http_denied");
    expect(normalizeProviderError("leakcheck_lookup", "forbidden", null)).toBe(GENERIC);
    // Defence in depth: even handed the category directly, the 403 documentation needs a 403.
    expect(normalizeProviderError("leakcheck_lookup", "Active plan required", null, "http_denied")).toBe(GENERIC);
    expect(normalizeProviderError("leakcheck_lookup", "Limit reached", 200, "http_denied")).toBe("Access denied (HTTP 200) — the provider blocked this request, usually bot protection or IP reputation, not a bad key.");
  });

  // The regression the review found: a keyword rule would send an analyst to "check your plan" for a paywalled
  // page, a CDN quota page or a shodan-style 403. Every one of these must be byte-identical to the generic wording.
  const UNRELATED: Array<[string, string]> = [
    ["jina_reader_scrape", "403 Forbidden: Subscription required to read this article"],
    ["jina_reader_scrape", "Target returned 403: please log in to your subscription"],
    ["jina_reader_scrape", "Active plan required"],
    ["firecrawl_scrape", "HTTP 403 — daily limit reached for anonymous readers"],
    ["http_fingerprint", "HTTP 403 — Cloudflare: request quota for your IP"],
    ["reddit_user", "Whoa there, pardner! Reddit's awfully busy; your IP quota"],
    ["shodan_host", "403 Forbidden: subscription required"],
    ["some_paid_api", "403 Active plan required"],
    ["nominatim_geocode", "nominatim 403 account limit exceeded"],
    ["leakcheck_lookup_lookalike", "Limit reached"],
  ];
  it.each(UNRELATED)("NEGATIVE CONTROL — %s 403 saying %j keeps the generic wording", (tool, raw) => {
    expect(normalizeProviderError(tool, raw, 403)).toBe(GENERIC);
  });

  it("ordinary 403s with no account words keep the generic wording", () => {
    expect(normalizeProviderError("jina_reader_scrape", "jina 403", 403)).toBe(GENERIC);
    expect(normalizeProviderError("reddit_user", "reddit 403 Blocked", 403)).toBe(GENERIC);
    expect(normalizeProviderError("nominatim_geocode", "nominatim 403", 403)).toBe(GENERIC);
  });

  it("does not change the category: still http_denied (the calm bucket) for every case above", () => {
    expect(classifyDetailedOutcome("failed", "Active plan required", 403)).toBe("http_denied");
    expect(classifyDetailedOutcome("failed", "upstream returned HTTP 403", 403)).toBe("http_denied");
    for (const [, raw] of UNRELATED) expect(classifyDetailedOutcome("failed", raw, 403)).toBe("http_denied");
  });
});

describe("aggregateToolHealth — a repeated denial carries the reason (LeakCheck 403, 2026-10-13)", () => {
  // normalizeProviderError is only called for needs-attention categories, and http_denied is deliberately the calm
  // bucket — so a 403 wording written there was never shown. A tool denied REPEATEDLY on one case already trips the
  // repetition floor; that is where the analyst needs the reason, and the only place this changes.
  const at = (tool: string, error_msg: string | null, created_at: string, over: Record<string, unknown> = {}) =>
    ({ tool_name: tool, outcome: "failed", error_msg, status_code: 403, ok: false, created_at, ...over });
  const REPEAT = "3 attempts on this case, none returned data — stop calling it here.";
  const T = (n: number) => `2026-10-13T00:0${n}:00Z`;
  const lk = (n: number, msg: string | null = "upstream returned HTTP 403") => Array.from({ length: n }, (_, i) => at("leakcheck_lookup", msg, T(i)));

  it("three LeakCheck 403s: the repetition sentence is kept and the documented-meaning sentence is appended", () => {
    const { rows, attention } = aggregateToolHealth(lk(3));
    expect(attention.map((r) => r.toolName)).toEqual(["leakcheck_lookup"]);
    const issue = rows[0].lastIssue!;
    expect(issue.category).toBe("http_denied");
    expect(issue.statusCode).toBe(403);
    expect(issue.message.startsWith(REPEAT)).toBe(true);
    expect(issue.message).toContain("Last denial: Refused (HTTP 403).");
    expect(issue.message).toMatch(/either an inactive plan or a reached usage quota, and the response did not say which/);
    expect(issue.message).not.toMatch(/bot protection/i);
  });

  it("one or two LeakCheck 403s stay calm: no attention, no message (the Denied chip only)", () => {
    for (const n of [1, 2]) {
      const { rows, attention } = aggregateToolHealth(lk(n));
      expect(attention).toEqual([]);
      expect(rows[0].needsAttention).toBe(false);
      expect(rows[0].lastIssue).toBeNull();
      expect(rows[0].worst).toBe("http_denied");
    }
  });

  it("another tool denied three times gets ITS OWN generic wording — never the LeakCheck reading, whatever its text says", () => {
    for (const msg of ["403 Forbidden: Subscription required to read this article", "jina 403", "Active plan required"]) {
      const { rows } = aggregateToolHealth(Array.from({ length: 3 }, (_, i) => at("jina_reader_scrape", msg, T(i))));
      expect(rows[0].lastIssue!.message).toBe(
        `${REPEAT} Last denial: Access denied (HTTP 403) — the provider blocked this request, usually bot protection or IP reputation, not a bad key.`,
      );
      expect(rows[0].lastIssue!.message).not.toMatch(/Refused|inactive plan|usage quota/i);
    }
  });

  it("the MOST RECENT denial supplies the reason, regardless of input order", () => {
    const { rows } = aggregateToolHealth([
      at("leakcheck_lookup", "upstream returned HTTP 403", T(2)),
      at("leakcheck_lookup", "Active plan required", T(3)),
      at("leakcheck_lookup", "upstream returned HTTP 403", T(1)),
    ]);
    expect(rows[0].lastIssue!.message).toContain('Last denial: Refused (HTTP 403) — "Active plan required".');
    expect(rows[0].lastIssue!.message).not.toMatch(/did not say which/);
  });

  it("a tool whose worst category is not a denial keeps the old repetition sentence EXACTLY", () => {
    const mixed = aggregateToolHealth([
      at("leakcheck_lookup", "upstream returned HTTP 403", T(1)),
      at("leakcheck_lookup", "upstream returned HTTP 403", T(2)),
      at("leakcheck_lookup", "request timed out after 30000ms", T(3), { status_code: null }),
    ]);
    expect(mixed.rows[0].worst).toBe("timeout");
    expect(mixed.rows[0].lastIssue).toEqual({ category: "timeout", message: REPEAT, statusCode: null });
    const timeouts = aggregateToolHealth(Array.from({ length: 3 }, (_, i) => at("exa_search", "request timed out after 30000ms", T(i), { status_code: null })));
    expect(timeouts.rows[0].lastIssue).toEqual({ category: "timeout", message: REPEAT, statusCode: null });
  });

  it("any success among the attempts means no repetition flag, so nothing is added", () => {
    const { rows } = aggregateToolHealth([...lk(3), { tool_name: "leakcheck_lookup", outcome: "ok", error_msg: null, status_code: 200, ok: true, created_at: T(5) }]);
    expect(rows[0].needsAttention).toBe(false);
    expect(rows[0].lastIssue).toBeNull();
  });

  it("does not change which tools need attention or the totals", () => {
    const { totals, attention } = aggregateToolHealth([...lk(3), at("firecrawl_scrape", "jina 403", T(1))]);
    expect(attention.map((r) => r.toolName)).toEqual(["leakcheck_lookup"]);
    expect(totals.http_denied).toBe(4);
    expect(totals.total).toBe(4);
  });
});
