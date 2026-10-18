import { describe, expect, it } from "vitest";
import { detectSeed, extractDisplaySeed, formatThreadTitle } from "@/lib/seed";
import { DEFAULT_CONTROLS, evaluatePreflight, type PreflightControls } from "@/lib/composer-preflight";
import { readProviderExport } from "@/lib/provider-export";
import {
  detectSeedServer,
  formatThreadTitle as formatThreadTitleServer,
} from "../../supabase/functions/osint-agent/validation";

/**
 * A pasted provider export is a case seed whose subject is INSIDE the block.
 *
 * Production, 2026-10-01: an OathNet export was pasted as the seed. The
 * free-text scan met "Found via oathnet.org" before the phone field, so the
 * composer offered `oathnet.org (domain)` as the target, the analyst's type
 * correction sent `Target: oathnet.org (other)`, and the report read
 * `Selector: oathnet.org · Type: domain` — a case about the lookup service.
 *
 * Every value below is fictitious.
 */

const EXPORT = [
  "=== OATHNET INTELLIGENCE ===",
  "Found via oathnet.org",
  "Date: 2026-10-01T19:30:55.511Z",
  "",
  "Database: thatsthem.com",
  "",
  "phone national: 5550104477",
  "phone number: 5550104477",
  "dbname: thatsthem.com",
  "full name: Jane Q. Example",
  "city: Springfield",
  "country: US",
  "address street: 12 Example Rd",
  "first name: Jane",
  "last name: Q. Example",
  "import id: 0000aaaa1111bbbb2222",
  "indexed at: 2026-08-20T14:03:07Z",
  "postal code: 95311",
  "state: CA",
  "",
  "=== END - oathnet.org ===",
].join("\n");

const withoutPhones = (s: string) => s.split("\n").filter((l) => !/^phone/.test(l)).join("\n");
const ATTRIBUTION_ONLY = [
  "=== OATHNET INTELLIGENCE ===",
  "Found via oathnet.org",
  "Database: thatsthem.com",
  "dbname: thatsthem.com",
  "city: Springfield",
  "=== END - oathnet.org ===",
].join("\n");

const preflight = (text: string, over: Partial<PreflightControls> = {}) =>
  evaluatePreflight({ text, attachments: 0, isFollowUp: false, controls: { ...DEFAULT_CONTROLS, ...over } });

describe("provider export → the subject's selector, never the provider's domain", () => {
  it("the export block targets the phone", () => {
    const d = extractDisplaySeed(EXPORT, "other");
    expect(d).toMatchObject({ selector: "5550104477", kind: "phone" });

    const r = preflight(EXPORT);
    expect(r.target).toMatchObject({ value: "5550104477", kind: "phone", corrected: false, freeText: false });
    expect(r.summary.target).toBe("5550104477 (phone)");
    // Not a correction, so nothing is appended: the export is sent as pasted.
    expect(r.message).toBe(EXPORT);
  });

  it("a corrected type on an export names the phone in the Target line, never oathnet.org", () => {
    // The production paste: the analyst re-typed the offered target as Free text.
    const r = preflight(EXPORT, { targetKind: "other" });
    expect(r.message.endsWith("\n\nTarget: 5550104477 (other)")).toBe(true);
    expect(r.message).not.toMatch(/Target: oathnet\.org/);
  });

  it("the report's stored seed (first 200 chars) still reads as the phone", () => {
    // auth.ts stores `seed_value: text.slice(0, 200)`; Seed Details reads that.
    expect(extractDisplaySeed(EXPORT.slice(0, 200), "other")).toMatchObject({ selector: "5550104477", kind: "phone" });
  });

  it("titles the case with the target and a provider tag, not the raw header", () => {
    const d = extractDisplaySeed(EXPORT, "other");
    expect(d.title).toBe("5550104477 · OathNet export");
    expect(d.title).not.toMatch(/===|INTELLIGENCE/);
  });

  it("an email field outranks the phone", () => {
    const block = EXPORT.replace("full name:", "email: jane.example@example.test\nfull name:");
    expect(extractDisplaySeed(block, "other")).toMatchObject({ selector: "jane.example@example.test", kind: "email" });
    expect(preflight(block).target).toMatchObject({ value: "jane.example@example.test", kind: "email" });
  });

  it("a username field outranks the name", () => {
    const block = withoutPhones(EXPORT).replace("full name:", "username: jq_example\nfull name:");
    expect(extractDisplaySeed(block, "other")).toMatchObject({ selector: "jq_example", kind: "username" });
  });

  it("a name-only export targets the name, as free text", () => {
    const block = withoutPhones(EXPORT);
    expect(extractDisplaySeed(block, "other")).toMatchObject({ selector: "Jane Q. Example", kind: "other" });
    const r = preflight(block);
    expect(r.target).toMatchObject({ value: "Jane Q. Example", freeText: true });
    expect(r.summary.target).toBe("Jane Q. Example (free text)");
  });

  it("first + last name stand in for a missing full name", () => {
    const block = withoutPhones(EXPORT).split("\n").filter((l) => !l.startsWith("full name")).join("\n");
    expect(extractDisplaySeed(block, "other").selector).toBe("Jane Q. Example");
  });

  it("masked and placeholder values are not selectors", () => {
    const block = EXPORT.replace("full name:", "email: j***@example.test\nusername: null\nfull name:");
    expect(extractDisplaySeed(block, "other")).toMatchObject({ selector: "5550104477", kind: "phone" });
  });

  it("a provider domain that appears only in attribution positions is never chosen", () => {
    const d = extractDisplaySeed(ATTRIBUTION_ONLY, "other");
    expect(d.kind).not.toBe("domain");
    expect(d.selector).not.toMatch(/oathnet\.org|thatsthem\.com/);
    const r = preflight(ATTRIBUTION_ONLY);
    expect(r.target?.kind).not.toBe("domain");
    expect(r.target?.value).not.toMatch(/oathnet\.org|thatsthem\.com|===/);
  });

  it("every known provider domain is attribution inside an export", () => {
    for (const host of ["intelx.io", "dehashed.com", "leakcheck.io", "snusbase.com", "hudsonrock.com", "haveibeenpwned.com"]) {
      const block = `Results via ${host}\nquery: lookup\ncity: Springfield\nreport: https://${host}/r/0000`;
      const d = extractDisplaySeed(block, "other");
      expect(d.selector, host).not.toContain(host);
      expect(d.kind, host).not.toBe("domain");
    }
  });

  it("a real domain field inside an export is still a domain target", () => {
    // Attribution is excluded, not every domain.
    const block = withoutPhones(EXPORT).replace("full name: Jane Q. Example\n", "").replace("first name: Jane\nlast name: Q. Example\n", "") +
      "\nwebsite: example.com";
    expect(extractDisplaySeed(block, "other")).toMatchObject({ selector: "example.com", kind: "domain" });
  });

  it("an export flattened onto one line: the timestamp is not a phone and the provider is not the target", () => {
    const flat = EXPORT.replace(/\s+/g, " ");
    expect(extractDisplaySeed(flat, "other")).toMatchObject({ selector: "5550104477", kind: "phone" });
  });
});

