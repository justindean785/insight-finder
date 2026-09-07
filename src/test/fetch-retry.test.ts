import { describe, it, expect, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  fetchWithRetry,
  isReplaySafeMethod,
  resolveRequestMethod,
  MAX_ATTEMPTS,
  RETRYABLE_HTTP_CODES,
} from "@/lib/fetch-retry";

/**
 * NO AUTOMATIC REPLAY OF AN INVESTIGATION POST.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `ChatWindow`'s transport retried every request up to three times with no
 * method check. Its only outbound call is a POST to
 * `/functions/v1/osint-agent`, which has no idempotency key and does not
 * reject overlapping runs for a thread. A single 429, 502 or dropped socket
 * on a request the server had already accepted therefore did not retry a
 * failed submit — it launched a SECOND investigation on the same thread:
 * duplicate paid tool calls, duplicate artifacts, duplicate spend against the
 * paid-call cap, and two writers racing the same finalize path.
 *
 * THE CONTRACT
 *
 *     GET / HEAD                    → up to MAX_ATTEMPTS, on retryable
 *                                     statuses AND on network errors
 *     POST / PUT / PATCH / DELETE   → exactly one attempt, always
 *
 * These tests DRIVE `fetchWithRetry` — the function the shipped transport
 * calls — by counting real invocations of a stubbed `fetch`. They do not
 * re-describe the policy; the call count is the assertion. The final block
 * pins the wiring so the component cannot quietly grow a private copy again.
 */

/** Minimal stand-in — `fetchWithRetry` reads only `status`. */
function statusResponse(status: number): Response {
  return { status, ok: status >= 200 && status < 300 } as unknown as Response;
}

