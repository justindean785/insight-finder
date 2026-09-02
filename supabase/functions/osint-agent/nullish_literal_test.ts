// nullish_literal_test.ts — the write boundary refuses null-shaped values.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { isNullishLiteral } from "./lib/nullish-literal.ts";
import { normalizeFinding } from "./auto-persist-findings.ts";
import { validateArtifact } from "./validation.ts";

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