describe("plain selectors behave exactly as before", () => {
  it("a domain typed alone is a domain seed", () => {
    expect(detectSeed("example.com")?.kind).toBe("domain");
    expect(extractDisplaySeed("example.com", null)).toEqual({ selector: "example.com", kind: "domain", title: "example.com" });
    const r = preflight("example.com");
    expect(r.target).toMatchObject({ value: "example.com", kind: "domain", freeText: false });
    expect(r.message).toBe("example.com");
    expect(formatThreadTitle("example.com")).toBe("Domain: example.com");
  });

  it("a provider's own domain typed alone is still a domain seed", () => {
    expect(extractDisplaySeed("oathnet.org", null)).toMatchObject({ selector: "oathnet.org", kind: "domain" });
    expect(preflight("oathnet.org").target).toMatchObject({ value: "oathnet.org", kind: "domain" });
  });

  it("an email typed alone is an email seed", () => {
    expect(extractDisplaySeed("jane.example@example.test", null)).toMatchObject({ selector: "jane.example@example.test", kind: "email" });
    const r = preflight("jane.example@example.test");
    expect(r.target).toMatchObject({ value: "jane.example@example.test", kind: "email" });
    expect(r.message).toBe("jane.example@example.test");
  });

  it("a phone typed alone is a phone seed", () => {
    for (const p of ["5550104477", "+1 555 010 4477"]) {
      expect(extractDisplaySeed(p, null), p).toMatchObject({ selector: p, kind: "phone" });
      const r = preflight(p);
      expect(r.target, p).toMatchObject({ value: p, kind: "phone" });
      expect(r.message, p).toBe(p);
    }
  });

  it("prose that merely mentions a provider is not an export", () => {
    expect(readProviderExport("investigate dehashed.com")).toBeNull();
    expect(extractDisplaySeed("investigate dehashed.com", null)).toMatchObject({ selector: "dehashed.com", kind: "domain" });
    expect(readProviderExport("jane.example@example.test — found via example.com, who owns it?")).toBeNull();
  });

  it("plain selectors are never read as exports", () => {
    for (const s of ["example.com", "oathnet.org", "jane.example@example.test", "5550104477", "@jq_example", "Jane Example, Springfield"]) {
      expect(readProviderExport(s), s).toBeNull();
    }
  });
});

describe("seed detection and the thread title are unchanged for an export (server mirror)", () => {
  it("the cache key still classifies the block as `other` on both halves", () => {
    expect(detectSeed(EXPORT)?.kind).toBe("other");
    expect(detectSeedServer(EXPORT)?.kind).toBe("other");
  });

  it("formatThreadTitle still mirrors the server's — the stored title is written by the edge function", () => {
    expect(formatThreadTitle(EXPORT)).toBe(formatThreadTitleServer(EXPORT));
  });
});

