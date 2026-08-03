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
} from "@/lib/intel";
import type { Artifact } from "@/hooks/useThreadArtifacts";

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
    expect(got?.name).toBeTruthy();
    expect(got?.name).not.toContain("schema");
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
