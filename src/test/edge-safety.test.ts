import { describe, it, expect } from "vitest";
import {
  scrubArtifactRow,
  normalizeForHash,
  hashInput,
  sanitizeToolOutput,
  isPrivateHost,
  assertSafeUrl,
  capPartsSize,
  REDACTED,
} from "../../supabase/functions/osint-agent/safety.ts";

// Tests run against the REAL edge module. These are security-critical:
// SSRF blocking, PII/credential redaction, and minor-safety scrubbing.

describe("isPrivateHost (SSRF guard)", () => {
  it("blocks loopback / internal hostnames", () => {
    expect(isPrivateHost("localhost")).toBe(true);
    expect(isPrivateHost("foo.localhost")).toBe(true);
    expect(isPrivateHost("svc.internal")).toBe(true);
    expect(isPrivateHost("::1")).toBe(true);
  });

  it("blocks RFC1918 + loopback + 0.0.0.0 IPv4 ranges", () => {
    expect(isPrivateHost("10.1.2.3")).toBe(true);
    expect(isPrivateHost("127.0.0.1")).toBe(true);
    expect(isPrivateHost("0.0.0.0")).toBe(true);
    expect(isPrivateHost("172.16.5.5")).toBe(true);
    expect(isPrivateHost("172.31.255.255")).toBe(true);
    expect(isPrivateHost("192.168.0.1")).toBe(true);
  });

  it("blocks the 169.254 link-local / cloud metadata range", () => {
    expect(isPrivateHost("169.254.169.254")).toBe(true);
  });

  it("blocks multicast / reserved (>=224)", () => {
    expect(isPrivateHost("239.0.0.1")).toBe(true);
    expect(isPrivateHost("255.255.255.255")).toBe(true);
  });

  it("allows public hosts and 172.x outside the private block", () => {
    expect(isPrivateHost("example.com")).toBe(false);
    expect(isPrivateHost("8.8.8.8")).toBe(false);
    expect(isPrivateHost("172.15.0.1")).toBe(false);
    expect(isPrivateHost("172.32.0.1")).toBe(false);
  });
});

describe("assertSafeUrl", () => {
  it("returns a URL for safe public https/http", () => {
    expect(assertSafeUrl("https://example.com/path").hostname).toBe("example.com");
    expect(assertSafeUrl("http://example.com").protocol).toBe("http:");
  });

  it("blocks non-http(s) protocols", () => {
    expect(() => assertSafeUrl("file:///etc/passwd")).toThrow(/blocked: protocol/);
    expect(() => assertSafeUrl("ftp://example.com")).toThrow(/blocked: protocol/);
  });

  it("blocks private/internal hosts", () => {
    expect(() => assertSafeUrl("http://169.254.169.254/latest/meta-data")).toThrow(/private\/internal/);
    expect(() => assertSafeUrl("http://localhost:8080")).toThrow(/private\/internal/);
  });

  it("throws on a malformed URL", () => {
    expect(() => assertSafeUrl("not a url")).toThrow();
  });
});

describe("sanitizeToolOutput", () => {
  it("redacts our own auth material by key", () => {
    const out = sanitizeToolOutput({ token: "abc", api_key: "k", authorization: "Bearer x", name: "Jo" });
    expect(out).toEqual({ token: REDACTED, api_key: REDACTED, authorization: REDACTED, name: "Jo" });
  });

  it("does NOT redact investigation-target fields (password/ssn/dob)", () => {
    const out = sanitizeToolOutput({ password: "hunter2", ssn: "111-22-3333", dob: "2000-01-01" });
    expect(out).toEqual({ password: "hunter2", ssn: "111-22-3333", dob: "2000-01-01" });
  });

  it("truncates long strings to maxStr", () => {
    const out = sanitizeToolOutput("x".repeat(50), 10) as string;
    expect(out.startsWith("xxxxxxxxxx")).toBe(true);
    expect(out.endsWith("…[truncated]")).toBe(true);
  });

  it("caps arrays at 200 elements and recurses", () => {
    const out = sanitizeToolOutput(Array.from({ length: 500 }, (_, i) => i)) as number[];
    expect(out.length).toBe(200);
  });

  it("stops recursion past depth 8", () => {
    let nested: Record<string, unknown> = { v: "leaf" };
    for (let i = 0; i < 12; i++) nested = { child: nested };
    const out = sanitizeToolOutput(nested);
    // Walk down; deep nodes collapse to the REDACTED sentinel.
    expect(JSON.stringify(out)).toContain(REDACTED);
  });
});

describe("scrubArtifactRow (minor-safety)", () => {
  it("flags an explicit age cue in bio metadata and caps confidence", () => {
    const row = scrubArtifactRow({ kind: "name", value: "x", confidence: 90, metadata: { bio: "i'm 14 and love art" } });
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.possible_minor).toBe(true);
    expect(meta.sensitive).toBe(true);
    expect(meta.auto_pivot_blocked).toBe(true);
    expect(row.confidence).toBeLessThanOrEqual(25);
  });

  it("flags minor phrases", () => {
    const row = scrubArtifactRow({ kind: "username", value: "high school sophomore", confidence: 80, metadata: {} });
    expect((row.metadata as Record<string, unknown>).possible_minor).toBe(true);
  });

  it("leaves adult / neutral rows untouched", () => {
    const row = scrubArtifactRow({ kind: "name", value: "Jane Doe", confidence: 88, metadata: { bio: "software engineer" } });
    const meta = row.metadata as Record<string, unknown>;
    expect(meta.possible_minor).toBeUndefined();
    expect(row.confidence).toBe(88);
  });
});

describe("normalizeForHash / hashInput", () => {
  it("lowercases + trims strings and sorts object keys deterministically", () => {
    expect(normalizeForHash({ b: " HELLO ", a: ["X", "y"] })).toEqual({ a: ["x", "y"], b: "hello" });
  });

  it("produces identical hashes regardless of key order / casing", async () => {
    const h1 = await hashInput({ a: "Foo", b: "Bar" });
    const h2 = await hashInput({ b: "bar", a: "foo" });
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different hashes for different content", async () => {
    expect(await hashInput("a")).not.toBe(await hashInput("b"));
  });
});

describe("capPartsSize", () => {
  it("returns parts unchanged when under budget", () => {
    const parts = [{ type: "text", text: "hi" }];
    expect(capPartsSize(parts, 10_000)).toBe(parts);
  });

  it("strips raw/per_source from tool-result output when over budget", () => {
    const big = "z".repeat(5000);
    const parts = [{ type: "tool-result", toolCallId: "1", toolName: "t", output: { raw: big, kept: "ok" } }];
    const out = capPartsSize(parts, 1000) as Array<Record<string, unknown>>;
    const output = out[0].output as Record<string, unknown>;
    expect(output.raw).toBeUndefined();
    expect(output.kept).toBe("ok");
  });

  it("stubs oversized tool-results as a last resort", () => {
    const huge = "q".repeat(200_000);
    const parts = [{ type: "tool-result", toolCallId: "1", toolName: "t", output: { notes: huge } }];
    const out = capPartsSize(parts, 1000) as Array<Record<string, unknown>>;
    expect((out[0].output as Record<string, unknown>).truncated).toBe(true);
  });
});
