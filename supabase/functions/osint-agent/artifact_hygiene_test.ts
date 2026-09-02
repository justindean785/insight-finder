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
  nullResultKey,
  breachExposureCanonicalKey,
  collapseBreachExposureBatch,
  collapseStealerHashBatch,
  collapseRecordArtifactsBatch,
} from "./lib/artifact-hygiene.ts";
import { TOOL_CATALOG } from "./catalog.ts";

/** The REAL tool vocabulary G1 keys on — the same set tool-registry.ts passes.
 *  Built from the catalog so this test cannot drift from the shipped call. */
const TOOLS: ReadonlySet<string> = new Set(TOOL_CATALOG.tools.map((t) => t.name.toLowerCase()));

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
    assert(isQueuedPlaceholder(v, TOOLS), `should have been rejected as queued: ${v}`);
  }
});

Deno.test("G1 keeps real records whose identifiers merely LOOK like tool slugs", () => {
  // Executed against the first implementation, all three of these were dropped
  // as "queued-tool placeholder": TOOL_SLUG_RE matched the docket/case number,
  // and "(pending appeal)" / "(pending decision)" is ordinary court and
  // immigration language. This is evidence loss, so it is pinned by value.
  const realRecords = [
    "Docket 2021_cv_01188 (pending appeal) — Anne Arundel",
    "Asylum application (pending decision) ref uscis_2024_88231",
    "Sentencing (queued) for case_number 19_cr_457",
  ];
  for (const v of realRecords) {
    assert(!isQueuedPlaceholder(v, TOOLS), `real record must NOT be discarded: ${v}`);
  }
});

Deno.test("G1 fails CLOSED — no vocabulary means no discard", () => {
  // A duplicated placeholder is a counting error; a dropped court record is
  // evidence loss. Those are not symmetric, so the unknown case must keep.
  assert(
    !isQueuedPlaceholder("hawkcapo - socialfetch_lookup (pending Instagram)"),
    "without the tool vocabulary the row must be KEPT, never discarded",
  );
  assert(
    !isQueuedPlaceholder("hawkcapo - socialfetch_lookup (pending Instagram)", new Set()),
    "an empty vocabulary must behave the same as none",
  );
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

/* ── G3 — DEFERRED, and the reason is worth keeping ──────────────────────
 *
 * #460 shipped a legal_record demotion keyed on the TOOL name: demote unless
 * classifySource(source) is an OFFICIAL class. It is not in this PR, because a
 * measured run (1720 Sea Pine Circle, 2026-08-16) produced two legal_record
 * rows from the SAME tool at the SAME confidence whose correct answers differ:
 *
 *   jina_reader_scrape @75  aacounty.org police press release  -> genuine LE record
 *   jina_reader_scrape @75  Gun Violence Archive incident      -> not a court/LE record
 *
 * classifySource("jina_reader_scrape") is `independent_public`, so the
 * tool-keyed rule demotes BOTH — mis-filing a real law-enforcement record. The
 * obvious repair, demoting only on a user-generated-content signal, keeps BOTH
 * — letting the aggregator keep an authority it does not have.
 *
 * The signal is in the URL host, and classifySource cannot supply it:
 * `aacounty.org` and `maryland.gov` both classify as `unknown`; only
 * `courts.state.md.us` resolves to `court_record`. Closing this needs an
 * explicit authoritative-host test, which is an evidence-ranking decision and
 * is deliberately not being made inside a rebase.
 */

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
const HYGIENE_SRC = await Deno.readTextFile(new URL("./lib/artifact-hygiene.ts", import.meta.url));

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
    REGISTRY.includes("if (isQueuedPlaceholder(a.value, KNOWN_TOOL_SLUGS)) {"),
    "isQueuedPlaceholder must gate the record path with no disabling prefix, AND be passed the real tool vocabulary",
  );
});

Deno.test("wiring: the singular record_artifact shim is gated too", () => {
  // record_artifact is advertised in catalog.ts, so the model may call it. It
  // previously wrote artifacts with NONE of these gates applied — an open bypass
  // of the entire cleanup. "Prefer record_artifacts" is guidance, not a control.
  assert(
    REGISTRY.includes("isQueuedPlaceholder(value, KNOWN_TOOL_SLUGS)"),
    "the record_artifact shim must run G1 with the tool vocabulary",
  );
  assert(
    REGISTRY.includes("stripStatusAssertions(value)"),
    "the record_artifact shim must run G2",
  );
});

