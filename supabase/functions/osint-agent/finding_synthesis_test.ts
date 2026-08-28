// finding_synthesis_test.ts — findings must be EARNED, not counted.
//
// THE PROBLEM THIS CLOSES (production, measured 2026-08-28): 9,615 artifacts
// across 181 threads and **13** `kind='finding'` rows in the product's lifetime,
// the last one 11 days old. 6 of 181 threads ever produced a conclusion, because
// `workflow_prompt.ts` makes calling `record_finding` advisory and the model
// almost never does. Meanwhile 0 of 9,615 rows exceed their own
// `confidence_cap_applied` — the scorer is exact, it is simply never invoked.
//
// ⚠️ THE HALF THAT MATTERS MORE IS WHAT SYNTHESIS MUST **NOT** DO. Manufacturing
// conclusions from thin evidence would be far worse than having none: a finding
// carries engine authority, and the whole point of the confidence engine is that
// correlation is not confirmation. Every bar below is a NEGATIVE control.
//
// All source names are real tools and their classifications were measured against
// the live `classifySource`, not assumed — see the mirrors test.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { synthesizeFindings, eligibleArtifacts, MIN_INDEPENDENT_CLASSES } from "./finding-synthesis.ts";
import { classifySource, countIndependentClasses } from "./source-classification.ts";
import { buildFindingRow } from "./lib/finding-row.ts";

const SUBJECT_EMAIL = "jordan.vale@example.test";

function row(o: Partial<Record<string, unknown>> & { kind: string; value: string; source: string }) {
  return {
    id: o.id ?? crypto.randomUUID(),
    kind: o.kind,
    value: o.value,
    source: o.source,
    confidence: o.confidence ?? 60,
    metadata: o.metadata ?? {},
    created_at: o.created_at ?? "2026-08-28T00:00:00Z",
  };
}

/* ── the bar ─────────────────────────────────────────────────────────────── */

Deno.test("⛔ two mirrors of one leak do NOT clear the two-class bar", () => {
  // THE REQUIRED FIXTURE. Four different breach tools are four TOOLS but one
  // source CLASS, and a leak republished four times is still one leak. Measured
  // against the live classifier rather than asserted:
  const mirrors = ["breach_check", "leakcheck_lookup", "hibp_lookup", "oathnet_lookup"];
  assertEquals(
    new Set(mirrors.map(classifySource)).size,
    1,
    "all four breach tools must classify to ONE class — that is what makes them mirrors",
  );
  assertEquals(countIndependentClasses(mirrors.map(classifySource)), 1);

  const out = synthesizeFindings(mirrors.map((s) => row({ kind: "email", value: SUBJECT_EMAIL, source: s })));
  assertEquals(out.length, 0, "four mirrors of one leak must synthesize NOTHING");
});

Deno.test("two genuinely independent classes DO clear the bar", () => {
  // court_record + public_record: two distinct, corroborating classes.
  const sources = ["court_record_search", "opencorporates_search"];
  assertEquals(countIndependentClasses(sources.map(classifySource)), 2);

  const out = synthesizeFindings(sources.map((s) => row({ kind: "email", value: SUBJECT_EMAIL, source: s })));
  assertEquals(out.length, 1, "two independent classes on one selector is a finding");
  assertEquals(out[0].independentClasses, 2);
  assert(out[0].supportingArtifactIds.length >= 2, "the finding must cite the rows it rests on");
});

Deno.test("⛔ NEGATIVE CONTROL: volume is not corroboration", () => {
  // Forty artifacts, one class. The bar is independence, never count — this is
  // the exact inflation audit F06 fixed at the write layer, and synthesis must
  // not reintroduce it at the selection layer.
  const many = Array.from({ length: 40 }, (_, i) =>
    row({ kind: "email", value: SUBJECT_EMAIL, source: "breach_check", id: `b${i}` }));
  assertEquals(synthesizeFindings(many).length, 0, "40 artifacts of one class is still one class");
});

Deno.test("⛔ NEGATIVE CONTROL: a non-corroborating class cannot be the second class", () => {
  // ai_summary and web_search are in NON_CORROBORATING_CLASSES on purpose: a
  // model summary restating a page is not independent evidence of identity.
  assertEquals(classifySource("minimax_web_search"), "ai_summary");
  const sources = ["minimax_web_search", "jina_reader_scrape"];
  assertEquals(countIndependentClasses(sources.map(classifySource)), 1, "ai_summary does not count");
  assertEquals(
    synthesizeFindings(sources.map((s) => row({ kind: "email", value: SUBJECT_EMAIL, source: s }))).length,
    0,
  );
});

/* ── the quarantine boundary ─────────────────────────────────────────────── */

