// selector_normalize_test.ts — one phone is one artifact, and an address is
// composed rather than concatenated.
//
// THE REGRESSION THIS PINS (production, 2026-08-26; seed "Jesus Acosta, age 31"
// pivoting to +19172915568). One phone became FOUR artifacts and one address
// rendered as a run-together restatement of itself. Both are write-path
// spelling problems: dedup everywhere is `checkpointKey(kind, value)` — exact
// equality — so the spelling IS the identity.
//
// FIXTURES ARE SYNTHETIC except the two values that ARE the bug report (the
// phone digits and the Anderson Ave strings), which are reproduced because the
// defect is in their exact shape. No other real selector appears here.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { canonicalPhoneValue, composeAddress, normPhoneE164 } from "./lib/selector-normalize.ts";
import { normalizeFinding } from "./auto-persist-findings.ts";
import { validateArtifact } from "./validation.ts";
import { checkpointKey } from "./incremental-persist.ts";

/* ── phone: the four spellings ─────────────────────────────────────────── */

Deno.test("the spellings of ONE phone collapse to a single dedup key", () => {
  const spellings = ["+19172915568", "19172915568", "9172915568", "(917) 291-5568"];
  const keys = new Set(
    spellings.map((s) => checkpointKey("phone", normalizeFinding("phone", s)!.value)),
  );
  assertEquals(keys.size, 1, "four spellings of one number must be one artifact, not four");
  assertEquals(normalizeFinding("phone", "9172915568")?.value, "+19172915568");
});

Deno.test("NEGATIVE CONTROL: the Russian +7 number sharing ten digits stays distinct", () => {
  // 79172915568 came off a zoloto585.ru row belonging to a different person and
  // was persisted as a subject selector. It shares ten digits with the US
  // number and is NOT the same number. Merging them would be a false identity
  // claim — worse than the duplicate this file exists to fix.
  const us = normalizeFinding("phone", "+19172915568")!.value;
  const ru = normalizeFinding("phone", "79172915568")!.value;
  assertEquals(ru, "+79172915568");
  assert(
    checkpointKey("phone", us) !== checkpointKey("phone", ru),
    "a +7 number must never fold into a +1 number that shares ten digits",
  );
});

Deno.test("NEGATIVE CONTROL: a seven-digit local number is still accepted", () => {
  // normPhoneE164 returns null below 8 digits, but both write paths have always
  // accepted 7. Substituting the fold directly would turn an identity fix into
  // a silent admission change.
  assertEquals(normPhoneE164("2915568"), null, "the raw fold declines 7 digits");
  assertEquals(canonicalPhoneValue("2915568"), "2915568", "the storage form keeps it");
  assertEquals(normalizeFinding("phone", "291-5568")?.value, "2915568");
});

Deno.test("NEGATIVE CONTROL: admission is unchanged at both ends of the range", () => {
  assertEquals(normalizeFinding("phone", "12345"), null, "under 7 digits still rejected");
  // 16+ digits is outside the fold's 8..15 window: keep today's stored form
  // rather than inventing a country code for it.
  assertEquals(canonicalPhoneValue("12345678901234567"), "12345678901234567");
});

Deno.test("validateArtifact canonicalises phones too — three writers, one identity", () => {
  // record_artifacts / record_artifact do NOT pass through normalizeFinding.
  // Before this, a model typing 9172915568 minted its own row beside an
  // existing +19172915568 no matter what the extractor did.
  const v = validateArtifact("phone", "917-291-5568");
  assert(v.ok, "a real phone must still validate");
  assertEquals(v.ok && v.value, "+19172915568");
});

/* ── address: composed, not concatenated ───────────────────────────────── */

Deno.test("the production concatenation collapses to one legible line", () => {
  // Persisted value was:
  //   1110 ANDERSON AVE3F 1110 ANDERSON AVE APT 3F BRONX NY 10452
  // `address_street` held corpus junk and `address_street2` restated it.
  const out = composeAddress({
    street: "1110 ANDERSON AVE3F",
    street2: "1110 ANDERSON AVE APT 3F",
    city: "BRONX",
    state: "NY",
    postcode: "10452",
  });
  assert(!out.includes("AVE3F"), `the run-together junk spelling must be gone: ${out}`);
  assertEquals(out, "1110 ANDERSON AVE APT 3F, BRONX, NY 10452");
});

Deno.test("NEGATIVE CONTROL: a genuinely distinct secondary line is never lost", () => {
  // Evidence loss and an ugly string are not symmetric costs. When the two
  // lines are not redundant, BOTH survive.
  const out = composeAddress({
    street: "1110 Anderson Ave",
    street2: "c/o Parkash Management",
    city: "Bronx",
    state: "NY",
    postcode: "10452",
  });
  assert(out.includes("1110 Anderson Ave"), out);
  assert(out.includes("c/o Parkash Management"), out);
});

Deno.test("NEGATIVE CONTROL: a bare unit line is not swallowed by its street", () => {
  // This is the prefix-vs-substring guard. "APT 3F" folds to "3f", which occurs
  // INSIDE "1110andersonave3f" — a substring test would delete it as a
  // duplicate of the street it belongs to.
  const out = composeAddress({ street: "1110 ANDERSON AVE3F", street2: "APT 3F" });
  assert(out.includes("APT 3F"), `a distinct unit line must survive: ${out}`);
});

Deno.test("NEGATIVE CONTROL: two house numbers on one street never merge", () => {
  const out = composeAddress({ street: "12 Oak St", street2: "120 Oak St" });
  assert(out.includes("12 Oak St") && out.includes("120 Oak St"), out);
});

Deno.test("a street line extended by a unit keeps the longer form only", () => {
  const out = composeAddress({ street: "12 Oak St", street2: "12 Oak St Apt 4" });
  assertEquals(out, "12 Oak St Apt 4", "the prefix spelling is the same line, continued");
});

Deno.test("an address with no second line composes cleanly", () => {
  assertEquals(
    composeAddress({ street: "742 Evergreen Terrace", city: "Springfield", state: "OR", postcode: "97477" }),
    "742 Evergreen Terrace, Springfield, OR 97477",
  );
});

Deno.test("composeAddress ignores non-string and empty components", () => {
  assertEquals(composeAddress({ street: "1 Main St", street2: null, city: "", state: undefined, postcode: 90210 }), "1 Main St");
  assertEquals(composeAddress({}), "", "nothing usable yields nothing");
});
