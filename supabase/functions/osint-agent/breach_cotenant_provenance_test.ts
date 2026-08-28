// breach_cotenant_provenance_test.ts — a breach corpus is CO-TENANTED, and a
// neighbour's selector must not inherit the subject's authority.
//
// THE REGRESSION (production, 2026-08-26). A run pivoting on +12025550142
// persisted 72025550142 — a Russian +7 number off a `zoloto585.ru` row that the
// same artifact set describes as "Marta Kovalenko, Kazan Russia — COLLISION,
// unrelated" — as a subject selector, with its own cluster id.
//
// `breachSubjectAnchor` already states the principle: it "deliberately NEVER
// reads a DISCOVERED email/handle out of the breach payload … those can belong
// to other people in the same corpus." The oathnet item loop then minted
// phone/email/name/address from exactly those rows anyway.
//
// WHAT THE GATE IS, PRECISELY: a POSITIVE mismatch on the queried field. Absence
// is never an accusation — see the negative controls, which are the more
// important half of this file.
//
// FIXTURES ARE SYNTHETIC (RFC 2606 reserved domains, reserved 555-01xx numbers)
// except the two phone numbers that ARE the bug report.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { extractFindings } from "./auto-persist-findings.ts";

const SUBJECT_PHONE = "+12025550142";

/** One oathnet_lookup return carrying the subject's row and a co-tenant's. */
function oathnetTwoRows() {
  return {
    ok: true,
    data: {
      success: true,
      data: {
        dbname_info: { "example.com": { Title: "Example" } },
        items: [
          {
            // The subject: carries the queried phone.
            phone_number: "2025550142",
            email: "subject@example.com",
            full_name: "Dana Whitfield",
            dbname: "example.com",
          },
          {
            // A neighbour in the same corpus: a DIFFERENT number in the field
            // that was queried.
            phone_number: "72025550142",
            email: "other@example.net",
            full_name: "Marta Kovalenko",
            linkedin: "https://www.linkedin.com/in/example-cotenant",
            dbname: "example.net",
          },
        ],
      },
    },
  };
}

const find = (out: ReturnType<typeof extractFindings>, kind: string, needle: string) =>
  out.find((f) => f.kind === kind && f.value.includes(needle));

Deno.test("a corpus row that disagrees on the queried field is quarantined as a co-tenant", () => {
  const out = extractFindings("oathnet_lookup", oathnetTwoRows(), { type: "phone", value: SUBJECT_PHONE });
  const cotenant = find(out, "phone", "+72025550142");
  assert(cotenant, "the +7 number must still be extracted — quarantine is not deletion");
  assertEquals(
    cotenant?.context?.subject_unlinked,
    true,
    "a neighbour's phone must not carry subject authority",
  );
  assert(
    String(cotenant?.context?.subject_unlinked_reason ?? "").length > 0,
    "an analyst must be able to read WHY it lost authority",
  );
});

Deno.test("every selector on the co-tenant row is stamped, including its URL", () => {
  // pushUrl bypasses `push`, so a per-call ctx that only covered `push` would
  // leave the LinkedIn profile of a third party at full authority.
  const out = extractFindings("oathnet_lookup", oathnetTwoRows(), { type: "phone", value: SUBJECT_PHONE });
  for (const [kind, needle] of [["email", "other@example.net"], ["name", "Marta"], ["url", "example-cotenant"]]) {
    const f = find(out, kind, needle);
    assert(f, `expected a ${kind} finding for ${needle}`);
    assertEquals(f?.context?.subject_unlinked, true, `${kind} on a co-tenant row must be quarantined`);
  }
});

Deno.test("NEGATIVE CONTROL: the subject's own row keeps full authority", () => {
  const out = extractFindings("oathnet_lookup", oathnetTwoRows(), { type: "phone", value: SUBJECT_PHONE });
  const own = find(out, "phone", "+12025550142");
  assert(own, "the subject's phone must be extracted");
  assertEquals(own?.context?.subject_unlinked, undefined, "the queried row is NOT a co-tenant");
  const ownEmail = find(out, "email", "subject@example.com");
  assertEquals(ownEmail?.context?.subject_unlinked, undefined, "nor is anything else on that row");
});

