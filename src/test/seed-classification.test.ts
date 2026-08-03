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

  // The allowlist is a POSITIVE fast-path, not the classifier. A suffix it does
  // not recognise must not silently become either answer — a real newer gTLD
  // would be called a username, and a handle would be called a domain. Both are
  // invented certainty, so the token is marked ambiguous and the report says so.
  it.each([
    ["example.quest"],
    ["example.zip"],
    ["example.observer"],
    ["example.lol"],
  ])("marks %s ambiguous rather than guessing (real TLD, not in the allowlist)", (input) => {
    const d = detectSeed(input);
    expect(d?.ambiguous).toBe(true);
    // Least-assertive: we do NOT assert a domain we cannot defend.
    expect(d?.kind).not.toBe("domain");
  });

  it.each([
    ["Ronny.doe"],
    ["john.smith"],
    ["foo.bar"],
  ])("marks the dotted handle %s ambiguous too, and never a domain", (input) => {
    const d = detectSeed(input);
    expect(d?.ambiguous).toBe(true);
    expect(d?.kind).toBe("username");
  });

  it.each([
    ["example.com"],
    ["sub.example.co.uk"],
    ["acme.io"],
  ])("does not mark the confident domain %s ambiguous", (input) => {
    expect(detectSeed(input)?.ambiguous).toBeFalsy();
  });

  it.each([
    ["ronny.doe@example.com"],
    ["https://example.com/x"],
    ["213.193.180.72"],
    ["+15550001111"],
    ["plainhandle"],
  ])("does not mark the unambiguous selector %s ambiguous", (input) => {
    expect(detectSeed(input)?.ambiguous).toBeFalsy();
  });

  it("surfaces the ambiguity in the report rather than hiding it", () => {
    const md = buildReportMarkdown({
      seedValue: "Ronny.doe",
      seedType: "username",
      artifacts: [],
    });
    const seedSection = md.split("## Seed Details")[1]?.split("\n## ")[0] ?? "";
    expect(seedSection).toMatch(/ambiguous/i);
    expect(seedSection).not.toContain("**Type:** domain");
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
