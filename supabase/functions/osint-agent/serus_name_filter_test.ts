// serus_name_filter_test.ts — one-word Serus "names" are not persisted as names.
//
// Production 2026-10-01: one Serus scan's extractedData.names held a username
// fragment, a first name, a surname and a leaked password. Each became a `name`
// artifact; the password then printed as an identity-cluster heading in the
// exported report, and the four tokens fed the "distinct names" conflict that
// pinned the case's finding at 15. Values below are invented.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { extractFindings, serusNameAdmissible, serusNameFilterSelfTest } from "./auto-persist-findings.ts";

const SCAN = {
  ok: true, isBreached: true, totalBreaches: 1,
  breaches: [{ name: "ExampleSite" }],
  extractedData: {
    names: ["Jane Example", "Qwerty", "Jane", "Janeexample1", "  "],
    emails: [], phones: [], usernames: ["janeexample1"], cryptoAddresses: [],
  },
};
const names = (out: ReturnType<typeof extractFindings>) =>
  out.filter((f) => f.kind === "name").map((f) => f.value).sort();

Deno.test("only multi-word Serus names become name artifacts", () => {
  assertEquals(names(extractFindings("serus_darkweb_scan", SCAN)), ["Jane Example"]);
});

Deno.test("the breach row and usernames are unaffected", () => {
  const out = extractFindings("serus_darkweb_scan", SCAN);
  assert(out.some((f) => f.kind === "breach_exposure"), "breach_exposure still emitted");
  assert(out.some((f) => f.kind === "username" && f.value === "janeexample1"), "usernames still emitted");
});

Deno.test("SERUS_NAME_FILTER_DISABLED restores every token", () => {
  Deno.env.set("SERUS_NAME_FILTER_DISABLED", "true");
  try {
    const legacy = names(extractFindings("serus_darkweb_scan", SCAN));
    for (const token of ["Qwerty", "Jane"]) assert(legacy.includes(token), `${token} restored: ${legacy}`);
  } finally {
    Deno.env.delete("SERUS_NAME_FILTER_DISABLED");
  }
});

Deno.test("serusNameAdmissible and its /health self-test", () => {
  const off = () => undefined;
  assertEquals(serusNameAdmissible("Jane Example", off), true);
  assertEquals(serusNameAdmissible("Qwerty", off), false);
  assertEquals(serusNameAdmissible(42, off), false);
  const r = serusNameFilterSelfTest(off);
  assert(r.ok, r.detail);
  assert(serusNameFilterSelfTest((k) => (k === "SERUS_NAME_FILTER_DISABLED" ? "true" : undefined)).detail.startsWith("LEGACY"));
});
