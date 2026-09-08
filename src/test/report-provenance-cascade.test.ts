/**
 * report-provenance-cascade.test.ts — analyst rejection follows the EVIDENCE
 * CHAIN, not just the row that was clicked.
 *
 * Production defect, thread b74049ad (seed @glitterkittens12, 2026-09-08). An
 * OathNet breach match on the seed handle produced a whole identity branch
 * rooted at `dgoff1276@gmail.com`. The analyst rejected the root; the two
 * plaintext breach passwords extracted FROM that email survived into the
 * exported report's "Network Connections — Breach / Exposure" section, listed as
 * part of the subject's network, because their literal values differ from the
 * value that was rejected. The agent itself had already written "this is a
 * completely different identity profile from what the breach data suggested".
 */
import { describe, expect, it } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { buildReportMarkdown } from "@/lib/intel";

let seq = 0;
function art(p: Partial<Artifact> & { kind: string; value: string }): Artifact {
  seq += 1;
  return {
    id: p.id ?? `pc${seq}`,
    kind: p.kind,
    value: p.value,
    confidence: p.confidence ?? 60,
    source: p.source ?? "oathnet_lookup",
    created_at: p.created_at ?? `2026-09-08T06:5${seq % 10}:00Z`,
    metadata: p.metadata ?? {},
  };
}

// The real branch, in the shape the run recorded it.
const EMAIL = art({ id: "email", kind: "email", value: "dgoff1276@gmail.com" });
const PW1 = art({
  id: "pw1", kind: "hash", source: "serus_darkweb_scan",
  value: "alex12 (plaintext password — Wishbone 2016 breach)",
  metadata: { parent_selector: "dgoff1276@gmail.com" },
});
const PW2 = art({
  id: "pw2", kind: "hash", source: "serus_darkweb_scan",
  value: "233696sps (plaintext password — Wattpad 2020 breach)",
  metadata: { parent_selector: "dgoff1276@gmail.com" },
});
const ALT = art({
  id: "alt", kind: "username", source: "serus_darkweb_scan", value: "diamondnicole7",
  metadata: { parent_selector: "dgoff1276@gmail.com" },
});
// Kept evidence — no rejected provenance.
const IG = art({
  id: "ig", kind: "social_profile", source: "socialfetch_lookup", confidence: 40,
  value: "Instagram: @glitterkittens12 — displayName 'Sac Archives'",
});

const ALL = [EMAIL, PW1, PW2, ALT, IG];
const REVIEWS = { email: "wrong" } as Record<string, string>;

function report(reviews?: Record<string, string>) {
  return buildReportMarkdown({
    seedValue: "glitterkittens12", seedType: "username", artifacts: ALL, reviews,
  });
}

/** The body of one `##` section, so an assertion can't pass on a mention elsewhere. */
function section(md: string, heading: string): string {
  const parts = md.split(`## ${heading}`);
  if (parts.length < 2) return "";
  return parts[1].split("\n## ")[0];
}

describe("rejection cascades through provenance", () => {
  it("FAILURE-FIRST: with no verdict, the whole breach branch is active in Network Connections", () => {
    const net = section(report(), "Network Connections");
    expect(net).toContain("alex12");
    expect(net).toContain("233696sps");
  });

  it("⛔ rejecting the parent email removes its derived passwords from Network Connections", () => {
    const net = section(report(REVIEWS), "Network Connections");
    expect(net).not.toContain("alex12");
    expect(net).not.toContain("233696sps");
    expect(net).not.toContain("diamondnicole7");
    expect(net).not.toContain("dgoff1276@gmail.com");
  });

  it("⛔ derived rows are not recommended as next pivots", () => {
    const next = section(report(REVIEWS), "Recommended Next Steps");
    // The rejected email must not still be driving email-tool recommendations.
    expect(next).not.toContain("**email**");
  });

  it("⛔ evidence with no rejected provenance is untouched — rejection removes a branch, not the case", () => {
    const net = section(report(REVIEWS), "Network Connections");
    expect(net).toContain("Sac Archives");
  });

  it("⛔ excluded rows are PRESERVED and reasoned, never deleted", () => {
    const md = report(REVIEWS);
    const appendix = section(md, "Excluded by Analyst");
    expect(appendix).toContain("dgoff1276@gmail.com");
    expect(appendix).toContain("analyst rejected");
    expect(appendix).toContain("alex12");
    expect(appendix).toContain("derived solely from rejected evidence");
    // Chain of custody: every row still appears in the forensic table.
    const table = section(md, "Artifact / Entity Table");
    for (const v of ["dgoff1276@gmail.com", "alex12", "233696sps", "diamondnicole7"]) {
      expect(table).toContain(v);
    }
    // ...and the appendix says plainly that none of it supports the subject.
    expect(appendix).toContain("do NOT support the subject identity".replace("do NOT", "do NOT"));
  });
});