Deno.test("wiring: a G2 strip is DISCLOSED, never silent", () => {
  // stripStatusAssertions rewrites the stored value. `stripped` had no consumer,
  // so an ALL-CAPS quotation was altered with no audit trail. Both write paths
  // must retain the pre-hygiene value.
  const disclosures = REGISTRY.split("status_assertion_stripped: true").length - 1;
  assert(disclosures >= 2, `both record paths must disclose the strip (found ${disclosures})`);
  assert(
    REGISTRY.includes("value_before_hygiene"),
    "the pre-hygiene value must be retained for chain of custody",
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

Deno.test("wiring: no unwired gate ships — G3 is absent from BOTH sides", () => {
  // A gate nobody calls is not a gate, and this project has merged exactly that
  // before. G3 is deferred, so it must be absent from the library AND the call
  // site — not left exported-but-unused, which reads as shipped.
  assert(
    !REGISTRY.includes("demoteUnauthoritativeLegalRecord"),
    "G3 is deferred — the call site must not reference it",
  );
  assert(
    !HYGIENE_SRC.includes("export function demoteUnauthoritativeLegalRecord"),
    "G3 is deferred — it must not ship as dead exported code",
  );
});

Deno.test("wiring: the null-result key is what dedup actually uses", () => {
  assert(REGISTRY.includes("nullResultKey({"), "null-result key must be computed");
  assert(
    REGISTRY.includes("breachExposureCanonicalKey({"),
    "G6 breach canonical key must participate in dedup",
  );
  assert(
    REGISTRY.includes("collapseRecordArtifactsBatch(rawArtifacts)"),
    "G6/G7 batch collapse must run before validation",
  );
  assert(
    REGISTRY.includes("?? breachExposureCanonicalKey({"),
    "dedupKey must prefer the G6 breach key before the literal value key",
  );
});

Deno.test("wiring: the null-result key is built on the AUTHORITATIVE source only", () => {
  // #463's partition: model-authored metadata labels are persisted for
  // disclosure but may not manufacture another observation row. Keying this on
  // disclosed labels would let a relabelled row split one null result into
  // several — reintroducing through the dedup key exactly what #463 closed.
  assert(
    /nullResultKey\(\{[\s\S]{0,200}source:\s*authoritativeSource/.test(REGISTRY),
    "nullResultKey must key on authoritativeSource, never on disclosed metadata labels",
  );
  assert(
    !/nullResultKey\(\{[\s\S]{0,200}effSources/.test(REGISTRY),
    "effSources was deleted by #463 and must not come back through this key",
  );
});

Deno.test("G4 must NOT collapse two DIFFERENT records that both mention a zero result", () => {
  // Executed against the first implementation these canonicalised identically,
  // so within one batch the second was rejected as a "duplicate". Different
  // courts, different dockets, different dispositions — one surviving row.
  const a = nullResultKey({
    kind: "legal_record", source: "jina_reader_scrape", selector: "james harker",
    value: "Case 2021-CV-01188 (Anne Arundel Cty): no records of prior conviction",
  });
  const b = nullResultKey({
    kind: "legal_record", source: "jina_reader_scrape", selector: "james harker",
    value: "Case 2019-CR-00457 (Baltimore Cty): no records of appeal",
  });
  assertEquals(a, null, "a record naming a specific docket is not a plain null result");
  assertEquals(b, null, "a record naming a specific docket is not a plain null result");
});

Deno.test("G4 still dedups the SAME null result phrased two ways (the original defect)", () => {
  // The regression guard for the fix above: the residue check must not be so
  // eager that it un-canonicalises a plain null result. These two are the exact
  // rows from the live run, 33s apart, both at confidence 60.
  const a = nullResultKey({
    kind: "breach_exposure", source: "breach_check", selector: "hawkcapo",
    value: "no breach hits (breach_check)",
  });
  const b = nullResultKey({
    kind: "breach_exposure", source: "breach_check", selector: "hawkcapo",
    value: "hawkcapo - 0 hits (breach_check)",
  });
  assert(a !== null, "a plain null result must still canonicalise");
  assertEquals(a, b, "the same null result phrased two ways must share one key");
});

/* ── G6 — one breach exposure row per (selector, provider) ──────────────── */

Deno.test("G6 collapses duplicate Serus breach prose for the same email", () => {
  const selector = "satans.owl@gmail.com";
  const rows = [
    {
      kind: "breach_exposure",
      value: `${selector} — Serus darkweb scan: 10 breaches, 0 pastes. Breaches: NazApi, Telegram Combolists`,
      source: "dark-web scan",
      confidence: 60,
    },
    {
      kind: "breach_exposure",
      value: `${selector} — Serus 10 breaches: NazApi (2023-09-20), Telegram Combolists (2024-05-28)`,
      source: "dark-web scan",
      confidence: 60,
    },
  ];
  const out = collapseBreachExposureBatch(rows);
  assertEquals(out.length, 1);
  assertEquals(out[0]?.value, `Breach exposure: ${selector} (serus_darkweb)`);
  const lines = out[0]?.metadata?.breach_detail_lines as string[];
  assertEquals(lines?.length, 2);
});

Deno.test("G6 keeps different breach providers distinct for the same selector", () => {
  const selector = "satans.owl@gmail.com";
  const keys = [
    breachExposureCanonicalKey({ kind: "breach_exposure", value: `Breach exposure: ${selector} (hibp_style)`, source: "rapidapi breach search" }),
    breachExposureCanonicalKey({ kind: "breach_exposure", value: `Breach exposure: ${selector} (breach_check)`, source: "breach check" }),
    breachExposureCanonicalKey({ kind: "breach_exposure", value: `${selector} — Stealer Logs (leakcheck): 13 records`, source: "breach check" }),
  ];
  assertEquals(new Set(keys).size, 3);
});

Deno.test("G6 merges multiple rapidapi corpus lines into one row", () => {
  const selector = "satans.owl@gmail.com";
  const rows = [
    { kind: "breach_exposure", value: `${selector} — NAZ.api (2023-09-20): exposed Email, nick, Password`, source: "rapidapi breach search", confidence: 60 },
    { kind: "breach_exposure", value: `${selector} — NotSOCRadar (2024-08-03): exposed Email only`, source: "rapidapi breach search", confidence: 55 },
  ];
  const out = collapseBreachExposureBatch(rows);
  assertEquals(out.length, 1);
  assertEquals(out[0]?.value, `Breach exposure: ${selector} (rapidapi)`);
});

/* ── G7 — stealer hash batch collapse ───────────────────────────────────── */

Deno.test("G7 batches oathnet stealer password strings into one hash row", () => {
  const rows = [
    { kind: "hash", value: "Houdini0", source: "oathnet stealer search", confidence: 60 },
    { kind: "hash", value: "Houdini1", source: "oathnet stealer search", confidence: 60 },
    { kind: "hash", value: "MilkHoudini1", source: "oathnet stealer search", confidence: 60 },
    { kind: "hash", value: "HoudiniMilk2", source: "oathnet stealer search", confidence: 60 },
  ];
  const out = collapseStealerHashBatch(rows);
  assertEquals(out.length, 1);
  assert(out[0]?.value.includes("Stealer-log credentials (4)"));
  assertEquals((out[0]?.metadata?.stealer_credentials as string[])?.length, 4);
});

Deno.test("G7 leaves non-stealer hash rows untouched", () => {
  const rows = [
    { kind: "hash", value: "deadbeef", source: "virustotal", confidence: 70 },
    { kind: "hash", value: "cafebabe", source: "virustotal", confidence: 70 },
  ];
  assertEquals(collapseStealerHashBatch(rows).length, 2);
});

Deno.test("collapseRecordArtifactsBatch runs G6 then G7", () => {
  const selector = "satans.owl@gmail.com";
  const rows = [
    { kind: "breach_exposure", value: `${selector} — Serus darkweb scan: 10 breaches`, source: "dark-web scan", confidence: 60 },
    { kind: "breach_exposure", value: `${selector} — Serus 10 breaches: NazApi`, source: "dark-web scan", confidence: 60 },
    { kind: "hash", value: "Houdini0", source: "oathnet stealer search", confidence: 60 },
    { kind: "hash", value: "Houdini1", source: "oathnet stealer search", confidence: 60 },
    { kind: "name", value: "Callum Jones", source: "source page review", confidence: 75 },
  ];
  const out = collapseRecordArtifactsBatch(rows);
  assertEquals(out.length, 3);
  assert(out.some((r) => r.kind === "name"));
  assert(out.some((r) => r.kind === "breach_exposure"));
  assert(out.some((r) => r.kind === "hash" && String(r.value).includes("Stealer-log credentials")));
});
