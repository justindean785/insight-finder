import { describe, it, expect } from "vitest";
import { hashSourceNode, hashSourceWeb } from "@/lib/audit/report-hash";

describe("report-hash", () => {
  it("returns 64-char lowercase hex", async () => {
    expect(await hashSourceNode("abc")).toMatch(/^[a-f0-9]{64}$/);
    expect(await hashSourceWeb("abc")).toMatch(/^[a-f0-9]{64}$/);
  });

  it("matches the known SHA-256 of 'abc'", async () => {
    const known = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    expect(await hashSourceNode("abc")).toBe(known);
    expect(await hashSourceWeb("abc")).toBe(known);
  });

  // The whole point of the split: a fingerprint computed in CI (Node) must verify
  // against one computed in the browser (Web Crypto). If these ever diverge,
  // chain-of-custody is no longer environment-stable.
  it("Node and Web paths produce identical digests", async () => {
    const inputs = [
      "abc",
      "",
      "S1|https://leakcheck.io/x|2026-06-07T18:00:00Z",
      "unicode → ✓ café",
    ];
    for (const input of inputs) {
      expect(await hashSourceWeb(input)).toBe(await hashSourceNode(input));
    }
  });
});
