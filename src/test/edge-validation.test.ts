import { describe, it, expect } from "vitest";
import {
  detectSeedServer,
  shannonEntropy,
  validateArtifact,
  EMAIL_RE,
  DOMAIN_RE,
  IPV4_RE,
  NAME_RE,
  PHONE_RE,
} from "../../supabase/functions/osint-agent/validation.ts";

// Tests run against the REAL edge module (pure TS, no Deno-only deps) rather
// than an inline copy, so production drift is caught.

describe("detectSeedServer", () => {
  it("returns null for empty / whitespace input", () => {
    expect(detectSeedServer("")).toBeNull();
    expect(detectSeedServer("   ")).toBeNull();
  });

  it("detects and normalizes email (lowercases, strips +tag)", () => {
    expect(detectSeedServer("Foo.Bar+spam@Example.COM")).toEqual({
      kind: "email",
      raw: "Foo.Bar+spam@Example.COM",
      normalized: "foo.bar@example.com",
    });
  });

  it("detects url and normalizes scheme/host, dropping trailing slash", () => {
    const r = detectSeedServer("HTTPS://Example.com/Path/");
    expect(r?.kind).toBe("url");
    expect(r?.normalized).toBe("https://example.com/Path");
  });

  it("detects bare IPv4", () => {
    expect(detectSeedServer("8.8.8.8")).toMatchObject({ kind: "ip", normalized: "8.8.8.8" });
  });

  it("detects crypto wallets (eth + btc) and lowercases them", () => {
    expect(detectSeedServer("0x" + "a".repeat(40)).kind).toBe("crypto");
    expect(detectSeedServer("0x" + "A".repeat(40)).normalized).toBe("0x" + "a".repeat(40));
    expect(detectSeedServer("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4").kind).toBe("crypto");
  });

  it("detects phone and strips formatting", () => {
    expect(detectSeedServer("+1 (415) 555-1234")).toMatchObject({
      kind: "phone",
      normalized: "+14155551234",
    });
  });

  it("detects domain", () => {
    expect(detectSeedServer("Example.co.uk")).toMatchObject({ kind: "domain", normalized: "example.co.uk" });
  });

  it("detects a bare username", () => {
    expect(detectSeedServer("cool_user.99")).toMatchObject({ kind: "username", normalized: "cool_user.99" });
  });

  it("detects a multi-word person seed and collapses whitespace/commas", () => {
    expect(detectSeedServer("Josh Gillman, Rocklin  CA")).toEqual({
      kind: "person",
      raw: "Josh Gillman, Rocklin  CA",
      normalized: "josh gillman rocklin ca",
    });
  });

  it("falls back to `other` for unclassifiable input", () => {
    expect(detectSeedServer("???!!!").kind).toBe("other");
  });

  it("prefers email over the username/person heuristics", () => {
    expect(detectSeedServer("a@b.com").kind).toBe("email");
  });
});

describe("shannonEntropy", () => {
  it("is 0 for a single repeated character", () => {
    expect(shannonEntropy("aaaa")).toBe(0);
  });

  it("is 1 bit for a two-symbol balanced string", () => {
    expect(shannonEntropy("abab")).toBeCloseTo(1, 10);
  });

  it("is higher for more diverse strings", () => {
    expect(shannonEntropy("abcd")).toBeGreaterThan(shannonEntropy("aabb"));
  });

  it("does not divide by zero on empty input", () => {
    expect(shannonEntropy("")).toBe(0);
  });
});

describe("validation regexes", () => {
  it("EMAIL_RE accepts valid and rejects malformed", () => {
    expect(EMAIL_RE.test("user@example.com")).toBe(true);
    expect(EMAIL_RE.test("user@example")).toBe(false); // no TLD dot
    expect(EMAIL_RE.test("no-at-sign.com")).toBe(false);
  });

  it("DOMAIN_RE accepts hostnames and rejects schemes/paths", () => {
    expect(DOMAIN_RE.test("sub.example.com")).toBe(true);
    expect(DOMAIN_RE.test("example")).toBe(false);
    expect(DOMAIN_RE.test("http://example.com")).toBe(false);
  });

  it("IPV4_RE enforces octet ranges", () => {
    expect(IPV4_RE.test("192.168.1.1")).toBe(true);
    expect(IPV4_RE.test("256.1.1.1")).toBe(false);
    expect(IPV4_RE.test("1.2.3")).toBe(false);
  });

  it("NAME_RE accepts unicode names and rejects digits", () => {
    expect(NAME_RE.test("José O'Brien-Smith")).toBe(true);
    expect(NAME_RE.test("Agent007")).toBe(false);
  });

  it("PHONE_RE accepts formatted numbers", () => {
    expect(PHONE_RE.test("+1 (415) 555-1234")).toBe(true);
    expect(PHONE_RE.test("abc")).toBe(false);
  });
});

