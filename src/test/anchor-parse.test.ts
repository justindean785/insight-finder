// Verifies the anchor-read entity parsers (WP1) against payloads shaped like the
// live SocialFetch + Perplexity responses. Pure module — runs here and in Deno CI.
import { describe, it, expect } from "vitest";
import {
  extractProfileEntities,
  parseSerpEntities,
  seedToHandle,
  foldHandle,
} from "../../supabase/functions/osint-agent/anchor-parse";

describe("WP1 seedToHandle", () => {
  it("strips a leading @ and folds case", () => {
    expect(seedToHandle({ kind: "username", raw: "@PJSmakka", normalized: "pjsmakka" })).toBe("pjsmakka");
  });
  it("extracts a handle from an instagram profile URL seed", () => {
    expect(seedToHandle({ kind: "url", raw: "https://www.instagram.com/pjsmakka/", normalized: "https://www.instagram.com/pjsmakka" })).toBe("pjsmakka");
  });
  it("returns null for a non-handle seed", () => {
    expect(seedToHandle({ kind: "email", raw: "a@b.com", normalized: "a@b.com" })).toBeNull();
  });
  it("foldHandle normalizes @ and trailing dots", () => {
    expect(foldHandle("@Youngdeji_.")).toBe("youngdeji_");
  });
});

describe("WP1 extractProfileEntities (profile READ)", () => {
  it("pulls bio, display name, counts, external links and bio-mentioned accounts", () => {
    const payload = {
      handle: "onlythepressure_noextras",
      displayName: "onlythepressure_noextras",
      bio: "Influence with intention. Lifestyle, Fashion, Culture. Dm for Promo. Backup: @onlythepressure_noextrastv",
      followers: 15867,
      following: 79,
      verified: true,
      externalUrl: "http://example.com/promo",
      bioLinks: ["linktr.ee/otp"],
    };
    const ent = extractProfileEntities(payload);
    expect(ent.displayName).toBe("onlythepressure_noextras");
    expect(ent.followers).toBe(15867);
    expect(ent.following).toBe(79);
    expect(ent.verified).toBe(true);
    expect(ent.externalLinks).toContain("http://example.com/promo");
    expect(ent.externalLinks.some((l) => l.includes("linktr.ee/otp"))).toBe(true);
    // the @mentioned backup account is a RELATED handle, not the subject itself
    expect(ent.relatedHandles).toContain("onlythepressure_noextrastv");
    expect(ent.relatedHandles).not.toContain("onlythepressure_noextras");
  });
  it("handles a sparse profile without throwing", () => {
    const ent = extractProfileEntities({ handle: "pjsmakka", bio: "LLPOPS LLBOODAH LLRICH" });
    expect(ent.handle).toBe("pjsmakka");
    expect(ent.relatedHandles).toEqual([]);
    expect(ent.followers).toBeNull();
  });
});

describe("WP1 parseSerpEntities (SERP READ)", () => {
  it("mines related accounts, the seed's own profile URL, and external links", () => {
    // Shaped like a Perplexity answer for @pjsmakka (the Google AI-overview network).
    const answer =
      "Pj Smakka (@pjsmakka) is a content creator known for jail-cooking videos. " +
      "Related accounts include @raphousetvhq, @youngdeji_ and @inmateswithtalent. " +
      "See https://www.instagram.com/pjsmakka/ and https://www.instagram.com/raphousetvhq/. " +
      "External: https://raphousetv.com/about";
    const citations = [
      "https://www.instagram.com/pjsmakka/",
      "https://www.instagram.com/dillonchaseok/",
      "https://example-news.com/jail-cooking",
    ];
    const ent = parseSerpEntities(answer, citations, "pjsmakka");
    expect(ent.seedProfileUrl).toBe("https://www.instagram.com/pjsmakka/");
    expect(ent.relatedHandles).toEqual(expect.arrayContaining(["raphousetvhq", "youngdeji_", "inmateswithtalent", "dillonchaseok"]));
    expect(ent.relatedHandles).not.toContain("pjsmakka");
    expect(ent.profileUrls).toContain("https://www.instagram.com/raphousetvhq/");
    expect(ent.externalLinks.some((l) => l.includes("example-news.com"))).toBe(true);
  });
  it("ignores instagram reserved path segments", () => {
    const ent = parseSerpEntities("see https://www.instagram.com/p/abc123/ and https://www.instagram.com/explore/", [], "pjsmakka");
    expect(ent.relatedHandles).not.toContain("p");
    expect(ent.relatedHandles).not.toContain("explore");
  });
});
