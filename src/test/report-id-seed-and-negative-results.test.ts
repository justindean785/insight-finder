/**
 * report-id-seed-and-negative-results.test.ts
 *
 * Three report defects observed on one live Discord-ID case (2026-09-25):
 *
 *  1. SEED PARSING. The seed "<19-digit Discord ID> discord ID" rendered as
 *     `Type: phone` and `Detected location target: ID` — the 19-digit snowflake
 *     matched the phone pattern (E.164 caps a phone number at 15 digits), and the
 *     word "ID" matched Idaho in the state table. The whole Seed-Location section
 *     and "No direct ID corroboration found" were fabricated from that.
 *
 *  2. NEGATIVE RESULTS AS EVIDENCE. Zero-hit breach lookups on emails the model
 *     GUESSED (`<handle>@outlook/yahoo`) merged into the subject's cluster on the
 *     email's local-part and contributed the `breach` class, so the report read
 *     "3 independent source classes" for a cluster whose only independent
 *     observation was one profile lookup. A lookup that found nothing observed
 *     nothing: it can neither link a selector to a subject nor corroborate one.
 *
 *  3. "HIGH-CONFIDENCE" = ANALYST CLICK. Tool Coverage counted ATTESTED rows as
 *     high-confidence, so a vision summary at confidence 45 read "1 high-confidence".
 *
 * VALUES ARE SYNTHETIC — CLAUDE.md forbids real investigation PII in this repo.
 */
import { describe, expect, it } from "vitest";
import {
  buildIdentityClusters,
  buildReportMarkdown,
  buildToolAudit,
  isNegativeResultArtifact,
} from "@/lib/intel";
import { detectSeed, extractDisplaySeed } from "@/lib/seed";
import type { Artifact } from "@/hooks/useThreadArtifacts";

const NOW = "2026-09-25T18:00:00.000Z";
const SNOWFLAKE = "1234567890123456789";
const HANDLE = "sample4242";
const ID_SEED = `${SNOWFLAKE} discord ID`;

let n = 0;
function art(kind: string, value: string, source: string, meta: Record<string, unknown>, confidence = 55): Artifact {
  n++;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    kind,
    value,
    confidence,
    source,
    created_at: NOW,
    metadata: meta,
  } as Artifact;
}

function section(md: string, heading: string): string {
  const start = md.indexOf(heading);
  if (start === -1) return "";
  const after = start + heading.length;
  const next = md.indexOf("\n## ", after);
  return md.slice(after, next === -1 ? undefined : next);
}

describe("seed parsing — platform account IDs are not phones or places", () => {
  it("a 19-digit snowflake is not a phone number (E.164 max is 15 digits)", () => {
    expect(detectSeed(SNOWFLAKE)?.kind).not.toBe("phone");
    expect(extractDisplaySeed(ID_SEED, "other").kind).not.toBe("phone");
  });

  it("real phone numbers still classify as phone", () => {
    expect(detectSeed("+1 (555) 010-0199")?.kind).toBe("phone");
    expect(detectSeed("+44 20 7946 0958")?.kind).toBe("phone");
    expect(extractDisplaySeed("call +1 555 010 0199 re: case", "other").kind).toBe("phone");
  });

  it("'<id> discord ID' yields no location target and no phantom subject", () => {
    const r = buildIdentityClusters([], ID_SEED);
    expect(r.seedState).toBeNull();
    expect(r.seedName).toBeNull();
    const md = buildReportMarkdown({ seedValue: ID_SEED, seedType: "other", artifacts: [] });
    expect(md).not.toContain("Detected location target");
    expect(md).not.toContain("## Seed-Location Match");
  });

  it("'ID' next to a platform word is the word ID, not Idaho", () => {
    expect(buildIdentityClusters([], `discord id ${HANDLE}`).seedState).toBeNull();
  });

  it("genuine name+location seeds keep their state, Idaho included", () => {
    expect(buildIdentityClusters([], "jane roe boise id").seedState).toBe("ID");
    expect(buildIdentityClusters([], "jane roe sacramento ca").seedState).toBe("CA");
  });
});

