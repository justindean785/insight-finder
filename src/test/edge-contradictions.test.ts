import { describe, it, expect } from "vitest";
import { detectContradictions } from "../../supabase/functions/osint-agent/contradictions.ts";

type A = Parameters<typeof detectContradictions>[0][number];
const art = (over: Partial<A>): A => ({ kind: "other", value: "v", ...over });

describe("detectContradictions", () => {
  it("returns nothing for a clean, consistent cluster", () => {
    const found = detectContradictions([
      art({ kind: "name", value: "Jane Doe" }),
      art({ kind: "email", value: "jane@doe.com" }),
    ]);
    expect(found).toEqual([]);
  });

  it("flags conflicting locations as high severity", () => {
    const found = detectContradictions([
      art({ value: "a", metadata: { location: "Berlin" } }),
      art({ value: "b", metadata: { city: "Tokyo" } }),
    ]);
    const c = found.find((f) => f.kind === "location_conflict");
    expect(c?.severity).toBe("high");
    expect(c?.involved).toEqual(expect.arrayContaining(["a", "b"]));
  });

  it("flags multiple employers", () => {
    const found = detectContradictions([
      art({ metadata: { employer: "Acme" } }),
      art({ metadata: { company: "Globex" } }),
    ]);
    expect(found.some((f) => f.kind === "employer_conflict")).toBe(true);
  });

  it("flags an extremely common handle", () => {
    const found = detectContradictions([art({ kind: "username", value: "admin" })]);
    expect(found.some((f) => f.kind === "common_handle_collision")).toBe(true);
  });

  it("flags a single-token (thin) name", () => {
    const found = detectContradictions([art({ kind: "name", value: "Madonna" })]);
    const c = found.find((f) => f.kind === "thin_name");
    expect(c?.severity).toBe("low");
  });

  it("flags an IP on shared CDN infrastructure", () => {
    const found = detectContradictions([
      art({ kind: "ip", value: "1.2.3.4", metadata: { asn_org: "Cloudflare Inc" } }),
    ]);
    const c = found.find((f) => f.kind === "cdn_shared_infra");
    expect(c?.severity).toBe("high");
  });

  it("flags stale breach data older than 5 years", () => {
    const found = detectContradictions([
      art({ kind: "breach", value: "old@leak.com", metadata: { breach_date: "2015-01-01" } }),
    ]);
    expect(found.some((f) => f.kind === "stale_breach")).toBe(true);
  });

  it("does not flag a recent breach", () => {
    const recent = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const found = detectContradictions([
      art({ kind: "breach", value: "x", metadata: { breach_date: recent } }),
    ]);
    expect(found.some((f) => f.kind === "stale_breach")).toBe(false);
  });

  it("ignores an unparseable breach date", () => {
    const found = detectContradictions([
      art({ kind: "breach", value: "x", metadata: { breach_date: "not-a-date" } }),
    ]);
    expect(found.some((f) => f.kind === "stale_breach")).toBe(false);
  });
});
