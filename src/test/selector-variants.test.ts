import { describe, expect, it } from "vitest";
import { anySearchKeyIn, expandSearchKeys, searchKeys } from "@/lib/selector-variants";
import { normalizeTarget } from "@/lib/next-step-cards";

const n = normalizeTarget;

describe("searchKeys — the already-searched comparison", () => {
  it("matches a phone across country code and punctuation", () => {
    const logged = expandSearchKeys([n("4155550142")]);
    expect(anySearchKeyIn(logged, n("+1 (415) 555-0142"))).toBe(true);
    expect(anySearchKeyIn(logged, n("415.555.0142"))).toBe(true);
  });

  it("does not treat a short number or a mixed string as a phone", () => {
    expect(searchKeys(n("2024"))).toEqual(["2024"]);
    expect(searchKeys(n("user2024x"))).toEqual(["user2024x"]);
  });

  it("matches a URL with and without scheme and www", () => {
    const logged = expandSearchKeys([n("instagram.com/jrnike123speedy")]);
    expect(anySearchKeyIn(logged, n("https://www.instagram.com/jrnike123speedy/"))).toBe(true);
  });

  it("keeps different targets apart", () => {
    const logged = expandSearchKeys([n("jrnike123speedy"), n("4155550142")]);
    expect(anySearchKeyIn(logged, n("jrnike123"))).toBe(false);
    expect(anySearchKeyIn(logged, n("+1 415 555 0199"))).toBe(false);
  });

  it("an empty target has no keys", () => {
    expect(searchKeys("")).toEqual([]);
  });
});

describe("searchKeys — prefix stripping is for URLs only (#945 review)", () => {
  it("a username starting with 'mobile' does not match the bare remainder", () => {
    const logged = expandSearchKeys([n("mobile_user")]);
    expect(anySearchKeyIn(logged, n("user"))).toBe(false);
  });

  it("a name starting with an initial 'M.' does not match the surname alone", () => {
    const logged = expandSearchKeys([n("M. Jordan")]);
    expect(anySearchKeyIn(logged, n("Jordan"))).toBe(false);
  });

  it("'www' / 'https' / 'm.' URLs still match their bare host form", () => {
    expect(anySearchKeyIn(expandSearchKeys([n("instagram.com/subject_handle")]), n("https://www.instagram.com/subject_handle/"))).toBe(true);
    expect(anySearchKeyIn(expandSearchKeys([n("facebook.com/jordan.vale")]), n("m.facebook.com/jordan.vale"))).toBe(true);
  });
});

describe("searchKeys — URLs outside a TLD shortlist still match (#948 review)", () => {
  it("www. hosts match their bare form whatever the TLD", () => {
    expect(anySearchKeyIn(expandSearchKeys([n("example.nl")]), n("www.example.nl"))).toBe(true);
    expect(anySearchKeyIn(expandSearchKeys([n("example.museum/x")]), n("www.example.museum/x"))).toBe(true);
  });

  it("m. hosts with a country-code TLD match", () => {
    expect(anySearchKeyIn(expandSearchKeys([n("example.nl")]), n("m.example.nl"))).toBe(true);
  });

  it("a name like 'M. Jordan Smith' still does not match 'Jordan Smith'", () => {
    expect(anySearchKeyIn(expandSearchKeys([n("M. Jordan Smith")]), n("Jordan Smith"))).toBe(false);
  });
});
