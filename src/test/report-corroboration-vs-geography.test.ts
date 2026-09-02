/**
 * report-corroboration-vs-geography.test.ts — issue #488.
 *
 * The report's "What Is Actually Corroborated" section filtered on
 * `matchesSeedLocation`, a US-state match, and never evaluated corroboration at
 * all. A geography-match section was wearing a corroboration title. Both the
 * heading and the filter date to the initial commit (`9397cee`, 2026-06-04);
 * neither had a single test.
 *
 * WHAT THIS FILE PINS. Geography and corroboration are INDEPENDENT claims:
 *   - a seed-state match with one source class is a location match, NOT corroboration
 *   - two independent source classes corroborate even when the geography does not match
 *
 * WHY NOT `cluster.sources.length`. That field is the set of raw source STRINGS
 * (tool ids) — the report renders it elsewhere as "Source tools:". Two tool ids
 * are not two independent classes: the backend taxonomy collapses census +
 * nominatim to one `public_record`, and excludes discovery/AI-summary classes
 * from corroborating anything. The authority is `independentSourceClassCount`
 * (`intel.ts`), which is what awards CONFIRMED — measured on production
 * 2026-08-24, 388 artifacts carry >=2 raw categories but only 123 carry >=2
 * INDEPENDENT ones, so the raw count over-reports by ~3.2x.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT TOUCH. The Corroboration axis in
 * `confidence-dimensions.ts` uses a different, coarser class function. Aligning
 * the two is a scoring change, deferred for double-counting/regression risk, and
 * is NOT in scope here. The model also writes its own "What Is Actually
 * Corroborated" section into the stored chat narrative (system-prompt.ts) — a
 * separate producer, tracked with the report-authority work in #479.
 *
 * VALUES ARE SYNTHETIC — CLAUDE.md forbids real investigation PII in this repo.
 */
import { describe, expect, it } from "vitest";
import { buildIdentityClusters, buildReportMarkdown } from "@/lib/intel";
import type { Artifact } from "@/hooks/useThreadArtifacts";

const NOW = "2026-08-24T08:00:00.000Z";

/** Seed state = CA, and `detectSeed` reads it as kind "other" → a name search. */
const SEED = "jane roe sacramento ca";

type Opts = {
  id: string;
  email: string;
  region: string;
  source: string;
  category?: string | string[];
};

/** Two rows share one email selector, so the pair always merges into one bucket
 *  and clears `bucketQualifiesAsCluster` (>=2 artifacts). */
function row({ id, email, region, source, category }: Opts): Artifact {
  const meta: Record<string, unknown> = { region };
  if (category !== undefined) meta.source_category = category;
  return {
    id,
    kind: "email",
    value: email,
    confidence: 70,
    source,
    created_at: NOW,
    metadata: meta,
  };
}

// Cluster A — geography MATCHES the seed (CA), exactly ONE independent class.
const A_EMAIL = "a.subject@example.test";
const CLUSTER_A: Artifact[] = [
  row({ id: "aaaaaaa1-0000-4000-8000-000000000001", email: A_EMAIL, region: "CA", source: "data_broker_lookup", category: "data_broker" }),
  row({ id: "aaaaaaa1-0000-4000-8000-000000000002", email: A_EMAIL, region: "CA", source: "data_broker_lookup", category: "data_broker" }),
];

// Cluster B — geography does NOT match (TX), TWO independent classes.
const B_EMAIL = "b.subject@example.test";
const CLUSTER_B: Artifact[] = [
  row({ id: "bbbbbbb1-0000-4000-8000-000000000001", email: B_EMAIL, region: "TX", source: "county_records", category: "public_record" }),
  row({ id: "bbbbbbb1-0000-4000-8000-000000000002", email: B_EMAIL, region: "TX", source: "news_archive", category: "news" }),
];

// Cluster C — geography matches (CA), but both classes are NON-corroborating.
const C_EMAIL = "c.subject@example.test";
const CLUSTER_C: Artifact[] = [
  row({ id: "ccccccc1-0000-4000-8000-000000000001", email: C_EMAIL, region: "CA", source: "gemini_summary", category: "ai_summary" }),
  row({ id: "ccccccc1-0000-4000-8000-000000000002", email: C_EMAIL, region: "CA", source: "minimax_web_search", category: "web_search" }),
];

// Cluster D — two DIFFERENT tool ids that the taxonomy collapses to ONE class.
// `sources.length` is 2 here; the authoritative class count is 1.
const D_EMAIL = "d.subject@example.test";
const CLUSTER_D: Artifact[] = [
  row({ id: "ddddddd1-0000-4000-8000-000000000001", email: D_EMAIL, region: "CA", source: "census_api", category: "public_record" }),
  row({ id: "ddddddd1-0000-4000-8000-000000000002", email: D_EMAIL, region: "CA", source: "nominatim", category: "public_record" }),
];

