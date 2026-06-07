import { describe, it, expect } from "vitest";
import { detectContradictions } from "../../supabase/functions/osint-agent/contradictions.ts";

type A = Parameters<typeof detectContradictions>[0][number];
const art = (over: Partial<A>): A => ({ kind: "other", value: "v", ...over });

// These reproduce the false-positives observed in a real run on johnd@gmail.com:
// the same handle resolved to "John Daniels" (GitHub) and "John Demos" (Twitter),
// and username_sweep "confirmed" the handle on 55 platforms — yet
// detect_contradictions returned []. Both should now be flagged.

describe("detectContradictions — identity conflicts", () => {
  it("flags two distinct person names on the same selector (high severity)", () => {
    const found = detectContradictions([
      art({ kind: "name", value: "John Daniels", source: "github_user" }),
      art({ kind: "name", value: "John Demos", source: "socialfetch_lookup" }),
    ]);
    const c = found.find((f) => f.kind === "name_conflict");
    expect(c?.severity).toBe("high");
    expect(c?.involved).toEqual(expect.arrayContaining(["John Daniels", "John Demos"]));
  });

  it("does not flag a single name, or the same name in different casing", () => {
    expect(detectContradictions([art({ kind: "name", value: "John Daniels" })]).some((f) => f.kind === "name_conflict")).toBe(false);
    expect(
      detectContradictions([
        art({ kind: "name", value: "John Daniels" }),
        art({ kind: "name", value: "john daniels" }),
      ]).some((f) => f.kind === "name_conflict"),
    ).toBe(false);
  });

  it("flags an over-broad handle via platforms_confirmed count", () => {
    const found = detectContradictions([
      art({ kind: "username", value: "johnd", source: "username_sweep", metadata: { platforms_confirmed: 55 } }),
    ]);
    const c = found.find((f) => f.kind === "over_broad_username");
    expect(c?.severity).toBe("medium");
    expect(c?.detail).toContain("55");
  });

  it("also reads primary_platforms array length", () => {
    const found = detectContradictions([
      art({ kind: "username", value: "johnd", metadata: { primary_platforms: Array(20).fill("x") } }),
    ]);
    expect(found.some((f) => f.kind === "over_broad_username")).toBe(true);
  });

  it("does not flag a handle present on only a few platforms", () => {
    const found = detectContradictions([
      art({ kind: "username", value: "rare_handle", metadata: { platforms_confirmed: 3 } }),
    ]);
    expect(found.some((f) => f.kind === "over_broad_username")).toBe(false);
  });

  it("catches both problems together on the real-run shape", () => {
    const found = detectContradictions([
      art({ kind: "name", value: "John Daniels", source: "github_user", metadata: { location: "Edinburgh, Scotland" } }),
      art({ kind: "name", value: "John Demos", source: "socialfetch_lookup" }),
      art({ kind: "username", value: "johnd", source: "username_sweep", metadata: { platforms_confirmed: 55 } }),
    ]);
    const kinds = found.map((f) => f.kind);
    expect(kinds).toContain("name_conflict");
    expect(kinds).toContain("over_broad_username");
  });
});
