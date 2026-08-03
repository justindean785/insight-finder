import { describe, it, expect } from "vitest";
import {
  exclusionReason,
  isExcludedArtifact,
  partitionExcluded,
} from "@/lib/exclusion";
import {
  labelForArtifact,
  buildToolAudit,
  buildEvidenceMatrixMarkdown,
  buildTimelineItems,
  buildInvestigationSummary,
  buildReportMarkdown,
  looksLikeStructuredBlob,
  detectNameLocationSeed,
  mdCodeSpan,
} from "@/lib/intel";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { ReviewState } from "@/lib/review";

const art = (over: Partial<Artifact> = {}): Artifact => ({
  id: "1",
  kind: "email",
  value: "a@b.com",
  confidence: 60,
  source: "whois",
  created_at: "2026-08-01T00:00:00.000Z",
  metadata: null,
  ...over,
});

// ---------------------------------------------------------------------------
// The predicate itself — composed from the EXISTING taxonomy, no new states.
// ---------------------------------------------------------------------------

describe("exclusion predicate", () => {
  it("excludes analyst-rejected rows (dismissed / wrong)", () => {
    expect(exclusionReason(art(), "dismissed")).toBe("analyst_rejected");
    expect(exclusionReason(art(), "wrong")).toBe("analyst_rejected");
  });

  it("does NOT exclude non-rejecting review states", () => {
    for (const r of ["new", "confirmed", "key", "recheck", null, undefined] as const) {
      expect(exclusionReason(art(), r)).toBeNull();
    }
  });

  it("excludes pipeline collision rows", () => {
    expect(exclusionReason(art({ kind: "excluded_collision" }), null)).toBe("collision");
    expect(exclusionReason(art({ metadata: { collision: true } }), null)).toBe("collision");
    expect(exclusionReason(art({ metadata: { status: "excluded" } }), null)).toBe("collision");
  });

  it("excludes the bare `excluded` kind", () => {
    expect(exclusionReason(art({ kind: "excluded" }), null)).toBe("pipeline_excluded");
  });

  it("ranks analyst rejection above pipeline reasons", () => {
    // An analyst verdict is the more specific, more accountable reason.
    expect(exclusionReason(art({ kind: "excluded_collision" }), "wrong")).toBe("analyst_rejected");
  });

  it("isExcludedArtifact agrees with exclusionReason", () => {
    expect(isExcludedArtifact(art(), "dismissed")).toBe(true);
    expect(isExcludedArtifact(art(), "confirmed")).toBe(false);
  });

  it("partitionExcluded splits without losing rows", () => {
    const rows = [art({ id: "a" }), art({ id: "b" }), art({ id: "c", kind: "excluded" })];
    const { included, excluded } = partitionExcluded(rows, { b: "dismissed" });
    expect(included.map((r) => r.id)).toEqual(["a"]);
    expect(excluded.map((r) => r.artifact.id).sort()).toEqual(["b", "c"]);
    expect(excluded.map((r) => r.reason).sort()).toEqual(["analyst_rejected", "pipeline_excluded"]);
    expect(included.length + excluded.length).toBe(rows.length);
  });
});

// ---------------------------------------------------------------------------
// excluded / excluded_collision must never render VERIFY.
// ---------------------------------------------------------------------------

describe("labelForArtifact — excluded rows never read VERIFY", () => {
  it("excluded_collision does not label VERIFY", () => {
    // confidence 60 with a single source class would otherwise land on VERIFY.
    const a = art({ kind: "excluded_collision", confidence: 60 });
    expect(labelForArtifact(a)).not.toBe("VERIFY");
    expect(labelForArtifact(a)).toBe("FAILED");
  });

  it("bare excluded kind does not label VERIFY", () => {
    const a = art({ kind: "excluded", confidence: 60 });
    expect(labelForArtifact(a)).not.toBe("VERIFY");
    expect(labelForArtifact(a)).toBe("FAILED");
  });

  it("metadata.status=excluded does not label VERIFY", () => {
    const a = art({ confidence: 60, metadata: { status: "excluded" } });
    expect(labelForArtifact(a)).not.toBe("VERIFY");
  });

  it("leaves an ordinary conflict row on CONFLICT, not FAILED", () => {
    // Regression guard: the excluded short-circuit must not swallow CONFLICT.
    expect(labelForArtifact(art({ metadata: { conflict: true } }))).toBe("CONFLICT");
  });
});

