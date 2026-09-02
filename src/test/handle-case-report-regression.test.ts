/**
 * handle-case-report-regression — pins, on ONE synthetic report, every
 * report-layer defect the 2026-09-02 production export showed:
 *
 *   1. cluster headers above every member's evidence (98 / 95 / 90 over ≤70);
 *   2. "Engine-adjudicated findings: none" one heading above "Key Findings"
 *      listing rows, with nothing to say they are different populations;
 *   3. the subject's public footprint filed under **Other** and a contradiction
 *      record printed as a network connection;
 *   4. one selector listed twice under two kind spellings, a Dismiss on one
 *      twin leaving the other authoritative;
 *   5. one tool printed as six Tool Coverage lines.
 *
 * Fixture values are invented; see fixtures/handle-case.ts for the shape.
 */
import { describe, it, expect } from "vitest";
import { buildIdentityClusters, buildReportMarkdown, buildToolAudit, GROUP_LABEL } from "@/lib/intel";
import { effectiveConfidenceOrZero } from "@/lib/display-confidence";
import { keyFindingsFraming } from "@/lib/authoritative-findings";
import { foldAliasTwins, isNonEntityArtifact } from "@/lib/report-hygiene";
import {
  CONTRADICTION_VALUE, EVENT_VALUE, HANDLE_CASE_REVIEWS, HANDLE_EMAIL, HANDLE_SEED, LEGAL_RECORD_VALUE, ORG_VALUE,
  SOCIAL_ACCOUNT_VALUE, TWIN_IP, TWIN_URL, WEAK_LEAD_VALUE, handleCaseArtifacts, handleCaseAuthority,
} from "./fixtures/handle-case";

const section = (md: string, heading: string): string => {
  const start = md.indexOf(`## ${heading}`);
  if (start === -1) return "";
  const next = md.indexOf("\n## ", start + 1);
  return next === -1 ? md.slice(start) : md.slice(start, next);
};
const sectionStartingWith = (md: string, prefix: string): string => {
  const start = md.indexOf(`## ${prefix}`);
  if (start === -1) return "";
  const next = md.indexOf("\n## ", start + 1);
  return next === -1 ? md.slice(start) : md.slice(start, next);
};

const build = () => {
  const artifacts = handleCaseArtifacts();
  return {
    artifacts,
    md: buildReportMarkdown({
      seedValue: HANDLE_SEED, seedType: "username", artifacts, messages: [],
      reviews: HANDLE_CASE_REVIEWS, authority: handleCaseAuthority(artifacts.length),
    }),
  };
};

