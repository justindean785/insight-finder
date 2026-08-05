// Coverage for the person-intel tool shapes that the auto-persist backstop
// historically ignored — the root cause of "20 successful tools, 0 artifacts"
// on CPU-killed runs. Fixtures are shape-accurate to real tool_call_cache
// outputs (values anonymized). Each asserts that a run KILLED before the model
// calls record_artifacts still salvages the tool's high-signal findings.
import { assertEquals, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { extractFindings, normalizeFinding } from "./auto-persist-findings.ts";

function kinds(out: Array<{ kind: string }>): string[] {
  return out.map((f) => f.kind).sort();
}
function values(out: Array<{ kind: string; value: string }>, kind: string): string[] {
  return out.filter((f) => f.kind === kind).map((f) => f.value).sort();
}

// ---- normalizeFinding: the new identity kinds -------------------------------
Deno.test("normalizeFinding accepts name/address/organization/username", () => {
  assertEquals(normalizeFinding("name", "Matthew P. Geimer")?.value, "Matthew P. Geimer");
  assertEquals(normalizeFinding("address", "1860 Venice Park Dr Apt 110 North Miami FL 33181")?.kind, "address");
  assertEquals(normalizeFinding("organization", "Paramount Commercial")?.kind, "organization");
  assertEquals(normalizeFinding("username", "@josephpenguinys")?.value, "josephpenguinys");
});

Deno.test("normalizeFinding rejects junk names/addresses", () => {
  assertEquals(normalizeFinding("name", "x"), null);        // too short
  assertEquals(normalizeFinding("name", "12345"), null);    // purely numeric
  assertEquals(normalizeFinding("address", "FL"), null);    // too short to be an address
  assertEquals(normalizeFinding("name", "  "), null);       // empty
});

// ---- indicia_person / indicia_phone / indicia_email -------------------------
Deno.test("extractFindings: indicia_person salvages subject identity", () => {
  const out = extractFindings("indicia_person", {
    ok: true, source: "indicia", endpoint: "person",
    records: [{
      aka: ["Mathew P Geimer"],
      name: "Matthew P. Geimer",
      emails: ["geimerm@gmail.com", "matt@paramountcommercial.net"],
      phones: ["954-815-1199", "305-685-8192"],
      children: 1,
      associates: [{ name: "SOME THIRD PARTY" }], // third parties must NOT be surfaced
      maritalStatus: "Single",
      pastAddresses: ["740 N 73rd Ter Hollywood FL 33024"],
      currentAddress: "1860 Venice Park Dr Apt 110 North Miami FL 33181",
    }],
  });
  assert(values(out, "email").includes("geimerm@gmail.com"));
  assert(values(out, "phone").length === 2);
  assert(values(out, "name").includes("Matthew P. Geimer"));
  assert(values(out, "name").includes("Mathew P Geimer")); // aka
  assert(values(out, "address").length === 2);             // current + 1 past
  // Third-party associate names are NOT auto-persisted.
  assert(!values(out, "name").includes("SOME THIRD PARTY"));
});

// ---- serus_darkweb_scan -----------------------------------------------------
Deno.test("extractFindings: serus_darkweb_scan salvages breaches + extractedData", () => {
  const out = extractFindings("serus_darkweb_scan", {
    ok: true, isBreached: true, totalBreaches: 2,
    breaches: [{ name: "LinkedIn" }, { Name: "Adobe" }],
    extractedData: {
      names: ["John Doe"], emails: ["a@b.com"], phones: ["5551234567"],
      usernames: ["jdoe"], cryptoAddresses: [],
    },
  });
  // Corpora collapse into one breach_exposure row; both names are retained.
  assertEquals(values(out, "breach"), [], "no bare corpus artifacts");
  const exp = out.find((f) => f.kind === "breach_exposure");
  assert(exp, "a breach_exposure row must be emitted");
  assertEquals(exp!.context?.breach_corpora, ["Adobe", "LinkedIn"]);
  assert(values(out, "email").includes("a@b.com"));
  assert(values(out, "phone").length === 1);
  assert(values(out, "name").includes("John Doe"));
  assert(values(out, "username").includes("jdoe"));
});

// ---- breach_check / leakcheck_lookup ---------------------------------------
Deno.test("extractFindings: breach_check salvages breach source names", () => {
  const out = extractFindings("breach_check", {
    ok: true,
    data: { found: 1, fields: ["first_name", "phone"], sources: [{ date: "2020-06", name: "Ordersnapp.com" }], success: true },
  });
  assertEquals(values(out, "breach"), [], "no bare corpus artifacts");
  const exp = out.find((f) => f.kind === "breach_exposure");
  assertEquals(exp?.value, "Breach exposure (breach_check)");
  assertEquals(exp?.context?.breach_corpora, ["Ordersnapp.com"]);
});

Deno.test("extractFindings: leakcheck_lookup salvages breach source names", () => {
  const out = extractFindings("leakcheck_lookup", {
    ok: true,
    data: { found: 2, quota: 100, sources: [{ name: "Adobe", date: "2013" }, { name: "Canva" }], success: true },
  });
  assertEquals(values(out, "breach"), [], "no bare corpus artifacts");
  const exp = out.find((f) => f.kind === "breach_exposure");
  assertEquals(exp?.value, "Breach exposure (leakcheck_lookup)");
  assertEquals(exp?.context?.breach_corpora, ["Adobe", "Canva"]);
});

Deno.test("extractFindings: leakcheck_lookup with zero results yields nothing", () => {
  const out = extractFindings("leakcheck_lookup", {
    ok: true, data: { raw: { found: 0, result: [] }, found: 0, sources: [], success: true },
  });
  assertEquals(out.length, 0);
});

// ---- oathnet_lookup — the big one, and the sensitive-field guard ------------
Deno.test("extractFindings: oathnet_lookup salvages items + breach names, NEVER secrets", () => {
  const out = extractFindings("oathnet_lookup", {
    ok: true,
    data: {
      success: true,
      data: {
        dbname_info: { "adt.com": { Title: "ADT" }, "dave.com": { Title: "Dave" } },
        items: [{
          email: "x@y.com",
          phone_number: "5551239876",
          full_name: "Jane Roe",
          username: "jroe",
          address_street: "1 Main St", address_city: "Springfield", address_state: "IL", address_postcode: "62704",
          ip: "8.8.8.8",
          linkedin: "https://www.linkedin.com/in/janeroe",
          dbname: "adt.com",
          // sensitive fields — MUST never become artifacts:
          ssn: "123-45-6789", password: "hunter2", password_hash: "deadbeef", pin: "0000", encrypted_cc: "xxxx",
        }],
      },
    },
  });
  assertEquals(values(out, "breach"), [], "no bare corpus artifacts");
  const oexp = out.find((f) => f.kind === "breach_exposure");
  assertEquals(oexp?.value, "Breach exposure (oathnet_db)");
  assertEquals(oexp?.context?.breach_corpora, ["ADT", "Dave"]);
  assert(values(out, "email").includes("x@y.com"));
  assert(values(out, "phone").length === 1);
  assert(values(out, "name").includes("Jane Roe"));
  assert(values(out, "username").includes("jroe"));
  assert(values(out, "ip_address").includes("8.8.8.8"));
  assert(out.some((f) => f.kind === "address" && /Main St/.test(f.value)));
  // The sensitive-field guarantee: NO finding value contains SSN/password material.
  const allValues = out.map((f) => f.value.toLowerCase()).join("|");
  assert(!allValues.includes("123-45-6789"), "SSN leaked");
  assert(!allValues.includes("hunter2"), "password leaked");
  assert(!allValues.includes("deadbeef"), "hash leaked");
});

// ---- username_sweep — confirmed profiles were previously dropped ------------
Deno.test("extractFindings: username_sweep salvages confirmed profile hits", () => {
  const out = extractFindings("username_sweep", {
    hits: 2, total: 99, username: "josephpenguinys",
    found: [
      { url: "https://www.twitch.tv/josephpenguinys", site: "Twitch", found: true, status: 200 },
      { url: "https://open.spotify.com/user/josephpenguinys", site: "Spotify", found: true, status: 200 },
    ],
    missed: ["Reddit", "GitHub"],
  });
  assert(values(out, "url").length === 2);
  assert(values(out, "url").some((u) => /twitch\.tv/.test(u)));
});

Deno.test("extractFindings: a full sweep collapses to ONE footprint artifact, URLs kept", () => {
  // Measured on the youngcl17@gmail.com run: 62 of 103 artifacts (60%) were sweep
  // URLs — pypi/weibo/hashnode account-existence checks each shown to the analyst
  // as separate evidence at confidence 30. Evidence read 99+ and the report closed
  // with "Key Findings: No findings recorded yet.": the breach hits and alternate
  // handles were buried under noise. A sweep hit proves a string is REGISTERED,
  // never who owns it, so the footprint is the finding and the URLs are its detail.
  const found = ["twitch.tv", "pypi.org", "weibo.com", "hashnode.com", "500px.com"]
    .map((site) => ({ url: `https://${site}/youngcl17`, site, found: true, status: 200 }));
  const out = extractFindings("username_sweep", { hits: 5, total: 99, username: "youngcl17", found });

  assertEquals(values(out, "url").length, 0, "individual platform URLs must not each become an artifact");
  const fp = out.filter((f) => f.kind === "social_footprint");
  assertEquals(fp.length, 1, "exactly one footprint artifact per swept handle");
  assert(/youngcl17/.test(fp[0].value) && /5 platform registrations/.test(fp[0].value));
  // Collapsing the ARTIFACT must not lose the underlying data.
  assertEquals((fp[0].context as { urls?: string[] }).urls?.length, 5);
});

Deno.test("extractFindings: a thin sweep stays as individual URLs", () => {
  // Below the threshold a couple of hits are legible on their own — collapsing
  // them would hide detail without removing any meaningful noise.
  const out = extractFindings("username_sweep", {
    hits: 2, total: 99, username: "thin",
    found: [
      { url: "https://www.twitch.tv/thin", site: "Twitch", found: true, status: 200 },
      { url: "https://t.me/thin", site: "Telegram", found: true, status: 200 },
    ],
  });
  assertEquals(values(out, "url").length, 2);
  assertEquals(out.filter((f) => f.kind === "social_footprint").length, 0);
});

// ---- socialfetch_lookup — real shape is data.profile -----------------------
Deno.test("extractFindings: socialfetch_lookup reads data.profile when found", () => {
  const out = extractFindings("socialfetch_lookup", {
    ok: true, found: true, lookupStatus: "found",
    data: { metrics: { followers: 10 }, profile: { url: "https://twitter.com/foo", username: "foo" }, lookupStatus: "found" },
  });
  assert(values(out, "url").some((u) => /twitter\.com\/foo/.test(u)));
});

Deno.test("extractFindings: socialfetch_lookup not_found yields nothing", () => {
  const out = extractFindings("socialfetch_lookup", {
    ok: true, found: false, lookupStatus: "not_found",
    data: { metrics: null, profile: null, lookupStatus: "not_found" },
  });
  assertEquals(out.length, 0);
});

// ---- the regression this whole change exists to prevent ---------------------
Deno.test("extractFindings: a Ray-Martinez-style tool mix now salvages findings", () => {
  // These are exactly the tools that ran on the '0 artifacts' production run.
  const indicia = extractFindings("indicia_person", {
    ok: true, records: [{ name: "Ray Martinez", emails: ["ray@example.com"], phones: ["5550001111"], currentAddress: "10 Palm Ave Los Angeles CA 90001", pastAddresses: [], aka: [], associates: [], children: 0 }],
  });
  const oathnet = extractFindings("oathnet_lookup", {
    ok: true, data: { success: true, data: { dbname_info: { "dropbox.com": { Title: "Dropbox" } }, items: [{ email: "ray@example.com" }] } },
  });
  assert(indicia.length > 0, "indicia_person must salvage");
  assert(oathnet.some((f) => f.kind === "breach_exposure"), "oathnet must salvage the breach corpora as one exposure row");
});

Deno.test("normalizeFinding: handle-shaped junk is never recorded as a person's name", () => {
  // From the youngcl17@gmail.com run: a dark-web scan's "name" field carried
  // these, and all three were persisted as people at confidence 40, then seeded
  // identity clusters and appeared in the report's Identity section.
  for (const junk of ["Daycron123", "Napster6", "Dreamcast6", "lgit123", "user_name", "a@b.c"]) {
    assertEquals(normalizeFinding("name", junk), null, `${junk} must not be a name`);
  }
});

Deno.test("normalizeFinding: real names still pass", () => {
  // The fix must not cost genuine data — these came from the same run.
  assertEquals(normalizeFinding("name", "cameron lawson")?.value, "cameron lawson");
  assertEquals(normalizeFinding("name", "Cameron")?.value, "Cameron");
  assertEquals(normalizeFinding("name", "  Mary   Jane  O'Neill ")?.value, "Mary Jane O'Neill");
  assertEquals(normalizeFinding("name", "Jean-Luc Picard")?.value, "Jean-Luc Picard");
});
