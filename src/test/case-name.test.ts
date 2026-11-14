import { describe, expect, it } from "vitest";
import { humanCaseName, threadDisplayTitle } from "@/lib/case-name";
import { typedTextBeforeAttachments } from "@/lib/attachments";

describe("humanCaseName", () => {
  const seed = "j.harker@northgate-logistics.com";

  it("returns the analyst's name for the case", () => {
    expect(humanCaseName("James Harker — logistics", seed, seed)).toBe("James Harker — logistics");
  });

  it("falls back (null) for blank and placeholder titles", () => {
    for (const t of [null, "", "  ", "New investigation", "new investigation", "Untitled"]) {
      expect(humanCaseName(t, seed, seed)).toBeNull();
    }
  });

  it("falls back when the title only repeats the selector", () => {
    expect(humanCaseName(seed, seed, seed)).toBeNull();
    expect(humanCaseName(" J.Harker@Northgate-Logistics.com ", seed, seed)).toBeNull();
    expect(humanCaseName("datatracera.com", "https://datatracera.com/", "datatracera.com")).toBeNull();
  });
});

/**
 * Typed text followed by an upload. The edge stores the first 80 characters of
 * the whole first message as the title, so the composer's "Attached files:"
 * block rides along, cut wherever the 80th character falls. Seen in production
 * 2026-11-09: the case header and breadcrumb printed the block after the seed.
 */
describe("a title that carries the composer's attachment block", () => {
  const seed = "jane.roe@example.com";
  const full = `${seed}\n\nAttached files:\n- [export.json](https://example.supabase.co/storage/v1/object/sign/x?token=abc) (application/json, 4 KB)`;
  const title = full.slice(0, 80);
  const seedValue = full.slice(0, 200);

  it("the fixture is the cut shape the edge stores", () => {
    expect(title).toContain("Attached files:");
    expect(title).not.toContain(")");
  });

  it("reads only the typed words, wherever the block was cut", () => {
    expect(typedTextBeforeAttachments(title)).toBe(seed);
    expect(typedTextBeforeAttachments(`${seed} Attached files:`)).toBe(seed);
    expect(typedTextBeforeAttachments(`${seed} Attached fil`)).toBe(seed);
  });

  it("leaves ordinary titles and upload-only titles alone", () => {
    expect(typedTextBeforeAttachments("James Harker, logistics")).toBeNull();
    expect(typedTextBeforeAttachments("Evidence Attached")).toBeNull();
    expect(typedTextBeforeAttachments("Attached files:\n- [scan.pdf](https://x")).toBeNull();
    expect(typedTextBeforeAttachments(null)).toBeNull();
  });

  it("the header falls back to the selector instead of printing the block", () => {
    expect(humanCaseName(title, seedValue, seed)).toBeNull();
  });

  it("the header keeps a typed name and drops only the block", () => {
    const named = "Roe household review\n\nAttached files:\n- [export.json](https://example.supabase.co/st";
    expect(humanCaseName(named, named, "Roe household review")).toBeNull();
    expect(humanCaseName(named, seedValue, seed)).toBe("Roe household review");
  });

  it("list surfaces print the typed words and never the link", () => {
    expect(threadDisplayTitle(title, seedValue)).toBe(seed);
    expect(threadDisplayTitle("James Harker, logistics", seed)).toBe("James Harker, logistics");
    expect(threadDisplayTitle("Attached files:\n- [scan.pdf](https://x", null)).toBe("Attachment: scan.pdf");
  });
});
