import { describe, it, expect } from "vitest";
import {
  exclusionReason,
  isExcludedArtifact,
  partitionExcluded,
} from "@/lib/exclusion";
import {
  labelForArtifact,
  buildIdentityClusters,
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
import { REDACTED_MINOR_PLACEHOLDER } from "@/lib/artifact-exclusion";

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

  // SUPERSEDED BY CONTRACT ITEM 11 / REVIEW FINDING 3. This asserted that a
  // dismissed row counts as `failed`, which is the misattribution itself: a
  // tool that ran correctly and returned a row the analyst rejected is not a
  // failing tool. The test's actual intent — a rejected row must not be
  // high-confidence — is unchanged and still asserted below.
  it("counts a dismissed row as excluded, not high-confidence and not failed", () => {
    const withReview = buildToolAudit(rows, { x: "dismissed" });
    const entry = withReview.tools[0];
    expect(entry.highConf).toBe(0);
    expect(entry.rejected).toBe(1);
    expect(entry.retained).toBe(0);
    expect(entry.failed).toBe(0);
    expect(withReview.rejectedCount).toBe(1);
    expect(withReview.failedCount).toBe(0);
  });

  it("is unchanged when no reviews are supplied", () => {
    const bare = buildToolAudit(rows);
    expect(bare.tools[0].failed).toBe(0);
  });
});

// SUPERSEDED BY CONTRACT ITEM 9 — recorded here rather than deleted, because
// the change is deliberate. The original assertion was "a rejected row renders
// FAILED in the matrix", which pinned the intent that a rejected row must never
// appear under its original source-derived label. Item 9 strengthens that: a
// FAILED label is what a TOOL FAILURE looks like, so leaving analyst verdicts
// in the evidence table wearing it made a dismissal indistinguishable from an
// outage. The row now leaves the table entirely.
describe("buildEvidenceMatrixMarkdown — rejected rows leave the evidence table", () => {
  const rows = [art({ id: "x", value: "REJECTED_VALUE", confidence: 90, source: "github_user" })];

  it("does not render the rejected row as ordinary evidence", () => {
    const md = buildEvidenceMatrixMarkdown(rows, { x: "wrong" });
    expect(md).not.toContain("REJECTED_VALUE");
    expect(md).not.toContain("FAILED");
  });

  it("still scores it FAILED where scoring is what is being asked", () => {
    // The label logic is unchanged; only the matrix's presentation moved.
    expect(labelForArtifact(rows[0], "wrong")).toBe("FAILED");
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
  // Seed-linked on purpose: Network Connections is now the SUBJECT's graph, so
  // a row must be linked or corroborated to appear there at all. Using an
  // unlinked value would make the exclusion assertion below pass for the wrong
  // reason (absent because unassigned, not because rejected).
  const kept = art({ id: "good", kind: "email", value: "a@b.com" });

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
    expect(network).toContain("a@b.com");
  });

  it("surfaces the rejected row in an explicit Excluded appendix", () => {
    const out = md();
    expect(out).toContain("## Excluded from Analysis");
    const appendix = out.split("## Excluded from Analysis")[1] ?? "";
    expect(appendix).toContain("REJECTED_HANDLE");
  });

  it("does not double-count the rejected row in the analysed total", () => {
    // "recorded" is the population; "analyzed" is what survived the partition.
    // Printing the analysed count under the word "recorded" — directly above
    // "Excluded from analysis: 1" — invited the reader to subtract twice.
    expect(md()).toMatch(/\*\*Artifacts analyzed:\*\* 1\b/);
  });
});

// ---------------------------------------------------------------------------
// Contract item 10: recorded = analyzed + excluded, stated in those words.
// ---------------------------------------------------------------------------