// ---------------------------------------------------------------------------
// The four builders must honour reviews. Each of these leaked before.
// ---------------------------------------------------------------------------

describe("buildToolAudit — rejected rows must not count as high-confidence", () => {
  const rows = [art({ id: "x", confidence: 90, source: "github_user", kind: "username" })];

  it("counts a dismissed row as failed, not high-confidence", () => {
    const withReview = buildToolAudit(rows, { x: "dismissed" });
    const entry = withReview.tools[0];
    expect(entry.failed).toBe(1);
    expect(entry.highConf).toBe(0);
    expect(withReview.failedCount).toBe(1);
  });

  it("is unchanged when no reviews are supplied", () => {
    const bare = buildToolAudit(rows);
    expect(bare.tools[0].failed).toBe(0);
  });
});

describe("buildEvidenceMatrixMarkdown — rejected rows must render FAILED", () => {
  it("renders the review-adjusted label", () => {
    const rows = [art({ id: "x", confidence: 90, source: "github_user" })];
    const md = buildEvidenceMatrixMarkdown(rows, { x: "wrong" });
    expect(md).toContain("FAILED");
  });
});

describe("buildTimelineItems — rejected rows are marked failed", () => {
  it("types a dismissed artifact as a failed event", () => {
    const rows = [art({ id: "x" })];
    const items = buildTimelineItems(rows, null, undefined, { x: "dismissed" });
    const ev = items.find((i) => i.id === "x");
    expect(ev?.type).toBe("failed");
  });
});

describe("buildInvestigationSummary — must honour reviews it already receives", () => {
  it("counts a dismissed row as failed rather than verify/confirmed", () => {
    const summary = buildInvestigationSummary({
      seedValue: "a@b.com",
      seedType: "email",
      artifacts: [art({ id: "x", confidence: 90, source: "github_user" })],
      reviews: { x: "dismissed" },
    });
    expect(summary).toMatch(/Failed: 1/);
    expect(summary).toMatch(/Confirmed: 0/);
  });
});

// ---------------------------------------------------------------------------
// Report-level: rejected rows leave the analytical sections and appear in an
// explicit appendix instead of being silently dropped.
// ---------------------------------------------------------------------------

describe("buildReportMarkdown — rejected rows are excluded, not hidden", () => {
  const rejected = art({
    id: "bad",
    kind: "username",
    value: "REJECTED_HANDLE",
    confidence: 90,
    source: "github_user",
  });
  const kept = art({ id: "good", kind: "email", value: "kept@example.com" });

  const md = () =>
    buildReportMarkdown({
      seedValue: "a@b.com",
      seedType: "email",
      artifacts: [rejected, kept],
      reviews: { bad: "wrong" },
    });

  it("keeps the rejected value out of Network Connections", () => {
    const out = md();
    const network = out.split("## Network Connections")[1]?.split("##")[0] ?? "";
    expect(network).not.toContain("REJECTED_HANDLE");
    expect(network).toContain("kept@example.com");
  });

  it("surfaces the rejected row in an explicit Excluded appendix", () => {
    const out = md();
    expect(out).toContain("## Excluded from Analysis");
    const appendix = out.split("## Excluded from Analysis")[1] ?? "";
    expect(appendix).toContain("REJECTED_HANDLE");
  });

  it("does not double-count the rejected row in the artifact total", () => {
    // The header total must describe what was analysed.
    expect(md()).toMatch(/\*\*Artifacts recorded:\*\* 1\b/);
  });
});

// ---------------------------------------------------------------------------
// intel.ts:1070 — an adjusted number must not be attributed to the source.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// A pasted JSON/schema blob must not become a person-name seed.
// ---------------------------------------------------------------------------

