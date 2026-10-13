// lib/analyst_authority_keys_test.ts — A1: a model cannot write the analyst's keys.
//
// The readers (src/lib/intel.ts labelForArtifact, src/lib/evidence-status.ts, src/lib/quarantine.ts)
// treat `metadata.reviewed === true` as an analyst attestation, `linkage_confirmed === true` as a
// quarantine release and `false_positive === true` as an analyst dismissal. The record tools spread
// MODEL-supplied metadata verbatim, so each of those was writable by the model. The analyst's real
// decisions live in `artifact_reviews` (written by the browser) and in a release patch the browser
// writes; the edge function never writes either. Synthetic values only.
import { assert, assertEquals, assertNotEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ANALYST_AUTHORITY_DISCLOSURE_KEY,
  analystAuthorityBoundarySelfTest,
  analystAuthorityStripDisabled,
  RESERVED_ANALYST_AUTHORITY_KEYS,
  stripAnalystAuthorityKeys,
} from "./analyst-authority-keys.ts";

const KILL = "ANALYST_AUTHORITY_STRIP_DISABLED";

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

Deno.test("the reserved list is pinned — widening or narrowing it is a deliberate, reviewed change", () => {
  assertEquals([...RESERVED_ANALYST_AUTHORITY_KEYS].sort(), [
    "analyst_confirmed",
    "analyst_review",
    "attested",
    "false_positive",
    "human_verified",
    "linkage_confirmed",
    "linkage_confirmed_at",
    "review_state",
    "reviewed",
  ]);
});

Deno.test("every reserved key is stripped whatever the model wrote as its value", () => {
  for (const key of RESERVED_ANALYST_AUTHORITY_KEYS) {
    for (const value of [true, false, "true", 1, 0, null, {}, [], { nested: true }, "confirmed"]) {
      const out = stripAnalystAuthorityKeys({ [key]: value, keep: "x" });
      assert(!(key in (out.metadata ?? {})), `${key}=${JSON.stringify(value)} must not survive`);
      assertEquals(out.metadata?.keep, "x");
      assertEquals(out.stripped, [key]);
    }
  }
});

Deno.test("case and whitespace variants of a reserved key are stripped and reported once, under the canonical name", () => {
  const out = stripAnalystAuthorityKeys({ Reviewed: true, " LINKAGE_CONFIRMED ": true, "reviewed ": true, keep: 1 });
  assertEquals(out.stripped, ["linkage_confirmed", "reviewed"]);
  assertEquals(Object.keys(out.metadata ?? {}).filter((k) => k !== ANALYST_AUTHORITY_DISCLOSURE_KEY), ["keep"]);
});

Deno.test("keys that are server-derived or protective are NOT reserved (the model may still lower authority)", () => {
  const meta = {
    status: "verified",
    sources: ["a"],
    source_category: ["breach"],
    confidence_cap_applied: 60,
    cluster_id: "c1",
    parent_seed: "x@example.com",
    subject_unlinked: true,
    possible_minor: true,
    minor_warning: true,
    conflict: true,
    collision: true,
    excluded_collision: true,
    user_supplied_unreviewed: true,
    reason_not_confirmed: "r",
    note: "free text",
  };
  const out = stripAnalystAuthorityKeys(meta);
  assertEquals(out.stripped, []);
  assertEquals(out.metadata, meta);
});

Deno.test("only the TOP-LEVEL key is read by every reader, so nested look-alikes are left alone", () => {
  const meta = { extra: { reviewed: true, linkage_confirmed: true }, list: [{ false_positive: true }] };
  const out = stripAnalystAuthorityKeys(meta);
  assertEquals(out.stripped, []);
  assertEquals(out.metadata, meta);
});

Deno.test("never mutates its input and hands back the SAME object when nothing was stripped", () => {
  const clean = deepFreeze({ a: 1, b: { c: 2 } });
  assert(stripAnalystAuthorityKeys(clean).metadata === clean, "no copy when nothing changes");
  const dirty = deepFreeze({ a: 1, reviewed: true });
  const out = stripAnalystAuthorityKeys(dirty);
  assertEquals(dirty, { a: 1, reviewed: true });
  assertNotEquals(out.metadata, dirty);
});

Deno.test("absent or non-record metadata passes through untouched", () => {
  assertEquals(stripAnalystAuthorityKeys(undefined), { metadata: undefined, stripped: [] });
  assertEquals(stripAnalystAuthorityKeys(null), { metadata: null, stripped: [] });
  for (const odd of ["reviewed", 5, ["reviewed"]]) {
    const out = stripAnalystAuthorityKeys(odd as never);
    assertEquals(out.metadata, odd);
    assertEquals(out.stripped, []);
  }
});

Deno.test("a strip leaves a value-free disclosure: key NAMES only, sorted, deduplicated", () => {
  const out = stripAnalystAuthorityKeys({ reviewed: "SECRET-VALUE-1", false_positive: "SECRET-VALUE-2", linkage_confirmed: true });
  assertEquals(out.metadata?.[ANALYST_AUTHORITY_DISCLOSURE_KEY], ["false_positive", "linkage_confirmed", "reviewed"]);
  const serialised = JSON.stringify(out.metadata);
  assert(!serialised.includes("SECRET-VALUE"), "the model's values must never be persisted");
});

Deno.test("no strip, no disclosure key", () => {
  const out = stripAnalystAuthorityKeys({ note: "x" });
  assert(!(ANALYST_AUTHORITY_DISCLOSURE_KEY in (out.metadata ?? {})));
});

Deno.test("a model-written disclosure key is itself reserved: it is replaced by the true record, never trusted", () => {
  const spoofed = stripAnalystAuthorityKeys({ [ANALYST_AUTHORITY_DISCLOSURE_KEY]: [], note: "x" });
  assertEquals(spoofed.stripped, [ANALYST_AUTHORITY_DISCLOSURE_KEY]);
  assertEquals(spoofed.metadata?.[ANALYST_AUTHORITY_DISCLOSURE_KEY], [ANALYST_AUTHORITY_DISCLOSURE_KEY]);
});

Deno.test("kill switch (call-time) restores legacy pass-through", () => {
  const env = (k: string) => (k === KILL ? "true" : undefined);
  const meta = { reviewed: true };
  const out = stripAnalystAuthorityKeys(meta, env);
  assert(out.metadata === meta);
  assertEquals(out.stripped, []);
  assert(analystAuthorityStripDisabled(env));
  assert(!analystAuthorityStripDisabled(() => undefined));
  assert(!analystAuthorityStripDisabled(() => "false"));
});

Deno.test("process env kill switch is read at CALL time and ships OFF", () => {
  assertEquals(Deno.env.get(KILL), undefined, "the switch must not be set in the default environment");
  Deno.env.set(KILL, "true");
  try {
    assertEquals(stripAnalystAuthorityKeys({ reviewed: true }).stripped, []);
    assertEquals(analystAuthorityBoundarySelfTest().detail, "LEGACY via ANALYST_AUTHORITY_STRIP_DISABLED");
  } finally {
    Deno.env.delete(KILL);
  }
  assertEquals(stripAnalystAuthorityKeys({ reviewed: true }).stripped, ["reviewed"]);
});

Deno.test("health self-test passes with the rule on and states what it proves", () => {
  const t = analystAuthorityBoundarySelfTest();
  assert(t.ok, t.detail);
  assert(/analyst/i.test(t.detail));
});
