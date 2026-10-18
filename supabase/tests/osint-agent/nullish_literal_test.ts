// nullish_literal_test.ts — the write boundary refuses null-shaped values.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isNullishLiteral } from "../../functions/osint-agent/lib/nullish-literal.ts";
import { normalizeFinding } from "../../functions/osint-agent/auto-persist-findings.ts";
import { validateArtifact } from "../../functions/osint-agent/validation.ts";

Deno.test("isNullishLiteral: every spelling a tool has returned for 'no value'", () => {
  for (const v of ["NULL", "null", " Null ", "undefined", "None", "n/a", "N/A", "NA", "nil", "-", "—", "[null]", "(null)", "\"NULL\"", "'none'", "<null>", "", "   ", "unknown", "not found"]) {
    assert(isNullishLiteral(v), `expected nullish: ${JSON.stringify(v)}`);
  }
  assert(isNullishLiteral(null));
  assert(isNullishLiteral(undefined));
});

Deno.test("isNullishLiteral: real selectors are not nullish", () => {
  for (const v of ["nullable_dev", "none.such@example.invalid", "203.0.113.57", "Noneen Smith", "nil-by-mouth", "n/a-records.example", "NULLIFY"]) {
    assert(!isNullishLiteral(v), `unexpected nullish: ${v}`);
  }
  assert(!isNullishLiteral(0));
  assert(!isNullishLiteral(false));
});

Deno.test("⛔ normalizeFinding refuses a 'NULL' username — the production row", () => {
  assertEquals(normalizeFinding("username", "NULL"), null);
  assertEquals(normalizeFinding("username", "null"), null);
  assertEquals(normalizeFinding("name", "None"), null);
  assertEquals(normalizeFinding("email", "undefined"), null);
  // control: a real username still persists (and the @ still strips)
  assertEquals(normalizeFinding("username", "@qa_nightjar"), { kind: "username", value: "qa_nightjar" });
});

Deno.test("validateArtifact refuses null literals BEFORE the strict passthrough set", () => {
  for (const kind of ["alias", "social_profile", "weak_lead", "username", "name", "email"]) {
    const r = validateArtifact(kind, "NULL");
    assertEquals(r.ok, false, kind);
    if (!r.ok) assert(/null-literal/.test(r.reason), r.reason);
  }
  assertEquals(validateArtifact("alias", "Hood Ken").ok, true);
});

// ---------------------------------------------------------------------------
// The ABSENT-FIELD spellings breach aggregators put in a name column.
//
// OathNet returns the literal `No Name` for a record with no name. On the
// 2026-09-12 `baig_azhar` export that persisted as a `name` artifact at
// confidence 40, became its own identity cluster, and the analyst had to
// Dismiss it by hand — the exact incident this module was written for, one
// vocabulary short.
// ---------------------------------------------------------------------------

Deno.test("isNullishLiteral: the absent-field spellings a breach corpus writes into a name column", () => {
  for (
    const v of [
      "No Name", "no name", " NO NAME ", "NoName", "no_name", "No name provided", "Name not provided",
      "not set", "Not Specified", "unspecified", "not applicable", "no data", "No Value",
      "no record", "no results", "no result", "\"No Name\"", "(no name)",
    ]
  ) {
    assert(isNullishLiteral(v), `expected nullish: ${JSON.stringify(v)}`);
  }
});

Deno.test("isNullishLiteral: real values that merely CONTAIN a null phrase survive", () => {
  // Exact match only. These are observations, and a null-result row is a
  // coverage fact the case needs — dropping one would be evidence loss.
  for (
    const v of [
      "baig_azhar - no breach hits",
      "No Name Brand LLC",
      "Gravatar profile NOT FOUND for baigazhar042@gmail.com",
      "no name given for the registrant, but the address matched",
      "Nonamé",
      "nonames.example.com",
      "Nodata Holdings",
    ]
  ) {
    assert(!isNullishLiteral(v), `unexpected nullish: ${v}`);
  }
});

Deno.test("⛔ normalizeFinding refuses OathNet's 'No Name' — the production row", () => {
  assertEquals(normalizeFinding("name", "No Name"), null);
  assertEquals(normalizeFinding("name", "no name"), null);
  assertEquals(normalizeFinding("username", "not set"), null);
  // control: a real name on the same case still persists
  assertEquals(normalizeFinding("name", "Azhar Baig"), { kind: "name", value: "Azhar Baig" });
});

Deno.test("validateArtifact refuses 'No Name' with a legible reason", () => {
  const r = validateArtifact("name", "No Name");
  assertEquals(r.ok, false);
  if (!r.ok) assert(/null-literal/.test(r.reason), r.reason);
});