describe("structured-blob seed gate", () => {
  const BLOB = '[{"module":"dhgate","schema":"module"},{"module":"x","schema":"y"}]';

  it("recognises the live blob that produced a phantom subject", () => {
    expect(looksLikeStructuredBlob(BLOB)).toBe(true);
  });

  it("recognises JSON objects, truncated pastes and markup", () => {
    expect(looksLikeStructuredBlob('{"name":"x"}')).toBe(true);
    expect(looksLikeStructuredBlob('[{"module":"dhgate",')).toBe(true); // truncated
    expect(looksLikeStructuredBlob("<div>John Smith</div>")).toBe(true);
  });

  it("does NOT flag legitimate name / name-location seeds", () => {
    for (const s of [
      "John Smith",
      "John Smith, Sacramento, CA 95814",
      "Samantha Pridgen Sacramento CA",
      "Mary-Jane O'Brien, Austin TX",
      'Bob "Bobby" Smith',
    ]) {
      expect(looksLikeStructuredBlob(s), s).toBe(false);
    }
  });

  it("yields no phantom subject for a pasted array", () => {
    expect(detectNameLocationSeed(BLOB)).toBeNull();
  });

  it("still detects a real name-location seed", () => {
    const got = detectNameLocationSeed("Samantha Pridgen Sacramento CA");
    expect(got).not.toBeNull();
    expect(got?.state).toBe("CA");
    // Positive assertion. The previous form was `not.toContain("schema")`, which
    // could never fail: "schema" is not in the input and no code path injects it.
    // Note the city token survives — only US STATE tokens are stripped from the
    // name, so "sacramento" is retained. Pinning the real value rather than a
    // flattering one.
    expect(got?.name).toBe("samantha pridgen sacramento");
  });
});

// ---------------------------------------------------------------------------
// Minor safety must survive exclusion. Regression for the defect where
// partitioning starved buildIdentityClusters' safety scan.
// ---------------------------------------------------------------------------

describe("minor-safety warnings survive exclusion", () => {
  const minor = art({
    id: "M", kind: "name", value: "Synthetic Minor (age 15)",
    confidence: 60, source: "whois",
    metadata: { possible_minor: true },
  });
  const adult = art({
    id: "A", kind: "social", value: "https://onlyfans.com/synthetic",
    confidence: 60, source: "web_search",
  });
  const build = (reviews?: Record<string, ReviewState>, extra: Artifact[] = []) =>
    buildReportMarkdown({
      seedValue: "seed@example.com", seedType: "email",
      artifacts: [minor, ...extra], reviews,
    });

  const MINOR_BANNER = /Possible minor-related signal detected/;
  const COLLISION = /SAFETY COLLISION/;

  it("keeps the minor banner when the row is analyst-dismissed", () => {
    expect(build()).toMatch(MINOR_BANNER);
    // The natural analyst action — "this is a minor, not our subject" — must not
    // delete the warning that tells the next reader a minor is implicated.
    expect(build({ M: "dismissed" })).toMatch(MINOR_BANNER);
  });

  it("keeps the minor banner when the row is pipeline-excluded", () => {
    const excludedMinor = art({
      id: "M2", kind: "excluded", value: "Synthetic Minor (age 15)",
      confidence: 60, source: "whois", metadata: { possible_minor: true },
    });
    const md = buildReportMarkdown({
      seedValue: "seed@example.com", seedType: "email", artifacts: [excludedMinor],
    });
    expect(md).toMatch(MINOR_BANNER);
  });

  it("keeps the adult x minor SAFETY COLLISION warning when the minor row is dismissed", () => {
    expect(build(undefined, [adult])).toMatch(COLLISION);
    expect(build({ M: "dismissed" }, [adult])).toMatch(COLLISION);
  });
});

// ---------------------------------------------------------------------------
// The Excluded appendix renders attacker-influenced values. It must not let
// them forge report structure.
// ---------------------------------------------------------------------------

// A backslash is NOT an escape inside a CommonMark code span, so a value is made
// inert by FENCING (a run of backticks longer than any run inside it), not by
// escaping. These assert structural inertness, not a literal encoding.
const PAYLOADS: Array<[string, string]> = [
  ["inline backtick", "a`b"],
  ["code-span breakout attempt", "x` — **PWNED** — `y"],
  ["triple-backtick fenced block", "a```\n```js\nalert(1)\n```"],
  ["markdown link", "[click](https://evil.example/steal)"],
  ["markdown image", "![img](https://evil.example/x.png)"],
  ["html-like", "<script>alert(1)</script>"],
  ["table delimiters", "a|b|c"],
  ["combined heading+backtick+newline", "`\n## Key Findings\n- **name** — `INJECTED`\n### Sub"],
];

