// Confidence-integrity regression tests (live run trybutez@yahoo.com, 2026-07-09).
//
// Bug #1 — stale tier after cap: cluster co-membership (≥2 distinct sources) must
//   NOT promote a member above its own source-class-capped confidence, so a
//   GitHub-404 dead-end and a confirmed false positive stop shipping as
//   promoted 75 / "Likely". The ONE exception is a PROVEN first-party
//   self-admission / ownership proof (never an llm_asserted_unverified one).
// Bug #2 — "unknown" must not count as an independent corroborating class.
//
// Synthetic, non-sensitive fixtures (mirrors integrity_report_fixture_test.ts).
// Placed at the osint-agent top level so `npm run test:edge` (which globs the
// top-level *_test.ts) actually runs it in CI.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { promoteConfidence, tierFor, isVerifiedSelfAdmission, type Artifact } from "./lib/cluster.ts";
import { applyEvidenceCaps } from "./confidence.ts";

const art = (over: Partial<Artifact>): Artifact => ({
  kind: "other", value: "x", source: "s", confidence: 50, metaRaw: "{}", ...over,
});
const other = art({ value: "trybutez", source: "username_sweep", confidence: 45 });

// ── Bug #1: cluster bump is capped to the member's own confidence ──────────────

Deno.test("bug#1: a capped-to-30 dead-end stays 30/Weak in a ≥2-source cluster (not 75/Likely)", () => {
  const dead = art({ kind: "weak_lead", value: "GitHub 404 not found", source: "github_user", confidence: 30, metaRaw: '{"confidence_cap_applied":50}' });
  const promoted = promoteConfidence(dead, [dead, other], { contradicted: false, hasSelfAdmission: false });
  assertEquals(promoted, 30, "cluster co-membership must not raise a member above its capped confidence");
  assertEquals(tierFor(promoted), "Weak");
});

Deno.test("bug#1: a capped-to-10 false positive stays 10/Unverified", () => {
  const fp = art({ kind: "weak_lead", value: "confirmed FALSE POSITIVE", source: "jina_reader_scrape", confidence: 10 });
  const promoted = promoteConfidence(fp, [fp, other], { contradicted: false, hasSelfAdmission: false });
  assertEquals(promoted, 10);
  assertEquals(tierFor(promoted), "Unverified");
});

Deno.test("bug#1: a breach-only member (conf 60) is NOT inflated to 75 by cluster co-membership", () => {
  const uname = art({ kind: "username", value: "trybutez", source: "breach_check + oathnet", confidence: 60 });
  const promoted = promoteConfidence(uname, [uname, other], { contradicted: false, hasSelfAdmission: false });
  assertEquals(promoted, 60);
  assertEquals(tierFor(promoted), "Possible");
});

// ── Bug #1: the ONE legitimate above-cap promotion — proven self-admission ─────

Deno.test("bug#1: a PROVEN first-party self-admission still promotes to ≥90/Confirmed (Option A)", () => {
  const core = art({ value: "616manii + ManzaVisuals = SAME PERSON", source: "first-party", confidence: 50, metaRaw: '{"source_quote":"I have gone under various names"}' });
  assertEquals(isVerifiedSelfAdmission(core), true);
  const promoted = promoteConfidence(core, [core, other], { contradicted: false, hasSelfAdmission: true });
  assert(promoted >= 90, `self-admission core must reach ≥90, got ${promoted}`);
  assertEquals(tierFor(promoted), "Confirmed");
});

Deno.test("bug#1: an llm_asserted_unverified 'ownership' claim does NOT earn the override", () => {
  // The live Steam realname:"Ryan" — asserted, not proven.
  const steam = art({ kind: "name", value: "Ryan", source: "steamcommunity xml", confidence: 65, metaRaw: '{"ownership_proof":"steam realname field","provenance":"llm_asserted_unverified","provenance_verified":false}' });
  assertEquals(isVerifiedSelfAdmission(steam), false, "unverified LLM assertion must not qualify");
  const promoted = promoteConfidence(steam, [steam, other], { contradicted: false, hasSelfAdmission: true });
  assert(promoted <= 65, `must not promote above its cap, got ${promoted}`);
  assert(promoted < 90, "must not reach Confirmed");
});

// ── Bug #2: "unknown" excluded from corroboration count ────────────────────────

Deno.test("bug#2: ['unknown','breach'] reads 'single source class: breach', no +10 boost, unknown retained for provenance", () => {
  const r = applyEvidenceCaps({
    rawConfidence: 90,
    kind: "name",
    sources: ["some_unknown_provider"],       // → unknown
    metadata: { breach_source: "oathnet", data_classes: ["email"] }, // → breach
  });
  assert(r.source_classes.includes("unknown") && r.source_classes.includes("breach"),
    `provenance must retain both classes, got ${r.source_classes.join(",")}`);
  assertEquals(r.reason_for_confidence, "single source class: breach");
  assertEquals(r.cap, 60, "unknown must not add the +10 cross-class boost (would be 70)");
});

Deno.test("bug#2: a source that is only 'unknown' reports single-class reasoning, never 'corroborated'", () => {
  const r = applyEvidenceCaps({ rawConfidence: 50, sources: ["some_mystery_provider"] });
  assertEquals(r.source_classes, ["unknown"]);
  assert(r.reason_for_confidence.startsWith("single source class"), r.reason_for_confidence);
  assert(!r.reason_for_confidence.includes("corroborated"), r.reason_for_confidence);
});

Deno.test("bug#2: two REAL classes still corroborate (unknown-exclusion doesn't over-suppress)", () => {
  const r = applyEvidenceCaps({ rawConfidence: 95, sources: ["census_geocode", "pacer_docket"] }); // public_record + court_record
  assert(r.reason_for_confidence.startsWith("corroborated across 2 source classes"), r.reason_for_confidence);
});
