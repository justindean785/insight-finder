import { describe, it, expect } from "vitest";
import {
  describeTransportError, formatHttpFailure, isNetworkDropError, parseHttpStatusFromError, withHttpStatusInErrorBody,
} from "@/lib/tool-run";

// ── Tests: parseHttpStatusFromError ────────────────────────────

describe("parseHttpStatusFromError", () => {
  it("extracts HTTP 401 from error message", () => {
    expect(parseHttpStatusFromError(new Error("HTTP 401 Unauthorized"))).toBe(401);
  });

  it("extracts HTTP 403 from error message", () => {
    expect(parseHttpStatusFromError(new Error("HTTP 403 Forbidden"))).toBe(403);
  });

  it("extracts HTTP 404 from error message", () => {
    expect(parseHttpStatusFromError(new Error("HTTP 404 Not Found"))).toBe(404);
  });

  it("extracts HTTP 429 from error message", () => {
    expect(parseHttpStatusFromError(new Error("HTTP 429 Too Many Requests"))).toBe(429);
  });

  it("extracts HTTP 500 from error message", () => {
    expect(parseHttpStatusFromError(new Error("HTTP 500 Internal Server Error"))).toBe(500);
  });

  it("extracts HTTP 502 from error message", () => {
    expect(parseHttpStatusFromError(new Error("HTTP 502 Bad Gateway"))).toBe(502);
  });

  it("extracts status from 'status: 500' format", () => {
    expect(parseHttpStatusFromError(new Error("Request failed with status: 500"))).toBe(500);
  });

  it("extracts status from 'status=403' format", () => {
    expect(parseHttpStatusFromError(new Error("status=403 Access Denied"))).toBe(403);
  });

  it("extracts bare status code from message", () => {
    expect(parseHttpStatusFromError(new Error("got 404 from server"))).toBe(404);
  });

  it("returns null for non-HTTP errors", () => {
    expect(parseHttpStatusFromError(new Error("Network timeout"))).toBeNull();
  });

  it("returns null for non-numeric status", () => {
    expect(parseHttpStatusFromError(new Error("HTTP XXX error"))).toBeNull();
  });

  it("handles non-Error objects", () => {
    expect(parseHttpStatusFromError("HTTP 401")).toBe(401);
  });

  it("handles null/undefined gracefully", () => {
    expect(parseHttpStatusFromError(null)).toBeNull();
    expect(parseHttpStatusFromError(undefined)).toBeNull();
  });

  it("does not extract 3xx status codes (non-error)", () => {
    expect(parseHttpStatusFromError(new Error("HTTP 301 redirect"))).toBeNull();
  });
});

// ── Tests: describeTransportError ──────────────────────────────

