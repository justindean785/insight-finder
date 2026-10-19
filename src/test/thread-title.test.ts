import { describe, it, expect } from "vitest";
import { formatThreadTitle, THREAD_TITLE_MAX } from "@/lib/seed";

describe("formatThreadTitle (issue #73)", () => {
  it("prefixes a detected email with its entity type", () => {
    expect(formatThreadTitle("john.doe@gmail.com")).toBe("Email: john.doe@gmail.com");
  });

  it("labels a domain seed", () => {
    expect(formatThreadTitle("example.com")).toBe("Domain: example.com");
  });

  it("labels a phone seed", () => {
    expect(formatThreadTitle("8005551234")).toBe("Phone: 8005551234");
  });

  it("labels a username seed", () => {
    expect(formatThreadTitle("neo_hacker")).toBe("Username: neo_hacker");
  });

  it("trims surrounding whitespace before detecting", () => {
    expect(formatThreadTitle("  admin@site.io  ")).toBe("Email: admin@site.io");
  });

  it("falls back to the raw slice(0,80) for unclassified seeds (no regression)", () => {
    const blob = "find everything about the person who runs the shop on 4th street";
    expect(formatThreadTitle(blob)).toBe(blob.slice(0, THREAD_TITLE_MAX));
  });

  it("never exceeds the title length cap", () => {
    const long = "a".repeat(200) + "@gmail.com";
    expect(formatThreadTitle(long).length).toBeLessThanOrEqual(THREAD_TITLE_MAX);
  });

  it("handles empty input without throwing", () => {
    expect(formatThreadTitle("")).toBe("");
  });

  // 2026-10-19: the sidebar leaked composer furniture into case names.
  it("flattens markdown in an unclassified first message to plain words", () => {
    expect(formatThreadTitle("Here are the results for **16 Mclellen St** `apt 302`")).toBe("Here are the results for 16 Mclellen St apt 302");
    expect(formatThreadTitle("## Lead\n- check the shop\n- then the owner")).toBe("Lead check the shop then the owner");
    expect(formatThreadTitle("look at neo_hacker_x and __this__")).toBe("look at neo_hacker_x and this");
  });

  it("titles an attachments-only message by its files, never by the composer's block", () => {
    const msg = "Attached files:\n- [IMG_5717.png](https://x.example/a) (image/png, 1.2 MB)\n- [notes.txt](https://x.example/b) (text/plain, 2 KB)";
    expect(formatThreadTitle(msg)).toBe("Files: IMG_5717.png +1");
  });

  it("keeps the analyst's words when a message carries both words and files", () => {
    const msg = "who owns this storefront\n\nAttached files:\n- [IMG_1.png](https://x.example/a) (image/png, 1 MB)";
    expect(formatThreadTitle(msg)).toBe("who owns this storefront");
  });

  it("still detects a seed typed above an attachment", () => {
    const msg = "@iamfoxxx\n\nAttached files:\n- [IMG_1.png](https://x.example/a) (image/png, 1 MB)";
    expect(formatThreadTitle(msg)).toBe("Username: @iamfoxxx");
  });
});
