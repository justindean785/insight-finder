import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Regression guard (beta P0 #4): no real-looking personal identifier may live in
 * code paths that are SHIPPED to users as seed examples or sample report data.
 *
 * The exposure we are guarding against: a real person's email (e.g. an @icloud /
 * @gmail address pulled from a live investigation) being used as the seed-example
 * chip shown to every user, or baked into the /report-preview sample dossier.
 *
 * Rule: any email literal in these files must use a reserved RFC2606 domain
 * (example.com / .net / .org). Consumer mailbox domains (gmail, icloud, …) are
 * the signature of a real personal address and are forbidden here. A legitimate
 * support address (e.g. support@<our-domain>) is NOT a consumer mailbox, so this
 * guard does not interfere with the beta contact link.
 */

const FILES = [
  "src/components/ChatWindow.tsx", // seed-example chips in the empty state
  "src/pages/ReportPreview.tsx", // /report-preview sample dossier
  "src/lib/seed.ts", // display-seed extraction doc examples
];

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

// Consumer/personal mailbox providers — the fingerprint of a real person's address.
const CONSUMER_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "yahoo.com",
  "ymail.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "att.net",
  "comcast.net",
  "msn.com",
];

const RESERVED = ["example.com", "example.net", "example.org"];

describe("no real-looking PII in shipped seed/sample data (#4 guard)", () => {
  for (const rel of FILES) {
    const path = resolve(process.cwd(), rel);
    const src = readFileSync(path, "utf8");
    const emails = Array.from(src.matchAll(EMAIL_RE), (m) => m[0]);

    it(`${rel}: every email literal uses a reserved example.* domain`, () => {
      const offenders = emails.filter(
        (e) => !RESERVED.some((d) => e.toLowerCase().endsWith("@" + d)),
      );
      expect(offenders, `non-synthetic email(s) in ${rel}`).toEqual([]);
    });

    it(`${rel}: contains no consumer-mailbox (real-person) address`, () => {
      const offenders = emails.filter((e) =>
        CONSUMER_DOMAINS.some((d) => e.toLowerCase().endsWith("@" + d)),
      );
      expect(offenders, `real-looking personal email(s) in ${rel}`).toEqual([]);
    });
  }
});