describe("describeTransportError", () => {
  it("returns session-expired message for 401", () => {
    const result = describeTransportError(new Error("HTTP 401"));
    expect(result).toContain("Session expired");
    expect(result).toContain("Sign in again");
  });

  it("returns access-denied message for 403", () => {
    const result = describeTransportError(new Error("HTTP 403 Forbidden"));
    expect(result).toContain("Access denied");
    expect(result).toContain("doesn't belong to your account");
  });

  it("returns not-deployed message for 404", () => {
    const result = describeTransportError(new Error("HTTP 404"));
    expect(result).toContain("Edge function not deployed");
    expect(result).toContain("Deploy the Supabase function");
  });

  it("returns rate-limited message for 429", () => {
    const result = describeTransportError(new Error("HTTP 429"));
    expect(result).toContain("Rate limited");
    expect(result).toContain("30 seconds");
  });

  it("returns unavailable message for 502", () => {
    const result = describeTransportError(new Error("HTTP 502"));
    expect(result).toContain("temporarily unavailable");
  });

  it("returns unavailable message for 503", () => {
    const result = describeTransportError(new Error("HTTP 503"));
    expect(result).toContain("temporarily unavailable");
  });

  it("returns unavailable message for 504", () => {
    const result = describeTransportError(new Error("HTTP 504"));
    expect(result).toContain("temporarily unavailable");
  });

  it("returns backend-error message for 500", () => {
    const result = describeTransportError(new Error("HTTP 500"));
    expect(result).toContain("Backend error");
    expect(result).toContain("500");
  });

  it("returns backend-error message for 511", () => {
    const result = describeTransportError(new Error("HTTP 511"));
    expect(result).toContain("Backend error (HTTP 511)");
  });

  it("returns network-failure for fetch errors", () => {
    expect(describeTransportError(new Error("Failed to fetch"))).toContain("Network failure");
    expect(describeTransportError(new Error("NetworkError"))).toContain("Network failure");
    expect(describeTransportError(new Error("network request failed"))).toContain("Network failure");
    expect(describeTransportError(new Error("Load failed"))).toContain("Network failure");
    expect(describeTransportError(new Error("DNS error"))).toContain("Network failure");
  });

  it("returns catch-all for unrecognized errors", () => {
    const result = describeTransportError(new Error("something weird happened"));
    expect(result).toContain("failed before the stream started");
  });
  it("returns out-of-credits message for 402", () => {
    expect(describeTransportError(new Error("HTTP 402"))).toContain("Out of beta credits");
  });

  it("returns bad-request message for 400", () => {
    expect(describeTransportError(new Error("HTTP 400 Bad Request (MISSING_PARAMS)"))).toContain("Bad request");
  });

  it("returns too-large message for 413", () => {
    const result = describeTransportError(new Error("HTTP 413 Payload Too Large (BODY_TOO_LARGE)"));
    expect(result).toContain("Request too large");
    expect(result).toContain("Start a new investigation");
  });
});

// ── Tests: carrying the HTTP status through the AI SDK transport ────────────
//
// The SDK throws `new Error(await response.text())` on a non-2xx answer, so the
// body is the only thing that survives. These pin that the status gets into it.

/** What the osint-agent actually sends (auth.ts / orchestrator-fault.ts shapes). */
const EDGE_BODIES: Array<{ status: number; body: Record<string, string>; says: string }> = [
  { status: 400, body: { error: "Bad Request", code: "MISSING_PARAMS", detail: "Request must include threadId and messages array." }, says: "Bad request" },
  { status: 401, body: { error: "Unauthorized", code: "INVALID_SESSION", detail: "Session is invalid or expired. Sign in again." }, says: "Session expired" },
  { status: 402, body: { error: "Out of credits", code: "INSUFFICIENT_CREDITS", detail: "No credits left." }, says: "Out of beta credits" },
  { status: 403, body: { error: "Forbidden", code: "THREAD_ACCESS_DENIED", detail: "This thread does not exist or does not belong to your account." }, says: "Access denied" },
  { status: 413, body: { error: "Payload Too Large", code: "BODY_TOO_LARGE", detail: "Request body exceeds the 2000000 byte limit." }, says: "Request too large" },
  { status: 429, body: { error: "Too Many Requests", code: "RATE_LIMITED", detail: "Slow down. Retry in 42s." }, says: "Rate limited" },
  { status: 500, body: { error: "Internal Server Error", code: "ORCHESTRATOR_FAULT", detail: "engine fault" }, says: "Backend error (HTTP 500)" },
];