describe("validateArtifact", () => {
  it("rejects empty values", () => {
    expect(validateArtifact("email", "   ")).toEqual({ ok: false, reason: "empty value" });
  });

  it("rejects values over 2000 chars", () => {
    const r = validateArtifact("other", "x".repeat(2001));
    expect(r.ok).toBe(false);
  });

  it("lowercases and accepts a valid email", () => {
    expect(validateArtifact("email", "User@Example.COM")).toEqual({
      ok: true,
      kind: "email",
      value: "user@example.com",
    });
  });

  it("rejects an invalid email", () => {
    expect(validateArtifact("email", "not-an-email").ok).toBe(false);
  });

  it("strips scheme/path from a domain", () => {
    expect(validateArtifact("domain", "https://Example.com/login")).toEqual({
      ok: true,
      kind: "domain",
      value: "example.com",
    });
  });

  it("validates IPv4 and rejects bad IPs", () => {
    expect(validateArtifact("ip", "10.0.0.1").ok).toBe(true);
    expect(validateArtifact("ip", "999.1.1.1").ok).toBe(false);
  });

  it("normalizes a username (strips @, lowercases) and rejects whitespace", () => {
    expect(validateArtifact("username", "@CoolUser")).toEqual({
      ok: true,
      kind: "username",
      value: "cooluser",
    });
    expect(validateArtifact("username", "two words").ok).toBe(false);
  });

  it("reclassifies a social-reference name into a username", () => {
    const r = validateArtifact("name", "deantecarson on Instagram");
    expect(r).toMatchObject({ ok: true, kind: "username", value: "deantecarson" });
    if (r.ok) expect((r.metaPatch as Record<string, unknown>)?.platforms).toEqual(["instagram"]);
  });

  it("strips a platform parenthetical from a name and records the hint", () => {
    const r = validateArtifact("name", "Prince (Twitter display name)");
    expect(r).toMatchObject({ ok: true, kind: "name", value: "Prince" });
  });

  it("reclassifies a case caption to `case`", () => {
    const r = validateArtifact("other", "United States v. John Doe");
    expect(r).toMatchObject({ ok: true, kind: "case" });
    if (r.ok) expect((r.metaPatch as Record<string, unknown>)?.reclassified_from).toBe("other");
  });

  it("reclassifies a subdomain shape", () => {
    const r = validateArtifact("other", "crm.example.com");
    expect(r).toMatchObject({ ok: true, kind: "subdomain", value: "crm.example.com" });
  });

  it("reclassifies an organization shape", () => {
    const r = validateArtifact("other", "Acme Holdings Inc.");
    expect(r).toMatchObject({ ok: true, kind: "organization" });
  });

  it("drops a high-entropy opaque blob in `other`", () => {
    const blob = "aGVsbG8gd29ybGQ" + "QWxhZGRpbjpvcGVuIHNlc2FtZQ".repeat(6);
    const r = validateArtifact("other", blob);
    expect(r.ok).toBe(false);
  });

  it("rejects narrative text masquerading as `other`", () => {
    const r = validateArtifact("other", "Check this out. it reads like prose here.");
    expect(r.ok).toBe(false);
  });

  it("accepts strict-passthrough kinds and caps their length", () => {
    expect(validateArtifact("alias", "Shadow").ok).toBe(true);
    expect(validateArtifact("alias", "x".repeat(501)).ok).toBe(false);
  });

  it("coerces an unknown kind to `other` keeping the original kind hint", () => {
    const r = validateArtifact("mystery", "abc");
    expect(r).toMatchObject({ ok: true, kind: "other" });
    if (r.ok) expect((r.metaPatch as Record<string, unknown>)?.original_kind).toBe("mystery");
  });

  it("promotes a `person` that parses as a real name to `name`", () => {
    expect(validateArtifact("person", "Jane Doe")).toEqual({ ok: true, kind: "name", value: "Jane Doe" });
  });
});
