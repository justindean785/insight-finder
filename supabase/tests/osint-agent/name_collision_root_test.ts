/**
 * name_collision_root_test.ts — the queried-name ECHO is not self-authorizing.
 *
 * THE ESCAPE (production-derived, generalized from a live thread)
 * An investigation opens on a durable selector (an email). A lookup on that
 * selector harvests a NAME. The model then feeds that harvested name into a
 * name-only tool. The provider returns a DIFFERENT person who happens to carry
 * the same name, plus that stranger's email, phone and address.
 *
 * Every descendant of that call was already quarantined correctly. The ROOT was
 * not: `auto-persist-findings.ts` exempted any `name` row whose value equalled
 * the queried name, on the reasoning that "the query echoed back is the
 * subject's own asserted name". That reasoning holds only when the QUERIED NAME
 * itself is durably linked to the subject. When the queried name was merely
 * harvested mid-run, the echo is the STRANGER's name record — string-identical,
 * different person — and it escaped with ordinary subject authority, free to
 * seed clusters and pivots toward the wrong human being.
 *
 * THE CONTRACT
 *  - Name equality alone is NEVER durable linkage.
 *  - The echo may skip quarantine ONLY when the queried name is linked to the
 *    subject by an already-authorized mechanism — here, the investigation seed.
 *  - Absent proof of linkage the gate FAILS CLOSED: the echo is quarantined.
 *  - Quarantine remains DISCLOSURE, NOT DELETION. Every row still persists.
 *
 * FIXTURES ARE SYNTHETIC. No real subject, selector or name from the originating
 * investigation appears here. `example.test` / `example.com` are RFC 2606
 * reserved and resolve to nobody; the 555-01xx phone block is reserved for
 * fiction; the street address is the canonical fictional one.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { extractFindings } from "../../functions/osint-agent/auto-persist-findings.ts";

// ---- The investigation ------------------------------------------------------
/** The durable selector the investigation opened on. NOT a name. */
const SEED_EMAIL = "primary@example.test";
/** The name durably harvested from a selector-keyed lookup on SEED_EMAIL. */
const SUBJECT_NAME = "Example Original Subject";
/** The name fed into the name-only tool — and the stranger it collides with. */
const COLLISION_NAME = "Example Collision Name";

// ---- The stranger the name-only lookup actually returned --------------------
const STRANGER_EMAIL = "unrelated.stranger@example.com";
const STRANGER_PHONE = "5550100123";
const STRANGER_ADDRESS = "742 Evergreen Terrace Springfield OR 97477";

/** The oathnet `data.data.items[]` shape, carrying one same-name stranger. */
const collisionHits = {
  data: {
    data: {
      items: [{
        full_name: COLLISION_NAME,
        email: STRANGER_EMAIL,
        phone_number: STRANGER_PHONE,
        address_street: "742 Evergreen Terrace",
        address_city: "Springfield",
        address_state: "OR",
        address_postcode: "97477",
      }],
    },
  },
};

/** The name-only call: the harvested name is the entire selector. */
const nameOnlyInput = { type: "name", value: COLLISION_NAME };

const unlinked = (f: { context?: Record<string, unknown> } | undefined) =>
  f?.context?.subject_unlinked === true;

const rowOfKind = (out: Array<{ kind: string; value: string }>, kind: string) =>
  out.find((f) => f.kind === kind);

/**
 * An email-seeded investigation carries NO seed name, so the fourth argument is
 * empty — there is nothing that could durably link `COLLISION_NAME` to the
 * subject.
 */
const extractFromCollision = () =>
  extractFindings("oathnet_lookup", collisionHits, nameOnlyInput, "");

// ---- THE ESCAPE -------------------------------------------------------------

Deno.test("collision root: the queried-name echo is quarantined when the queried name is not seed-linked", () => {
  const out = extractFromCollision();
  const nameRow = rowOfKind(out, "name");
  assert(nameRow, "the echoed name must still be extracted — quarantine is not deletion");
  assertEquals(nameRow!.value, COLLISION_NAME, "fixture sanity: this is the echo row");
  assert(
    unlinked(nameRow),
    "THE BUG: a name harvested mid-run and fed back as a query cannot authorize " +
      "the stranger record it returns. Name equality is not durable linkage.",
  );
});