const GEO_HEADING = "## Seed-Location Match";
const CORROBORATED_HEADING = "## What Is Actually Corroborated";
const NOT_CORROBORATED_HEADING = "## What Is Not Corroborated";

/** Body of one `## ` section, up to the next `## ` heading. */
function section(md: string, heading: string): string {
  const start = md.indexOf(heading);
  if (start === -1) return "";
  const after = start + heading.length;
  const next = md.indexOf("\n## ", after);
  return md.slice(after, next === -1 ? undefined : next);
}

function render(artifacts: Artifact[], seedValue: string = SEED): string {
  return buildReportMarkdown({ seedValue, seedType: "other", artifacts });
}

/** The rendered label of the cluster holding `email`. */
function labelFor(artifacts: Artifact[], email: string, seedValue: string = SEED): string {
  const { clusters } = buildIdentityClusters(artifacts, seedValue);
  const c = clusters.find((x) => x.emails.some((e) => e.toLowerCase() === email.toLowerCase()));
  if (!c) throw new Error(`fixture built no cluster for ${email} — the fixture, not the assertion, is broken`);
  return c.label;
}

describe("#488 — geography match and corroboration are separate claims", () => {
  it("a seed-location match with ONE source class is geography, not corroboration", () => {
    const md = render(CLUSTER_A);
    const label = labelFor(CLUSTER_A, A_EMAIL);

    expect(section(md, GEO_HEADING)).toContain(label);
    expect(section(md, CORROBORATED_HEADING)).not.toContain(label);
  });

  it("two independent source classes corroborate even when the geography does NOT match", () => {
    const md = render(CLUSTER_B);
    const label = labelFor(CLUSTER_B, B_EMAIL);

    expect(section(md, CORROBORATED_HEADING)).toContain(label);
    // geography is not the gate, and the section must not claim a match it lacks
    expect(section(md, GEO_HEADING)).not.toContain(label);
  });

  it("non-corroborating classes (ai_summary, web_search) never qualify", () => {
    const md = render(CLUSTER_C);
    const label = labelFor(CLUSTER_C, C_EMAIL);

    expect(section(md, GEO_HEADING)).toContain(label);
    expect(section(md, CORROBORATED_HEADING)).not.toContain(label);
  });

  it("honors metadata.source_category over the raw source strings", () => {
    const md = render(CLUSTER_D);
    const label = labelFor(CLUSTER_D, D_EMAIL);
    const { clusters } = buildIdentityClusters(CLUSTER_D, SEED);
    const cluster = clusters.find((c) => c.emails.some((e) => e === D_EMAIL))!;

    // two distinct tool ids — the naive `sources.length >= 2` test would pass
    expect(cluster.sources.length).toBe(2);
    // …but the taxonomy collapses both to one `public_record` class
    expect(section(md, CORROBORATED_HEADING)).not.toContain(label);
  });

  it("renders an explicit empty state when nothing is corroborated", () => {
    const md = render([...CLUSTER_A, ...CLUSTER_C]);

    expect(section(md, CORROBORATED_HEADING)).toContain(
      "No cluster is corroborated by 2 or more independent source classes yet",
    );
  });

  it("keeps the geography signal — heading, matching cluster, and the out-of-area caveat", () => {
    const md = render([...CLUSTER_A, ...CLUSTER_B]);
    const geo = section(md, GEO_HEADING);

    expect(md).toContain(GEO_HEADING);
    expect(geo).toContain(labelFor([...CLUSTER_A, ...CLUSTER_B], A_EMAIL));
    // the out-of-area warning the old section carried must survive the rename
    expect(md).toContain("Out-of-area");
    expect(md).toContain("CA");
  });

  it("still names what is NOT corroborated", () => {
    const md = render([...CLUSTER_A, ...CLUSTER_B]);

    expect(md).toContain(NOT_CORROBORATED_HEADING);
    expect(section(md, NOT_CORROBORATED_HEADING)).toContain(
      labelFor([...CLUSTER_A, ...CLUSTER_B], A_EMAIL),
    );
  });

  it("emits none of these sections for a non-name seed", () => {
    const md = render(CLUSTER_B, "example.com");

    expect(md).not.toContain(GEO_HEADING);
    expect(md).not.toContain(CORROBORATED_HEADING);
    expect(md).not.toContain(NOT_CORROBORATED_HEADING);
  });
});
