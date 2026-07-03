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

// ---------------------------------------------------------------------------
// Codex + Copilot review follow-ups on this PR — 3 remaining under-folding
// gaps in the SAME direction as the fixes above (compatible variants must not
// manufacture a HIGH "different people" conflict). None inflate confidence;
// genuinely incompatible names/locations are unaffected (pinned below too).
// ---------------------------------------------------------------------------

Deno.test("name_conflict: a surname INITIAL folds against the full surname (Codex)", () => {
  assertEquals(namesCompatible("John S.", "John Smith"), true);
  assertEquals(namesCompatible("John Smith", "John S."), true);
  // A surname initial still correctly conflicts with a genuinely different surname.
  assertEquals(namesCompatible("John S.", "John Doe"), false);
});

Deno.test("name_conflict: a bare SURNAME-ONLY token folds against a matching full name (Copilot)", () => {
  // "Smith" alone is ambiguous (could be either half of "John Smith") — thin_name
  // already flags it as low-confidence advisory; it must not ALSO fire a HIGH
  // "different people" conflict against a name it plausibly matches.
  assertEquals(namesCompatible("Smith", "John Smith"), true);
  assertEquals(namesCompatible("John Smith", "Smith"), true);
  // Surname-initial-only ("S.") folds the same way.
  assertEquals(namesCompatible("S.", "John Smith"), true);
  // A bare token that matches NEITHER the given nor the surname still conflicts.
  assertEquals(namesCompatible("Jones", "John Smith"), false);
});

Deno.test("location_conflict: a run-on 'City State' with NO comma folds against 'City, ST' (Codex)", () => {
  assertEquals(locationsCompatible("Tampa Florida", "Tampa, FL"), true);
  assertEquals(locationsCompatible("Rocklin CA", "Rocklin, CA"), true);
  // Multi-word state name, no comma.
  assertEquals(locationsCompatible("Charlotte North Carolina", "Charlotte, NC"), true);
  // A genuinely different state still conflicts even without a comma.
  assertEquals(locationsCompatible("Tampa Florida", "Austin Texas"), false);
});

Deno.test("location_conflict: a plain two-word city with no trailing state is NOT mis-split", () => {
  // "Elk Grove" must not be parsed as city="elk" + a bogus trailing state.
  assertEquals(locationsCompatible("Elk Grove, CA", "Elk Grove, CA"), true);
  assertEquals(locationsCompatible("Elk Grove, CA", "Austin, TX"), false);
});

Deno.test("location_conflict: a no-comma run-on with a trailing COUNTRY still folds a state (Codex)", () => {
  // A trailing "USA" must not block state recognition on the residual
  // "City State" run — this must fold identically to its comma-form
  // counterpart "Tampa, FL, USA".
  assertEquals(locationsCompatible("Tampa Florida USA", "Tampa, FL, USA"), true);
  assertEquals(locationsCompatible("Tampa Florida USA", "Tampa, FL"), true);
  assertEquals(locationsCompatible("Rocklin CA US", "Rocklin, CA"), true);
  // Multi-word state AND multi-word country trailing, no comma anywhere.
  assertEquals(locationsCompatible("Charlotte North Carolina United States", "Charlotte, NC"), true);
  // A genuinely different state still conflicts with a trailing country present.
  assertEquals(locationsCompatible("Tampa Florida USA", "Austin Texas USA"), false);
});