describe("count terminology reconciles", () => {
  const counts = (md: string) => {
    const seed = md.split("## Seed Details")[1]?.split("\n## ")[0] ?? "";
    const num = (re: RegExp) => {
      const m = seed.match(re);
      return m ? Number(m[1]) : null;
    };
    return {
      seed,
      recorded: num(/\*\*Artifacts recorded:\*\* (\d+)/),
      analyzed: num(/\*\*Artifacts analyzed:\*\* (\d+)/),
      excluded: num(/\*\*Excluded from analysis:\*\* (\d+)/),
    };
  };

  it("prints all three counts and they reconcile", () => {
    const md = buildReportMarkdown({
      seedValue: "seed@example.com",
      seedType: "email",
      artifacts: [
        art({ id: "keep", kind: "email", value: "kept@example.com" }),
        art({ id: "bad1", kind: "username", value: "REJ1", source: "github_user" }),
        art({ id: "bad2", kind: "username", value: "REJ2", source: "github_user" }),
      ],
      reviews: { bad1: "wrong", bad2: "dismissed" },
    });
    const c = counts(md);
    expect(c.recorded).toBe(3);
    expect(c.analyzed).toBe(1);
    expect(c.excluded).toBe(2);
    expect(c.recorded).toBe((c.analyzed ?? 0) + (c.excluded ?? 0));
  });

  it("says explicitly how collision rows are counted", () => {
    // Collision rows are NOT partitioned out (they have their own section), so
    // they sit inside "analyzed". A reader cannot infer that; say it.
    const md = buildReportMarkdown({
      seedValue: "seed@example.com",
      seedType: "email",
      artifacts: [
        art({ id: "keep", kind: "email", value: "kept@example.com" }),
        art({ id: "col", kind: "name", value: "Someone Else", metadata: { collision: true } }),
      ],
    });
    const c = counts(md);
    expect(c.recorded).toBe(2);
    expect(c.analyzed).toBe(2);
    expect(c.seed).toMatch(/quarantined as namesake/i);
  });

  it("still reconciles when nothing is excluded", () => {
    const md = buildReportMarkdown({
      seedValue: "seed@example.com",
      seedType: "email",
      artifacts: [art({ id: "keep", kind: "email", value: "kept@example.com" })],
    });
    const c = counts(md);
    expect(c.recorded).toBe(1);
    expect(c.analyzed).toBe(1);
    expect(c.excluded ?? 0).toBe(0);
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

  // The name-search branch renders cluster LABELS into bullets, and a label is
  // built from artifact values. It is a separate interpolation from the value
  // lists, and it was missed on the first hardening pass.
  it.each(PAYLOADS)("renders %s inertly in the name-search corroboration sections", (_label, payload) => {
    const md = buildReportMarkdown({
      seedValue: "John Smith Austin TX",
      seedType: "person",
      artifacts: [
        // Shared `parent` merges these into ONE cluster, so the cluster carries
        // both the payload as its name and a TX address. That is what makes
        // `matchesSeedLocation` true and renders the cluster LABEL into the
        // "What Is Actually Corroborated" bullet — without it that assertion
        // passes vacuously (verified by mutation).
        art({ id: "n", kind: "name", value: payload, source: "people_search", metadata: { parent: "seed-1" } }),
        art({ id: "a", kind: "address", value: "1 Main St Austin TX", source: "people_search", metadata: { parent: "seed-1" } }),
      ],
    });
    expect(md.match(/^## Key Findings$/gm)?.length ?? 0).toBe(1);
    // No forged SECTION (h1/h2) and no forged fence anywhere in the document.
    expect(md.match(/^## /gm)?.length ?? 0).toBe(
      // The real h2 set is fixed for this fixture; a payload adding one is the failure.
      buildReportMarkdown({
        seedValue: "John Smith Austin TX", seedType: "person",
        artifacts: [art({ id: "n", kind: "name", value: "Plain Name", source: "people_search" })],
      }).match(/^## /gm)?.length ?? 0,
    );
    expect(md).not.toMatch(/^```/m);
    // The clusters section legitimately owns "### Cluster …" sub-headings; any
    // OTHER heading inside it came from the payload.
    const clusters = md.split("## Candidate Identity Clusters\n")[1]?.split(/\n## /)[0] ?? "";
    for (const line of clusters.split("\n").filter((l) => /^#{1,6} /.test(l))) {
      expect(line).toMatch(/^### Cluster /);
    }
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

// ---------------------------------------------------------------------------
// Contract item 9. The standalone Evidence Matrix (ReportTab's copy button) was
// built from the UNPARTITIONED artifact list, so analyst-rejected and
// pipeline-excluded rows sat in the ordinary evidence table wearing a FAILED
// label — indistinguishable from a tool that failed.
// ---------------------------------------------------------------------------

describe("evidence matrix — excluded rows are not ordinary evidence", () => {
  const kept = art({ id: "keep", kind: "email", value: "kept@example.com" });
  const rejected = art({ id: "bad", kind: "username", value: "REJECTED_HANDLE", source: "github_user" });
  const excludedKind = art({ id: "px", kind: "excluded", value: "PIPELINE_EXCLUDED", source: "whois" });
  const minor = art({
    id: "m", kind: "account", value: "MINOR_IDENTIFIER",
    source: "web_search", metadata: { possible_minor: true },
  });
  const build = () =>
    buildEvidenceMatrixMarkdown(
      [kept, rejected, excludedKind, minor],
      { bad: "wrong", m: "dismissed" },
      { includeExcludedAppendix: true },
    );

  /** Table rows only — everything before the audit appendix. */
  const tableRows = (md: string) =>
    md.split("\n").filter((l) => l.trim().startsWith("|")).slice(2);

  it("keeps rejected and pipeline-excluded rows out of the table", () => {
    const rows = tableRows(build()).join("\n");
    expect(rows).toContain("kept@example.com");
    expect(rows).not.toContain("REJECTED_HANDLE");
    expect(rows).not.toContain("PIPELINE_EXCLUDED");
  });

  it("retains them in an explicitly labelled audit appendix", () => {
    const md = build();
    expect(md).toContain("Excluded from analysis");
    const appendix = md.split("Excluded from analysis")[1] ?? "";
    expect(appendix).toContain("REJECTED_HANDLE");
    expect(appendix).toContain("Rejected by analyst");
  });

  it("redacts a possible-minor value in the appendix", () => {
    const md = build();
    expect(md).not.toContain("MINOR_IDENTIFIER");
    expect(md).toContain(REDACTED_MINOR_PLACEHOLDER);
  });

  it("omits the appendix when not asked for one", () => {
    const md = buildEvidenceMatrixMarkdown([kept, rejected], { bad: "wrong" });
    expect(md).not.toContain("Excluded from analysis");
    expect(md).not.toContain("REJECTED_HANDLE");
  });

  it("leaves the in-report entity table's collision handling alone", () => {
    // Collision rows keep their own report section, so the report's own call
    // must not strip them from the entity table as well — that would break the
    // recorded = analyzed + excluded reconciliation.
    const md = buildReportMarkdown({
      seedValue: "seed@example.com",
      seedType: "email",
      artifacts: [kept, art({ id: "col", kind: "name", value: "NAMESAKE_ROW", metadata: { collision: true } })],
    });
    const table = md.split("## Artifact / Entity Table")[1]?.split("\n## ")[0] ?? "";
    expect(table).toContain("NAMESAKE_ROW");
  });
});

// ---------------------------------------------------------------------------
// Contract item 11 + review finding 3. Tool EXECUTION and evidentiary COVERAGE
// are different measurements and were collapsed into one. `failed` counted
// analyst dismissals and pipeline-excluded namesakes alongside genuine tool
// failures, so AuditTab's "Skipped / Failed" section reported a tool that ran
// perfectly and returned a correctly-excluded namesake as failing.
// ---------------------------------------------------------------------------

describe("tool audit — execution is not coverage", () => {
  const entry = (rows: Artifact[], reviews?: Record<string, ReviewState>) =>
    buildToolAudit(rows, reviews).tools[0];

  it("does not count an analyst dismissal as a tool failure", () => {
    const e = entry([art({ id: "x", source: "oathnet_lookup" })], { x: "dismissed" });
    expect(e.failed).toBe(0);
    expect(e.rejected).toBe(1);
    expect(e.retained).toBe(0);
  });

  it("does not count a pipeline-excluded namesake as a tool failure", () => {
    const e = entry([art({ id: "x", kind: "excluded_collision", source: "people_search" })]);
    expect(e.failed).toBe(0);
    expect(e.rejected).toBe(1);
  });

  it("still counts a genuinely skipped or failed invocation", () => {
    expect(entry([art({ id: "x", source: "hibp", metadata: { skipped: true } })]).failed).toBe(1);
    expect(entry([art({ id: "x", source: "hibp", metadata: { failed: true } })]).failed).toBe(1);
  });

  it("keeps the tool operationally visible even when every row was rejected", () => {
    const audit = buildToolAudit([art({ id: "x", source: "oathnet_lookup" })], { x: "wrong" });
    expect(audit.tools.map((t) => t.tool)).toContain("oathnet_lookup");
    expect(audit.retainedCount).toBe(0);
    expect(audit.rejectedCount).toBe(1);
  });

  it("does not let a rejected-only kind satisfy coverage", () => {
    // Otherwise inferToolGaps concludes the kind is handled and stops
    // recommending the tools that would actually close the gap.
    const audit = buildToolAudit([art({ id: "x", kind: "email", source: "hibp" })], { x: "dismissed" });
    expect(audit.kindsCovered.has("email")).toBe(false);
  });

  it("counts a retained kind as covered", () => {
    const audit = buildToolAudit([art({ id: "x", kind: "email", source: "hibp" })]);
    expect(audit.kindsCovered.has("email")).toBe(true);
  });
});

describe("report — attempted tools and evidentiary sources are reported separately", () => {
  const md = () =>
    buildReportMarkdown({
      seedValue: "seed@example.com",
      seedType: "email",
      artifacts: [
        art({ id: "keep", kind: "email", value: "kept@example.com", source: "hibp" }),
        art({ id: "bad", kind: "phone", value: "+15550001111", source: "oathnet_lookup" }),
      ],
      reviews: { bad: "dismissed" },
      toolInvocations: 36,
    });

  it("does not present artifact-producing sources as the tool-invocation count", () => {
    // The live dossier read "52 artifacts across 4 tools" while the Activity
    // Log recorded 36 invocations across many more tools.
    const exec = md().split("## Executive Summary")[1]?.split("\n## ")[0] ?? "";
    expect(exec).not.toMatch(/across \d+ tools?\./);
    expect(exec).toMatch(/artifact-producing source/i);
  });

  it("shows the excluded rows in the tool coverage line rather than as failures", () => {
    const section = md().split("## Tool Coverage Summary")[1]?.split("\n## ")[0] ?? "";
    // Both tools stay listed — the one whose only row was dismissed included.
    expect(section.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(2);
    expect(section).toMatch(/1 excluded/);
    expect(section).not.toMatch(/1 failed/);
  });
});

// ---------------------------------------------------------------------------
// Contract items 3 + 4. A bulk breach/person-search response returns a whole
// ROW of fields — other people's names, emails, phones, addresses. The
// extractor flattens them into standalone artifacts carrying only
// `source_category: breach` and no record-level link to the queried selector.
// `bucketQualifiesAsCluster` then promoted each one to a candidate identity
// cluster: a lone NAME always qualified, and any lone artifact with a durable
// selector qualified. The live Ronny.doe dossier turned ~24 unrelated rows into
// the subject's candidate identities, contacts and network — while its own
// prose claimed weak single-artifact signals were NOT shown as clusters.
//
// A source being a breach dataset is not evidence that every field it returned
// belongs to the searched person.
// ---------------------------------------------------------------------------

describe("bulk-result rows do not become the subject's identity", () => {
  const SEED = "ronnydoe";
  // One row explicitly tied to the seed.
  const linked = art({
    id: "linked", kind: "username", value: "ronnydoe", source: "username_sweep",
    metadata: { source_category: ["username_sweep"] },
  });
  // Neighbours from the same bulk OathNet batch — no linkage of any kind.
  const neighbours = [
    art({ id: "n1", kind: "name", value: "Ron Daoust", source: "oathnet_lookup", metadata: { source_category: ["breach"] } }),
    art({ id: "n2", kind: "name", value: "Ronny Beerling van der Doe", source: "oathnet_lookup", metadata: { source_category: ["breach"] } }),
    art({ id: "n3", kind: "email", value: "unrelated@corp.example", source: "oathnet_lookup", metadata: { source_category: ["breach"] } }),
    art({ id: "n4", kind: "phone", value: "+2250700000000", source: "oathnet_lookup", metadata: { source_category: ["breach"] } }),
    art({ id: "n5", kind: "address", value: "528 Lacroix Bay Rd Westmeath ON", source: "oathnet_lookup", metadata: { source_category: ["breach"] } }),
  ];

  const report = () => buildIdentityClusters([linked, ...neighbours], SEED);

  it("does not promote an unlinked bulk-batch name to a candidate cluster", () => {
    const labels = report().clusters.map((c) => c.label).join(" | ");
    expect(labels).not.toContain("Ron Daoust");
    expect(labels).not.toContain("Ronny Beerling van der Doe");
  });

  it("does not promote an unlinked email, phone or address either", () => {
    const all = report().clusters.flatMap((c) => [...c.emails, ...c.phones, ...c.addresses]);
    expect(all).not.toContain("unrelated@corp.example");
    expect(all).not.toContain("+2250700000000");
    expect(all).not.toContain("528 Lacroix Bay Rd Westmeath ON");
  });

  it("still clusters the row that is actually linked to the seed", () => {
    // Guard: the predicate must not simply suppress everything.
    expect(report().clusters.length).toBeGreaterThan(0);
    expect(report().clusters.flatMap((c) => c.usernames)).toContain("ronnydoe");
  });

  it("every displayed cluster satisfies the documented display predicate", () => {
    for (const c of report().clusters) {
      const corroborated = c.artifacts.length >= 2;
      const seedLinked = [...c.usernames, ...c.emails, ...c.phones]
        .some((v) => v.toLowerCase() === SEED);
      expect(corroborated || seedLinked).toBe(true);
    }
  });

  it("does not launder unlinked rows into the subject's network graph", () => {
    const md = buildReportMarkdown({
      seedValue: SEED,
      seedType: "username",
      artifacts: [linked, ...neighbours],
    });
    const network = md.split("## Network Connections")[1]?.split("\n## ")[0] ?? "";
    expect(network).not.toContain("Ron Daoust");
    expect(network).not.toContain("unrelated@corp.example");
    expect(network).not.toContain("+2250700000000");
    expect(network).not.toContain("528 Lacroix Bay Rd Westmeath ON");
  });

  it("names them in an explicit unassigned surface instead of dropping them", () => {
    const md = buildReportMarkdown({
      seedValue: SEED,
      seedType: "username",
      artifacts: [linked, ...neighbours],
    });
    const unassigned = md.split("## Unassigned Observations")[1]?.split("\n## ")[0] ?? "";
    expect(unassigned).toContain("Ron Daoust");
    expect(unassigned).toContain("unrelated@corp.example");
    expect(unassigned).toMatch(/NOT linked to the subject/i);
    // Retained, not deleted — the Artifact Table still carries every row.
    const table = md.split("## Artifact / Entity Table")[1]?.split("\n## ")[0] ?? "";
    expect(table).toContain("Ron Daoust");
  });

  it("leads Recommended Next Steps with resolving the association", () => {
    // The live dossier skipped the actual priority — deciding which record, if
    // any, is the subject — and recommended expanding unrelated pivots instead.
    const md = buildReportMarkdown({
      seedValue: SEED, seedType: "username", artifacts: [linked, ...neighbours],
    });
    const steps = md.split("## Recommended Next Steps")[1]?.split("\n## ")[0] ?? "";
    const first = steps.split("\n").find((l) => l.startsWith("- ")) ?? "";
    expect(first).toMatch(/Resolve identity association first/i);
  });

  it("counts the suppressed rows exactly, and says why in those terms", () => {
    const w = report().warnings.find((x) => /not shown as standalone identity clusters/i.test(x)) ?? "";
    expect(w).toContain(`${neighbours.length} `);
    // The prose must describe the predicate that actually ran.
    expect(w).toMatch(/corroboration|linked to the seed/i);
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

  // Contract item 7 — positive assertions. Not attributing the adjusted score
  // to the source is only half of it; the report must SAY what the evidence
  // scored and what the analyst did, as two separate facts.
  const reviewed = (review: ReviewState) =>
    buildReportMarkdown({
      seedValue: "k@example.com",
      seedType: "email",
      artifacts: [art({
        id: "k", kind: "email", value: "k@example.com", confidence: 70, source: "github_user",
        metadata: { source_category: ["public_record", "social_profile_direct"] },
      })],
      reviews: { k: review },
    });
  const keyFindings = (md: string) => md.split("## Key Findings")[1]?.split("\n## ")[0] ?? "";

  it("reports the stored evidence confidence and the analyst review separately", () => {
    const kf = keyFindings(reviewed("key"));
    expect(kf).toMatch(/evidence confidence:? 70/i);
    expect(kf).toMatch(/analyst review:? key/i);
  });

  it("never presents the review-adjusted number as the evidence confidence", () => {
    // "key" adds +25 → 95. That is an assessment, not what the source scored.
    const kf = keyFindings(reviewed("key"));
    expect(kf).not.toMatch(/evidence confidence:? 95/i);
  });

  it("omits the analyst-review clause when there is no verdict", () => {
    const md = buildReportMarkdown({
      seedValue: "k@example.com",
      seedType: "email",
      artifacts: [art({
        id: "k", kind: "email", value: "k@example.com", confidence: 70, source: "github_user",
        metadata: { source_category: ["public_record", "social_profile_direct"] },
      })],
    });
    // Scoped to the BULLET: the leads-branch preamble legitimately contains the
    // phrase "…2+ independent source classes or analyst review".
    const bullet = keyFindings(md).split("\n").find((l) => l.startsWith("- ")) ?? "";
    expect(bullet).toMatch(/evidence confidence:? 70/i);
    expect(bullet).not.toMatch(/analyst review:/i);
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
