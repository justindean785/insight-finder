/**
 * provider-401-not-session — a provider rejecting ITS key mid-stream is not the analyst's
 * session expiring. Measured 2026-10-14: a revoked ANTHROPIC_API_KEY made every scan sign
 * the operator out, because the bare-number status fallback read "(401)" out of the
 * classifier's fixed text.
 */
import { describe, it, expect } from "vitest";
import { describeTransportError, isTransportAuthFailure, parseHttpStatusFromError } from "@/lib/tool-run";

const PROVIDER_401 = "Anthropic rejected the API key (401). Your partial results were saved. An operator needs to check ANTHROPIC_API_KEY.";
const BACKEND_401 = "HTTP 401 Unauthorized (INVALID_SESSION): Session is invalid or expired. Sign in again.";

describe("a provider 401 is not the analyst's session", () => {
  it("the bare-number parser still sees 401 in the provider text (that is the trap)", () => {
    expect(parseHttpStatusFromError(new Error(PROVIDER_401))).toBe(401);
  });

  it("only the backend's own pre-stream 401 counts as an auth failure", () => {
    expect(isTransportAuthFailure(new Error(BACKEND_401))).toBe(true);
    expect(isTransportAuthFailure("  HTTP 401 Unauthorized")).toBe(true);
    expect(isTransportAuthFailure(new Error(PROVIDER_401))).toBe(false);
    expect(isTransportAuthFailure(new Error("Provider returned HTTP 401 upstream"))).toBe(false);
    expect(isTransportAuthFailure(new Error("HTTP 403 Forbidden"))).toBe(false);
    expect(isTransportAuthFailure(null)).toBe(false);
  });

  it("the friendly text never says 'Session expired' for a provider 401, and still does for the backend's", () => {
    expect(describeTransportError(new Error(BACKEND_401))).toMatch(/^Session expired/);
    const provider = describeTransportError(new Error(PROVIDER_401));
    expect(provider).not.toMatch(/Session expired/);
    expect(provider).toMatch(/provider rejected its API key/);
    expect(provider).toMatch(/not your login/);
  });
});
