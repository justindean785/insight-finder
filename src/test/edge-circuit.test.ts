import { describe, it, expect, beforeEach } from "vitest";
import {
  normalizeSelector,
  callKey,
  shouldRun,
  recordResult,
  classifyResult,
  snapshot,
  clearThread,
  applyBaselineDisables,
} from "../../supabase/functions/osint-agent/circuit.ts";

// The circuit breaker keeps per-thread in-memory state, so each test uses a
// unique thread id and clears it afterwards to stay isolated.
let tid = 0;
let thread = "";
beforeEach(() => {
  thread = `t-${++tid}-${Math.random()}`;
  clearThread(thread);
});

describe("normalizeSelector", () => {
  it("returns empty string for nullish/blank", () => {
    expect(normalizeSelector("email", null)).toBe("");
    expect(normalizeSelector("email", "  ")).toBe("");
  });

  it("lowercases emails/domains", () => {
    expect(normalizeSelector("email", "Foo@Bar.COM")).toBe("foo@bar.com");
  });

  it("strips @ from handles", () => {
    expect(normalizeSelector("username", "@CoolUser")).toBe("cooluser");
  });

  it("keeps only digits and + for phones", () => {
    expect(normalizeSelector("phone", "+1 (415) 555-1234")).toBe("+14155551234");
  });

  it("canonicalizes URLs (drops trailing slash)", () => {
    expect(normalizeSelector("url", "HTTPS://Example.com/p/")).toBe("https://example.com/p");
  });

  it("falls back to lowercase for unknown kinds", () => {
    expect(normalizeSelector("weird", "ABC")).toBe("abc");
  });
});

describe("callKey", () => {
  it("is deterministic and includes purpose", () => {
    expect(callKey("tool", "sel")).toBe("tool::sel::default");
    expect(callKey("tool", "sel", "p")).toBe("tool::sel::p");
  });
});

describe("classifyResult", () => {
  it("returns ok for plain success objects", () => {
    expect(classifyResult({ data: 1 }, null)).toBe("ok");
    expect(classifyResult("string-result", null)).toBe("ok");
  });

  it("maps thrown timeouts/aborts to timeout, else other", () => {
    expect(classifyResult(null, new Error("Request timed out"))).toBe("timeout");
    expect(classifyResult(null, new Error("aborted"))).toBe("timeout");
    expect(classifyResult(null, new Error("boom"))).toBe("other");
  });

  it("maps HTTP status codes in error results", () => {
    expect(classifyResult({ ok: false, status: 402 }, null)).toBe("http_402");
    expect(classifyResult({ error: "x", status_code: 404 }, null)).toBe("http_404");
    expect(classifyResult({ error: "legal restriction", status: 451 }, null)).toBe("http_451");
    expect(classifyResult({ ok: false, status: 503 }, null)).toBe("http_500");
  });

  it("treats 'disabled'/'not configured' as a free ok (not a failure)", () => {
    expect(classifyResult({ ok: false, error: "tool disabled" }, null)).toBe("ok");
    expect(classifyResult({ error: "API not configured" }, null)).toBe("ok");
  });

  it("treats skipped:true as ok so unsupported-platform no-ops do not poison keys", () => {
    expect(classifyResult({
      ok: false,
      skipped: true,
      reason: "socialfetch_lookup does not support platform='github'",
    }, null)).toBe("ok");
  });
});

