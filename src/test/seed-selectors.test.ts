import { describe, expect, it } from "vitest";
import { matchesSeedSelector, seedSelectors } from "@/lib/seed-selectors";

// Synthetic values only.
describe("seedSelectors — strong selectors typed into one seed", () => {
  it("one selector returns nothing: the whole-seed path handles it", () => {
    for (const s of ["first@example.test", "@examplehandle77", "examplehandle77", "+1 555 010 0100", "example.test", ""]) {
      expect(seedSelectors(s)).toEqual([]);
    }
    expect(seedSelectors(null)).toEqual([]);
  });

  it("extracts emails, a phone, an @handle, a URL and a domain; never a name or a bare word", () => {
    const got = seedSelectors("Sam Example, first@example.test; +1 (555) 010-0100 @examplehandle77 https://example.test/u/sam/ example.org works nights");
    expect(got).toEqual([
      { kind: "email", value: "first@example.test" },
      { kind: "username", value: "examplehandle77" },
      { kind: "url", value: "https://example.test/u/sam" },
      { kind: "domain", value: "example.org" },
      { kind: "phone", value: "15550100100" },
    ]);
  });

  it("a house number and a postcode are not phones", () => {
    expect(seedSelectors("Sam Example, 12 Example St, Springfield 90000, first@example.test")).toEqual([{ kind: "email", value: "first@example.test" }]);
  });

  it("the same selector typed twice is one selector", () => {
    expect(seedSelectors("first@example.test FIRST@example.test second@example.test")).toHaveLength(2);
  });

  it("an upload block contributes nothing; typed text before it still counts", () => {
    const block = "Attached files:\n- [second@example.test.pdf](https://files.example.test/x.pdf) (application/pdf, 1 MB)";
    expect(seedSelectors(block)).toEqual([]);
    expect(seedSelectors(`first@example.test and third@example.test\n\n${block}`).map((s) => s.value)).toEqual(["first@example.test", "third@example.test"]);
  });

  it("drops the token that touches the 200-character cut, and only then", () => {
    const cut = `first@example.test ${"note ".repeat(36)}second@example.test`.slice(0, 200);
    expect(seedSelectors(cut).map((s) => s.value)).toEqual(["first@example.test"]);
    expect(seedSelectors("first@example.test, second@example.test").map((s) => s.value)).toEqual(["first@example.test", "second@example.test"]);
  });
});

describe("matchesSeedSelector — kind and value must both match", () => {
  const sel = seedSelectors("first@example.test @examplehandle77 +1 555 010 0100 note");
  it("matches the row of the same kind, across spellings", () => {
    expect(matchesSeedSelector({ kind: "email", value: "First@Example.test" }, sel)).toBe(true);
    expect(matchesSeedSelector({ kind: "handle", value: "@examplehandle77" }, sel)).toBe(true);
    expect(matchesSeedSelector({ kind: "phone", value: "(555) 010-0100" }, sel)).toBe(true);
  });
  it("never matches a row of another kind, a name included", () => {
    expect(matchesSeedSelector({ kind: "name", value: "examplehandle77" }, sel)).toBe(false);
    expect(matchesSeedSelector({ kind: "username", value: "first@example.test" }, sel)).toBe(false);
    expect(matchesSeedSelector({ kind: "phone", value: "555 010 0199" }, sel)).toBe(false);
  });
});
