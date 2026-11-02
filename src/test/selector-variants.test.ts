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