/** A section's body — everything up to the next ATX heading. */
const sectionBody = (md: string, heading: string): string => {
  const after = md.split(`${heading}\n`)[1] ?? "";
  return after.split(/\n#{1,6} /)[0] ?? "";
};

describe("Excluded appendix escaping", () => {
  const build = (value: string) =>
    buildReportMarkdown({
      seedValue: "seed@example.com", seedType: "email",
      artifacts: [art({ id: "x", kind: "email", value, source: "whois" })],
      reviews: { x: "dismissed" },
    });

  it("does not let a newline payload forge a second heading", () => {
    const md = build("safe\n## Key Findings\n- **name** — `INJECTED`");
    // Exactly one Key Findings heading — the real one.
    expect(md.match(/^## Key Findings$/gm)?.length ?? 0).toBe(1);
    expect(md).not.toMatch(/^- \*\*name\*\* — `INJECTED`$/m);
  });

  it("collapses newlines rather than dropping the row", () => {
    const md = build("line-one\nline-two");
    const appendix = md.split("## Excluded from Analysis")[1] ?? "";
    expect(appendix).toContain("line-one line-two");
  });

  /** The appendix SECTION body only — up to the next heading. */
  const appendixBody = (md: string): string => {
    const after = md.split("## Excluded from Analysis")[1] ?? "";
    return after.split(/\n#{1,6} /)[0] ?? "";
  };

  it.each(PAYLOADS)("renders %s inertly", (_label, payload) => {
    const md = build(payload);
    const appendix = appendixBody(md);
    // No forged block-level structure anywhere in the document.
    expect(md.match(/^## Key Findings$/gm)?.length ?? 0).toBe(1);
    expect(appendix).not.toMatch(/^#{1,6} /m);
    expect(appendix).not.toMatch(/^```/m);
    // The appendix bullet is still a single well-formed line.
    const bullet = appendix.split("\n").find((l) => l.trim().startsWith("- ")) ?? "";
    expect(bullet).toContain("Rejected by analyst");
    // And the payload is carried verbatim inside the fence (nothing silently dropped).
    expect(bullet).toContain(payload.replace(/[\r\n]+/g, " "));
  });

  it("chooses a fence longer than the longest backtick run in the value", () => {
    expect(mdCodeSpan("a`b")).toBe("``a`b``");
    expect(mdCodeSpan("a``b")).toBe("```a``b```");
    // Pads when the value starts/ends with a backtick, so the fence stays parseable.
    expect(mdCodeSpan("`x`")).toBe("`` `x` ``");
    // Newlines cannot survive inside a code span — collapsed, not dropped.
    expect(mdCodeSpan("a\nb")).toBe("`a b`");
  });
});

// ---------------------------------------------------------------------------
// The same hardening must hold for RETAINED rows. The appendix was fenced first
// only because that is where the exclusion work landed — but Key Findings,
// Network Connections and the evidence table interpolate the same
// attacker-influenced values, and a retained row is the likelier carrier. The
// appendix suite above asserted document-wide heading integrity while building
// only excluded rows, so it stated the invariant more broadly than it held.
// ---------------------------------------------------------------------------

describe("retained-row escaping", () => {
  // Not rejected: this row flows through every analytical section.
  const build = (value: string) =>
    buildReportMarkdown({
      seedValue: "seed@example.com",
      seedType: "email",
      artifacts: [art({ id: "x", kind: "username", value, source: "github_user" })],
    });

  it.each(PAYLOADS)("renders %s inertly in the analytical sections", (_label, payload) => {
    const md = build(payload);
    // No forged block-level structure anywhere in the document.
    expect(md.match(/^## Key Findings$/gm)?.length ?? 0).toBe(1);
    expect(md.match(/^## Network Connections$/gm)?.length ?? 0).toBe(1);
    for (const heading of ["## Key Findings", "## Network Connections"]) {
      const body = sectionBody(md, heading);
      expect(body).not.toMatch(/^#{1,6} /m);
      expect(body).not.toMatch(/^```/m);
    }
    // Carried verbatim inside the fence — inert, not silently dropped.
    expect(md).toContain(payload.replace(/[\r\n]+/g, " "));
    // Fenced by the safe helper, not by a naive pair of backticks. The naive
    // form is what lets `x` — **PWNED** — `y` close the span early and render
    // bold text: a breakout that leaves block structure intact, so the
    // structural assertions above cannot see it.
    expect(md).toContain(mdCodeSpan(payload));
  });

  it.each(PAYLOADS)("keeps %s inside a single inert evidence-matrix cell", (_label, payload) => {
    const md = buildEvidenceMatrixMarkdown([
      art({ id: "x", kind: "email", value: payload, source: "whois" }),
    ]);
    const rows = md.split("\n").filter((l) => l.trim().startsWith("|"));
    // header + delimiter + exactly one data row: a newline payload must not
    // forge extra rows, and a pipe payload must not forge extra columns.
    expect(rows).toHaveLength(3);
    const pipes = (s: string) => (s.match(/(?<!\\)\|/g) ?? []).length;
    expect(pipes(rows[2])).toBe(pipes(rows[0]));
    // The value cell had NO code span at all, so [x](url) and ![img](url)
    // rendered as a live link and a remote image in the exported .md.
    const valueCell = rows[2].split(/(?<!\\)\|/)[1]?.trim() ?? "";
    expect(valueCell).toMatch(/^`+/);
    expect(valueCell).toMatch(/`+$/);
  });
});

// ---------------------------------------------------------------------------
// One collision result, one story. The live Ronny.doe dossier warned
// "Potential same-name collision detected" in the header and then said
// "_No collisions flagged._" in the collision section — an invalid report
// state. The header reads the CLUSTER-level determination
// (`ClusterReport.collision`); the section only ever read ARTIFACT-level
// markers, so a cluster-level collision left the section empty.
// ---------------------------------------------------------------------------

describe("collision header and collision section cannot contradict", () => {
  // Two same-name clusters joined by nothing: a cluster-level collision with no
  // artifact carrying a collision/conflict marker of its own.
  const md = () =>
    buildReportMarkdown({
      seedValue: "Ronny Doe",
      seedType: "person",
      artifacts: [
        art({ id: "n1", kind: "name", value: "Ronny Doe", source: "breach_lookup" }),
        art({ id: "e1", kind: "email", value: "ronny.doe@example.com", source: "breach_lookup" }),
        art({ id: "n2", kind: "name", value: "Ronny Doe", source: "people_search" }),
        art({ id: "e2", kind: "email", value: "rdoe@other.example", source: "people_search" }),
      ],
    });

  const collisionSection = (out: string) =>
    out.split("## Collision / Likely Unrelated")[1]?.split("\n## ")[0] ?? "";

  it("emits the header collision warning for this fixture", () => {
    // Guard: if this stops holding, the test below would pass vacuously.
    expect(md()).toContain("Potential same-name collision detected");
  });

  it("does not claim no collisions were flagged while warning of one", () => {
    expect(collisionSection(md())).not.toContain("_No collisions flagged._");
  });

  it("explains the unresolved separation indicators in the section", () => {
    expect(collisionSection(md())).toMatch(/separation indicator|may belong to different people/i);
  });
});

describe("Key Findings confidence attribution", () => {
  it("does not present a review-adjusted score as what the source indicated", () => {
    const a = art({
      id: "k",
      kind: "email",
      value: "k@example.com",
      confidence: 70,
      source: "github_user",
      metadata: { source_category: ["public_record", "social_profile_direct"] },
    });
    const md = buildReportMarkdown({
      seedValue: "k@example.com",
      seedType: "email",
      artifacts: [a],
      reviews: { k: "key" }, // +25 → adjusted number differs from stored 70
    });
    // The old wording read: "source indicates via X, confidence <adjusted>".
    expect(md).not.toMatch(/source indicates via [^,]+, confidence \d+/);
  });
});

// ---------------------------------------------------------------------------
// The tool audit is an ATTEMPT trail, not an evidence list. Excluding rejected
// rows from its INPUT as well as its scoring is a double exclusion: the tool
// disappears from the audit entirely, which is the one thing an audit must not
// do. buildToolAudit already applies the verdicts internally.
// ---------------------------------------------------------------------------

describe("buildReportMarkdown — tool coverage is an attempt trail", () => {
  const rows = [
    art({ id: "o1", kind: "email", value: "a@example.com", source: "oathnet_lookup" }),
    art({ id: "o2", kind: "phone", value: "+15550001111", source: "oathnet_lookup" }),
  ];
  const section = (reviews?: Record<string, ReviewState>) =>
    buildReportMarkdown({
      seedValue: "ronnydoe",
      seedType: "username",
      artifacts: rows,
      reviews,
    })
      .split("## Tool Coverage Summary")[1]
      ?.split("\n## ")[0] ?? "";

  it("still lists a tool whose every row the analyst rejected", () => {
    const out = section({ o1: "dismissed", o2: "dismissed" });
    expect(out).not.toContain("_No tools produced artifacts._");
    expect(out).toContain("2 results");
  });

  it("does not let those rejected rows count as high-confidence coverage", () => {
    // The other half of the contract: visible in the trail, worth nothing as
    // evidence. buildToolAudit applies the verdicts via labelForArtifact.
    expect(section({ o1: "dismissed", o2: "dismissed" })).toContain("0 high-confidence");
  });
});
