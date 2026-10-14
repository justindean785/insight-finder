/**
 * seed-account-id.test.ts — a platform account ID is not a phone number or a place.
 *
 * Observed on one live Discord-ID case (2026-09-25): the seed "<19-digit Discord ID> discord ID" rendered as
 * `Type: phone` and `Detected location target: ID` — the 19-digit snowflake matched the phone pattern (E.164 caps a
 * phone number at 15 digits) and the word "ID" matched Idaho in the state table. The whole Seed-Location section and
 * "No direct ID corroboration found" were fabricated from that.
 *
 * This file covers SEED PARSING only. (The matching edge classifier is supabase/functions/osint-agent/validation.ts and
 * ships in its own edge PR; zero-hit-lookup evidence semantics are deliberately NOT part of this change.)
 *
 * VALUES ARE SYNTHETIC — CLAUDE.md forbids real investigation PII in this repo.
 */
import { describe, expect, it } from "vitest";
import { buildIdentityClusters, buildReportMarkdown } from "@/lib/intel";
import { detectSeed, extractDisplaySeed } from "@/lib/seed";

const SNOWFLAKE = "1234567890123456789"; // 19 digits, synthetic
const HANDLE = "sample4242";
const ID_SEED = `${SNOWFLAKE} discord ID`;

describe("seed parsing — platform account IDs are not phones", () => {
  it("a bare digit run past E.164's 15 digits is an account id (`other`), not a phone or a username", () => {
    for (const id of [SNOWFLAKE, "12345678901234567", "76561197960287930", "12345678901234567890", "1234567890123456"]) {
      expect(detectSeed(id)?.kind, id).toBe("other");
      expect(detectSeed(id)?.normalized, id).toBe(id);
    }
  });

  it("the display seed does not call '<id> discord ID' a phone", () => {
    expect(extractDisplaySeed(ID_SEED, "other").kind).not.toBe("phone");
    expect(extractDisplaySeed(SNOWFLAKE, "other").kind).not.toBe("phone");
  });

  it("real phone numbers still classify as phone, including the 15-digit E.164 ceiling", () => {
    for (const p of ["+1 (555) 010-0199", "+44 20 7946 0958", "555-010-0199", "+15550100199", "123456789012345"]) {
      expect(detectSeed(p)?.kind, p).toBe("phone");
    }
    expect(extractDisplaySeed("call +1 555 010 0199 re: case", "other").kind).toBe("phone");
  });

  it("a punctuated value past 15 digits is not a phone either", () => {
    expect(detectSeed("+1 234 567 890 123 456 78")?.kind).not.toBe("phone");
  });
});

describe("seed parsing — 'ID' beside an account number or platform is the word ID, not Idaho", () => {
  it("'<id> discord ID' yields no location target and no phantom subject", () => {
    const r = buildIdentityClusters([], ID_SEED);
    expect(r.seedState).toBeNull();
    expect(r.seedName).toBeNull();
    const md = buildReportMarkdown({ seedValue: ID_SEED, seedType: "other", artifacts: [] });
    expect(md).not.toContain("Detected location target");
    expect(md).not.toContain("## Seed-Location Match");
  });

  it("'discord id <handle>' is not Idaho", () => {
    expect(buildIdentityClusters([], `discord id ${HANDLE}`).seedState).toBeNull();
  });

  it("genuine name+location seeds keep their state, Idaho included", () => {
    expect(buildIdentityClusters([], "jane roe boise id").seedState).toBe("ID");
    expect(buildIdentityClusters([], "jane roe sacramento ca").seedState).toBe("CA");
  });

  it("a ZIP code (5 digits) still counts as part of a place, not an account id", () => {
    expect(buildIdentityClusters([], "jane roe boise id 83702").seedState).toBe("ID");
  });
});
