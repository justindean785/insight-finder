// thread_wide_artifact_dedup_test.ts — one observation is one row, thread-wide.
//
// THE REGRESSION (production, 2026-08-26). `record_artifacts` deduped against
// `seenInBatch`, which only ever caught a repeat inside ONE call. The
// duplicates measured were seconds apart in DIFFERENT calls:
//
//     V&S 1110 LLC   3 `organization` rows at 55 / 75 / 75
//     Ved Parkash    3 `source_person` rows
//     the address    4+ rows
//
// so an Evidence count of 88 was not a count of distinct facts.
//
// ⚠️ THE HALF THAT MATTERS MORE IS WHAT THIS MUST **NOT** DO. #305's dedup
// migration would have deleted ~120 genuinely distinct rows and orphaned 53
// analyst reviews; #307, which existed to fix that, was closed unmerged. The
// negative controls below are the guard rails those two PRs died for.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { artifactDedupKey } from "./lib/artifact-hygiene.ts";
import { loadSeenArtifactKeys, SEEN_ARTIFACT_PAGE_SIZE } from "./auto-persist-findings.ts";
import { checkpointKey } from "./incremental-persist.ts";

/* ── the identity key ──────────────────────────────────────────────────── */

Deno.test("the same observation from the same source is one key", () => {
  const a = artifactDedupKey({ kind: "organization", value: "V&S 1110 LLC", source: "opencorporates_search" });
  const b = artifactDedupKey({ kind: "organization", value: "V&S 1110 LLC", source: "OpenCorporates_Search " });
  assertEquals(a, b, "source is compared trimmed and case-folded, as the write path folds it");
});

Deno.test("NEGATIVE CONTROL: disagreeing counts are CONTRADICTIONS, not duplicates", () => {
  // 670 / 676 / 28 violations_total, 34 / 30 open, 117 / 118 evictions — all
  // recorded on one building in one session. Collapsing them would convert a
  // visible disagreement into a silent merge, which is the data-loss shape
  // #305 and #307 both died on. The value is in the key WHOLE and UNPARSED, so
  // this is structural, not a behaviour anyone has to remember.
  const keys = new Set(
    ["670", "676", "28"].map((n) =>
      artifactDedupKey({ kind: "finding", value: `violations_total ${n}`, source: "hpd_lookup" })
    ),
  );
  assertEquals(keys.size, 3, "three different numbers are three surviving rows");
  assert(
    artifactDedupKey({ kind: "finding", value: "open violations 34", source: "hpd_lookup" }) !==
      artifactDedupKey({ kind: "finding", value: "open violations 30", source: "hpd_lookup" }),
    "34 and 30 are a disagreement to surface, never a duplicate to hide",
  );
});

Deno.test("NEGATIVE CONTROL: the same value from a DIFFERENT source is corroboration", () => {
  // `source` is in the key on purpose. Four corpora returning the same answer
  // is four coverage facts; collapsing them erases breadth (#189's migration).
  assert(
    artifactDedupKey({ kind: "phone", value: "+19172915568", source: "oathnet_lookup" }) !==
      artifactDedupKey({ kind: "phone", value: "+19172915568", source: "indicia_phone" }),
    "two independent sources agreeing must remain two rows",
  );
});

Deno.test("a missing source folds to the empty string, matching a stored NULL", () => {
  assertEquals(
    artifactDedupKey({ kind: "name", value: "Ved Parkash", source: null }),
    artifactDedupKey({ kind: "name", value: "Ved Parkash" }),
    "the write path stores `a.source ?? null`; both must key identically",
  );
});

/* ── the thread-wide seen set (auto-persist writer) ────────────────────── */

/** Fake PostgREST: `.from().select().eq().range()` returning scripted pages. */
function fakeDb(pages: Array<Array<{ kind?: unknown; value?: unknown }>>, error: unknown = null) {
  const calls: Array<[number, number]> = [];
  const db = {
    from: () => ({
      select: () => ({
        eq: () => ({
          range: (from: number, to: number) => {
            calls.push([from, to]);
            const page = pages.shift() ?? [];
            return Promise.resolve({ data: error ? null : page, error });
          },
        }),
      }),
    }),
  };
  return { db: db as unknown as Parameters<typeof loadSeenArtifactKeys>[0], calls };
}

Deno.test("a legacy phone row shields the canonical spelling from re-insert", () => {
  // Rows written before the E.164 fold hold "9172915568" where a new extraction
  // now yields "+19172915568". Without registering the normalized spelling the
  // legacy row would not block the duplicate — and there is no migration here
  // by design, so old and new must be reconciled at read time.
  return loadSeenArtifactKeys(fakeDb([[{ kind: "phone", value: "9172915568" }]]).db, "t1").then((seen) => {
    assert(seen.has(checkpointKey("phone", "+19172915568")), "the canonical form must be shielded");
    assert(seen.has(checkpointKey("phone", "9172915568")), "and the literal stored form too");
  });
});

