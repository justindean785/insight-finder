/**
 * artifact_hygiene_test.ts — write-path accuracy gates.
 *
 * Every case here is a row measured on a REAL production run (thread
 * 2d0dcd03, build 8c6184b, 2026-08-14). Selectors are the live ones the
 * operator supplied for diagnosis; they are a public artist handle and its
 * public booking address, and nothing here is a credential. The point of using
 * them verbatim is that a sanitized fixture would have been written from my
 * memory of the shape and would not have caught the defects below.
 *
 * The run persisted 54 artifacts. Roughly 20 were not observations:
 *   - 10 "(pending)" rows recorded BEFORE the tool ran, status "observed"
 *   -  2 rows for ONE breach_check null result, phrased differently
 *   -  3 rows for @blapdre, two of them identical in meaning
 *   -  4 rows for a single Reddit post, split across kinds
 * The Evidence counter therefore overstated distinct evidence by ~2x.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isQueuedPlaceholder,
  stripStatusAssertions,
  demoteUnauthoritativeLegalRecord,
  nullResultKey,
} from "./lib/artifact-hygiene.ts";

/* ── G1 — a queued tool call is not an observation ──────────────────────── */

Deno.test("rejects the '(pending)' placeholders the live run persisted", () => {
  // Verbatim values from the run. Each was written before its tool returned,
  // carried status:"observed", and was later shadowed by the real result —
  // so every one of them is both a falsehood and a guaranteed duplicate.
  const placeholders = [
    "hawkcapo - serus_darkweb_scan (pending)",
    "hawkcapo - rapidapi_breach_search (pending for hawkcapomgmt@gmail.com)",
    "hawkcapo - oathnet_lookup (pending)",
    "hawkcapo - socialfetch_lookup (pending Instagram)",
    "hawkcapo - socialfetch_lookup (pending Twitter/X)",
    "hawkcapo - socialfetch_lookup (pending SoundCloud)",
    "hawkcapo - reddit_user (pending)",
    "hawkcapo - jina_reader_scrape SoundCloud (pending)",
    "hawkcapo - exa_search (pending)",
    "hawkcapo - google_dorks legal/court (pending)",
  ];
  for (const v of placeholders) {
    assert(isQueuedPlaceholder(v), `should have been rejected as queued: ${v}`);
  }
});

Deno.test("does NOT reject real findings that merely contain the word pending", () => {
  // The gate keys on "<tool_slug> (pending…)", not on the word alone, so a
  // genuine observation about a pending state still records.
  const real = [
    "account suspended pending appeal",
    "Sacramento Superior Court case 24FE001234 — disposition pending",
    "hawkcapo - Telegram",
    "SoundCloud hawkcapo - California, US (empty, 1 follower)",
  ];
  for (const v of real) {
    assert(!isQueuedPlaceholder(v), `real finding wrongly rejected: ${v}`);
  }
});

/* ── G2 — a status word inside the value contradicts the stored number ──── */

Deno.test("strips CONFIRMED from values the model asserted it into", () => {
  // Live rows. The left-hand text shipped in the DB next to the confidence on
  // the right — and next to reason_not_confirmed "needs second independent
  // class of evidence". This is the label the report layer was told not to
  // print, smuggled into the data where every surface repeats it verbatim.
  const cases: Array<[string, number, string]> = [
    ["Instagram @hawkcapo - CONFIRMED active profile", 40, "Instagram @hawkcapo - active profile"],
    ["Twitter/X @HawkCapo - CONFIRMED active profile", 70, "Twitter/X @HawkCapo - active profile"],
    [
      "HawkCapo shot 5 times in South Sacramento — CONFIRMED via r/CaliBanging post",
      70,
      "HawkCapo shot 5 times in South Sacramento — via r/CaliBanging post",
    ],
  ];
  for (const [input, _conf, expected] of cases) {
    const out = stripStatusAssertions(input);
    assertEquals(out.value, expected);
    assert(out.stripped, `should have reported a strip for: ${input}`);
  }
});

Deno.test("leaves values without a status assertion byte-identical", () => {
  // Must not rewrite ordinary evidence. Identity, not just equality.
  const untouched = "SoundCloud hawkcapo - California, US (empty, 1 follower)";
  const out = stripStatusAssertions(untouched);
  assertEquals(out.value, untouched);
  assertEquals(out.stripped, false);
});

Deno.test("does not strip a status word that is part of the evidence itself", () => {
  // "confirmed" appearing inside quoted source text is content, not an
  // assertion about our own confidence.
  const quoted = 'Reddit comment: "nobody confirmed that story"';
  assertEquals(stripStatusAssertions(quoted).stripped, false);
});

/* ── G3 — a Reddit thread is not a legal record ─────────────────────────── */

Deno.test("demotes legal_record when the source is not authoritative", () => {
  // Both live rows: kind legal_record at confidence 70, sourced from
  // socialfetch_web_read of reddit.com. The SOURCE classifier had it right
  // (social_profile_active); the KIND was wrong, which is what ranks community
  // gossip about a shooting and a gang affiliation as a legal record.
  const out = demoteUnauthoritativeLegalRecord({
    kind: "legal_record",
    source: "socialfetch_web_read",
    url: "https://www.reddit.com/r/CaliBanging/comments/1lgy1zx/",
  });
  assert(out, "expected a demotion");
  assertEquals(out.kind, "media_report");
  assert(/not an authoritative/i.test(out.reason), `reason should explain: ${out?.reason}`);
});

