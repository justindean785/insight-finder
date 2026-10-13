// breach_origin_cap_test.ts — E1: a breach-material qualifier is provenance.
// Production thread 7a2968e1: rows sourced "jina_reader_scrape (FloeIntel breach PDF)"
// scored 75 against a breach cap of 60 because the parenthetical was stripped.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyEvidenceCapsLegacyOccurrenceBaseline } from "./confidence.ts";
import { breachOriginCapSelfTest, classifySource } from "./source-classification.ts";

const KILL = "BREACH_ORIGIN_CAP_DISABLED";
const capOf = (source: string) =>
  applyEvidenceCapsLegacyOccurrenceBaseline({ rawConfidence: 95, sources: [source], kind: "email" }).cap;

Deno.test("breach PDF read by a scrape tool classifies as breach and is capped at 60", () => {
  for (const s of [
    "jina_reader_scrape (FloeIntel breach PDF)",
    "jina_reader_scrape (FloeIntel breach PDF - user attachment)",
    "user_supplied (FloeIntel_Breach_Search.pdf)",
  ]) {
    assertEquals(classifySource(s), "breach", s);
    assert(capOf(s) <= 60, `${s} capped at ${capOf(s)}`);
  }
});

Deno.test("ordinary parentheticals are untouched (no false breach)", () => {
  for (const s of [
    "jina_reader_scrape (https://www.fbi.gov/wanted/example)",
    "exa_search (athletics roster)",
    "jina_reader_scrape (company annual report PDF)",
  ]) {
    assert(classifySource(s) !== "breach", s);
  }
});

Deno.test("only lowers: a breach label never outranks the plain class cap", () => {
  assert(capOf("jina_reader_scrape (FloeIntel breach PDF)") <= capOf("jina_reader_scrape (annual report PDF)"));
});

Deno.test("kill switch restores legacy classification", () => {
  Deno.env.set(KILL, "true");
  try {
    assertEquals(classifySource("jina_reader_scrape (FloeIntel breach PDF)"), "independent_public");
    assertEquals(breachOriginCapSelfTest().detail, "LEGACY via BREACH_ORIGIN_CAP_DISABLED");
  } finally {
    Deno.env.delete(KILL);
  }
});

Deno.test("health self-test passes with the rule on", () => {
  assert(breachOriginCapSelfTest().ok);
});
