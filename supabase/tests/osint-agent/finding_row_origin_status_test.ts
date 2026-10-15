/**
 * finding_row_origin_status_test.ts — the origin boundary must hold on BOTH
 * authority paths inside buildFindingRow.
 *
 * FIXTURES ARE SYNTHETIC. Nothing here is real case data.
 *
 * THE DEFECT (Codex P1 on the origin-classification PR). buildFindingRow has
 * two consumers of the same evidence:
 *
 *   supporting_sources ──> classifySourceWithOrigin ──> countIndependentClasses
 *                            └─> corroborationCount ──> computeAxes        [A]
 *   supporting_sources ──> applyRecordingSourcePolicy ──> cap.source_classes
 *                            └─> resolveRecordingStatus ──> deriveStatus   [B]
 *
 * Path [A] was made origin-aware; path [B] re-counted `cap.source_classes`,
 * which carries no origin. So one hostname read through two tools that classify
 * differently counted 1 in [A] and 2 in [B], and the row PERSISTED as
 * `needs_corroboration` with two authoritative source categories where the
 * single-source truth is `observed`.
 *
 * THE INVARIANT THESE TESTS PIN: if two source labels resolve to the same
 * origin, no downstream authoritative consumer in buildFindingRow may later
 * reinterpret them as two independent corroborating sources.
 */
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildFindingRow } from "../../functions/osint-agent/lib/finding-row.ts";
import {
  attributeClassesToOrigins,
  classifySourceWithOrigin,
  countIndependentClasses,
  type SourceClass,
} from "../../functions/osint-agent/source-classification.ts";
import { applyRecordingSourcePolicy, resolveRecordingStatus } from "../../functions/osint-agent/recording-source-policy.ts";

/** The reachable shape from the review: ONE hostname, TWO tools, which the
 *  classifier resolves to two DIFFERENT classes. */
const SAME_ORIGIN_PAIR = [
  "socialfetch_web_read (x.com/acct/status/1)",
  "jina_reader_scrape (x.com/acct/status/1)",
];
/** The single-source control: what the pair above must be equivalent to. */
const SINGLE = ["socialfetch_web_read (x.com/acct/status/1)"];

const build = (sources: string[]) =>
  buildFindingRow({
    conclusion: "Subject operates the account",
    supporting_sources: sources,
    drivers: ["handle matches across reads"],
    identity_evidence_strength: 60,
    relationship_evidence_strength: 40,
    label: "CONFIRMED",
  }, {
    threadId: "11111111-2222-4333-8444-555555555555",
    userId: "00000000-0000-4000-8000-000000000000",
    contraRows: null,
  });

const capOf = (sources: string[], raw: number) =>
  applyRecordingSourcePolicy({ rawConfidence: raw, sources, kind: "finding", metadata: null }).effective;

/* ── 1. the corroboration count itself ───────────────────────────────────── */

Deno.test("same-origin cross-tool pair derives ONE independent source, not two", () => {
  const entries = SAME_ORIGIN_PAIR.map(classifySourceWithOrigin);
  // Precondition that makes this case interesting: the two tools genuinely
  // classify differently, so class-only dedup CANNOT collapse them.
  assertEquals(new Set(entries.map((e) => e.sourceClass)).size, 2);
  assertEquals(new Set(entries.map((e) => e.originId)).size, 1);
  assertEquals(countIndependentClasses(entries), 1);
});

/* ── 2. the PERSISTED status — the half the review found still broken ────── */

Deno.test("the same-origin pair PERSISTS as the single-source status, not needs_corroboration", () => {
  const pair = build(SAME_ORIGIN_PAIR);
  const single = build(SINGLE);
  assertEquals(single.status, "observed"); // the control
  assertEquals(pair.status, "observed"); // was "needs_corroboration" before the fix
  assertEquals(pair.status, single.status);
  assertEquals((pair.row.metadata as Record<string, unknown>).status, "observed");
});

Deno.test("the two authority paths agree on the same-origin pair", () => {
  // [A] computeAxes' corroborationCount vs [B] what deriveStatus now counts.
  const cap = capOf(SAME_ORIGIN_PAIR, build(SAME_ORIGIN_PAIR).axes.case);
  const pathA = countIndependentClasses(SAME_ORIGIN_PAIR.map(classifySourceWithOrigin));
  const pathB = countIndependentClasses(
    attributeClassesToOrigins(cap.source_classes, SAME_ORIGIN_PAIR),
  );
  assertEquals(pathA, 1);
  assertEquals(pathB, 1);
  assertEquals(pathA, pathB);
});

/* ── 3. reliability / caps stay conservative and SEPARATE ────────────────── */

Deno.test("the fix touches independence only — the cap engine's own classes are unchanged", () => {
  const cap = capOf(SAME_ORIGIN_PAIR, 70);
  // Verified against origin/main: these two classes, and this cap, are exactly
  // what main already produced for this input. The origin work must not move
  // either — reliability classification and origin independence are separate
  // axes, and the cap's cross-class ceiling is deliberately NOT re-derived here.
  assertEquals(cap.source_classes, ["social_profile_active", "independent_public"]);
  assertEquals(cap.cap, 85);
  // And the fix must never RAISE the persisted confidence.
  assert(build(SAME_ORIGIN_PAIR).row.confidence <= cap.cap);
  assertEquals(build(SAME_ORIGIN_PAIR).row.confidence, build(SINGLE).row.confidence);
});