Deno.test("leaves a genuine legal_record alone", () => {
  // A court docket keeps its kind — the gate must narrow, never block.
  for (const source of ["pacer_docket", "courtlistener", "county_court_records"]) {
    assertEquals(
      demoteUnauthoritativeLegalRecord({ kind: "legal_record", source, url: null }),
      null,
      `wrongly demoted an authoritative source: ${source}`,
    );
  }
});

Deno.test("ignores kinds other than legal_record", () => {
  assertEquals(
    demoteUnauthoritativeLegalRecord({ kind: "social_profile", source: "socialfetch_web_read", url: null }),
    null,
  );
});

/* ── G4 — one null result is one row ────────────────────────────────────── */

Deno.test("collapses the two differently-phrased breach_check null rows", () => {
  // The live run recorded breach_check twice — "no breach hits (breach_check)"
  // and "0 hits (breach_check)" — 33 seconds apart, both confidence 60, both
  // in the main subject cluster. The dedup key is checkpointKey(kind, value),
  // an exact string, so paraphrase defeats it. A null result is identified by
  // (kind, tool, selector), never by how it was worded.
  const a = nullResultKey({
    kind: "breach_exposure",
    source: "breach_check",
    value: "hawkcapo - no breach hits (breach_check)",
    selector: "hawkcapo",
  });
  const b = nullResultKey({
    kind: "breach_exposure",
    source: "breach_check",
    value: "hawkcapo - 0 hits (breach_check)",
    selector: "hawkcapo",
  });
  assert(a !== null, "expected a null-result key for a zero-hit row");
  assertEquals(a, b);
});

Deno.test("keeps null results from DIFFERENT tools distinct", () => {
  // Four corpora returning zero is four coverage facts, not one. Collapsing
  // them would erase breadth — the failure mode of the earlier dedup attempt
  // whose key omitted `source`.
  const keys = ["breach_check", "oathnet_lookup", "serus_darkweb_scan", "rapidapi_breach_search"].map((source) =>
    nullResultKey({ kind: "breach_exposure", source, value: `hawkcapo - 0 hits (${source})`, selector: "hawkcapo" })
  );
  assertEquals(new Set(keys).size, 4);
});

Deno.test("keeps the same tool's null results distinct per selector", () => {
  // username clean and email clean are two different facts.
  const u = nullResultKey({
    kind: "breach_exposure", source: "rapidapi_breach_search",
    value: "hawkcapo - 0 hits", selector: "hawkcapo",
  });
  const e = nullResultKey({
    kind: "breach_exposure", source: "rapidapi_breach_search",
    value: "hawkcapomgmt@gmail.com - 0 breaches", selector: "hawkcapomgmt@gmail.com",
  });
  assert(u !== e);
});

Deno.test("returns null for a row that actually found something", () => {
  // A HIT must never be deduped by this path — only absence is canonicalised.
  assertEquals(
    nullResultKey({
      kind: "breach_exposure", source: "breach_check",
      value: "hawkcapo - 3 breaches found (Collection#1, Antipublic)", selector: "hawkcapo",
    }),
    null,
  );
});

/* ── Wiring — the gates must be CALLED, not merely exist ────────────────── */
/*
 * Everything above tests the library. Deleting all four call sites in
 * tool-registry.ts leaves every one of those tests green — verified by
 * mutation. A gate nobody calls is not a gate, and this project has shipped
 * exactly that before (an unwired module merged with a passing suite).
 *
 * Same source-level approach as reviews_wiring_test.ts, which is why the edge
 * suite runs with --allow-read.
 */
const REGISTRY = await Deno.readTextFile(new URL("./tool-registry.ts", import.meta.url));

Deno.test("wiring: record_artifacts imports the hygiene gates", () => {
  assert(
    /from\s+"\.\/lib\/artifact-hygiene\.ts"/.test(REGISTRY),
    "tool-registry.ts must import lib/artifact-hygiene.ts — without it the gates are dead code",
  );
});

Deno.test("wiring: the queued-placeholder gate guards the record path unconditionally", () => {
  // Asserts the exact call form, so a `false &&` / `if (0 &&` disable is caught
  // rather than passing as "still referenced somewhere".
  assert(
    REGISTRY.includes("if (isQueuedPlaceholder(a.value)) {"),
    "isQueuedPlaceholder must gate the record path with no disabling prefix",
  );
});

Deno.test("wiring: the value reaching validateArtifact is the stripped one", () => {
  // The whole point is that the DB never receives the asserted label. If
  // validateArtifact still saw a.value, the raw string would be persisted.
  assert(REGISTRY.includes("stripStatusAssertions(a.value)"), "must strip before validating");
  assert(
    REGISTRY.includes("validateArtifact(inferred.kind, hygienic.value)"),
    "validateArtifact must receive the STRIPPED value, not the raw one",
  );
});

Deno.test("wiring: the legal_record demotion decides finalKind", () => {
  assert(REGISTRY.includes("demoteUnauthoritativeLegalRecord({"), "demotion must be computed");
  assert(
    REGISTRY.includes("legalDemotion?.kind ?? v.kind"),
    "finalKind must honour the demotion — computing it and discarding it changes nothing",
  );
});

Deno.test("wiring: the null-result key is what dedup actually uses", () => {
  assert(REGISTRY.includes("nullResultKey({"), "null-result key must be computed");
  assert(
    REGISTRY.includes("canonicalNullKey ?? `${finalKind} ${v.value}"),
    "dedupKey must PREFER the canonical null key, falling back to the exact-string key",
  );
});
