import { describe, it, expect } from "vitest";
// Pure helper shared with the Deno dns_records tool (index.ts). Importing the
// real module (not a re-implementation) so this test locks the shipped logic.
import {
  DNS_TYPES,
  REAL_DNS_TYPES,
  VIRTUAL_DNS_TYPES,
  VIRTUAL_TYPE_MAP,
  isVirtualType,
  resolveVirtualHost,
  filterTxtByPrefix,
} from "../../supabase/functions/osint-agent/tools/dns-virtual.ts";

describe("DNS type tables", () => {
  it("DNS_TYPES is the union of real + virtual", () => {
    expect(DNS_TYPES).toEqual([...REAL_DNS_TYPES, ...VIRTUAL_DNS_TYPES]);
  });

  it("every VIRTUAL_TYPE_MAP key is a declared virtual type", () => {
    for (const k of Object.keys(VIRTUAL_TYPE_MAP)) {
      expect(VIRTUAL_DNS_TYPES).toContain(k as (typeof VIRTUAL_DNS_TYPES)[number]);
    }
  });

  it("classifies real vs virtual types", () => {
    expect(isVirtualType("A")).toBe(false);
    expect(isVirtualType("TXT")).toBe(false);
    expect(isVirtualType("SPF")).toBe(true);
    expect(isVirtualType("DMARC")).toBe(true);
  });
});

describe("resolveVirtualHost", () => {
  it("SPF queries the host unchanged (TXT @ host)", () => {
    expect(resolveVirtualHost("SPF", "gmail.com")).toBe("gmail.com");
  });

  it("DMARC mutates host to _dmarc.<host>", () => {
    expect(resolveVirtualHost("DMARC", "gmail.com")).toBe("_dmarc.gmail.com");
  });

  it("BIMI mutates host to default._bimi.<host>", () => {
    expect(resolveVirtualHost("BIMI", "gmail.com")).toBe("default._bimi.gmail.com");
  });

  it("DKIM with a selector → <selector>._domainkey.<host>", () => {
    expect(resolveVirtualHost("DKIM", "gmail.com", "20230601")).toBe(
      "20230601._domainkey.gmail.com"
    );
  });

  it("DKIM without a selector throws (the selector requirement)", () => {
    expect(() => resolveVirtualHost("DKIM", "gmail.com")).toThrow(/dkimSelector is required/);
  });
});

describe("filterTxtByPrefix", () => {
  it("keeps only records matching the prefix, case-insensitive", () => {
    const txt = ['"v=spf1 include:_spf.google.com ~all"', '"google-site-verification=abc"'];
    expect(filterTxtByPrefix(txt, VIRTUAL_TYPE_MAP.SPF.txtPrefix)).toEqual([
      "v=spf1 include:_spf.google.com ~all",
    ]);
  });

  it("strips DoH quoting and joins split chunks", () => {
    expect(filterTxtByPrefix(['"v=DMARC1; p=none;" "rua=mailto:x@y.com"'], "v=DMARC1")).toEqual([
      "v=DMARC1; p=none;rua=mailto:x@y.com",
    ]);
  });

  it("returns empty when nothing matches", () => {
    expect(filterTxtByPrefix(['"unrelated"'], "v=spf1")).toEqual([]);
  });
});

describe("Broner-case regression — SPF no longer crashes the tool", () => {
  it("SPF is a known type that maps to a TXT query filtered by v=spf1", () => {
    expect(DNS_TYPES).toContain("SPF");
    expect(isVirtualType("SPF")).toBe(true);
    expect(VIRTUAL_TYPE_MAP.SPF).toEqual({ realType: "TXT", txtPrefix: "v=spf1" });
    // host is unchanged, content filtered — exactly what the tool now does instead of throwing.
    expect(resolveVirtualHost("SPF", "gmail.com")).toBe("gmail.com");
  });
});