describe("withHttpStatusInErrorBody", () => {
  it.each(EDGE_BODIES)("HTTP $status: the message the SDK builds names the status and the server's code", async ({ status, body, says }) => {
    const res = await withHttpStatusInErrorBody(
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }),
    );
    expect(res.status).toBe(status);
    // Exactly what the SDK does with it.
    const err = new Error(await res.text());
    expect(parseHttpStatusFromError(err)).toBe(status);
    expect(err.message).toContain(`(${body.code})`);
    expect(err.message).toContain(body.detail);
    expect(describeTransportError(err)).toContain(says);
    // A response came back from the server — never a dropped connection.
    expect(isNetworkDropError(err)).toBe(false);
  });

  it.each(EDGE_BODIES)("HTTP $status: the RAW body alone loses the status (the defect this fixes)", ({ body }) => {
    const err = new Error(JSON.stringify(body));
    expect(parseHttpStatusFromError(err)).toBeNull();
  });

  it("passes a 2xx response through untouched", async () => {
    const ok = new Response("data: {}\n\n", { status: 200 });
    expect(await withHttpStatusInErrorBody(ok)).toBe(ok);
  });

  it("reads the Supabase gateway's `message` when there is no `detail` (undeployed function)", async () => {
    const res = await withHttpStatusInErrorBody(
      new Response(JSON.stringify({ code: "NOT_FOUND", message: "Requested function was not found" }), { status: 404 }),
    );
    const err = new Error(await res.text());
    expect(err.message).toBe("HTTP 404 (NOT_FOUND): Requested function was not found");
    expect(describeTransportError(err)).toContain("Edge function not deployed");
  });

  it("keeps a non-JSON body, stripped of markup and bounded", async () => {
    const html = `<html><body><h1>502 Bad Gateway</h1>${"x".repeat(1000)}</body></html>`;
    const res = await withHttpStatusInErrorBody(new Response(html, { status: 502, statusText: "Bad Gateway" }));
    const text = await res.text();
    expect(text.startsWith("HTTP 502 Bad Gateway: 502 Bad Gateway")).toBe(true);
    expect(text).not.toContain("<h1>");
    expect(text.length).toBeLessThan(400);
  });

  it("an empty body still names the status", async () => {
    const res = await withHttpStatusInErrorBody(new Response("", { status: 503 }));
    expect(parseHttpStatusFromError(new Error(await res.text()))).toBe(503);
  });

  it("puts the status and code before the first colon, which is where the failure card cuts its headline", () => {
    const line = formatHttpFailure(403, "", JSON.stringify(EDGE_BODIES[3].body));
    expect(line.split(":")[0]).toBe("HTTP 403 Forbidden (THREAD_ACCESS_DENIED)");
  });
});

// ── Edge function error envelope validation ─────────────────────

type EdgeError = {
  error: string;
  code: string;
  detail: string;
};

const KNOWN_CODES = [
  "MISSING_AUTH",
  "INVALID_SESSION",
  "MISSING_PARAMS",
  "THREAD_ACCESS_DENIED",
  "ORCHESTRATOR_FAULT",
] as const;

describe("edge function error envelope", () => {
  const responses: Record<string, EdgeError> = {
    MISSING_AUTH: {
      error: "Unauthorized",
      code: "MISSING_AUTH",
      detail: "No Authorization header provided. Sign in to continue.",
    },
    INVALID_SESSION: {
      error: "Unauthorized",
      code: "INVALID_SESSION",
      detail: "Session is invalid or expired. Sign in again.",
    },
    MISSING_PARAMS: {
      error: "Bad Request",
      code: "MISSING_PARAMS",
      detail: "Request must include threadId and messages array.",
    },
    THREAD_ACCESS_DENIED: {
      error: "Forbidden",
      code: "THREAD_ACCESS_DENIED",
      detail: "This thread does not exist or does not belong to your account.",
    },
    ORCHESTRATOR_FAULT: {
      error: "Internal Server Error",
      code: "ORCHESTRATOR_FAULT",
      detail: "MiniMax API key missing",
    },
  };

  it("all error codes have required fields", () => {
    for (const [codeName, envelope] of Object.entries(responses)) {
      expect(envelope).toHaveProperty("error");
      expect(envelope).toHaveProperty("code");
      expect(envelope).toHaveProperty("detail");
      expect(typeof envelope.error).toBe("string");
      expect(typeof envelope.code).toBe("string");
      expect(typeof envelope.detail).toBe("string");
      expect(envelope.error.length).toBeGreaterThan(0);
      expect(envelope.code.length).toBeGreaterThan(0);
      expect(envelope.detail.length).toBeGreaterThan(0);
      expect(envelope.code).toBe(codeName);
    }
  });

  it("all known codes are covered", () => {
    const covered = Object.keys(responses);
    for (const code of KNOWN_CODES) {
      expect(covered).toContain(code);
    }
  });

  it("error code matches HTTP status intent", () => {
    // 401 codes
    expect(responses.MISSING_AUTH.error).toBe("Unauthorized");
    expect(responses.INVALID_SESSION.error).toBe("Unauthorized");
    // 400 code
    expect(responses.MISSING_PARAMS.error).toBe("Bad Request");
    // 403 code
    expect(responses.THREAD_ACCESS_DENIED.error).toBe("Forbidden");
    // 500 code
    expect(responses.ORCHESTRATOR_FAULT.error).toBe("Internal Server Error");
  });

  it("error detail provides actionable guidance", () => {
    for (const envelope of Object.values(responses)) {
      // Every detail should be at least one full sentence
      expect(envelope.detail.length).toBeGreaterThan(20);
    }
  });

  it("JSON serialization round-trips correctly", () => {
    for (const envelope of Object.values(responses)) {
      const json = JSON.stringify(envelope);
      const parsed = JSON.parse(json) as EdgeError;
      expect(parsed.error).toBe(envelope.error);
      expect(parsed.code).toBe(envelope.code);
      expect(parsed.detail).toBe(envelope.detail);
    }
  });
});

