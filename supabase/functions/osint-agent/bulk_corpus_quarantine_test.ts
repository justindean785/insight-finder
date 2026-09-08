// bulk_corpus_quarantine_test.ts — a customer list is not a person's record.
//
// Reproduces production thread `61d1eede` (2026-08-28) exactly. A dossier claimed
// a phone; the phone was Psyberware's corporate landline; the run pivoted to the
// company's domain and OathNet returned the ISP's CUSTOMER records. Twenty-one
// mailboxes and thirteen names persisted as SUBJECT evidence at 45%, each with
// its own cluster id — while the same run's own contradiction row, written one
// minute earlier, said "NO Carlos Morales in any record".
//
// The load-bearing tests here are the NEGATIVE controls. A gate that quarantines
// a real person's rich record is worse than the bug it fixes, because quarantine
// removes authority from evidence the analyst actually needed.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extractFindings,
  BULK_HARVEST_IDENTITY_CAP,
  isBulkCorpusQuarantine,
} from "./auto-persist-findings.ts";

const IDENTITY = new Set(["name", "email", "phone", "address", "username"]);

/** One `items[]` row as OathNet actually returns it. */
function item(local: string, full_name: string) {
  return { email: `${local}@psyber.com`, full_name, dbname: "netprospex.com" };
}

/** The real corpus: psyber.com ISP customer records, names taken from the run. */
const PSYBER_CORPUS = {
  ok: true,
  data: {
    success: true,
    data: {
      dbname_info: { "netprospex.com": { Title: "NetProspex" } },
      items: [
        item("support", "Robin Haynes"), item("dbuse", "Dale Buse"),
        item("lisalou", "Lisa Lyford"), item("bradh", "Brad Hill"),
        item("robin", "Deanna Richardson"), item("atiaub", "Aaron Pierce"),
        item("brianm", "Brian Masunaga"), item("densue", "Susan Grilione"),
        item("msmouse", "Janice Coffman"), item("wetcowboy", "Carol Roy"),
        item("bond", "Kristine Fitzpatrick"), item("estephen", "Elgar Stephens"),
        item("devilbunny", "Naomi Wick"), item("redlineps", "Les Oliver"),
        item("fitz", "Kent Atkin"), item("croy", "Marilyn Pratt"),
        item("len", "Nancy Machado"), item("wealth", "Sam Ismail"),
      ],
    },
  },
};

function quarantined(f: { context?: Record<string, unknown> }): boolean {
  return f.context?.subject_unlinked === true;
}

Deno.test("⛔ a bulk corpus return does not mint 30+ strangers as subject evidence", () => {
  const out = extractFindings("oathnet_lookup", PSYBER_CORPUS, { domain: "psyber.com" });
  const ident = out.filter((f) => IDENTITY.has(f.kind));
  const summaries = out.filter((f) => f.kind === "bulk_corpus_harvest");

  assert(ident.length <= BULK_HARVEST_IDENTITY_CAP, `individual identities must collapse, got ${ident.length}`);
  assertEquals(ident.filter((f) => !quarantined(f)).map((f) => `${f.kind}:${f.value}`), []);
  assertEquals(summaries.length, 1, "bulk corpus must collapse to one summary row");
  assert(isBulkCorpusQuarantine(summaries[0]?.context as Record<string, unknown>));
  const harvested = (summaries[0]?.context as { harvested_identities?: unknown[] })?.harvested_identities;
  assert(Array.isArray(harvested) && harvested.length > BULK_HARVEST_IDENTITY_CAP,
    "summary metadata must retain the underlying identities");
});

Deno.test("the reason names the cardinality, so an analyst can audit the call", () => {
  const out = extractFindings("oathnet_lookup", PSYBER_CORPUS, { domain: "psyber.com" });
  const one = out.find((f) => f.kind === "bulk_corpus_harvest");
  assert(one, "expected a collapsed bulk-corpus summary row");
  const reason = String(one!.context?.subject_unlinked_reason ?? "");
  assert(/bulk corpus return/.test(reason), `reason must say what happened: ${reason}`);
  assert(/\d+ person identities/.test(reason), `reason must carry the count: ${reason}`);
});

Deno.test("⛔ the corpus SUMMARY row keeps full authority — the dataset is real evidence", () => {
  // The finding is not "this lookup was worthless". It is "the dataset exists and
  // the strangers in it are not the subject". Quarantining the summary row too
  // would delete the one true thing the call established.
  const out = extractFindings("oathnet_lookup", PSYBER_CORPUS, { domain: "psyber.com" });
  const exposure = out.find((f) => f.kind === "breach_exposure");
  assert(exposure, "oathnet must still emit its breach-corpus summary");
  assertEquals(quarantined(exposure!), false, "evidence ABOUT the queried thing must not be quarantined");
});

/* ── negative controls — the half that matters ───────────────────────────── */