describe("negative results — a zero-hit lookup is not an observation", () => {
  const profile = art("username", HANDLE, "cordcat_discord_lookup", {
    platform: "discord", discord_id: SNOWFLAKE, source_category: ["social_profile_active"],
  }, 70);
  const sweep = art("social_profile", `Roblox profile ${HANDLE}`, "username_sweep", {
    platform: "roblox", username: HANDLE, source_category: ["username_sweep"],
  }, 35);
  const guessedOutlook = art("breach_exposure", `${HANDLE}@outlook.test — 0 breach hits via RapidAPI`, "rapidapi_breach_search", {
    email: `${HANDLE}@outlook.test`, breaches_found: 0, source_category: ["breach"],
  });
  const guessedYahoo = art("breach_exposure", `${HANDLE}@yahoo.test — 0 breach hits via RapidAPI`, "rapidapi_breach_search", {
    email: `${HANDLE}@yahoo.test`, breaches_found: 0, source_category: ["breach"],
  });
  const github404 = art("social_profile", `GitHub ${HANDLE} — 404 not found`, "github_user", {
    platform: "github", handle: HANDLE, http_status: 404, source_category: ["social_profile_active"],
  }, 35);
  const twitterAbsent = art("social_profile", `Twitter/X ${HANDLE} — not found`, "socialfetch_lookup", {
    platform: "twitter", handle: HANDLE, lookup_status: "not_found", source_category: ["independent_public"],
  }, 35);
  const negatives = [guessedOutlook, guessedYahoo, github404, twitterAbsent];
  const all = [profile, sweep, ...negatives];

  it("classifies zero-hit and not-found rows as negative, and hits as not", () => {
    for (const a of negatives) expect(isNegativeResultArtifact(a)).toBe(true);
    expect(isNegativeResultArtifact(profile)).toBe(false);
    expect(isNegativeResultArtifact(sweep)).toBe(false);
    const hit = art("breach_exposure", `${HANDLE}@outlook.test — 3 breaches`, "rapidapi_breach_search", {
      email: `${HANDLE}@outlook.test`, breaches_found: 3, source_category: ["breach"],
    });
    expect(isNegativeResultArtifact(hit)).toBe(false);
  });

  it("negative rows never join the subject's cluster", () => {
    const r = buildIdentityClusters(all, ID_SEED);
    const negIds = new Set(negatives.map((a) => a.id));
    for (const c of r.clusters) {
      expect(c.artifacts.some((a) => negIds.has(a.id))).toBe(false);
      expect(c.mergeReasons.join(" ")).not.toContain("@outlook.test");
      expect(c.mergeReasons.join(" ")).not.toContain("@yahoo.test");
    }
  });

  it("negative rows never count toward cluster corroboration", () => {
    const md = buildReportMarkdown({ seedValue: ID_SEED, seedType: "other", artifacts: all });
    const corroborated = section(md, "## What Is Actually Corroborated");
    expect(corroborated).not.toContain("independent source classes:");
  });

  it("a breach row WITH hits still merges on its email (control)", () => {
    const e = `${HANDLE}@example.test`;
    const hitA = art("breach_exposure", `${e} — 3 breaches`, "rapidapi_breach_search", {
      email: e, breaches_found: 3, source_category: ["breach"],
    });
    const hitB = art("email", e, "hunter_email_verifier", { source_category: ["email_verification"] });
    const r = buildIdentityClusters([hitA, hitB], ID_SEED);
    expect(r.clusters.some((c) => c.artifacts.length === 2)).toBe(true);
  });
});

describe("tool coverage — analyst confirmation is not high confidence", () => {
  it("an ATTESTED row at confidence 45 is not counted high-confidence", () => {
    const avatar = art("avatar", "avatar description", "gemini_vision", { source_category: ["ai_summary"] }, 45);
    const audit = buildToolAudit([avatar], { [avatar.id]: "confirmed" });
    const entry = audit.tools.find((t) => t.tool.includes("gemini"))!;
    expect(entry.highConf).toBe(0);
    expect(entry.attested).toBe(1);
  });

  it("the report line says analyst-confirmed, not high-confidence", () => {
    const avatar = art("avatar", "avatar description", "gemini_vision", { source_category: ["ai_summary"] }, 45);
    const md = buildReportMarkdown({
      seedValue: ID_SEED, seedType: "other", artifacts: [avatar], reviews: { [avatar.id]: "confirmed" },
    });
    const cov = section(md, "## Tool Coverage Summary");
    expect(cov).toContain("0 high-confidence");
    expect(cov).toContain("1 analyst-confirmed");
  });
});
