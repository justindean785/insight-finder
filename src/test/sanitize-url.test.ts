import { describe, it, expect } from "vitest";
import { sanitizeUrl, capString, MAX_URL_LEN } from "@/lib/telemetry";

describe("sanitizeUrl — never persist auth/token material (issue #67)", () => {
  it("drops OAuth PKCE code + state from the query, keeps origin+path", () => {
    const out = sanitizeUrl("https://app.example.com/auth?code=abc123&state=xyz789");
    expect(out).toBe("https://app.example.com/auth");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("xyz789");
  });

  it("drops the fragment wholesale (Supabase implicit-flow tokens live there)", () => {
    const out = sanitizeUrl(
      "https://app.example.com/#access_token=eyJ.aaa.bbb&refresh_token=rrr&expires_in=3600&token_type=bearer",
    );
    expect(out).toBe("https://app.example.com/");
    expect(out).not.toContain("eyJ.aaa.bbb");
    expect(out).not.toContain("rrr");
  });

  it("strips a password-recovery fragment", () => {
    const out = sanitizeUrl("https://app.example.com/auth#access_token=secret&type=recovery");
    expect(out).toBe("https://app.example.com/auth");
    expect(out).not.toContain("secret");
  });

  it("keeps harmless query context for triage", () => {
    expect(sanitizeUrl("https://app.example.com/case/42?tab=evidence&sort=newest")).toBe(
      "https://app.example.com/case/42?tab=evidence&sort=newest",
    );
  });

  it("strips token/secret/session-shaped params it wasn't explicitly told about", () => {
    const out = sanitizeUrl(
      "https://app.example.com/x?tab=ok&sessionId=s1&api_key=k1&csrf_token=t1&jwt=j1",
    );
    expect(out).toContain("tab=ok");
    expect(out).not.toContain("s1");
    expect(out).not.toContain("k1");
    expect(out).not.toContain("t1");
    expect(out).not.toContain("j1");
  });

  it("removes sensitive params even when mixed with a fragment", () => {
    const out = sanitizeUrl("https://app.example.com/p?keep=1&token=zzz#access_token=fff");
    expect(out).toBe("https://app.example.com/p?keep=1");
  });

  it("truncates an over-long URL to the cap", () => {
    const long = "https://app.example.com/" + "a".repeat(5000);
    const out = sanitizeUrl(long);
    expect(out.length).toBe(MAX_URL_LEN);
  });

  it("handles a non-URL string by dropping everything after the first ? or #", () => {
    expect(sanitizeUrl("not a url ? token=abc")).toBe("not a url ");
    expect(sanitizeUrl("garbage#access_token=abc")).toBe("garbage");
  });

  it("passes through empty input unchanged", () => {
    expect(sanitizeUrl("")).toBe("");
  });
});

describe("capString — bound persisted field sizes", () => {
  it("returns short strings unchanged", () => {
    expect(capString("hello", 100)).toBe("hello");
  });
  it("truncates and marks long strings", () => {
    const out = capString("x".repeat(50), 10);
    expect(out).toBe("xxxxxxxxxx…[+40 chars]");
  });
  it("maps null/undefined to undefined", () => {
    expect(capString(null, 10)).toBeUndefined();
    expect(capString(undefined, 10)).toBeUndefined();
  });
});
