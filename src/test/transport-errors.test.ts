import { describe, it, expect } from "vitest";
import { describeTransportError, parseHttpStatusFromError } from "@/lib/tool-run";

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
