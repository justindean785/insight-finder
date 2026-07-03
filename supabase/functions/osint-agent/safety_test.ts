// Regression tests for the minor-safety scrubber (safety.ts).
//
// Root cause fixed here: a DOB reclassified `dob`→`other` was scanned for bare
// age numbers, so "1958-10-11" matched its month "10" and produced a spurious
// `possible_minor` flag (→ confidence cap 35, adult-platform × minor collision,
// false top-of-report safety banner). The fix excludes DOB / date-like values
// from the bare-age heuristic WITHOUT weakening real minor-age detection.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { scrubArtifactRow } from "./safety.ts";

function meta(row: Record<string, unknown>): Record<string, unknown> {
  return (scrubArtifactRow(row).metadata ?? {}) as Record<string, unknown>;
}

Deno.test("DOB 1958-10-11 (original_kind dob) does NOT trigger possible_minor", () => {
  const m = meta({ kind: "other", value: "1958-10-11", confidence: 60, metadata: { original_kind: "dob" } });
  assertEquals(m.possible_minor, undefined);
  assertEquals(m.minor_warning, undefined);
  assertEquals(m.minor_signals, undefined);
});

Deno.test("a date with month/day in 10–17 does NOT trigger bare minor detection", () => {
  // Not a DOB kind, but the value is date-like → the bare-age scan must skip it.
  for (const v of ["2020-10-15", "10/11/1958", "1973-12-14", "11.10.58"]) {
    const m = meta({ kind: "other", value: v, metadata: {} });
    assertEquals(m.possible_minor, undefined, `date ${v} must not flag minor`);
  }
});

Deno.test("adult-platform DOB does NOT produce a false safety collision flag", () => {
  // The exact case: a DOB clustered with an AdultFriendFinder artifact.
  const m = meta({
    kind: "other",
    value: "1958-10-11",
    source: "oathnet_lookup+serus_darkweb_scan/AdultFriendFinder breach",
    metadata: { original_kind: "dob", platform: "AdultFriendFinder", cluster_id: "cluster-a" },
  });
  assertEquals(m.possible_minor, undefined);
  assertEquals(m.auto_pivot_blocked, undefined);
});

Deno.test("real minor-age cue text STILL triggers (detection preserved)", () => {
  const cue = meta({ kind: "social", value: "coolkid", metadata: { bio: "art student, age 16, loves anime" } });
  assertEquals(cue.possible_minor, true);
  assert(Array.isArray(cue.minor_signals) && (cue.minor_signals as string[]).some((s) => s.startsWith("age-")));

  const phrase = meta({ kind: "social", value: "someone", metadata: { bio: "just a minor here" } });
  assertEquals(phrase.possible_minor, true);

  // A bare lone age in a short bio (not a date) is still a soft signal.
  const bare = meta({ kind: "username", value: "16", metadata: {} });
  assertEquals(bare.possible_minor, true);
  assert((bare.minor_signals as string[]).includes("bare-16"));
});

Deno.test("an explicit age cue inside a date-bearing bio still fires", () => {
  // The date-like guard only suppresses the BARE heuristic; an explicit cue is
  // matched independently, so a genuine minor signal is not lost.
  const m = meta({ kind: "social", value: "u", metadata: { bio: "born 2009, i'm 15 now" } });
  assertEquals(m.possible_minor, true);
});

Deno.test("an SSN whose group number is 10-17 does NOT trigger possible_minor", () => {
  // The exact live case: "602-17-1270" (kind "other", original_kind "ssn" —
  // an LLM-asserted free-text tag, not a controlled enum) matched the bare-age
  // scan on its "-17-" group number and produced a spurious possible_minor
  // flag + auto_pivot_blocked on a real adult's SSN. The fix is shape-based
  // (SSN_LIKE_RE), same approach as the DOB guard above, since original_kind
  // tagging isn't reliable enough to key off of alone.
  const m = meta({ kind: "other", value: "602-17-1270", confidence: 60, metadata: { original_kind: "ssn" } });
  assertEquals(m.possible_minor, undefined);
  assertEquals(m.auto_pivot_blocked, undefined);
  assertEquals(m.minor_signals, undefined);
});

Deno.test("other SSN-shaped group-number-in-10-17 values do not false-positive", () => {
  for (const v of ["123-14-5678", "275-92-7276".replace("92", "17"), "XXX-17-1234"]) {
    const m = meta({ kind: "other", value: v, metadata: {} });
    assertEquals(m.possible_minor, undefined, `SSN-shaped value ${v} must not flag minor`);
  }
});