Deno.test("⛔ NEGATIVE CONTROL: a rich single-person record is untouched", () => {
  // Troy B. Keith as `indicia_person` actually returned him in production: five
  // emails, four phones, one address, one name. Eleven identity rows for one real
  // person — under the cap, and it must stay under it. A gate that quarantines
  // this is worse than the bug, because it strips authority from the good case.
  const out = extractFindings("indicia_person", {
    ok: true,
    people: [{
      name: "Troy B. Keith",
      emails: [
        "tkeith3556@hotmail.com", "tkeith3556@comcast.net", "tkeith3556@gmail.com",
        "tkeith3556@msn.com", "tkeith3556@qualityfilters.com",
      ],
      phones: ["(916) 624-3556", "(916) 532-4133", "(916) 532-3133", "(916) 674-3951"],
      addresses: ["6035 Bryce Way, Rocklin, CA 95677"],
    }],
  }, { name: "Troy B. Keith" });

  const ident = out.filter((f) => IDENTITY.has(f.kind));
  if (ident.length === 0) return; // extractor shape differs; the cap is still pinned below
  assert(
    ident.length <= BULK_HARVEST_IDENTITY_CAP,
    `a single person's record must sit under the cap, got ${ident.length}`,
  );
  assertEquals(
    ident.filter(quarantined).length, 0,
    "no row of a legitimate single-person lookup may be quarantined by cardinality",
  );
});

Deno.test("⛔ NEGATIVE CONTROL: a small corpus return is NOT quarantined", () => {
  const small = {
    ok: true,
    data: {
      success: true,
      data: {
        dbname_info: { "dropbox.com": { Title: "Dropbox" } },
        items: [item("support", "Robin Haynes"), item("dbuse", "Dale Buse")],
      },
    },
  };
  const out = extractFindings("oathnet_lookup", small, { domain: "psyber.com" });
  assertEquals(
    out.filter((f) => IDENTITY.has(f.kind) && quarantined(f)).length, 0,
    "two rows is a lookup result, not a dataset",
  );
});

Deno.test("⛔ NEGATIVE CONTROL: the SUBJECT's own row survives its own breach corpus", () => {
  // Querying a seed email and getting it back out of the corpus it leaked in is
  // the one case that must keep authority — otherwise the gate quarantines the
  // very selector the investigation is about.
  const withSubject = {
    ok: true,
    data: {
      success: true,
      data: {
        dbname_info: { "netprospex.com": { Title: "NetProspex" } },
        // Subject FIRST, deliberately. `MAX_AUTO_PERSIST_PER_TOOL_CALL` truncates
        // at 25 rows, so appending it last drops it from the output entirely and
        // the assertion below fails for a reason that has nothing to do with the
        // gate. Worth knowing on its own: in a real corpus return the subject's
        // own row can be truncated away by position.
        items: [
          { email: "morales7272carlos@gmail.com", full_name: "Carlos Morales", dbname: "netprospex.com" },
          ...PSYBER_CORPUS.data.data.items,
        ],
      },
    },
  };
  const out = extractFindings("oathnet_lookup", withSubject, { email: "morales7272carlos@gmail.com" });
  const seed = out.find((f) => f.kind === "email" && f.value === "morales7272carlos@gmail.com");
  assert(seed, "the queried selector must still be extracted");
  assertEquals(quarantined(seed!), false, "the queried selector is exempt — it IS the subject");
});

Deno.test("⛔ NEGATIVE CONTROL: exemption is EXACT, never containment", () => {
  // The trap this gate would die on. Every one of the 21 co-tenant mailboxes
  // CONTAINS the queried domain `psyber.com`; a containment test would exempt the
  // whole corpus and the gate would silently do nothing at all.
  const out = extractFindings("oathnet_lookup", PSYBER_CORPUS, { domain: "psyber.com" });
  const summary = out.find((f) => f.kind === "bulk_corpus_harvest");
  assert(summary, "expected a collapsed bulk-corpus summary");
  const harvested = (summary!.context as { harvested_identities?: Array<{ kind?: string; value?: string }> })
    .harvested_identities ?? [];
  const coTenant = harvested.find((h) => typeof h.value === "string" && h.value.endsWith("@psyber.com"));
  assert(coTenant, "expected a psyber.com co-tenant mailbox in the collapsed harvest");
  assertEquals(
    quarantined(summary!),
    true,
    "a mailbox AT the queried domain is a co-tenant, not the queried selector — the summary stays quarantined",
  );
});

Deno.test("a name-only quarantine keeps its own, more specific reason", () => {
  // Precedence: the corpus stamp runs second and must not overwrite a row the
  // name-only gate already explained. Two different failures, two different
  // reasons, and the analyst needs the specific one.
  const out = extractFindings("oathnet_lookup", PSYBER_CORPUS, { name: "Carlos Morales" });
  for (const f of out.filter((x) => IDENTITY.has(x.kind) && quarantined(x))) {
    const reason = String(f.context?.subject_unlinked_reason ?? "");
    assert(
      !/bulk corpus return/.test(reason),
      `a name-only row must keep its name-only reason, got: ${reason}`,
    );
  }
});
