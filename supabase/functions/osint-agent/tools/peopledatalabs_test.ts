// Tests for pdl_person_enrich — the selector gate + credit-safety param builder.
// The gate must refuse name-only / name+country BEFORE any billed call, and the
// param builder must ALWAYS send min_likelihood (fix #4) so PDL does the free-404
// filtering server-side regardless of how the tool is invoked.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildPdlParams, pdlGateAllows, looksSpecificLocation } from "./peopledatalabs.ts";

const gate = (input: Parameters<typeof buildPdlParams>[0]) => pdlGateAllows(buildPdlParams(input));

Deno.test("gate REFUSES weak selectors before any billed call", () => {
  assertEquals(gate({ name: "John Smith" }), false, "name-only");
  assertEquals(gate({ name: "John Smith", location: "USA" }), false, "name+country");
  assertEquals(gate({}), false, "empty");
  assertEquals(gate({ first_name: "John" }), false, "first-name-only");
  assertEquals(gate({ name: "xX_darkslayer99_Xx" }), false, "gaming handle, name-only");
});

Deno.test("gate ACCEPTS strong professional selectors", () => {
  assertEquals(gate({ profile: "linkedin.com/in/seanthorne" }), true, "linkedin URL");
  assertEquals(gate({ email: "sean@company.com" }), true, "work email");
  assertEquals(gate({ phone: "+14155550123" }), true, "phone");
  assertEquals(gate({ name: "Elon Musk", company: "Tesla" }), true, "name+company");
  assertEquals(gate({ name: "Jane Doe", school: "MIT" }), true, "name+school");
  assertEquals(gate({ name: "Bill Gates", location: "Seattle, WA" }), true, "name+City,State");
  assertEquals(gate({ first_name: "John", last_name: "Smith", company: "Acme" }), true, "first+last+company");
});

Deno.test("fix #4: min_likelihood is ALWAYS sent, defaulting to 6", () => {
  assertEquals(buildPdlParams({ email: "a@b.com" }).get("min_likelihood"), "6", "default floor sent when omitted");
  assertEquals(buildPdlParams({ email: "a@b.com", min_likelihood: 8 }).get("min_likelihood"), "8", "explicit floor honored");
  // Even a bare/blank input carries the floor — a direct execute() path must not
  // reach PDL without it (the sub-6 200 credit-leak the audit found).
  assert(buildPdlParams({}).has("min_likelihood"), "floor present on empty input");
});

Deno.test("buildPdlParams drops blank/whitespace fields", () => {
  const p = buildPdlParams({ email: "", name: "   ", company: "Tesla" });
  assertEquals(p.has("email"), false, "empty string dropped");
  assertEquals(p.has("name"), false, "whitespace-only dropped");
  assertEquals(p.get("company"), "Tesla", "real value kept + trimmed");
});

Deno.test("looksSpecificLocation: City,Region yes; bare country/city no", () => {
  assert(looksSpecificLocation("Seattle, WA"));
  assert(looksSpecificLocation("Paris, France"));
  assertEquals(looksSpecificLocation("USA"), false);
  assertEquals(looksSpecificLocation("London"), false);
  assertEquals(looksSpecificLocation(""), false);
  assertEquals(looksSpecificLocation(null), false);
});
