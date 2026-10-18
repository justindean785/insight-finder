import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildExclusionMap,
  dropRejectedAndDerived,
  type ReviewLoad,
} from "../../functions/osint-agent/reviews.ts";

/**
 * Production shape from thread b74049ad (seed @glitterkittens12, 2026-09-08).
 * An OathNet breach match on the seed handle produced a whole identity branch;
 * the analyst rejected the branch's roots, and the pipeline kept every
 * descendant whose literal value differed from what was clicked.
 */
function productionRows() {
  return [
    { id: "seed", kind: "username", value: "glitterkittens12", metadata: {} },
    // --- the rejected roots (analyst clicked these) ---
    { id: "email", kind: "email", value: "dgoff1276@gmail.com", metadata: { via: "oathnet" } },
    { id: "name", kind: "name", value: "Diamond Nicole", metadata: { via: "oathnet" } },
    // --- descendants: different literal values, same provenance ---
    { id: "pw1", kind: "hash", value: "alex12 (plaintext password — Wishbone 2016 breach)", metadata: { parent_selector: "dgoff1276@gmail.com" } },
    { id: "pw2", kind: "hash", value: "233696sps (plaintext password — Wattpad 2020 breach)", metadata: { parent_selector: "dgoff1276@gmail.com" } },
    { id: "alt", kind: "username", value: "diamondnicole7", metadata: { parent_selector: "dgoff1276@gmail.com" } },
    { id: "bchk", kind: "breach_exposure", value: "dgoff1276@gmail.com — breach_check confirms Wishbone.io and Wattpad.com", metadata: { parent_selector: "dgoff1276@gmail.com" } },
    // --- grandchild: derived from a descendant, not from a rejected root ---
    { id: "gc", kind: "social_profile", value: "wattpad.com/user/diamondnicole7", metadata: { parent_selector: "diamondnicole7" } },
    // --- the evidence the analyst KEPT ---
    { id: "ig", kind: "social_profile", value: "Instagram: @glitterkittens12 — 'Sac Archives'", metadata: {} },
    { id: "org", kind: "organization", value: "Sac Archives — Sacramento crime commentary blog", metadata: {} },
  ];
}

function reviewLoad(partial: Partial<ReviewLoad> = {}): ReviewLoad {
  return {
    ok: true,
    error: null,
    byId: new Map(),
    noteById: new Map(),
    rejectedKeys: new Set(),
    ...partial,
  } as ReviewLoad;
}

Deno.test("rejection cascades through provenance: descendants of a rejected selector leave the working set", () => {
  const rows = productionRows();
  const review = reviewLoad({
    byId: new Map([["email", "wrong"], ["name", "dismissed"]]),
  });

  const kept = dropRejectedAndDerived(rows, review);
  const keptIds = kept.map((r) => r.id);

  // The roots the analyst rejected.
  assert(!keptIds.includes("email"), "rejected email survived");
  assert(!keptIds.includes("name"), "rejected name survived");
  // The descendants that used to survive because their VALUES differ — this is
  // the exact leak that put two plaintext passwords into the subject's network.
  for (const id of ["pw1", "pw2", "alt", "bchk"]) {
    assert(!keptIds.includes(id), `descendant ${id} survived a rejected parent`);
  }
  // ...and transitively, the grandchild reached only through a dropped child.
  assert(!keptIds.includes("gc"), "grandchild survived a rejected grandparent");

  // Evidence with no rejected provenance is untouched. Rejection removes
  // authority from a branch; it must not quietly gut the case.
  assertEquals(keptIds.sort(), ["ig", "org", "seed"]);
});

Deno.test("exclusion is REASONED, not just filtered — chain of custody keeps every row and says why", () => {
  const rows = productionRows();
  const review = reviewLoad({ byId: new Map([["email", "wrong"]]) });
  const map = buildExclusionMap(rows, review);

  assertEquals(map.get("email"), "analyst_rejected");
  assertEquals(map.get("pw1"), "derived_from_rejected");
  assertEquals(map.get("alt"), "derived_from_rejected");
  assertEquals(map.get("gc"), "derived_from_rejected");
  // Not excluded at all — no rejected provenance.
  assertEquals(map.get("ig"), undefined);
  assertEquals(map.get("name"), undefined);
  // Every row is still present in the input; nothing was deleted.
  assertEquals(rows.length, 10);
});

Deno.test("a re-record of a rejected value under a NEW id is still excluded", () => {
  const rows = [
    ...productionRows(),
    { id: "email-again", kind: "email", value: "DGoff1276@Gmail.com", metadata: {} },
  ];
  const review = reviewLoad({ byId: new Map([["email", "wrong"]]) });
  const keptIds = dropRejectedAndDerived(rows, review).map((r) => r.id);
  assert(!keptIds.includes("email-again"), "re-record under a new id bypassed the verdict");
});

Deno.test("unreadable review state FAILS CLOSED — planner evidence is withheld, never published unfiltered", () => {
  const rows = productionRows();
  const broken = reviewLoad({ ok: false, error: "artifact_reviews unavailable" });
  assertEquals(dropRejectedAndDerived(rows, broken).length, 0);
  assertEquals(buildExclusionMap(rows, broken).size, 0);
});

Deno.test("provenance cascade does NOT fire on loose text similarity", () => {
  // The hazard CLAUDE.md documents for the quarantine keyspace: normalization
  // collapses punctuation, so a value-keyed cascade would let a rejected `name`
  // "Jordan Vale" suppress an unrelated `username` "jordan.vale". Only an
  // explicit provenance edge may cascade.
  const rows = [
    { id: "n", kind: "name", value: "Jordan Vale", metadata: {} },
    { id: "u", kind: "username", value: "jordan.vale", metadata: {} },
    // Mentions the rejected value in prose but was NOT derived from it.
    { id: "p", kind: "social_profile", value: "post mentioning Jordan Vale in passing", metadata: {} },
  ];
  const review = reviewLoad({ byId: new Map([["n", "dismissed"]]) });
  const keptIds = dropRejectedAndDerived(rows, review).map((r) => r.id);
  assert(keptIds.includes("u"), "unrelated username suppressed by value collision");
  assert(keptIds.includes("p"), "prose mention suppressed by substring matching");
});

Deno.test("every explicit provenance parent binds, including queried_selector", () => {
  const rows = [
    { id: "root", kind: "email", value: "rejected@example.test", metadata: {} },
    {
      id: "queried",
      kind: "breach_exposure",
      value: "Breach exposure: rejected@example.test",
      metadata: { queried_selector: "rejected@example.test" },
    },
    {
      id: "second-parent",
      kind: "username",
      value: "derived-handle",
      metadata: {
        parent_selector: "independent@example.test",
        queried_selector: "rejected@example.test",
      },
    },
  ];
  const review = reviewLoad({ byId: new Map([["root", "wrong"]]) });
  const keptIds = dropRejectedAndDerived(rows, review).map((r) => r.id);

  assertEquals(keptIds, []);
});