Deno.test("NEGATIVE CONTROL: an absent anchor never stamps — absence is not an accusation", () => {
  // The 2-arg call shape (no input threaded). Stamping here would quarantine
  // every row from every provider that does not echo its query, which is mass
  // disenfranchisement — the failure isSubjectUnlinked's strict `=== true` and
  // G1's fail-closed rule both exist to prevent.
  const out = extractFindings("oathnet_lookup", oathnetTwoRows());
  for (const f of out) {
    assertEquals(
      f.context?.subject_unlinked,
      undefined,
      `no anchor means no accusation, but ${f.kind}=${f.value} was stamped`,
    );
  }
});

Deno.test("NEGATIVE CONTROL: a row that merely LACKS the queried field is not stamped", () => {
  // A genuine subject row often does not echo the queried selector — queried by
  // email, the row carries only a name and an address. Stamping on a missing
  // field would quarantine real evidence wholesale.
  const out = extractFindings("oathnet_lookup", {
    ok: true,
    data: {
      success: true,
      data: {
        items: [{ full_name: "Dana Whitfield", address_street: "742 Evergreen Ter", address_city: "Springfield", address_state: "OR", address_postcode: "97477" }],
      },
    },
  }, { type: "phone", value: SUBJECT_PHONE });
  const addr = out.find((f) => f.kind === "address");
  assert(addr, "the address must be extracted");
  assertEquals(addr?.context?.subject_unlinked, undefined, "no phone on the row is not a contradiction");
});

Deno.test("DECISION: the gate is PHONE-only — an email anchor does not quarantine", () => {
  // An email branch was implemented and REMOVED. It broke
  // subject_relevance_gate_test.ts's "a selector-keyed lookup is subject-linked
  // by construction" — the #433 position that a concrete-selector query is
  // trusted and only NAME-only queries quarantine. That boundary is settled;
  // moving it needs sign-off, not a drive-by.
  //
  // The measured defect is a phone mismatch. There is no measured email case,
  // and widening an integrity signal past its evidence to reach a tidier result
  // is how this module's other over-applications happened. This test records
  // the decision so a future reader sees a choice, not an oversight.
  const out = extractFindings("oathnet_lookup", {
    ok: true,
    data: { success: true, data: { items: [{ email: "stranger@example.net", full_name: "Test Person" }] } },
  }, { email: "subject@example.com" });
  assertEquals(
    out.find((f) => f.kind === "email")?.context?.subject_unlinked,
    undefined,
    "a differing email is NOT quarantined — that would move the #433 boundary",
  );
});

Deno.test("NEGATIVE CONTROL: quarantine is disclosure — no value is dropped or rewritten", () => {
  const out = extractFindings("oathnet_lookup", oathnetTwoRows(), { type: "phone", value: SUBJECT_PHONE });
  assert(find(out, "phone", "+72025550142"), "the co-tenant phone still persists");
  assert(find(out, "name", "Marta Kovalenko"), "with its value intact");
  assert(find(out, "phone", "+12025550142"), "beside the subject's own row");
});

/* ── wiring: a gate nobody calls is not a gate ─────────────────────────── */

const SRC = await Deno.readTextFile(new URL("./auto-persist-findings.ts", import.meta.url));

Deno.test("wiring: the oathnet item loop actually consults the anchor", () => {
  assert(
    SRC.includes("rowContradictsAnchor(row, oathnetAnchor)"),
    "the co-tenant predicate must gate the item loop with no disabling prefix",
  );
  assert(SRC.includes("CO_TENANT_CTX"), "the quarantine reason must be applied");
  assert(
    /const oathnetAnchor = breachSubjectAnchor\(o, input\)/.test(SRC),
    "the anchor must come from the QUERIED input, never from a discovered value",
  );
});

Deno.test("wiring: serus extractedData is deliberately NOT anchor-gated", () => {
  // Recorded as a decision, not an oversight. serus returns flat arrays
  // (extractedData.{emails,phones,names}) — the provider has already destroyed
  // the row structure, so the only available test would be "value != anchor",
  // which would quarantine every alternate handle a dark-web scan discovers.
  // That is the product's primary pivot output and is not the measured defect.
  const serus = extractFindings("serus_darkweb_scan", {
    ok: true,
    extractedData: { emails: ["alt@example.net"], phones: [], names: [], usernames: [] },
  }, { identifierType: "phone", identifierValue: SUBJECT_PHONE });
  const alt = serus.find((f) => f.kind === "email");
  if (alt) {
    assertEquals(alt.context?.subject_unlinked, undefined, "serus discoveries keep their authority");
  }
});
