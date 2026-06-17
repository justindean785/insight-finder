import { describe, it, expect } from "vitest";
import { functionsBaseUrl, osintAgentUrl } from "../lib/functionsUrl";

describe("osintAgentUrl — never doubles /functions/v1", () => {
  it("builds the single correct path from a plain Supabase URL", () => {
    expect(osintAgentUrl("https://abc.supabase.co")).toBe(
      "https://abc.supabase.co/functions/v1/osint-agent",
    );
  });

  it("strips a trailing /functions/v1 (the doubled-404 footgun)", () => {
    expect(osintAgentUrl("https://abc.supabase.co/functions/v1")).toBe(
      "https://abc.supabase.co/functions/v1/osint-agent",
    );
    expect(osintAgentUrl("https://abc.supabase.co/functions/v1/")).toBe(
      "https://abc.supabase.co/functions/v1/osint-agent",
    );
    expect(osintAgentUrl("https://abc.supabase.co/functions")).toBe(
      "https://abc.supabase.co/functions/v1/osint-agent",
    );
  });

  it("trims trailing slashes", () => {
    expect(osintAgentUrl("https://abc.supabase.co/")).toBe(
      "https://abc.supabase.co/functions/v1/osint-agent",
    );
  });

  it("falls back to project id", () => {
    expect(osintAgentUrl(undefined, "abc")).toBe(
      "https://abc.supabase.co/functions/v1/osint-agent",
    );
    expect(functionsBaseUrl(undefined, "abc")).toBe("https://abc.supabase.co");
  });

  it("returns empty string when nothing is configured", () => {
    expect(osintAgentUrl(undefined, undefined)).toBe("");
    expect(osintAgentUrl("", "")).toBe("");
  });
});
