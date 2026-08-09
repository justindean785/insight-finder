/**
 * subject_relevance_gate_test.ts — a name-only query cannot establish subject linkage.
 *
 * THE INCIDENT (production, 2026-08-06)
 * A breach-aggregator tool was queried by a person's NAME. It returned dozens of
 * unrelated people, and the extractor persisted 15+ of THEIR emails and usernames
 * onto the subject's thread at confidence 45 — including a K-12 school-district
 * student address belonging to nobody in the investigation. The agent's own
 * narration called the results "massive noise"; nothing downstream could tell,
 * because a harvested row carried no record of how weak its linkage was. Those
 * rows then fed union-find clustering.
 *
 * FIXTURES ARE SYNTHETIC. Real selectors from that run are deliberately NOT
 * reproduced here — a regression test must not become a second copy of the
 * disclosure it exists to prevent. @example.com / @example.edu are
 * RFC 2606 reserved and resolve to nobody.
 *
 * THE CONTRACT
 *  - A name-only query ⇒ every harvested row is stamped `subject_unlinked`,
 *    INCLUDING the echo of the queried name itself unless that name is the
 *    investigation's seed (P0-A — see name_collision_root_test.ts).
 *  - Quarantine is DISCLOSURE, NOT DELETION: the row still persists, keeps its
 *    value, and stays readable as a lead. Nothing is dropped.
 *  - A concrete selector (email/username/phone/domain/ip) anywhere in the input
 *    means the provider matched on that selector ⇒ NOT quarantined.
 *  - `isExcluded` treats a quarantined row as inert for clustering, so it can
 *    never merge a same-name stranger into the subject.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type Artifact, isExcluded } from "./lib/cluster.ts";
import { extractFindings } from "./auto-persist-findings.ts";

/** Stand-in for the K-12 student address the live run harvested. */
const STUDENT_ADDRESS = "000000@student.example.edu";
const SUBJECT_NAME = "Jane Roe";
const SUBJECT_EMAIL = "subject@example.com";
const SUBJECT_HANDLE = "subjecthandle710";

const unlinked = (f: { context?: Record<string, unknown> }) =>
  f.context?.subject_unlinked === true;

/** The name-search response shape that caused the incident (data.data.items[]). */
const nameSearchHits = {
  data: {
    data: {
      items: [
        { email: STUDENT_ADDRESS, username: "namesake-166" },
        { email: "third.party.a@example.com", username: "namesake-169" },
        { email: "third.party.b@example.com", username: "namesake-198" },
      ],
    },
  },
};

Deno.test("name-only query: every harvested identifier is quarantined", () => {
  const out = extractFindings("oathnet_lookup", nameSearchHits, { type: "name", value: SUBJECT_NAME });
  const ids = out.filter((f) => f.kind === "email" || f.kind === "username");
  assert(ids.length > 0, "the rows must still be extracted — quarantine is not deletion");
  assert(ids.every(unlinked), "every identifier from a name-only query must be subject_unlinked");
});

Deno.test("a third party's student address is quarantined, not persisted as evidence", () => {
  const out = extractFindings("oathnet_lookup", nameSearchHits, { type: "name", value: SUBJECT_NAME });
  const student = out.find((f) => f.value.includes(STUDENT_ADDRESS));
  assert(student, "the row is preserved — an analyst can still inspect it");
  assert(unlinked(student!), "but it must NOT count as subject evidence");
  assert(
    typeof student!.context?.subject_unlinked_reason === "string",
    "the reason must be recorded, not just the flag",
  );
});

Deno.test("a CONCRETE selector query is never quarantined", () => {
  const out = extractFindings(
    "oathnet_lookup",
    { data: { data: { items: [{ email: SUBJECT_EMAIL, username: SUBJECT_HANDLE }] } } },
    { email: SUBJECT_EMAIL },
  );
  assert(out.length > 0);
  assert(out.every((f) => !unlinked(f)), "a selector-keyed lookup is subject-linked by construction");
});

Deno.test("a bare multi-word query string is treated as a name", () => {
  const out = extractFindings("oathnet_lookup", nameSearchHits, { query: SUBJECT_NAME });
  assert(out.filter((f) => f.kind === "email").every(unlinked));
});

Deno.test("a single-token handle query is NOT mistaken for a person name", () => {
  const out = extractFindings("oathnet_lookup", nameSearchHits, { query: SUBJECT_HANDLE });
  assert(out.length > 0);
  assert(out.every((f) => !unlinked(f)), "one token with no space is a handle, not a name");
});