Deno.test("NEGATIVE CONTROL: the literal key is kept for values normalizeFinding rejects", () => {
  // Other writers legitimately persist kinds and values the auto-persist
  // extractor's ALLOWED_KINDS does not cover. Dropping the literal key would
  // WIDEN the extractor's permission to re-insert them. The set only ever
  // grows, so this can cause more dedup, never less.
  return loadSeenArtifactKeys(
    fakeDb([[{ kind: "organization", value: "V&S 1110 LLC" }, { kind: "court_case", value: "People v Parkash" }]]).db,
    "t1",
  ).then((seen) => {
    assert(seen.has(checkpointKey("organization", "V&S 1110 LLC")));
    assert(seen.has(checkpointKey("court_case", "People v Parkash")));
  });
});

Deno.test("NEGATIVE CONTROL: a genuinely different phone is not shielded", () => {
  return loadSeenArtifactKeys(fakeDb([[{ kind: "phone", value: "9172915568" }]]).db, "t1").then((seen) => {
    assert(
      !seen.has(checkpointKey("phone", "+79172915568")),
      "the Russian +7 number is a different fact and must still be insertable",
    );
  });
});

Deno.test("the seen set is PAGED — a full page triggers another read", () => {
  const full = Array.from({ length: SEEN_ARTIFACT_PAGE_SIZE }, (_, i) => ({ kind: "url", value: `https://e.example/${i}` }));
  const { db, calls } = fakeDb([full, [{ kind: "url", value: "https://e.example/last" }]]);
  return loadSeenArtifactKeys(db, "t1").then((seen) => {
    assertEquals(calls.length, 2, "a full page must be followed by another read");
    assert(seen.has(checkpointKey("url", "https://e.example/last")), "the second page must be included");
  });
});

Deno.test("a failed page degrades to partial dedup, never to a thrown request", () => {
  // Best-effort by contract: a partial set means a duplicate may slip through,
  // which is the pre-existing behaviour. It can never cause over-collapsing.
  return loadSeenArtifactKeys(fakeDb([[]], { message: "boom" }).db, "t1").then((seen) => {
    assertEquals(seen.size, 0);
  });
});

/* ── wiring: a gate nobody calls is not a gate ─────────────────────────── */

const REGISTRY = await Deno.readTextFile(new URL("./tool-registry.ts", import.meta.url));

Deno.test("wiring: record_artifacts loads the thread-wide key set", () => {
  assert(
    REGISTRY.includes("await loadThreadArtifactIdentities(supabase, threadId)"),
    "the batch loop must be preceded by the thread-wide scan, with no disabling prefix",
  );
  assert(
    /priorByKey\.get\(dedupKey\)/.test(REGISTRY),
    "the scan result must actually be consulted with the shared key",
  );
});

Deno.test("wiring: the SINGULAR record_artifact shim is thread-deduped too", () => {
  // It is a full duplicate implementation, not a delegation, and it is
  // advertised in the catalog — deduping only the plural tool would leave the
  // bypass advertised.
  assert(
    REGISTRY.includes("await findPriorThreadArtifact("),
    "record_artifact must consult the thread before inserting",
  );
});

Deno.test("wiring: both writers build the key with the SAME shared function", () => {
  // Two hand-written copies of one key is how a dedup gate silently stops
  // matching: the runtime key drifts from the stored key and nothing fails.
  const uses = REGISTRY.split("artifactDedupKey(").length - 1;
  assert(uses >= 3, `expected the shared key helper at every site, saw ${uses}`);
});

Deno.test("⛔ wiring: a duplicate NEVER mutates the surviving row's confidence", () => {
  // THIS IS THE LOAD-BEARING ONE. #307 merged with GREATEST, and that is unsafe
  // here: scrubArtifactRow caps confidence to 25/35 on a possible-minor row
  // AFTER finalConfidence is computed and BEFORE insert. A max(stored,
  // attempted) update would read the capped 25 and raise it back to the model's
  // number, silently undoing the minor-safety downgrade. The delta is disclosed
  // instead. Do not "improve" this into an update.
  // Comments are stripped first: this file and tool-registry.ts both DISCUSS
  // GREATEST at length, and a prose match would make the guard unfalsifiable.
  const code = REGISTRY.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  assert(
    !/confidenceUpgrades|GREATEST|Math\.max\([^)]*prior/.test(code),
    "no max-confidence merge may ship — the delta is disclosed, never applied",
  );
  assert(
    !/\.update\(\s*\{\s*confidence/.test(code),
    "no code path may write a confidence back onto an existing artifact row",
  );
  assert(
    REGISTRY.includes("confidence_deltas_suppressed"),
    "a suppressed confidence delta must be disclosed to the model",
  );
});
