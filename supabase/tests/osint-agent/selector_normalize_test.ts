// selector_normalize_test.ts — one phone is one artifact, and an address is
// composed rather than concatenated.
//
// THE REGRESSION THIS PINS (production, 2026-08-26). On a person seed that
// pivoted to a US phone, one number became FOUR artifacts and one address
// rendered as a run-together restatement of itself. Both are write-path
// spelling problems: dedup everywhere is `checkpointKey(kind, value)` — exact
// equality — so the spelling IS the identity.
//
// FIXTURES ARE FULLY SYNTHETIC. The real run's selectors were briefly committed
// here and have been replaced: reserved 555-01xx numbers and a fictional street,
// chosen to preserve the exact STRUCTURE the defect needs — ten shared digits
// between a +1 and a +7 number, and a street line whose unit runs into it while
// the second line restates it properly. The shape is the bug report; the real
// person's identifiers were never required to express it, and CLAUDE.md's rule
// is to sanitize before checking anything in.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { canonicalPhoneValue, composeAddress, normPhoneE164 } from "../../functions/osint-agent/lib/selector-normalize.ts";
import { normalizeFinding } from "../../functions/osint-agent/auto-persist-findings.ts";
import { validateArtifact } from "../../functions/osint-agent/validation.ts";
import { checkpointKey } from "../../functions/osint-agent/incremental-persist.ts";

/* ── phone: the four spellings ─────────────────────────────────────────── */

Deno.test("the spellings of ONE phone collapse to a single dedup key", () => {
  const spellings = ["+12025550142", "12025550142", "2025550142", "(202) 555-0142"];
  const keys = new Set(
    spellings.map((s) => checkpointKey("phone", normalizeFinding("phone", s)!.value)),
  );
  assertEquals(keys.size, 1, "four spellings of one number must be one artifact, not four");
  assertEquals(normalizeFinding("phone", "2025550142")?.value, "+12025550142");
});

Deno.test("NEGATIVE CONTROL: the Russian +7 number sharing ten digits stays distinct", () => {
  // 72025550142 came off a zoloto585.ru row belonging to a different person and
  // was persisted as a subject selector. It shares ten digits with the US
  // number and is NOT the same number. Merging them would be a false identity
  // claim — worse than the duplicate this file exists to fix.
  const us = normalizeFinding("phone", "+12025550142")!.value;
  const ru = normalizeFinding("phone", "72025550142")!.value;
  assertEquals(ru, "+72025550142");
  assert(
    checkpointKey("phone", us) !== checkpointKey("phone", ru),
    "a +7 number must never fold into a +1 number that shares ten digits",
  );
});

Deno.test("NEGATIVE CONTROL: a seven-digit local number is still accepted", () => {
  // normPhoneE164 returns null below 8 digits, but both write paths have always
  // accepted 7. Substituting the fold directly would turn an identity fix into
  // a silent admission change.
  assertEquals(normPhoneE164("5550142"), null, "the raw fold declines 7 digits");
  assertEquals(canonicalPhoneValue("5550142"), "5550142", "the storage form keeps it");
  assertEquals(normalizeFinding("phone", "555-0142")?.value, "5550142");
});

Deno.test("NEGATIVE CONTROL: admission is unchanged at both ends of the range", () => {
  assertEquals(normalizeFinding("phone", "12345"), null, "under 7 digits still rejected");
  // 16+ digits is outside the fold's 8..15 window: keep today's stored form
  // rather than inventing a country code for it.
  assertEquals(canonicalPhoneValue("12345678901234567"), "12345678901234567");
});

Deno.test("validateArtifact canonicalises phones too — three writers, one identity", () => {
  // record_artifacts / record_artifact do NOT pass through normalizeFinding.
  // Before this, a model typing 2025550142 minted its own row beside an
  // existing +12025550142 no matter what the extractor did.
  const v = validateArtifact("phone", "202-555-0142");
  assert(v.ok, "a real phone must still validate");
  assertEquals(v.ok && v.value, "+12025550142");
});

/* ── address: composed, not concatenated ───────────────────────────────── */

Deno.test("the production concatenation collapses to one legible line", () => {
  // Persisted value was:
  //   742 EVERGREEN TER4B 742 EVERGREEN TER APT 4B SPRINGFIELD OR 97477
  // `address_street` held corpus junk and `address_street2` restated it.
  const out = composeAddress({
    street: "742 EVERGREEN TER4B",
    street2: "742 EVERGREEN TER APT 4B",
    city: "SPRINGFIELD",
    state: "OR",
    postcode: "97477",
  });
  assert(!out.includes("TER4B"), `the run-together junk spelling must be gone: ${out}`);
  assertEquals(out, "742 EVERGREEN TER APT 4B, SPRINGFIELD, OR 97477");
});

Deno.test("NEGATIVE CONTROL: a genuinely distinct secondary line is never lost", () => {
  // Evidence loss and an ugly string are not symmetric costs. When the two
  // lines are not redundant, BOTH survive.
  const out = composeAddress({
    street: "742 Evergreen Ter",
    street2: "c/o Riverbend Management",
    city: "Springfield",
    state: "OR",
    postcode: "97477",
  });
  assert(out.includes("742 Evergreen Ter"), out);
  assert(out.includes("c/o Riverbend Management"), out);
});

Deno.test("NEGATIVE CONTROL: a bare unit line is not swallowed by its street", () => {
  // This is the prefix-vs-substring guard. "APT 4B" folds to "4b", which occurs
  // INSIDE "742evergreenter4b" — a substring test would delete it as a
  // duplicate of the street it belongs to.
  const out = composeAddress({ street: "742 EVERGREEN TER4B", street2: "APT 4B" });
  assert(out.includes("APT 4B"), `a distinct unit line must survive: ${out}`);
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