Deno.test("collision root: the quarantine reason is recorded, not just the flag", () => {
  const nameRow = rowOfKind(extractFromCollision(), "name");
  assert(
    typeof nameRow?.context?.subject_unlinked_reason === "string" &&
      (nameRow.context.subject_unlinked_reason as string).trim().length > 0,
    "an analyst must be able to read WHY the row lost authority",
  );
});

// ---- Descendants stay quarantined (no regression) ---------------------------

Deno.test("collision descendants: the stranger's email, phone and address stay quarantined", () => {
  const out = extractFromCollision();
  for (const kind of ["email", "phone", "address"]) {
    const row = rowOfKind(out, kind);
    assert(row, `the ${kind} row must still be extracted`);
    assert(unlinked(row), `the stranger's ${kind} must not count as subject evidence`);
  }
});

// ---- No evidence loss -------------------------------------------------------

Deno.test("no evidence loss: every row from the collision lookup is still persisted", () => {
  const out = extractFromCollision();
  const values = out.map((f) => f.value);
  assert(values.includes(COLLISION_NAME), "the name row survives");
  assert(values.includes(STRANGER_EMAIL), "the email row survives");
  assert(values.some((v) => v.includes("5550100123")), "the phone row survives");
  assert(values.some((v) => v.includes("Evergreen")), "the address row survives");
  assert(
    out.every((f) => typeof f.value === "string" && f.value.length > 0),
    "quarantine changes authority, never the value",
  );
});

// ---- The legitimate name seed still works -----------------------------------

Deno.test("legitimate name seed: the seed-name echo is NOT quarantined", () => {
  const out = extractFindings(
    "oathnet_lookup",
    { data: { data: { items: [{ full_name: COLLISION_NAME, email: STRANGER_EMAIL }] } } },
    nameOnlyInput,
    // The analyst opened the investigation ON this name — it IS the subject.
    COLLISION_NAME.toLowerCase(),
  );
  const nameRow = rowOfKind(out, "name");
  assert(nameRow, "the seed name is still extracted");
  assert(
    !unlinked(nameRow),
    "a name-seeded investigation must keep working — the seed IS the subject's asserted name",
  );
  assert(
    unlinked(rowOfKind(out, "email")),
    "but a co-returned stranger email is still quarantined",
  );
});

Deno.test("legitimate name seed: a seed carrying a location suffix still links its name", () => {
  const out = extractFindings(
    "oathnet_lookup",
    { data: { data: { items: [{ full_name: COLLISION_NAME }] } } },
    nameOnlyInput,
    // detectSeedServer normalizes "Example Collision Name Springfield OR" to this.
    "example collision name springfield or",
  );
  assert(
    !unlinked(rowOfKind(out, "name")),
    "a person seed narrowed by city/state still durably links the name it contains",
  );
});

Deno.test("a seed name that merely SHARES a token does not link an unrelated queried name", () => {
  const out = extractFindings(
    "oathnet_lookup",
    { data: { data: { items: [{ full_name: COLLISION_NAME }] } } },
    nameOnlyInput,
    // Shares only "example" with the queried name.
    "example different person",
  );
  assert(
    unlinked(rowOfKind(out, "name")),
    "partial token overlap is not linkage — that is the collision axis itself",
  );
});

// ---- The durable branch is untouched ----------------------------------------

Deno.test("durable branch: a selector-keyed lookup is still never quarantined", () => {
  const out = extractFindings(
    "oathnet_lookup",
    { data: { data: { items: [{ full_name: SUBJECT_NAME, email: SEED_EMAIL }] } } },
    { email: SEED_EMAIL },
    "",
  );
  assert(out.length > 0, "the durable branch still yields findings");
  assert(
    out.every((f) => !unlinked(f)),
    "a query keyed on a concrete selector is subject-linked by construction",
  );
});