describe("shouldRun / recordResult", () => {
  it("allows a fresh call", () => {
    expect(shouldRun(thread, "tool", "sel")).toEqual({ allow: true });
  });

  it("blocks a duplicate call that already produced artifacts", () => {
    recordResult(thread, "tool", "sel", "default", { status: "ok", artifactCount: 2 });
    expect(shouldRun(thread, "tool", "sel")).toMatchObject({ allow: false });
  });

  it("fails the provider over on the FIRST 5xx (CostGate v2: no retry spam)", () => {
    // Previously a plain 500 was treated as transient and re-allowed; the trace
    // showed that let synapsint 500 ×6 burn through. A 5xx now suppresses the
    // provider for the rest of the run on the first occurrence.
    recordResult(thread, "toolA", "sel", "default", { status: "http_500" });
    expect(shouldRun(thread, "toolA", "sel").allow).toBe(false);

    recordResult(thread, "toolB", "sel", "default", { status: "http_400" });
    // 400 also blacklists the selector, so the breaker blocks it.
    expect(shouldRun(thread, "toolB", "sel").allow).toBe(false);
  });

  it("disables a tool for the thread after a 402", () => {
    recordResult(thread, "paid", "sel", "default", { status: "http_402" });
    const d = shouldRun(thread, "paid", "other-sel");
    expect(d.allow).toBe(false);
    expect((d as { reason?: string }).reason).toMatch(/402/);
  });

  it("blacklists a selector after a 404", () => {
    recordResult(thread, "look", "deadsel", "default", { status: "http_404" });
    const d = shouldRun(thread, "look", "deadsel");
    expect(d.allow).toBe(false);
    expect((d as { reason?: string }).reason).toMatch(/blacklisted/);
  });

  it("limits a 451 legal block to the exact selector", () => {
    recordResult(thread, "reader", "https://blocked.example/item", "default", { status: "http_451" });
    expect(shouldRun(thread, "reader", "https://blocked.example/item").allow).toBe(false);
    expect(shouldRun(thread, "reader", "https://public.example/item").allow).toBe(true);
  });

  it("applies a timed backoff after a 429", () => {
    recordResult(thread, "rl", "sel", "default", { status: "http_429" });
    const d = shouldRun(thread, "rl", "sel");
    expect(d.allow).toBe(false);
    expect((d as { until?: number }).until).toBeGreaterThan(Date.now());
  });

  it("disables a tool after 3 consecutive generic failures", () => {
    for (let i = 0; i < 3; i++) recordResult(thread, "flaky", "", "default", { status: "other" });
    expect(shouldRun(thread, "flaky", "sel").allow).toBe(false);
  });

  it("force bypasses dedup", () => {
    recordResult(thread, "tool", "sel", "default", { status: "ok", artifactCount: 1 });
    expect(shouldRun(thread, "tool", "sel", "default", { force: true }).allow).toBe(true);
  });

  it("resets consecutive count on success", () => {
    recordResult(thread, "tool", "s1", "default", { status: "http_500" });
    recordResult(thread, "tool", "s2", "default", { status: "ok", artifactCount: 1 });
    const snap = snapshot(thread).find((x) => x.tool === "tool");
    expect(snap?.consecutive).toBe(0);
  });
});

describe("snapshot / applyBaselineDisables / clearThread", () => {
  it("reports breaker state", () => {
    recordResult(thread, "tool", "sel", "default", { status: "http_404" });
    const snap = snapshot(thread);
    const entry = snap.find((x) => x.tool === "tool");
    expect(entry).toMatchObject({ tool: "tool", total: 1, dead: 1 });
  });

  it("applyBaselineDisables is a no-op hook (no baseline disables at present)", () => {
    // The firecrawl_* / intelbase_email_lookup tools it used to pre-disable have
    // been removed from the runtime, so it disables nothing: the snapshot stays
    // empty right after the call, and a normal tool is still runnable. Kept as a
    // per-thread bootstrap hook.
    applyBaselineDisables(thread);
    expect(snapshot(thread)).toEqual([]);
    expect(shouldRun(thread, "exa_search", "x").allow).toBe(true);
  });

  it("clearThread wipes state", () => {
    recordResult(thread, "tool", "sel", "default", { status: "http_402" });
    clearThread(thread);
    // Check the snapshot first — shouldRun would lazily recreate the breaker.
    expect(snapshot(thread)).toEqual([]);
    expect(shouldRun(thread, "tool", "sel").allow).toBe(true);
  });
});
