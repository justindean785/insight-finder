import { describe, expect, it } from "vitest";
import { extractDisplaySeed, formatThreadTitle } from "@/lib/seed";
import { exportSubjectTitle, humanCaseName, threadDisplayTitle } from "@/lib/case-name";

/**
 * A pasted provider export became the case title (production, 2026-11-02): the
 * header's heading read "=== OATHNET INTELLIGENCE === Found via oathnet.org Date: …"
 * while its own subtitle correctly read "Phone seed · <number> · OathNet export".
 *
 * Why: the edge function stores `title = formatThreadTitle(text)`, and that goes
 * through `detectSeed`, which only classifies ONE clean token. A multi-line export
 * is `other`, so the title is the raw first 80 characters. The subtitle goes
 * through `extractDisplaySeed` -> `readProviderExport`, which reads the labelled
 * subject field. Two parsers, one input. The heading now derives from the same
 * detection the subtitle uses.
 *
 * Every value below is synthetic (555-01xx is the fictional NANP range).
 */

const BANNER = [
  "=== OATHNET INTELLIGENCE ===",
  "Found via oathnet.org",
  "Date: 2026-11-02T13:37:30.363Z",
  "",
  "Database: example-leak-db",
  "",
  "phone number: 954-555-0142",
  "city: Springfield",
  "=== END - oathnet.org ===",
].join("\n");

/** What the edge function writes: the title is the first 80 chars, seed_value the first 200. */
const STORED_TITLE = BANNER.slice(0, 80);
const SEED_VALUE = BANNER.slice(0, 200);

const NAME_ONLY = [
  "=== OATHNET INTELLIGENCE ===",
  "Found via oathnet.org",
  "Database: example-leak-db",
  "full name: Jordan Q. Example",
  "city: Springfield",
].join("\n");

describe("the stored title is the raw banner (the defect, pinned)", () => {
  it("formatThreadTitle still returns the raw first 80 chars — the edge writes the same, parity is pinned elsewhere", () => {
    expect(formatThreadTitle(BANNER)).toBe(STORED_TITLE);
    expect(STORED_TITLE.startsWith("=== OATHNET INTELLIGENCE ===")).toBe(true);
  });
});

describe("exportSubjectTitle", () => {
  it("reads the labelled phone out of the banner, like the subtitle does", () => {
    expect(extractDisplaySeed(BANNER)).toMatchObject({ selector: "954-555-0142", kind: "phone" });
    expect(exportSubjectTitle(BANNER)).toBe("Phone: 954-555-0142");
  });

  it("labels a name-only export as a Person", () => {
    expect(exportSubjectTitle(NAME_ONLY)).toBe("Person: Jordan Q. Example");
  });

  it("never names the provider as the subject", () => {
    expect(exportSubjectTitle(BANNER)).not.toMatch(/oathnet/i);
  });

  it("is null for anything that is not an export, so ordinary titles are untouched", () => {
    for (const t of ["Username: @casey_example", "example.com", "find everything about the shop on 4th street", "", null]) {
      expect(exportSubjectTitle(t)).toBeNull();
    }
  });

  it("is null for an export that names no subject", () => {
    expect(exportSubjectTitle("=== OATHNET INTELLIGENCE ===\nFound via oathnet.org\nDatabase: example-leak-db")).toBeNull();
  });
});

describe("humanCaseName (the header's heading)", () => {
  const display = extractDisplaySeed(SEED_VALUE).title;

  it("derives the heading from the seed when the stored title is a pasted banner", () => {
    expect(humanCaseName(STORED_TITLE, SEED_VALUE, display)).toBe("Phone: 954-555-0142");
  });

  it("derives it when the stored title was flattened onto one line", () => {
    const flat = "=== OATHNET INTELLIGENCE === Found via oathnet.org Date: 2026-11-02T13:37:30.363";
    expect(humanCaseName(flat, SEED_VALUE, display)).toBe("Phone: 954-555-0142");
  });

  it("returns null (heading falls back to the selector) when the export names no subject", () => {
    const bare = "=== OATHNET INTELLIGENCE ===\nFound via oathnet.org\nDatabase: example-leak-db";
    expect(humanCaseName(bare, bare, "OathNet export")).toBeNull();
  });

  it("leaves an analyst's own title alone", () => {
    expect(humanCaseName("Username: @casey_example", "casey_example", "casey_example")).toBe("Username: @casey_example");
    expect(humanCaseName("Casey Example — logistics", "casey@example.com", "casey@example.com")).toBe("Casey Example — logistics");
  });
});

describe("threadDisplayTitle (dense lists)", () => {
  it("shows the seed-derived title for a banner-titled thread", () => {
    expect(threadDisplayTitle(STORED_TITLE, SEED_VALUE)).toBe("Phone: 954-555-0142");
  });

  it("falls back to the provider when the seed was cut before the subject", () => {
    const cutSeed = BANNER.slice(0, 70);
    expect(threadDisplayTitle(STORED_TITLE, cutSeed)).toBe("OathNet export");
  });

  it("falls back to the provider when there is no seed at all", () => {
    expect(threadDisplayTitle(STORED_TITLE, null)).toBe("OathNet export");
  });

  it("passes every ordinary title through byte-for-byte", () => {
    for (const t of ["Phone: 8005550123", "Username: @casey_example", "Email: casey@example.com", "find everything about the shop", "New investigation"]) {
      expect(threadDisplayTitle(t, "ignored")).toBe(t);
    }
  });
});
