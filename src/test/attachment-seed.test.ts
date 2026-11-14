import { describe, it, expect } from "vitest";
import { attachmentOnlyNames } from "@/lib/attachments";
import { extractDisplaySeed } from "@/lib/seed";
import { humanCaseName, threadDisplayTitle } from "@/lib/case-name";

/**
 * A case whose first message is ONLY an upload. The edge (`auth.ts`) stores
 * `title` = the raw first 80 chars and `seed_value` = the first 200, both cut
 * mid-way through the signed storage URL, and `seed_type` = "other". Before this
 * the header read the signed URL out of that blob as a `url` seed — printing the
 * token on screen — and the title rendered as raw markdown. These pin the
 * display-time reading; the stored values are an edge fix, deferred.
 *
 * Synthetic hosts only — never a run-derived storage URL.
 */

const signed = (name: string) =>
  `https://proj.storage.example/storage/v1/object/sign/attachments/u1/c1/${name}?token=eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2ln`;
const block = (...names: string[]) =>
  `Attached files:\n${names.map((n) => `- [${n}](${signed(n)}) (application/pdf, 1.2 MB)`).join("\n")}`;
// What the edge stores.
const stored = (text: string) => ({ title: text.slice(0, 80), seed: text.slice(0, 200) });

describe("attachmentOnlyNames", () => {
  it("reads the filename from a block truncated before the link closes", () => {
    const { title, seed } = stored(block("scan-notes.pdf"));
    expect(title).not.toContain(")");
    expect(attachmentOnlyNames(title)).toEqual(["scan-notes.pdf"]);
    expect(attachmentOnlyNames(seed)).toEqual(["scan-notes.pdf"]);
  });

  it("reads every filename from a full block", () => {
    expect(attachmentOnlyNames(block("a.png", "b.json"))).toEqual(["a.png", "b.json"]);
  });

  it("is null when the analyst typed text before the attachments", () => {
    expect(attachmentOnlyNames(`look at this\n\n${block("a.png")}`)).toBeNull();
  });

  it("is null for ordinary seeds and empty input", () => {
    for (const t of ["j.harker@northgate-logistics.com", "", null, undefined, "Attached files:"]) {
      expect(attachmentOnlyNames(t)).toBeNull();
    }
  });
});

describe("extractDisplaySeed on an attachment-only case", () => {
  it("is an attachment seed named by the file, never the signed URL", () => {
    const { seed } = stored(block("scan-notes.pdf"));
    const d = extractDisplaySeed(seed, "other");
    expect(d.kind).toBe("attachment");
    expect(d.selector).toBe("scan-notes.pdf");
    expect(d.title).toBe("scan-notes.pdf");
    expect(JSON.stringify(d)).not.toMatch(/token=|storage\/v1/);
  });

  it("names the extra files when there are several", () => {
    const d = extractDisplaySeed(block("a.png", "b.json", "c.csv"), "other");
    expect(d.kind).toBe("attachment");
    expect(d.title).toBe("a.png +2");
  });
});

describe("case titles for an attachment-only case", () => {
  it("threadDisplayTitle reads 'Attachment: <file>' for the stored title", () => {
    const { title, seed } = stored(block("scan-notes.pdf"));
    expect(threadDisplayTitle(title, seed)).toBe("Attachment: scan-notes.pdf");
  });

  it("humanCaseName falls back to the seed heading (null), not raw markdown", () => {
    const { title, seed } = stored(block("scan-notes.pdf"));
    expect(humanCaseName(title, seed, "scan-notes.pdf")).toBeNull();
  });

  it("leaves ordinary titles untouched", () => {
    expect(threadDisplayTitle("James Harker — logistics", "j.harker@northgate-logistics.com")).toBe("James Harker — logistics");
  });
});