describe("handle-case report regression", () => {
  it("1. no cluster headline exceeds its strongest member's EFFECTIVE confidence", () => {
    const { artifacts } = build();
    const report = buildIdentityClusters(artifacts, HANDLE_SEED, HANDLE_CASE_REVIEWS);
    const email = report.clusters.find((c) => c.emails.includes(HANDLE_EMAIL));
    expect(email, "the EMAIL_MATCH cluster forms").toBeTruthy();
    expect(email!.mergeReasons.some((r) => r.startsWith("EMAIL_MATCH"))).toBe(true);
    for (const c of report.clusters) {
      const memberMax = Math.max(...c.artifacts.map((a) => effectiveConfidenceOrZero(a)));
      expect(c.confidence, `${c.label} headline ${c.confidence} vs member max ${memberMax}`).toBeLessThanOrEqual(memberMax);
    }
    // The member stored at 95 is capped at 70 by the server: the headline is ≤70,
    // not the 90+ that raw-mean + EMAIL_MATCH (35) would have produced.
    expect(email!.confidence).toBeLessThanOrEqual(70);
    expect(email!.confidence).toBeGreaterThanOrEqual(60);
  });

  it("2. the Key Findings heading and lead say these are leads, not engine findings", () => {
    const { md } = build();
    expect(md).toContain("adjudicated no findings");
    expect(md).toContain("## Key Findings — leads (not engine-adjudicated)");
    const kf = sectionStartingWith(md, "Key Findings");
    expect(kf).toContain("analyst-confirmed");
    expect(kf).toContain("none was scored by the engine");
    expect(kf).not.toContain("_No findings recorded yet._");
  });

  it("2b. keyFindingsFraming is plain when the engine DID score findings", () => {
    const framed = keyFindingsFraming(
      { state: "complete", findings: [{ id: "f", value: "x", confidence: 80, tier: "probable", origin: "model" }], rejectedCount: 0, totalArtifacts: 1 },
      { corroborated: 2, attested: 1 },
    );
    expect(framed).toEqual({ heading: "Key Findings", lead: null });
    expect(keyFindingsFraming(undefined, { corroborated: 0, attested: 3 })).toEqual({ heading: "Key Findings", lead: null });
  });

  it("3. the network section has no Other dumping ground and no meta rows", () => {
    const { md } = build();
    const net = section(md, "Network Connections");
    expect(net).not.toContain(`**${GROUP_LABEL.other}**`);
    expect(net).toContain(`**${GROUP_LABEL.affiliation}**`);
    expect(net).toContain(ORG_VALUE);
    expect(net).toContain(`**${GROUP_LABEL.records}**`);
    expect(net).toContain(EVENT_VALUE);
    expect(net).toContain(LEGAL_RECORD_VALUE);
    expect(net).toContain(SOCIAL_ACCOUNT_VALUE);
    // the contradiction record and the weak lead describe the case, they are not nodes in it
    expect(net).not.toContain(CONTRADICTION_VALUE);
    expect(net).not.toContain(WEAK_LEAD_VALUE);
    // …but neither disappears from the document
    const table = section(md, "Artifact / Entity Table");
    expect(table).toContain(CONTRADICTION_VALUE);
    expect(table).toContain(WEAK_LEAD_VALUE);
  });

  it("3b. isNonEntityArtifact keys on kind, conflict flag, or detector source", () => {
    expect(isNonEntityArtifact({ kind: "contradiction", metadata: {} })).toBe(true);
    expect(isNonEntityArtifact({ kind: "email", metadata: { conflict: true } })).toBe(true);
    expect(isNonEntityArtifact({ kind: "email", metadata: {}, source: "collision_detector" })).toBe(true);
    expect(isNonEntityArtifact({ kind: "email", metadata: {}, source: "hunter_email_verifier + detect_contradictions" })).toBe(true);
    expect(isNonEntityArtifact({ kind: "email", metadata: {}, source: "hunter_email_verifier" })).toBe(false);
    expect(isNonEntityArtifact({ kind: "organization", metadata: {} })).toBe(false);
  });

  it("4. alias twins print as ONE row, and a Dismiss on either twin binds", () => {
    const { md } = build();
    const table = section(md, "Artifact / Entity Table");
    const ipRows = table.split("\n").filter((l) => l.includes(TWIN_IP));
    expect(ipRows, ipRows.join("\n")).toHaveLength(1);
    // the dismissed twin represents the pair → FAILED, and out of the network
    expect(ipRows[0]).toContain("FAILED");
    expect(section(md, "Network Connections")).not.toContain(TWIN_IP);
    const urlRows = table.split("\n").filter((l) => l.includes(TWIN_URL));
    expect(urlRows, urlRows.join("\n")).toHaveLength(1);
    // provenance of both twins survives on the representative
    expect(urlRows[0]).toMatch(/username sweep|Sweeping platforms/i);
    expect(urlRows[0]).toMatch(/deep dork|deep search/i);
  });

  it("4b. foldAliasTwins keeps the strongest twin unless one is rejected, and never folds different values", () => {
    const arts = handleCaseArtifacts();
    const folded = foldAliasTwins(arts, {});
    const ip = folded.filter((a) => a.value === TWIN_IP);
    expect(ip).toHaveLength(1);
    expect(ip[0].id).toBe("twin-ip-b");
    expect(ip[0].metadata?.folded_kinds).toEqual(["ip_address"]);
    expect(ip[0].source).toBe("oathnet_lookup + ip_intel + shodan_internetdb"); // first-seen order, union of both twins
    const withReject = foldAliasTwins(arts, { "twin-ip-a": "dismissed" });
    expect(withReject.find((a) => a.value === TWIN_IP)!.id).toBe("twin-ip-a");
    // distinct values never fold; row count only drops by the two pairs
    expect(folded).toHaveLength(arts.length - 2);
    // case-sensitive on the value — a differently-cased URL is a different row
    const cased = foldAliasTwins([arts.find((a) => a.id === "twin-url-a")!, { ...arts.find((a) => a.id === "twin-url-b")!, value: TWIN_URL.toUpperCase() }]);
    expect(cased).toHaveLength(2);
  });

  it("5. one tool is ONE Tool Coverage line, whatever its source string spelling", () => {
    const { md, artifacts } = build();
    const cov = section(md, "Tool Coverage Summary");
    const sweepLines = cov.split("\n").filter((l) => /sweep/i.test(l));
    expect(sweepLines, cov).toHaveLength(1);
    expect(sweepLines[0]).toMatch(/[78] results/);
    const audit = buildToolAudit(artifacts, HANDLE_CASE_REVIEWS);
    const sweep = audit.tools.find((t) => t.tool === "username_sweep");
    expect(sweep?.variants).toHaveLength(6);
    // the dismissed twin counts as failed for its tool, through the review
    const oath = audit.tools.find((t) => t.tool === "oathnet_lookup");
    expect(oath?.failed).toBe(1);
  });

  it("seed details do not call a handle seed 'other'", () => {
    const { md } = build();
    expect(section(md, "Seed Details")).not.toMatch(/\*\*Type:\*\* other/);
  });
});
