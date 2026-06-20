import { describe, it, expect } from "vitest";
import { functionsBaseUrl, osintAgentUrl, edgeFunctionUrl } from "../lib/functionsUrl";

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

describe("edgeFunctionUrl — generic, same anti-doubling defense", () => {
  it("builds an arbitrary function path", () => {
    expect(edgeFunctionUrl("evidence-export", "https://abc.supabase.co")).toBe(
      "https://abc.supabase.co/functions/v1/evidence-export",
    );
  });

  it("strips a trailing /functions/v1 so evidence-export can't double it", () => {
    expect(edgeFunctionUrl("evidence-export", "https://abc.supabase.co/functions/v1")).toBe(
      "https://abc.supabase.co/functions/v1/evidence-export",
    );
  });

  it("falls back to project id and returns '' when unconfigured", () => {
    expect(edgeFunctionUrl("evidence-export", undefined, "abc")).toBe(
      "https://abc.supabase.co/functions/v1/evidence-export",
    );
    expect(edgeFunctionUrl("evidence-export", undefined, undefined)).toBe("");
  });
});