/* ── 4. ordering must not change the result ──────────────────────────────── */

Deno.test("input ordering does not change status, confidence, or the count", () => {
  const forward = build(SAME_ORIGIN_PAIR);
  const reversed = build([...SAME_ORIGIN_PAIR].reverse());
  assertEquals(reversed.status, forward.status);
  assertEquals(reversed.row.confidence, forward.row.confidence);
  assertEquals(
    countIndependentClasses([...SAME_ORIGIN_PAIR].reverse().map(classifySourceWithOrigin)),
    countIndependentClasses(SAME_ORIGIN_PAIR.map(classifySourceWithOrigin)),
  );
});

/* ── 5. the fix must not over-reach ──────────────────────────────────────── */

Deno.test("two GENUINELY different origins still corroborate on both paths", () => {
  const pair = [
    "socialfetch_web_read (asec.ahnlab.com/en/1)",
    "socialfetch_web_read (x.com/acct/status/1)",
  ];
  assertEquals(countIndependentClasses(pair.map(classifySourceWithOrigin)), 2);
  const cap = capOf(pair, 70);
  assertEquals(countIndependentClasses(attributeClassesToOrigins(cap.source_classes, pair)), 2);
});

Deno.test("#497's breach-split recovery is NOT clamped by the origin fix", () => {
  // The cap engine legitimately derives MORE classes than there are labels:
  // one joined label yields breach + infra classes. A naive 'ceiling the cap
  // count by the per-label count' fix would silently re-break #497 and write a
  // false "needs second independent class" onto a row that has three.
  const joined = ["serus_darkweb_scan+whois_lookup+dns_records"];
  const cap = capOf(joined, 70);
  assert(cap.source_classes.length > joined.length);
  assertEquals(countIndependentClasses(joined.map(classifySourceWithOrigin)), 1);
  // No origin is extractable from that label, so every class stays bare and the
  // count is exactly what it was before the origin work.
  assertEquals(
    attributeClassesToOrigins(cap.source_classes, joined),
    cap.source_classes as SourceClass[],
  );
  assertEquals(
    countIndependentClasses(attributeClassesToOrigins(cap.source_classes, joined)),
    countIndependentClasses(cap.source_classes),
  );
});

/* ── 6. attributeClassesToOrigins' own contract ──────────────────────────── */

Deno.test("attribution is strictly deflationary and never invents a class", () => {
  const cases: ReadonlyArray<[readonly SourceClass[], readonly string[]]> = [
    [["social_profile_active", "independent_public"], SAME_ORIGIN_PAIR],
    [["breach", "infra_dns"], ["serus_darkweb_scan+whois_lookup+dns_records"]],
    [["independent_public"], ["socialfetch_web_read (asec.ahnlab.com/en/1)"]],
    [["court_record", "news"], ["pacer_docket", "reuters"]],
    [[], SAME_ORIGIN_PAIR],
  ];
  for (const [capClasses, sources] of cases) {
    const attributed = attributeClassesToOrigins(capClasses, sources);
    // One entry per cap class, in order, class identity preserved.
    assertEquals(attributed.length, capClasses.length);
    assertEquals(
      attributed.map((e) => (typeof e === "string" ? e : e.sourceClass)),
      capClasses as SourceClass[],
    );
    // And it can only ever lower the count.
    assert(
      countIndependentClasses(attributed) <= countIndependentClasses(capClasses),
      JSON.stringify({ capClasses, sources }),
    );
  }
});

Deno.test("a class produced from SEVERAL origins stays a bare class", () => {
  // Merging it into one origin would be an arbitrary choice, and splitting it
  // into several would inflate. Leaving it bare reproduces today's behavior.
  const sources = [
    "jina_reader_scrape (alpha-example.org/a)",
    "jina_reader_scrape (beta-example.org/b)",
  ];
  const entries = sources.map(classifySourceWithOrigin);
  assertEquals(new Set(entries.map((e) => e.sourceClass)).size, 1);
  assertEquals(new Set(entries.map((e) => e.originId)).size, 2);
  assertEquals(attributeClassesToOrigins(["independent_public"], sources), [
    "independent_public",
  ]);
});

/* ── 7. callers that do not opt in are untouched ─────────────────────────── */

Deno.test("resolveRecordingStatus without originSources behaves exactly as before", () => {
  // tool-registry.ts:5000/:5447 and tools/recording.ts:78/:319 pass no opts.
  const cap = capOf(SAME_ORIGIN_PAIR, 70);
  const withoutOpt = resolveRecordingStatus(cap, { contradictions: [] });
  const explicitUndefined = resolveRecordingStatus(cap, { contradictions: [] }, {});
  assertEquals(withoutOpt, explicitUndefined);
  // ...and that legacy behavior is the UNFIXED one, which is precisely why the
  // finding path has to opt in.
  const withOpt = resolveRecordingStatus(cap, { contradictions: [] }, {
    originSources: SAME_ORIGIN_PAIR,
  });
  assertEquals(withoutOpt.status, "needs_corroboration");
  assertEquals(withOpt.status, "observed");
});
