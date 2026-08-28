import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  detectSeed,
  extractDisplaySeed,
  formatThreadTitle,
  looksLikePostalAddress,
  normalizeAddressValue,
} from "@/lib/seed";

/**
 * Client half of the address-seed routing fix.
 *
 * The client detector computes the cache key the edge function looks an
 * investigation up by, and src/lib/seed.ts's own comment says it must mirror
 * server detection — but it had no `address` kind at all, so
 *
 *     79 WAVERLY AVE
 *     CINCINNATI OH, 45215
 *
 * came back as `other` on both sides for two different reasons.
 *
 * These tests drive the real exported functions. The last block reads
 * supabase/functions/osint-agent/address.ts as text (it is Deno-targeted and
 * cannot be imported from vitest — the same approach catalog-guidance.test.ts
 * uses) and asserts the two normalizers still agree character for character.
 */

const MULTILINE_SEED = "79 WAVERLY AVE\nCINCINNATI OH, 45215";
const CACHE_KEY = "79 waverly ave cincinnati oh 45215";

describe("client seed detection — address", () => {
  it("detects the exact multiline/comma Cincinnati input as an address", () => {
    const d = detectSeed(MULTILINE_SEED);
    expect(d?.kind).toBe("address");
    expect(d?.raw).toBe(MULTILINE_SEED);
    expect(d?.normalized).toBe(CACHE_KEY);
  });

  it("keeps a normal one-line address an address", () => {
    for (const line of [
      "79 Waverly Ave, Cincinnati, OH 45215",
      "79 Waverly Ave Cincinnati OH 45215",
      "1600 Pennsylvania Ave NW Washington DC 20500",
      "742 Evergreen Terrace, Springfield, OR 97477-1234",
    ]) {
      expect(detectSeed(line)?.kind, line).toBe("address");
    }
  });

  it("collapses every punctuation/line layout to one cache key", () => {
    for (const variant of [
      MULTILINE_SEED,
      "79 Waverly Ave, Cincinnati, OH 45215",
      "79 Waverly Ave  Cincinnati   OH 45215",
      "79 WAVERLY AVE\nCINCINNATI, OH 45215",
    ]) {
      expect(detectSeed(variant)?.normalized, variant).toBe(CACHE_KEY);
    }
  });

  it("does not sweep non-addresses into the address kind", () => {
    expect(detectSeed("example.com")?.kind).toBe("domain");
    expect(detectSeed("casey.rivera@example.com")?.kind).toBe("email");
    expect(detectSeed("8.8.8.8")?.kind).toBe("ip");
    expect(detectSeed("caseyrivera")?.kind).toBe("username");
    expect(detectSeed("just some free text here")?.kind).toBe("other");
  });

  it("preserves the raw value for display while normalizing for the cache key", () => {
    const d = detectSeed("79 Waverly Ave, Cincinnati, OH 45215");
    expect(d?.raw).toBe("79 Waverly Ave, Cincinnati, OH 45215");
    expect(d?.normalized).toBe(CACHE_KEY);
  });

  it("requires a real USPS state code, not any two letters", () => {
    // A street suffix alone ("St") or a made-up two-letter token must not be
    // accepted as the state — see mem/architecture/address-seed-google-dork-
    // cross-layer-mismatch.md for why an unconstrained [A-Za-z]{2} regressed.
    expect(detectSeed("123 Main St 90210")?.kind).not.toBe("address");
    expect(detectSeed("42 Oak Rd 10001")?.kind).not.toBe("address");
    expect(detectSeed("5 AB CD 12345")?.kind).not.toBe("address");
    expect(detectSeed("1 Judiciary Sq NW, Washington, DC 20001")?.kind).toBe("address");
  });
});

describe("client display seed — address", () => {
  it("shows the whole address instead of only its first line", () => {
    // Before the fix the two-line value fell through to the blob fallback and
    // the report header read "Selector: 79 WAVERLY AVE".
    const d = extractDisplaySeed(MULTILINE_SEED, "other");
    expect(d.kind).toBe("address");
    expect(d.selector).toBe("79 WAVERLY AVE CINCINNATI OH, 45215");
  });

  it("labels an address thread as an Address", () => {
    expect(formatThreadTitle(MULTILINE_SEED)).toContain("Address:");
  });
});

describe("address normalizer", () => {
  it("recognises addresses and rejects non-addresses", () => {
    expect(looksLikePostalAddress(MULTILINE_SEED)).toBe(true);
    expect(looksLikePostalAddress("79 Waverly Ave, Cincinnati, OH 45215")).toBe(true);
    expect(looksLikePostalAddress("example.com")).toBe(false);
    expect(looksLikePostalAddress("")).toBe(false);
    expect(looksLikePostalAddress(null)).toBe(false);
  });

  it("drops punctuation that carries no meaning", () => {
    expect(normalizeAddressValue("79 Waverly Ave., Cincinnati, OH 45215")).toBe(CACHE_KEY);
  });
});

describe("client ↔ server address parity", () => {
  const SERVER = fs.readFileSync(
    path.resolve(process.cwd(), "supabase/functions/osint-agent/address.ts"),
    "utf-8",
  );
  const CLIENT = fs.readFileSync(
    path.resolve(process.cwd(), "src/lib/seed.ts"),
    "utf-8",
  );

  const body = (src: string, name: string) =>
    src
      .match(new RegExp(`export function ${name}\\([^]*?\\n\\}`))?.[0]
      // strip the signature and every comment/whitespace difference
      .replace(new RegExp(`export function ${name}\\([^)]*\\)[^{]*\\{`), "")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\s+/g, "") ?? "";

  it("normalizeAddressValue is character-identical on both sides", () => {
    const server = body(SERVER, "normalizeAddressValue");
    const client = body(CLIENT, "normalizeAddressValue");
    expect(server).not.toBe("");
    expect(client).toBe(server);
  });

  it("both sides use the same US_POSTAL_RE", () => {
    const re = (src: string) => src.match(/const US_POSTAL_RE\s*=\s*([^]*?);/)?.[1]?.replace(/\s+/g, "") ?? "";
    expect(re(SERVER)).not.toBe("");
    expect(re(CLIENT)).toBe(re(SERVER));
  });
});