/**
 * A provider profile exported as a PDF and pasted as the seed (live case 2026-10-06).
 *
 * Two independent defects produced `<file>.pdf (domain)` as the case subject:
 *  1. Every field line began with U+FFFC (OBJECT REPLACEMENT CHARACTER — an icon glyph the PDF
 *     conversion left behind). KV_LINE anchors on a letter after optional WHITESPACE, and U+FFFC is
 *     not whitespace, so NO field parsed: the labelled name was never read.
 *  2. With no field and no email/phone, the blob fallback took the first `word.tld` it met —
 *     `Source File: <name>.pdf` — as a domain.
 *
 * The stored seed is the composer's 200-character truncation, so the block can end mid-word.
 * Every value below is fictitious.
 */
const PDF_EXPORT = [
  "Person profile: Jordan Vale",
  "Source File: vale-profile.pdf",
  "Generated: 2026-10-06 14:02 UTC",
  "Overview",
  "\uFFFC Name: Jordan Vale",
  "\uFFFC Email: j***@example.test",
  "\uFFFC Username: jvale-sample",
  "\uFFFC Locatio",
].join("\n");

describe("a PDF-converted provider export names its real subject, not its file", () => {
  it("reads the labelled field through the object-replacement glyph", () => {
    expect(readProviderExport(PDF_EXPORT)?.pick).toMatchObject({ value: "jvale-sample", kind: "username" });
    const d = extractDisplaySeed(PDF_EXPORT, null);
    expect(d.selector).toBe("jvale-sample");
    expect(d.kind).toBe("username");
    expect(d.selector).not.toMatch(/\.pdf$/i);
  });

  it("does the same through any invisible/format prefix, not just U+FFFC", () => {
    for (const prefix of ["​", "‎", "﻿", "⁠", "­"]) {
      const text = PDF_EXPORT.split("\uFFFC").join(prefix);
      expect(extractDisplaySeed(text, null).selector, JSON.stringify(prefix)).toBe("jvale-sample");
    }
  });

  it("with no username field, the labelled NAME is the subject", () => {
    const text = PDF_EXPORT.replace("\uFFFC Username: jvale-sample\n", "");
    expect(extractDisplaySeed(text, null)).toMatchObject({ selector: "Jordan Vale", kind: "other" });
  });

  it("a file-name line is attribution: never the subject, and scrubbed from the free-text scan", () => {
    const noFields = ["Source File: vale-profile.pdf", "Overview", "nothing selector-shaped here"].join("\n");
    expect(extractDisplaySeed(noFields, null).selector).not.toMatch(/\.pdf$/i);
    for (const key of ["Source File", "File", "File name", "Filename", "Document", "Attachment"]) {
      const scrubbed = readProviderExport(`${key}: vale-profile.pdf\nfull name: Jordan Vale`)?.scrubbed ?? "";
      expect(scrubbed, key).not.toContain("vale-profile.pdf");
    }
  });

  it("a document extension is not a TLD in the free-text fallback — but real TLDs still are", () => {
    for (const ext of ["pdf", "docx", "xlsx", "txt", "csv", "png", "jpg", "json"]) {
      const d = extractDisplaySeed(`Overview\nsee attached scan-report.${ext}\nno other selector`, null);
      expect(d.kind, ext).not.toBe("domain");
    }
    // `.zip` and `.mov` are real TLDs and must keep working as domains.
    expect(extractDisplaySeed("Overview\nsee seed-example.zip\nno other selector", null)).toMatchObject({ kind: "domain", selector: "seed-example.zip" });
    expect(extractDisplaySeed("Overview\nsee seed-example.mov\nno other selector", null)).toMatchObject({ kind: "domain", selector: "seed-example.mov" });
    // …and a real domain AFTER a document name is still found.
    expect(extractDisplaySeed("Overview\nsee scan-report.pdf and example.org\nno other selector", null)).toMatchObject({ kind: "domain", selector: "example.org" });
  });

  it("controls: a bare document name typed ALONE is classified exactly as before (detectSeed untouched)", () => {
    // detectSeed mirrors the server's cache key; this PR must not move it.
    expect(extractDisplaySeed("report.pdf", null)).toMatchObject({ selector: "report.pdf", kind: "domain" });
    expect(detectSeed("report.pdf")?.kind).toBe(detectSeedServer("report.pdf")?.kind);
  });

  it("controls: a plain selector, and an export without the glyph, behave exactly as before", () => {
    expect(extractDisplaySeed("jane.example@example.test", null)).toMatchObject({ kind: "email" });
    expect(extractDisplaySeed(EXPORT, null).selector).toBe(extractDisplaySeed(EXPORT.split("\uFFFC").join(""), null).selector);
  });
});
