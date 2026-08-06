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
 *  - A name-only query ⇒ every harvested row is stamped `subject_unlinked`.
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

Deno.test("the queried name echoed back is the subject's own name, not a third party", () => {
  const out = extractFindings(
    "oathnet_lookup",
    { data: { data: { items: [{ full_name: SUBJECT_NAME, email: "third.party.c@example.com" }] } } },
    { type: "name", value: SUBJECT_NAME },
  );
  const nameRow = out.find((f) => f.kind === "name");
  if (nameRow) assert(!unlinked(nameRow), "the echo of the query is not a stranger");
  const other = out.find((f) => f.kind === "email");
  if (other) assert(unlinked(other), "but a co-returned email still is");
});

Deno.test("no input at all leaves rows unquarantined (no false accusation)", () => {
  const out = extractFindings("oathnet_lookup", nameSearchHits);
  assert(out.every((f) => !unlinked(f)), "absent an input we cannot claim the query was a name");
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