Deno.test("an email in the generic query slot is NOT treated as a name", () => {
  const out = extractFindings("oathnet_lookup", nameSearchHits, { query: SUBJECT_EMAIL });
  assert(out.every((f) => !unlinked(f)));
});

// The echo exemption is CONDITIONAL — see name_collision_root_test.ts for the
// escape it used to permit. It survives here only in its authorized form: the
// queried name is the investigation's own seed.
Deno.test("the queried name echoed back is the subject's own name when the SEED is that name", () => {
  const out = extractFindings(
    "oathnet_lookup",
    { data: { data: { items: [{ full_name: SUBJECT_NAME, email: "third.party.c@example.com" }] } } },
    { type: "name", value: SUBJECT_NAME },
    SUBJECT_NAME.toLowerCase(),
  );
  const nameRow = out.find((f) => f.kind === "name");
  if (nameRow) assert(!unlinked(nameRow), "the echo of a SEEDED name is not a stranger");
  const other = out.find((f) => f.kind === "email");
  if (other) assert(unlinked(other), "but a co-returned email still is");
});

Deno.test("the same echo IS quarantined when the queried name is not the seed", () => {
  const out = extractFindings(
    "oathnet_lookup",
    { data: { data: { items: [{ full_name: SUBJECT_NAME, email: "third.party.c@example.com" }] } } },
    { type: "name", value: SUBJECT_NAME },
    // Seeded on an email — nothing links this harvested name to the subject.
    "",
  );
  const nameRow = out.find((f) => f.kind === "name");
  assert(nameRow, "the row is still extracted — quarantine is not deletion");
  assert(unlinked(nameRow!), "name equality alone is not durable linkage");
});

Deno.test("no input at all leaves rows unquarantined (no false accusation)", () => {
  const out = extractFindings("oathnet_lookup", nameSearchHits);
  assert(out.every((f) => !unlinked(f)), "absent an input we cannot claim the query was a name");
});

/**
 * FP-1 — a free-text SEARCH QUERY is not a person name.
 *
 * `github_code_search`'s inputSchema is `z.object({ query: z.string() })`: there is
 * no concrete-selector key to find, and a useful code-search query is inherently
 * multiword. Shape-sniffing therefore classified every one of them as a person
 * name and quarantined every repo it found.
 */
Deno.test("a code-search query is not a person name, so its repos are not quarantined", () => {
  const out = extractFindings(
    "github_code_search",
    { items: [{ repo: "acme/widgets", path: "config.json" }] },
    { query: "widgets in:file extension:json" },
  );
  assert(out.length > 0, "the repo must still be extracted");
  assert(
    out.every((f) => !unlinked(f)),
    "a free-text code search is a query language, not a name — nothing it returns is subject_unlinked",
  );
});

/**
 * FP-2 — a declared CONCRETE type is authoritative, in both directions.
 *
 * `oathnet_lookup` declares `type: z.enum([...,"username",...])` with the selector
 * in `value`, not in a concrete-named key. Treating only `name`/`person` as
 * authoritative meant an explicit `type:"username"` fell through to shape-sniffing,
 * and a handle that happens to contain a space was quarantined as a name.
 */
Deno.test("an explicit type:'username' is honoured even when the value looks like a name", () => {
  const out = extractFindings(
    "oathnet_lookup",
    nameSearchHits,
    { type: "username", value: "kyle williams 710" },
  );
  assert(out.length > 0);
  assert(
    out.every((f) => !unlinked(f)),
    "the caller declared a concrete selector — the provider matched on it, so results are subject-linked",
  );
});

Deno.test("leakcheck_lookup's type/value shape is honoured the same way", () => {
  // NOTE the output shape: leakcheck's corpus arrives as data.breaches[], NOT the
  // data.data.items[] of a name search. Reusing nameSearchHits here extracted
  // nothing, so the test passed its quarantine assertion vacuously.
  const out = extractFindings(
    "leakcheck_lookup",
    { data: { breaches: [{ Name: "ExampleCorp" }] } },
    { type: "username", value: "kyle williams 710" },
  );
  assert(out.length > 0, "the fixture must actually reach the extractor");
  assert(out.every((f) => !unlinked(f)), "a declared concrete type wins over the value's shape");
});

