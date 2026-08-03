/**
 * Selector classification: a dot is not a domain.
 *
 * Production defect (live report, seed `Ronny.doe`): the dossier printed
 * "Type: domain". `DOMAIN_RE` matched any dotted token and was tested BEFORE
 * `USERNAME_RE`, so every handle containing a dot was reclassified as a
 * hostname — which then steered tool selection and the whole report narrative.
 *
 * The rule these tests pin: a trailing label counts as a TLD if it is a
 * two-letter ccTLD (every 2-letter TLD is one) or a known gTLD. "doe" is
 * neither, so `Ronny.doe` stays a username.
 */
import { describe, it, expect } from "vitest";
import { detectSeed, extractDisplaySeed } from "@/lib/seed";
import { buildReportMarkdown } from "@/lib/intel";

describe("detectSeed — domain grammar, not merely a dot", () => {
  it.each([
    ["Ronny.doe", "username"],
    ["ronny.doe", "username"],
    ["John.Smith", "username"],
  ])("classifies %s as %s, not a domain", (input, kind) => {
    expect(detectSeed(input)?.kind).toBe(kind);
  });

  it.each([
    ["example.com", "domain"],
    ["sub.example.com", "domain"],
    ["deep.sub.example.co.uk", "domain"],
    ["acme.io", "domain"],
    ["example.dev", "domain"],
    // Every two-letter TLD is a ccTLD, so the 2-letter rule must hold.
    ["example.de", "domain"],
  ])("still classifies %s as %s", (input, kind) => {
    expect(detectSeed(input)?.kind).toBe(kind);
  });

  it.each([
    ["ronny.doe@example.com", "email"],
    ["Ronny.Doe@Example.COM", "email"],
    ["https://example.com/in/ron-daoust-9138a947", "url"],
    ["213.193.180.72", "ip"],
    ["+15550001111", "phone"],
  ])("leaves %s classified as %s", (input, kind) => {
    expect(detectSeed(input)?.kind).toBe(kind);
  });

  it("does not invent a domain from a dotted token inside a pasted blob", () => {
    // extractDisplaySeed's blob path has its own domain regex; it must apply
    // the same TLD rule or the fix is only half-applied.
    const blob = "module: dhgate\nschema: module\nhandle Ronny.doe seen";
    expect(extractDisplaySeed(blob, null).kind).not.toBe("domain");
  });
});

describe("report output — Seed Details reports the corrected type", () => {
  it("does not print Type: domain for a dotted username seed", () => {
    const md = buildReportMarkdown({
      seedValue: "Ronny.doe",
      seedType: "username",
      artifacts: [],
    });
    const seedSection = md.split("## Seed Details")[1]?.split("\n## ")[0] ?? "";
    expect(seedSection).toContain("**Type:** username");
    expect(seedSection).not.toContain("**Type:** domain");
  });
});
