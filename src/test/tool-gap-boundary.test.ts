/**
 * "Recommended Next Steps" is a spend recommendation, so the quarantine and
 * alias boundaries have to bind on it too.
 *
 * Both defects below were measured by running the real `buildToolAudit` +
 * `inferToolGaps` over the 2026-09-12 `baig_azhar` production export, and both
 * tests drive those same two functions rather than restating their tables.
 */
import { describe, it, expect } from "vitest";
import { buildToolAudit, inferToolGaps, buildReportMarkdown } from "@/lib/intel";
import type { Artifact } from "@/hooks/useThreadArtifacts";

/** The selector kinds the report's "Recommended Next Steps" section spends on. */
function nextStepKinds(markdown: string): string[] {
  const section = markdown.split("## Recommended Next Steps")[1] ?? "";
  const body = section.split(/^## /m)[0];
  return [...body.matchAll(/^- \*\*([a-z_]+)\*\* —/gm)].map((m) => m[1]);
}

let seq = 0;
function artifact(kind: string, value: string, metadata: Record<string, unknown> = {}): Artifact {
  return {
    id: `a${++seq}`,
    kind,
    value,
    confidence: 40,
    source: "oathnet_lookup",
    created_at: "2026-09-12T05:26:20.029Z",
    metadata: { status: "observed", ...metadata },
  };
}

/** The shape the name-only harvest writes: quarantined, reason recorded. */
const QUARANTINED = {
  subject_unlinked: true,
  subject_unlinked_reason:
    "harvested from a name-only query — same-name collision axis; linkage to the subject is unproven",
};

describe("tool gaps do not recommend spending on quarantined selectors", () => {
  it("a case whose only URL is quarantined gets no URL tool recommendations", () => {
    // Verbatim from the production export: the single `url` artifact on the
    // case was a name-only collision hit, and the report still recommended
    // http_fingerprint, archive_url, wayback_snapshots and urlscan_search.
    const artifacts = [
      artifact("url", "http://www.linkedin.com/in/azhar-baig-34a73431", QUARANTINED),
      artifact("email", "baigazhar042@gmail.com"),
    ];
    const md = buildReportMarkdown({ seedValue: "baig_azhar", seedType: "username", artifacts });

    // Anchor on the kind heading, not the tool names: "Recommended Next Steps"
    // renders each tool through `humanizeTool`, so asserting on the raw
    // `http_fingerprint` string would pass whether or not the fix is present.
    expect(nextStepKinds(md)).not.toContain("url");
    // The un-quarantined email still drives its own recommendations — the fix
    // removes authority from quarantined rows, never from the working set.
    expect(nextStepKinds(md)).toContain("email");
    // And at the layer the report reads from, the gap itself is gone.
    expect(inferToolGaps(buildToolAudit(artifacts, undefined)).map((g) => g.kind)).toContain("url");
  });

  it("an explicit linkage_confirmed release restores the recommendations", () => {
    const released = artifact("url", "https://example.com/profile", {
      ...QUARANTINED,
      linkage_confirmed: true,
    });
    const gaps = inferToolGaps(buildToolAudit([released], undefined));
    expect(gaps.map((g) => g.kind)).toContain("url");
  });

  it("an analyst-rejected row still contributes nothing (unchanged behaviour)", () => {
    const rejected = artifact("url", "https://example.com/profile");
    const md = buildReportMarkdown({
      seedValue: "x", seedType: "username", artifacts: [rejected],
      reviews: { [rejected.id]: "dismissed" },
    });
    expect(nextStepKinds(md)).not.toContain("url");
  });
});

describe("tool gaps read the kind through the alias table", () => {
  it("`ip_address` earns IP tool recommendations, exactly as `ip` does", () => {
    // The auto-persist path writes `ip_address` and the model's
    // record_artifacts path writes `ip`. Before the fix `SUGGESTED_TOOLS_BY_KIND`
    // was matched against the raw spelling, so eight `ip_address` rows on the
    // production case were invisible to gap inference.
    const viaAlias = inferToolGaps(buildToolAudit([artifact("ip_address", "68.32.250.40")], undefined));
    const viaCanonical = inferToolGaps(buildToolAudit([artifact("ip", "68.32.250.40")], undefined));
    expect(viaAlias).toEqual(viaCanonical);
    expect(viaAlias.map((g) => g.kind)).toContain("ip");
  });

  it("every aliased spelling of a suggested kind resolves to that kind", () => {
    const cases: Array<[string, string, string]> = [
      ["ip_address", "68.32.250.40", "ip"],
      ["handle", "baig_azhar", "username"],
      ["social", "baig_azhar", "username"],
      ["subdomain", "mail.example.com", "domain"],
      ["crypto", "0x0000000000000000000000000000000000000001", "wallet"],
    ];
    for (const [kind, value, expected] of cases) {
      const gaps = inferToolGaps(buildToolAudit([artifact(kind, value)], undefined));
      expect(gaps.map((g) => g.kind), `${kind} should cover ${expected}`).toContain(expected);
    }
  });
});