/** Installs a stub `fetch` and returns the spy so tests can count calls. */
function stubFetch(impl: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>) {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── GET / HEAD keep the retry budget ───────────────────────────

describe("fetchWithRetry — replay-safe methods still retry", () => {
  it("GET retries on network failure and returns the eventual success", async () => {
    const spy = stubFetch(async (_url, _init) => {
      if (spy.mock.calls.length < 3) throw new TypeError("Failed to fetch");
      return statusResponse(200);
    });

    const res = await fetchWithRetry("https://example.test/health", { method: "GET" });

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it("GET exhausts its attempts and rethrows the last network error", async () => {
    const spy = stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });

    await expect(fetchWithRetry("https://example.test/health", { method: "GET" })).rejects.toThrow(
      /Failed to fetch/,
    );
    expect(spy).toHaveBeenCalledTimes(MAX_ATTEMPTS);
  });

  it.each([...RETRYABLE_HTTP_CODES])("GET retries on configured retryable status %i", async (code) => {
    const spy = stubFetch(async () =>
      spy.mock.calls.length < 2 ? statusResponse(code) : statusResponse(200),
    );

    const res = await fetchWithRetry("https://example.test/health", { method: "GET" });

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("GET returns a non-retryable status immediately", async () => {
    const spy = stubFetch(async () => statusResponse(404));

    const res = await fetchWithRetry("https://example.test/health", { method: "GET" });

    expect(res.status).toBe(404);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("HEAD retries like GET", async () => {
    const spy = stubFetch(async () =>
      spy.mock.calls.length < 2 ? statusResponse(503) : statusResponse(200),
    );

    const res = await fetchWithRetry("https://example.test/health", { method: "HEAD" });

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("a request with no explicit method is treated as GET and retries", async () => {
    const spy = stubFetch(async () =>
      spy.mock.calls.length < 2 ? statusResponse(500) : statusResponse(200),
    );

    const res = await fetchWithRetry("https://example.test/health");

    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

// ── The repair: mutating methods execute exactly once ──────────

describe("fetchWithRetry — POST is never replayed", () => {
  it("POST does not retry on network failure — the error reaches the caller", async () => {
    const spy = stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });

    await expect(
      fetchWithRetry("https://example.test/functions/v1/osint-agent", { method: "POST", body: "{}" }),
    ).rejects.toThrow(/Failed to fetch/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("POST does not retry on 429", async () => {
    const spy = stubFetch(async () => statusResponse(429));

    const res = await fetchWithRetry("https://example.test/functions/v1/osint-agent", {
      method: "POST",
      body: "{}",
    });

    expect(res.status).toBe(429);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it.each([500, 502, 503, 504])("POST does not retry on %i", async (code) => {
    const spy = stubFetch(async () => statusResponse(code));

    const res = await fetchWithRetry("https://example.test/functions/v1/osint-agent", {
      method: "POST",
      body: "{}",
    });

    expect(res.status).toBe(code);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a lower-case 'post' is not replayed either", async () => {
    const spy = stubFetch(async () => statusResponse(502));

    await fetchWithRetry("https://example.test/functions/v1/osint-agent", { method: "post" });

    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("fetchWithRetry — every other mutating method executes exactly once", () => {
  it.each(["PUT", "PATCH", "DELETE"])("%s does not retry on a retryable status", async (method) => {
    const spy = stubFetch(async () => statusResponse(503));

    const res = await fetchWithRetry("https://example.test/resource", { method });

    expect(res.status).toBe(503);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it.each(["PUT", "PATCH", "DELETE"])("%s does not retry on a network failure", async (method) => {
    const spy = stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });

    await expect(fetchWithRetry("https://example.test/resource", { method })).rejects.toThrow(
      /Failed to fetch/,
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ── Method resolution ──────────────────────────────────────────

describe("resolveRequestMethod", () => {
  it("defaults to GET when nothing specifies a method", () => {
    expect(resolveRequestMethod("https://example.test/x")).toBe("GET");
    expect(resolveRequestMethod("https://example.test/x", {})).toBe("GET");
  });

  it("normalizes case", () => {
    expect(resolveRequestMethod("https://example.test/x", { method: "post" })).toBe("POST");
    expect(resolveRequestMethod("https://example.test/x", { method: " Get " })).toBe("GET");
  });

  it("falls back to GET for an empty method string", () => {
    expect(resolveRequestMethod("https://example.test/x", { method: "" })).toBe("GET");
  });

  it("reads the method off a Request first argument", () => {
    const req = new Request("https://example.test/functions/v1/osint-agent", { method: "POST" });
    expect(resolveRequestMethod(req)).toBe("POST");
    expect(isReplaySafeMethod(resolveRequestMethod(req))).toBe(false);
  });

  it("init.method overrides a Request's own method", () => {
    const req = new Request("https://example.test/x", { method: "POST" });
    expect(resolveRequestMethod(req, { method: "GET" })).toBe("GET");
  });
});

describe("isReplaySafeMethod", () => {
  it("admits only GET and HEAD", () => {
    expect(isReplaySafeMethod("GET")).toBe(true);
    expect(isReplaySafeMethod("HEAD")).toBe(true);
    for (const m of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS", "TRACE", "CONNECT"]) {
      expect(isReplaySafeMethod(m)).toBe(false);
    }
  });
});

// ── Wiring: the shipped transport must use this helper ─────────

describe("ChatWindow transport wiring", () => {
  const SOURCE = readFileSync(
    resolve(process.cwd(), "src/components/ChatWindow.tsx"),
    "utf-8",
  );

  it("imports fetchWithRetry from the shared, method-scoped module", () => {
    expect(SOURCE).toMatch(/import\s*\{\s*fetchWithRetry\s*\}\s*from\s*"@\/lib\/fetch-retry"/);
  });

  it("routes the investigation transport through fetchWithRetry", () => {
    expect(SOURCE).toContain("return fetchWithRetry(url, { ...init, headers });");
  });

  it("no longer carries its own method-blind retry loop", () => {
    expect(SOURCE).not.toContain("async function fetchWithRetry");
    expect(SOURCE).not.toContain("const RETRYABLE_HTTP_CODES");
  });
});