Deno.test("an explicit type:'name' still quarantines — the gate's whole point survives", () => {
  const out = extractFindings("oathnet_lookup", nameSearchHits, { type: "name", value: SUBJECT_NAME });
  const ids = out.filter((f) => f.kind === "email" || f.kind === "username");
  assert(ids.length > 0);
  assert(ids.every(unlinked), "a declared name query must still quarantine everything it harvests");
});

/**
 * The rest of the free-text inventory, enumerated from real schemas in
 * tool-registry.ts rather than guessed from tool names. Each of these was probed
 * against the live module and confirmed to (a) produce findings and (b) have them
 * wrongly quarantined before the allowlist existed.
 *
 * The broad-search tools that would otherwise belong here — exa_search,
 * minimax_web_search, osint_navigator_search — are already on
 * AUTO_PERSIST_TOOL_DENYLIST and never reach the gate at all.
 */
const freeTextQueries: Array<[string, string]> = [
  ["fofa_search", 'domain="example.com" && port="443"'],
  ["oathnet_ai_filter", "US banking users with gmail addresses"],
  ["osint_navigator_query", "tools to find who registered a domain"],
  ["urlscan_search", 'domain:example.com AND page.url:"keyword"'],
];

for (const [tool, query] of freeTextQueries) {
  Deno.test(`${tool}'s query is a search expression, not a person name`, () => {
    const out = extractFindings(tool, { citations: ["https://example.com/a"] }, { query });
    assert(out.length > 0, "the fixture must actually reach the extractor");
    assert(out.every((f) => !unlinked(f)), `${tool} takes a query language — nothing it returns is subject_unlinked`);
  });
}

/**
 * The counter-case that keeps the allowlist honest. deepfind_telegram_search is
 * deliberately NOT allowlisted: it is a topic/keyword search, so querying it with
 * a person's name really does return same-name-collision-prone channels. If
 * someone "completes" the allowlist by adding every query-shaped tool, this fails.
 */
Deno.test("a topic search queried by name still quarantines — the allowlist is not 'every query tool'", () => {
  const out = extractFindings("deepfind_telegram_search", { citations: ["https://example.com/a"] }, {
    query: SUBJECT_NAME,
  });
  assert(out.length > 0);
  assert(out.every(unlinked), "a name typed into a topic search is exactly the weak linkage the gate discloses");
});

Deno.test("an explicit type:'domain' follows the declared type, not the value's shape", () => {
  const out = extractFindings(
    "oathnet_lookup",
    { data: { breaches: [{ Name: "ExampleCorp" }] } },
    { type: "domain", value: "example com ltd" },
  );
  assert(out.length > 0);
  assert(out.every((f) => !unlinked(f)), "a declared domain query is subject-linked by construction");
});

Deno.test("a name alongside a concrete selector is not a name-only query", () => {
  const out = extractFindings(
    "oathnet_lookup",
    nameSearchHits,
    { name: SUBJECT_NAME, email: SUBJECT_EMAIL },
  );
  assert(out.length > 0);
  assert(
    out.every((f) => !unlinked(f)),
    "the provider still matched on the email — the co-present name does not weaken it",
  );
});

/**
 * FN-1 — CHARACTERIZATION, not a red-green test. This pins the ACCEPTED limit
 * documented in `queryIsNameOnly`: a person name placed in a concrete slot escapes
 * the gate. Closing it would require inferring that a name sits inside a selector
 * slot, i.e. re-introducing prose-based inference — removed from this project
 * deliberately after it caused a production incident. If this test ever starts
 * failing, the gate got stricter; check that the change is intentional.
 */
Deno.test("KNOWN LIMIT (FN-1): a name in a concrete slot escapes the gate", () => {
  const out = extractFindings("oathnet_lookup", nameSearchHits, { username: "jane roe" });
  assert(out.length > 0);
  assert(out.every((f) => !unlinked(f)), "documented limit — a concrete key is trusted by construction");
});

/** A fully-typed minimal artifact — no cast, so both linters stay happy. */
const artifact = (value: string, metaRaw: string): Artifact => ({
  kind: "email",
  value,
  source: "oathnet_lookup",
  confidence: 45,
  metaRaw,
});

Deno.test("clustering treats a quarantined row as inert", () => {
  const quarantined = artifact(STUDENT_ADDRESS, JSON.stringify({ subject_unlinked: true }));
  const normal = artifact(SUBJECT_EMAIL, "{}");
  assert(isExcluded(quarantined), "a subject_unlinked row must not seed a cluster");
  assert(!isExcluded(normal), "a linked row must still cluster normally");
});
