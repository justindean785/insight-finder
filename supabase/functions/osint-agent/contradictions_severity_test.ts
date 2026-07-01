import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  detectContradictions,
  structuredContradictionPatches,
  namesCompatible,
  locationsCompatible,
} from "./contradictions.ts";

const NOW = "2026-06-19T00:00:00.000Z";

function nameArtifact(value: string, source: string) {
  return { kind: "name", value, source, metadata: {} };
}
function locArtifact(value: string, source: string, residence: string) {
  return { kind: "address", value, source, metadata: { residence } };
}

// ===========================================================================
// FIX 1 — name_conflict must NOT fire HIGH on compatible SAME-PERSON variants,
// but MUST still fire on genuinely different people.
// ===========================================================================

// --- Direction A: false-positive that should now be FIXED -----------------
Deno.test("name_conflict: compatible variants (initial / nickname / middle) do NOT fire HIGH", () => {
  const artifacts = [
    nameArtifact("John Smith", "GitHub"),
    nameArtifact("John A. Smith", "LinkedIn"),
    nameArtifact("Johnny Smith", "Twitter"),
  ];
  const findings = detectContradictions(artifacts);
  assertEquals(findings.some((f) => f.kind === "name_conflict"), false);
  // No structured "different people" patch → no -25 identity hit.
  const patches = structuredContradictionPatches(artifacts, NOW);
  assertEquals(patches.some((p) => p.entry.kind === "name_conflict"), false);
});

Deno.test("name_conflict: nickname<->formal (Bob/Robert, Bill/William) fold to compatible", () => {
  assertEquals(namesCompatible("Robert Jones", "Bob Jones"), true);
  assertEquals(namesCompatible("William Carter", "Bill Carter"), true);
  assertEquals(namesCompatible("Michael Ford Jr.", "Mike Ford"), true);
  assertEquals(namesCompatible("J. Smith", "John Smith"), true);
});

// --- Direction B: genuine conflict that must STILL fire -------------------
Deno.test("name_conflict: genuinely different names STILL fire HIGH", () => {
  const artifacts = [
    nameArtifact("John Smith", "GitHub"),
    nameArtifact("Jane Doe", "Twitter"),
  ];
  const findings = detectContradictions(artifacts);
  const nc = findings.find((f) => f.kind === "name_conflict");
  assertEquals(nc?.severity, "high");
  // And it structures into a patch (feeds the -25 path) for the real conflict.
  const patches = structuredContradictionPatches(artifacts, NOW);
  assertEquals(patches.some((p) => p.entry.kind === "name_conflict"), true);
});

Deno.test("name_conflict: same given name, DIFFERENT surname still fires (different people)", () => {
  // The canonical false-merge: one selector → "John Daniels" and "John Demos".
  const artifacts = [
    nameArtifact("John Daniels", "GitHub"),
    nameArtifact("John Demos", "Twitter"),
  ];
  const findings = detectContradictions(artifacts);
  assertEquals(findings.find((f) => f.kind === "name_conflict")?.severity, "high");
  assertEquals(namesCompatible("John Daniels", "John Demos"), false);
});

Deno.test("name_conflict: a compatible cluster with ONE outlier still fires HIGH", () => {
  const artifacts = [
    nameArtifact("John Smith", "A"),
    nameArtifact("Johnny Smith", "B"),
    nameArtifact("Jane Doe", "C"),
  ];
  const findings = detectContradictions(artifacts);
  assertEquals(findings.find((f) => f.kind === "name_conflict")?.severity, "high");
});

// ===========================================================================
// FIX 2 — location_conflict must NOT fire HIGH on containment/granularity
// variants, but MUST still fire on genuinely incompatible locations.
// ===========================================================================

// --- Direction A: false-positive that should now be FIXED -----------------
Deno.test("location_conflict: city / bare-state / 'City, ST' variants do NOT fire HIGH", () => {
  const artifacts = [
    locArtifact("prof A", "A", "Los Angeles"),
    locArtifact("prof B", "B", "CA"),
    locArtifact("prof C", "C", "Los Angeles, CA"),
  ];
  const findings = detectContradictions(artifacts);
  assertEquals(findings.some((f) => f.kind === "location_conflict"), false);
  const patches = structuredContradictionPatches(artifacts, NOW);
  assertEquals(patches.some((p) => p.entry.kind === "location_conflict"), false);
});

Deno.test("location_conflict: state-name vs abbreviation vs 'City, State' fold to compatible", () => {
  assertEquals(locationsCompatible("Tampa, Florida", "Tampa, FL"), true);
  assertEquals(locationsCompatible("Austin, TX", "Austin, Texas"), true);
  assertEquals(locationsCompatible("Los Angeles, CA, USA", "Los Angeles"), true);
  assertEquals(locationsCompatible("CA", "Los Angeles, CA"), true);
});

// --- Direction B: genuine conflict that must STILL fire -------------------
Deno.test("location_conflict: different states STILL fire HIGH (Tampa,FL vs LA,CA)", () => {
  const artifacts = [
    locArtifact("prof A", "FightFAX", "Tampa, Florida"),
    locArtifact("prof B", "OpenSponsorship", "Los Angeles, CA"),
  ];
  const findings = detectContradictions(artifacts);
  assertEquals(findings.find((f) => f.kind === "location_conflict")?.severity, "high");
  const patches = structuredContradictionPatches(artifacts, NOW);
  assertEquals(patches.some((p) => p.entry.kind === "location_conflict"), true);
});

Deno.test("location_conflict: different cities in different states are incompatible", () => {
  assertEquals(locationsCompatible("Portland, OR", "Portland, ME"), false);
  assertEquals(locationsCompatible("Austin, TX", "Boston, MA"), false);
});

Deno.test("location_conflict: same state, different city is NOT a HIGH conflict", () => {
  // Per spec, only different-state (or otherwise irreconcilable) locations fire.
  assertEquals(locationsCompatible("Los Angeles, CA", "San Diego, CA"), true);
});

Deno.test("name_conflict: differing generational suffixes (father/son) are NOT folded", () => {
  // Jr vs Sr and II vs III mark potentially different people; must not fold.
  assertEquals(namesCompatible("John Smith Jr.", "John Smith Sr."), false);
  assertEquals(namesCompatible("John Smith II", "John Smith III"), false);
  // Same suffix or suffix on only one side stays compatible (granularity).
  assertEquals(namesCompatible("John Smith Jr.", "John Smith Jr."), true);
  assertEquals(namesCompatible("John Smith Jr.", "John Smith"), true);
});

Deno.test("name_conflict: cross-gender-ambiguous nicknames are NOT auto-folded", () => {
  // 'steph' (Stephen vs Stephanie) and 'sasha' (Alexander vs Alexandra) are
  // ambiguous and were removed from the nickname groups — don't fold them.
  assertEquals(namesCompatible("Steph Jones", "Stephen Jones"), false);
  assertEquals(namesCompatible("Sasha Rivera", "Alexander Rivera"), false);
  // Unambiguous nickname pairs still fold.
  assertEquals(namesCompatible("Steve Jones", "Stephen Jones"), true);
});