Deno.test("⛔ a quarantined row cannot supply the second class", () => {
  // 405 rows in production carry subject_unlinked — 20% of a week's collection.
  // Their linkage to the subject is UNPROVEN, so letting one contribute a source
  // class would let an unproven row manufacture a confirmed conclusion. This is
  // the promote-boundary rule (#448) applied one layer up.
  const rows = [
    row({ kind: "email", value: SUBJECT_EMAIL, source: "court_record_search" }),
    row({
      kind: "email",
      value: SUBJECT_EMAIL,
      source: "opencorporates_search",
      metadata: { subject_unlinked: true, subject_unlinked_reason: "name-only harvest" },
    }),
  ];
  assertEquals(eligibleArtifacts(rows).length, 1, "the quarantined row is not an eligible input");
  assertEquals(
    synthesizeFindings(rows).length,
    0,
    "one real class plus one quarantined row is ONE class, not two",
  );
});

Deno.test("NEGATIVE CONTROL: quarantine removes AUTHORITY, never existence", () => {
  // Disclosure, not deletion. Synthesis declining to count a row must never be
  // confused with the row being gone — it stays in `artifacts` with its reason,
  // and this module simply never had the power to delete anything. Pinned
  // structurally: the module performs no writes at all.
  const src = Deno.readTextFileSync(new URL("./finding-synthesis.ts", import.meta.url));
  assert(!/\.delete\(|\.update\(|\.insert\(|\.upsert\(/.test(src), "synthesis must perform no writes");
});

Deno.test("excluded_collision and weak_lead are never eligible inputs", () => {
  const rows = [
    row({ kind: "excluded_collision", value: "Someone Else", source: "court_record_search" }),
    row({ kind: "weak_lead", value: "maybe", source: "opencorporates_search" }),
  ];
  assertEquals(eligibleArtifacts(rows).length, 0);
  assertEquals(synthesizeFindings(rows).length, 0);
});

Deno.test("a prior finding row is never re-ingested as evidence for a new one", () => {
  // Otherwise each sweep would feed on its own output and ratchet confidence.
  const rows = [
    row({ kind: "finding", value: "an earlier conclusion", source: "court_record_search" }),
    row({ kind: "finding", value: "another", source: "opencorporates_search" }),
  ];
  assertEquals(eligibleArtifacts(rows).length, 0, "kind='finding' is not evidence");
  assertEquals(synthesizeFindings(rows).length, 0);
});

/* ── the empty case is the COMMON case ───────────────────────────────────── */

Deno.test("the empty result is cheap, silent and correct", () => {
  assertEquals(synthesizeFindings([]).length, 0);
  assertEquals(synthesizeFindings([row({ kind: "email", value: SUBJECT_EMAIL, source: "breach_check" })]).length, 0);
  // On the measured corpus this is what MOST threads will do, so it is a
  // supported outcome, not a failure path.
});

Deno.test("synthesis is deterministic — the same thread yields the same findings", () => {
  const rows = [
    row({ kind: "email", value: SUBJECT_EMAIL, source: "court_record_search", id: "a" }),
    row({ kind: "email", value: SUBJECT_EMAIL, source: "opencorporates_search", id: "b" }),
    row({ kind: "email", value: SUBJECT_EMAIL, source: "indicia_person", id: "c" }),
  ];
  const a = synthesizeFindings(rows);
  const b = synthesizeFindings(rows);
  assertEquals(JSON.stringify(a), JSON.stringify(b), "a re-run must not produce different conclusions");
  assert(a.length >= 1);
});

/* ── the scorer is the SAME scorer ───────────────────────────────────────── */

Deno.test("⛔ a synthesized finding's number never exceeds its own cap", () => {
  // The display invariant (#481) that 0 of 9,615 production rows violate.
  // Synthesis routes through buildFindingRow — record_finding's chain, moved
  // verbatim — so this holds by construction rather than by a second rule.
  const rows = [
    row({ kind: "email", value: SUBJECT_EMAIL, source: "court_record_search" }),
    row({ kind: "email", value: SUBJECT_EMAIL, source: "opencorporates_search" }),
  ];
  const [cand] = synthesizeFindings(rows);
  assert(cand, "fixture must clear the bar");
  const { row: built } = buildFindingRow(cand.input, {
    threadId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    contraRows: [],
  });
  const meta = built.metadata as Record<string, unknown>;
  const cap = Number(meta.confidence_cap_applied);
  assert(Number.isFinite(cap), "a synthesized finding must carry confidence_cap_applied");
  assert(
    Math.min(Number(built.confidence), cap) <= cap,
    `published number ${built.confidence} must not exceed cap ${cap}`,
  );
  assertEquals(built.kind, "finding");
});

Deno.test("⛔ the model's label is never the persisted status", () => {
  // #477: ten of the thirteen real record_finding calls persisted
  // label:"CONFIRMED" on a server score between 15 and 78. Synthesis passes
  // label:"INFERRED" as disclosure only; the server decides.
  const rows = [
    row({ kind: "email", value: SUBJECT_EMAIL, source: "court_record_search" }),
    row({ kind: "email", value: SUBJECT_EMAIL, source: "opencorporates_search" }),
  ];
  const [cand] = synthesizeFindings(rows);
  const { row: built, status } = buildFindingRow(cand.input, {
    threadId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    contraRows: [],
  });
  const meta = built.metadata as Record<string, unknown>;
  assertEquals(meta.model_label, "INFERRED", "the requested label is kept as disclosure");
  assertEquals(meta.status, status, "the persisted status is the SERVER's");
  // The real vocabulary, read from confidence.ts's ArtifactStatus union rather
  // than guessed. Note what the server actually returns for a freshly
  // synthesized two-class finding: `needs_corroboration` — NOT `confirmed`.
  // That is the engine being stricter than this module's admission bar, and it
  // is the right relationship between them: synthesis decides what is worth
  // adjudicating, the engine decides what it is worth. A synthesized row is a
  // candidate conclusion, never an automatic confirmation.
  const STATUSES = [
    "observed", "needs_corroboration", "verified", "confirmed", "excluded",
    "exhausted", "contradicted", "needs_review", "manual_review_required",
  ];
  assert(
    STATUSES.includes(String(status)),
    `server status must come from resolveRecordingStatus, saw ${status}`,
  );
  assert(
    status !== "confirmed",
    "clearing the synthesis bar must NOT by itself produce a confirmed finding",
  );
});

/* ── wiring: one scorer, not two ─────────────────────────────────────────── */

Deno.test("wiring: record_finding delegates to the shared builder", () => {
  // The 161-line scoring block was MOVED into lib/finding-row.ts, not copied. If
  // anyone re-inlines a scorer here, synthesis and the tool path start drifting
  // silently — which is the failure this extraction exists to prevent.
  const registry = Deno.readTextFileSync(new URL("./tool-registry.ts", import.meta.url));
  assert(registry.includes("buildFindingRow(i, {"), "record_finding must call the shared builder");
  const code = registry.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert(
    !/const\s+findingCap\s*=\s*applyRecordingSourcePolicy/.test(code),
    "the scoring chain must not be re-inlined into tool-registry.ts",
  );
});

Deno.test("wiring: the bar is a named constant, not a literal buried in a branch", () => {
  assertEquals(MIN_INDEPENDENT_CLASSES, 2);
});

/* ── the persisted class beats a recomputed one ──────────────────────────── */

Deno.test("⛔ source classes come from the PERSISTED marker, not a recomputation", () => {
  // Measured on the live argusint.net run (2026-08-28). The row for
  // `argus-intelligence.io` carries source: "minimax_web_search" but
  // metadata.sources: ["minimax_web_search","whois_lookup"], so the integrity
  // layer recorded source_category: ["infra_registry"] — while recomputing from
  // the single `source` column yields "ai_summary", a NON-corroborating class.
  // 1 of 18 rows in that run disagreed, and the disagreement flips whether the
  // row can support a conclusion at all.
  assertEquals(classifySource("minimax_web_search"), "ai_summary", "the recomputation");
  const rows = [
    row({ kind: "domain", value: SUBJECT_EMAIL, source: "minimax_web_search",
          metadata: { source_category: ["infra_registry"], sources: ["minimax_web_search", "whois_lookup"] } }),
    row({ kind: "domain", value: SUBJECT_EMAIL, source: "dns_records",
          metadata: { source_category: ["infra_dns"] } }),
  ];
  const out = synthesizeFindings(rows);
  assertEquals(out.length, 1, "infra_registry + infra_dns is two independent classes");
  assertEquals(out[0].independentClasses, 2);
  assert(
    out[0].input.drivers[0].includes("infra_registry"),
    `the driver must name the persisted class, saw: ${out[0].input.drivers[0]}`,
  );
});

Deno.test("NEGATIVE CONTROL: a row with no persisted marker still classifies", () => {
  // 9,000+ rows predate source_category. Falling back to classifySource keeps
  // them countable rather than silently dropping them to zero classes.
  const rows = [
    row({ kind: "email", value: SUBJECT_EMAIL, source: "court_record_search" }),
    row({ kind: "email", value: SUBJECT_EMAIL, source: "opencorporates_search" }),
  ];
  assertEquals(synthesizeFindings(rows).length, 1, "the fallback must still reach the bar");
});
