// negative_source_qualifier_test.ts — a lookup that found nothing, and a memory
// recall, are not corroborating sources.
//
// Measured on a live case (2026-10-06): 11 of 14 persisted IP rows read
// "corroborated across 2 source classes: breach, infra_scan" at confidence 75–80 /
// tier Likely. The model-written `source` string named tools that had returned
// NOTHING — `shodan_internetdb (404)`, `oathnet_stealer_search (0 hits)`,
// `hackertarget (no PTR)` — and the class engine unioned every token's class
// regardless of the qualifier. Separately, `memory_recall (prior serus_darkweb_scan)`
// classified as `breach`, so a recalled note counted as a second fresh source.
//
// The fix is deliberately DEFLATIONARY: a mis-parse can only under-count, never
// over-count. The lasting fix is call-to-artifact lineage (join to the call's real
// outcome); this rule is the interim guard. Kill switch, read at CALL TIME:
// NEGATIVE_QUALIFIER_CLASS_DISABLED=true.
//
// Synthetic values only (CLAUDE.md forbids real investigation PII in this repo).
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyEvidenceCapsWithDistinctBreachIdentities, type CapResult } from "./confidence.ts";
import {
  negativeSourceQualifierRuleDisabled,
  negativeSourceQualifierSelfTest,
  sanitizeSourceLabelForEvidence,
} from "./source-classification.ts";

const caps = (source: string, kind = "ip", raw = 80): CapResult =>
  applyEvidenceCapsWithDistinctBreachIdentities({ rawConfidence: raw, sources: [source], kind });

async function withEnv<T>(key: string, value: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const prev = Deno.env.get(key);
  if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value);
  try { return await fn(); } finally {
    if (prev === undefined) Deno.env.delete(key); else Deno.env.set(key, prev);
  }
}

// ── The measured production shapes ─────────────────────────────────────────────

Deno.test("a 0-hit stealer search and a Shodan 404 do not make an IP row 'corroborated'", () => {
  const r = caps("ip_intel + hackertarget (no PTR) + shodan_internetdb (404) + oathnet_stealer_search (0 hits)");
  assertEquals(r.reason_for_confidence, "single source class: infra_scan");
  assertEquals(r.confidence, 70, "infra-only evidence caps at 70, not 80");
  assert(!r.source_classes.includes("breach"), "a 0-hit search must not supply the breach class");
});

Deno.test("a circuit-broken Shodan token adds nothing (already single-class, unchanged)", () => {
  const r = caps("ip_intel + shodan_internetdb (circuit-broken)");
  assertEquals(r.reason_for_confidence, "single source class: infra_scan");
  assertEquals(r.confidence, 70);
});

Deno.test("a 'finalize window — not completed' search is not a source", () => {
  const r = caps("ip_intel + oathnet_stealer_search (finalize window — not completed)");
  assert(!r.source_classes.includes("breach"));
  assertEquals(r.reason_for_confidence, "single source class: infra_scan");
});

// ── Positive controls: real observations are untouched ─────────────────────────

Deno.test("control: a breach-record IP with a positive qualifier still corroborates", () => {
  const r = caps("serus_darkweb_scan (iMesh 2013 breach on user@example.test) + ipgeolocation_lookup + shodan_internetdb");
  assert(r.source_classes.includes("breach"));
  assert(r.source_classes.includes("infra_scan"));
  assertEquals(r.reason_for_confidence, "corroborated across 2 source classes: breach, infra_scan");
});

Deno.test("control: '(3 hits)' and '(0.92 match)' are not negative qualifiers", () => {
  assert(caps("ip_intel + oathnet_stealer_search (3 hits)").source_classes.includes("breach"));
  assert(caps("ip_intel + oathnet_lookup (0.92 match)").source_classes.includes("breach"));
});

Deno.test("control: a parenthetical holding a separator stays one token", () => {
  const label = "exa_search (DOJ release + CBS SF)";
  assertEquals(sanitizeSourceLabelForEvidence(label), label);
});

// ── memory_recall is never a source (regression PINS of existing behaviour) ───
// An external audit claimed `memory_recall (prior serus_darkweb_scan)` inflates a
// row. Measured: it does not — the token classifies `unknown`, which the engine
// already excludes from corroboration, and the 83 stored rows citing memory_recall
// top out at confidence 75 via OTHER sources. These tests pin that so it stays true.

Deno.test("memory_recall (prior <tool>) does not count as a fresh breach source", () => {
  const alone = caps("memory_recall (prior serus_darkweb_scan)", "email", 70);
  assertEquals(alone.source_classes, ["unknown"], "a recalled note carries no source class of its own");
  assertEquals(alone.reason_for_confidence, "single source class: unknown");
});

Deno.test("memory_recall beside the fresh tool is the SAME evidence, counted once", () => {
  const both = caps("memory_recall (prior serus_darkweb_scan) + serus_darkweb_scan", "email", 70);
  const fresh = caps("serus_darkweb_scan", "email", 70);
  assertEquals(both.source_classes, fresh.source_classes);
  assertEquals(both.confidence, fresh.confidence);
});

// ── Never reduce a row to nothing; never create corroboration ─────────────────

Deno.test("an all-negative label keeps ONE class (provenance) and can never corroborate", () => {
  const r = caps("shodan_internetdb (404) + oathnet_stealer_search (0 hits)");
  assertEquals(r.source_classes.length, 1, "two negative lookups are not two classes of evidence");
  assert(!r.reason_for_confidence.startsWith("corroborated"));
});

Deno.test("a single-token negative label keeps its class (coverage-fact rows are not re-capped)", () => {
  assertEquals(sanitizeSourceLabelForEvidence("rapidapi_breach_search (0 hits)"), "rapidapi_breach_search");
  assert(caps("rapidapi_breach_search (0 hits)", "breach_exposure", 60).source_classes.includes("breach"));
});

Deno.test("a label with no negative or memory token is returned byte-identical", () => {
  for (const l of ["breach_check", "ip_intel + hackertarget (reverse DNS)", "D&B / Redfin", "Multiple sources", ""]) {
    assertEquals(sanitizeSourceLabelForEvidence(l), l);
  }
});

Deno.test("sanitizing is idempotent", () => {
  const once = sanitizeSourceLabelForEvidence("ip_intel + shodan_internetdb (404) + memory_recall (prior x)");
  assertEquals(once, "ip_intel + memory_recall (prior x)");
  assertEquals(sanitizeSourceLabelForEvidence(once), once);
});

// ── Kill switch + /health self-test ───────────────────────────────────────────

Deno.test("NEGATIVE_QUALIFIER_CLASS_DISABLED=true restores the old behaviour on the running build", async () => {
  await withEnv("NEGATIVE_QUALIFIER_CLASS_DISABLED", "true", () => {
    assert(negativeSourceQualifierRuleDisabled());
    const r = caps("ip_intel + shodan_internetdb (404) + oathnet_stealer_search (0 hits)");
    assertEquals(r.reason_for_confidence, "corroborated across 2 source classes: infra_scan, breach");
    assertEquals(r.confidence, 80);
  });
  await withEnv("NEGATIVE_QUALIFIER_CLASS_DISABLED", undefined, () => {
    assert(!negativeSourceQualifierRuleDisabled());
  });
});

Deno.test("the /health self-test engages and reports ok", () => {
  const t = negativeSourceQualifierSelfTest();
  assert(t.ok, t.detail);
  assert(t.detail.length > 0);
});