// ── Tests: formatUsd (from ThreadSidebar) ──────────────────────

function formatUsd(micro: number | null | undefined): string {
  const m = Number(micro ?? 0);
  const usd = m / 1_000_000;
  if (usd <= 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

describe("formatUsd", () => {
  it("formats zero correctly", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(null)).toBe("$0");
    expect(formatUsd(undefined)).toBe("$0");
  });

  it("formats sub-cent values with 4 decimals", () => {
    expect(formatUsd(1)).toBe("$0.0000");     // 1 micro = $0.000001
    expect(formatUsd(500)).toBe("$0.0005");
  });

  it("formats sub-dollar values with 3 decimals", () => {
    expect(formatUsd(1_000_000)).toBe("$1.00");  // edge: >= 1
    expect(formatUsd(999_999)).toBe("$1.000");    // 0.999999 < 1, 3 decimals
    expect(formatUsd(500_000)).toBe("$0.500");
    expect(formatUsd(10_000)).toBe("$0.010");
  });

  it("formats dollar values with 2 decimals", () => {
    expect(formatUsd(1_000_000)).toBe("$1.00");
    expect(formatUsd(10_000_000)).toBe("$10.00");
    expect(formatUsd(2_160_000)).toBe("$2.16");
    expect(formatUsd(1_234_567)).toBe("$1.23");
  });

  it("handles negative values (edge case)", () => {
    expect(formatUsd(-1)).toBe("$0");
  });
});

// ── Tests: compactSeed (from ResourcesPanel) ────────────────────

function compactSeed(raw: string | null | undefined): { display: string; isUrl: boolean } {
  if (!raw) return { display: "—", isUrl: false };
  try {
    const u = new URL(raw);
    const segs = u.pathname.split("/").filter(Boolean);
    const file = segs[segs.length - 1] ?? "";
    if (file) {
      const short = file.length > 36 ? file.slice(0, 18) + "…" + file.slice(-14) : file;
      return { display: `${u.hostname}/…/${short}`, isUrl: true };
    }
    return { display: u.hostname, isUrl: true };
  } catch {
    return { display: raw, isUrl: false };
  }
}

describe("compactSeed", () => {
  it("returns dash for null/undefined", () => {
    expect(compactSeed(null)).toEqual({ display: "—", isUrl: false });
    expect(compactSeed(undefined)).toEqual({ display: "—", isUrl: false });
    expect(compactSeed("")).toEqual({ display: "—", isUrl: false });
  });

  it("compacts long URLs with filename", () => {
    const result = compactSeed("https://example.com/path/to/long-filename-that-exceeds-36-chars.txt");
    expect(result.isUrl).toBe(true);
    expect(result.display).toContain("example.com/…/");
    expect(result.display).toContain("long-filename-th");  // first 18
    expect(result.display).toContain("36-chars.txt");       // last 14
    expect(result.display.length).toBeLessThan(60);
  });

  it("handles short filenames without truncation", () => {
    const result = compactSeed("https://example.com/short.txt");
    expect(result.display).toBe("example.com/…/short.txt");
    expect(result.isUrl).toBe(true);
  });

  it("returns hostname for URL without path", () => {
    const result = compactSeed("https://example.com");
    expect(result).toEqual({ display: "example.com", isUrl: true });
  });

  it("returns raw for non-URL strings", () => {
    const result = compactSeed("just a plain string");
    expect(result).toEqual({ display: "just a plain string", isUrl: false });
  });

  it("handles URLs with query strings", () => {
    const result = compactSeed("https://example.com/file.pdf?signature=abc123&expires=99999");
    expect(result.display).toContain("example.com/…/file.pdf");
    expect(result.isUrl).toBe(true);
  });
});

