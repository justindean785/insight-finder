// name_only_harvest_collapse_test.ts — a name is not a selector.
//
// Reproduces production thread `c599a5bc` (2026-09-03), seeded with a domain.
// The run scraped the site, lifted two person names off it, and called
// `oathnet_lookup{type:"name"}` on each. OathNet answered with everyone
// who shares those names: 15 addresses across 13 US states plus one in the UK,
// 14 phones including a UK mobile, and 12 mailboxes. All 42 persisted as 42
// separate quarantine cards on a thread of 123 artifacts.
//
// The write gate was never the problem — every one of those rows WAS correctly
// stamped subject_unlinked. The defect was that the stamp made them invisible to
// the bulk-corpus collapse: that collapse only considers rows where
// `subject_unlinked !== true`, so quarantining them first emptied its candidate
// set and nothing collapsed. The two mechanisms had to compose.
//
// The load-bearing tests here are the NEGATIVE controls. Collapsing a small
// name return, or collapsing the echo of the queried name itself, would hide
// leads the analyst asked for — worse than the noise this fixes.
//
// Values below are SYNTHETIC. The production run is real and is not committed.

import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  extractFindings,
  isNameOnlyHarvestQuarantine,
  NAME_ONLY_HARVEST_COLLAPSE_CAP,
} from "../../functions/osint-agent/auto-persist-findings.ts";

const IDENTITY = new Set(["name", "email", "phone", "address", "username"]);
const QUERIED = "Jordan Vale";

/** One `items[]` row in the shape OathNet actually returns for a name match. */
function person(n: number, full_name: string) {
  return {
    full_name,
    email: `jordan.vale${n}@example.invalid`,
    phone_number: `+1555010${String(n).padStart(4, "0")}`,
    address_street: `${100 + n} Example Street`,
    address_city: "Springfield",
    address_state: "IL",
    address_postcode: `627${String(n).padStart(2, "0")}`,
  };
}

/** `n` strangers who merely share the queried name. Row 0 echoes it exactly. */
function nameCorpus(n: number) {
  const spellings = [
    QUERIED, "Jordan A Vale", "J. Vale", "Jordan Vale Jr", "JORDAN VALE",
    "Jordan Vale Sr", "Jordy Vale", "Jordan Vale III", "Jordan M Vale",
    "Vale Jordan", "Jordan Vale-Smith", "Jordan Vale II",
  ];
  return {
    ok: true,
    data: {
      success: true,
      data: {
        dbname_info: { "people-search.invalid": { Title: "PeopleSearch" } },
        items: Array.from({ length: n }, (_, i) => person(i, spellings[i % spellings.length])),
      },
    },
  };
}

const NAME_INPUT = { type: "name", value: QUERIED };

function summaries(out: Array<{ kind: string }>) {
  return out.filter((f) => f.kind === "bulk_corpus_harvest");
}

Deno.test("⛔ a name-only harvest collapses to ONE summary, not 40 quarantine cards", () => {
  const out = extractFindings("oathnet_lookup", nameCorpus(12), NAME_INPUT);
  const ident = out.filter((f) => IDENTITY.has(f.kind));
  const sums = summaries(out);

  assertEquals(sums.length, 1, "a name corpus must collapse to exactly one summary row");
  assert(
    ident.length <= 2,
    `only the queried-name echo may survive as an identity row, got ${ident.length}: ` +
      ident.map((f) => `${f.kind}:${f.value}`).join(", "),
  );
  assert(
    isNameOnlyHarvestQuarantine(sums[0]?.context as Record<string, unknown>),
    "the summary must stay classified as a name-only harvest",
  );
});

Deno.test("disclosure is preserved — every collapsed identity is retained in metadata", () => {
  const out = extractFindings("oathnet_lookup", nameCorpus(12), NAME_INPUT);
  const ctx = summaries(out)[0]?.context as {
    harvested_identities?: Array<{ kind?: string; value?: string }>;
    collapsed_row_count?: number;
  };
  const harvested = ctx?.harvested_identities ?? [];
  assert(
    harvested.length > NAME_ONLY_HARVEST_COLLAPSE_CAP,
    `summary must retain the underlying rows, got ${harvested.length}`,
  );
  assertEquals(harvested.length, ctx?.collapsed_row_count, "retained count must match what was collapsed");
  // The values themselves survive — quarantine is disclosure, never deletion.
  assert(
    harvested.some((h) => String(h.value ?? "").includes("Example Street")),
    "addresses must remain readable inside the summary",
  );
});

Deno.test("the reason states the finding and keeps the mark the board groups on", () => {
  const out = extractFindings("oathnet_lookup", nameCorpus(12), NAME_INPUT);
  const reason = String(summaries(out)[0]?.context?.subject_unlinked_reason ?? "");
  // src/lib/bulk-corpus-display.ts groups on this exact phrase.
  assert(/harvested from a name-only query/.test(reason), `missing the group mark: ${reason}`);
  assert(/\d+ identities sharing the/.test(reason), `reason must carry the count: ${reason}`);
  assert(/name equality is not linkage/.test(reason), `reason must state WHY: ${reason}`);
});

// ---------------------------------------------------------------- negatives

Deno.test("NEGATIVE: a small name return does NOT collapse — those are readable leads", () => {
  const out = extractFindings("oathnet_lookup", nameCorpus(2), NAME_INPUT);
  assertEquals(summaries(out).length, 0, "a two-row name return must stay as individual leads");
  assert(
    out.filter((f) => IDENTITY.has(f.kind)).length > 2,
    "the individual rows must still be present",
  );
});

Deno.test("NEGATIVE: the echo of the queried name survives as its own row", () => {
  const out = extractFindings("oathnet_lookup", nameCorpus(12), NAME_INPUT);
  const names = out.filter((f) => f.kind === "name").map((f) => f.value.toLowerCase());
  assert(
    names.includes(QUERIED.toLowerCase()),
    `the queried name must not be folded into the group, got: ${names.join(", ")}`,
  );
});

Deno.test("NEGATIVE: a CONCRETE selector query is untouched by this path", () => {
  // Same payload, but queried by email — the provider matched on the selector, so
  // nothing here is a same-name collision and nothing may collapse as one.
  const out = extractFindings("oathnet_lookup", nameCorpus(12), { email: "jordan.vale0@example.invalid" });
  assertEquals(
    summaries(out).filter((f) =>
      isNameOnlyHarvestQuarantine(f.context as Record<string, unknown>)
    ).length,
    0,
    "a concrete-selector query must never produce a name-collision summary",
  );
});
