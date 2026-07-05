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
});
