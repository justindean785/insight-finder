import { describe, it, expect } from "vitest";
import { humanizeSelector } from "@/lib/humanize-selector";

/**
 * This runs while rendering a transcript row. An unhandled throw here takes the
 * whole thread view down — over a cosmetic filename tidy-up.
 *
 * `new URL()` accepts a malformed percent sequence in a path; it is
 * `decodeURIComponent` that rejects it, and that call used to sit outside the
 * try/catch that guarded the parse.
 */
describe("humanizeSelector", () => {
  const UP = "https://proj.supabase.co/storage/v1/object/sign/chat-uploads/t/m";

  it("collapses a signed upload URL to the original filename", () => {
    expect(humanizeSelector(`${UP}/1787738666550-jl6n4g-oathnet_export.json`)).toBe(
      "oathnet_export.json",
    );
  });

  it("decodes a percent-encoded filename", () => {
    expect(humanizeSelector(`${UP}/1787738666550-jl6n4g-case%20notes.json`)).toBe(
      "case notes.json",
    );
  });

  it("does not throw on a malformed percent sequence", () => {
    // Each of these parses as a URL and throws URIError inside decodeURIComponent.
    for (const bad of ["a%", "%zz.json", "%E0%A4%A", "100%"]) {
      const input = `${UP}/${bad}`;
      expect(() => humanizeSelector(input)).not.toThrow();
      // Falls back to the raw segment rather than losing the row entirely.
      expect(humanizeSelector(input)).toBe(bad);
    }
  });

  it("leaves a foreign URL alone — it IS the selector", () => {
    const url = "https://example.com/some/deep/path?q=1";
    expect(humanizeSelector(url)).toBe(url);
  });

  it("does not throw on a malformed percent sequence in a foreign URL either", () => {
    const url = "https://example.com/a%";
    expect(() => humanizeSelector(url)).not.toThrow();
    expect(humanizeSelector(url)).toBe(url);
  });

  it("passes through a non-URL selector unchanged", () => {
    expect(humanizeSelector("jordan.vale@example.com")).toBe("jordan.vale@example.com");
    expect(humanizeSelector("")).toBe("");
  });

  it("survives an unparseable URL", () => {
    expect(() => humanizeSelector("http://[::bad")).not.toThrow();
  });
});