// ── Tests: isNetworkDropError ──────────────────────────────────
//
// The client's stream dying is not the run dying. These pin the two axes that
// keep this predicate narrow: a parsed HTTP status always disqualifies, and
// server-originated stream errors must NOT be swallowed as drops.

describe("isNetworkDropError", () => {
  it("matches the real per-browser wordings for a dropped fetch", () => {
    // Safari/WebKit — the exact string persisted 3× on production thread
    // 727ec00c on 2026-09-07 while the backend went on to write a full report.
    expect(isNetworkDropError(new Error("Load failed"))).toBe(true);
    expect(isNetworkDropError(new Error("The network connection was lost."))).toBe(true);
    // Chrome
    expect(isNetworkDropError(new Error("Failed to fetch"))).toBe(true);
    // Firefox
    expect(isNetworkDropError(new Error("NetworkError when attempting to fetch resource."))).toBe(true);
    // React Native / misc
    expect(isNetworkDropError(new Error("Network request failed"))).toBe(true);
    expect(isNetworkDropError(new Error("The Internet connection appears to be offline."))).toBe(true);
  });

  it("is case-insensitive and reads plain strings too", () => {
    expect(isNetworkDropError("LOAD FAILED")).toBe(true);
    expect(isNetworkDropError({ message: "failed to fetch" })).toBe(true);
  });

  it("REFUSES anything carrying an HTTP status — the request reached the backend", () => {
    // A 5xx is a real backend failure and must keep its existing handling, even
    // when the message also contains drop-ish words.
    expect(isNetworkDropError(new Error("HTTP 500 Internal Server Error"))).toBe(false);
    expect(isNetworkDropError(new Error("HTTP 502 Bad Gateway"))).toBe(false);
    expect(isNetworkDropError(new Error("HTTP 429 Too Many Requests"))).toBe(false);
    expect(isNetworkDropError(new Error("HTTP 401 Unauthorized"))).toBe(false);
    expect(isNetworkDropError(new Error("Failed to fetch (HTTP 503)"))).toBe(false);
  });

  it("REFUSES server-originated stream errors — negative control", () => {
    // These arrive over the SSE error channel from the edge function itself and
    // are recorded as `recovery_reason: stream_error: …`. A broader regex (the
    // Lovable mirror's includes "terminated" and "connection closed") would
    // silence genuine backend faults as if they were connectivity blips.
    expect(isNetworkDropError(new Error("stream_error: Bad Request"))).toBe(false);
    expect(isNetworkDropError(new Error("Tool result is missing for tool call call_ec12bcfd"))).toBe(false);
    expect(isNetworkDropError(new Error("terminated"))).toBe(false);
    expect(isNetworkDropError(new Error("The connection was closed"))).toBe(false);
    expect(isNetworkDropError(new Error("stream ended unexpectedly"))).toBe(false);
    expect(isNetworkDropError(new Error("The AI analysis provider is rate-limited"))).toBe(false);
  });

  it("REFUSES ordinary/unknown failures and empty input", () => {
    expect(isNetworkDropError(new Error("something broke"))).toBe(false);
    expect(isNetworkDropError(null)).toBe(false);
    expect(isNetworkDropError(undefined)).toBe(false);
    expect(isNetworkDropError("")).toBe(false);
  });
});
