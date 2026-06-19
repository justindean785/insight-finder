import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  detectContradictions,
  structuredContradictionPatches,
  mergeStructuredContradictions,
  type StructuredContradiction,
} from "./contradictions.ts";

const NOW = "2026-06-19T00:00:00.000Z";

// ---------------------------------------------------------------------------
// The headline gap: a location conflict expressed via the keys the
// orchestrator actually writes (`based` / `residence`) must become a STRUCTURED
// contradiction, not survive only as prose in metadata.note.
// ---------------------------------------------------------------------------

Deno.test("location conflict (Tampa residence vs LA based) becomes a structured contradiction", () => {
  const artifacts = [
    { kind: "address", value: "Tampa, Florida, USA", source: "FightFAX", metadata: { residence: "Tampa, Florida" } },
    { kind: "employer", value: "OpenSponsorship profile", source: "OpenSponsorship", metadata: { based: "Los Angeles, CA" } },
  ];
  const patches = structuredContradictionPatches(artifacts, NOW);
  // Non-empty: both involved artifacts get the structured entry.
  assertEquals(patches.length, 2);
  const values = patches.map((p) => p.value).sort();
  assertEquals(values, ["OpenSponsorship profile", "Tampa, Florida, USA"]);
  const entry = patches[0].entry;
  assertEquals(entry.kind, "location_conflict");
  assertEquals(entry.field, "location");
  assertEquals(entry.severity, "high");
  assertEquals(entry.detected_at, NOW);
  // Captures both conflicting values WITH their sources (prior + conflicting).
  const claimValues = entry.claims.map((c) => c.value).sort();
  assertEquals(claimValues, ["Los Angeles, CA", "Tampa, Florida"]);
  const claimSources = entry.claims.map((c) => c.source).sort();
  assertEquals(claimSources, ["FightFAX", "OpenSponsorship"]);
});

Deno.test("no location conflict when all artifacts agree → no structured patch", () => {
  const artifacts = [
    { kind: "address", value: "Tampa, FL", source: "A", metadata: { residence: "Tampa, Florida" } },
    { kind: "address", value: "Tampa, FL (dup)", source: "B", metadata: { city: "Tampa, Florida" } },
  ];
  const patches = structuredContradictionPatches(artifacts, NOW);
  assertEquals(patches.length, 0);
});

Deno.test("birthplace is NOT treated as a current-location claim (no false conflict)", () => {
  // birthplace Tampa + residence Tampa must not manufacture a conflict, and
  // birthplace alone must never count as a second location.
  const artifacts = [
    { kind: "address", value: "Tampa", source: "A", metadata: { residence: "Tampa, Florida", birthplace: "Miami, Florida" } },
  ];
  const patches = structuredContradictionPatches(artifacts, NOW);
  assertEquals(patches.length, 0);
});

Deno.test("employer conflict becomes structured with field=employer", () => {
  const artifacts = [
    { kind: "person", value: "subject", source: "LinkedIn", metadata: { employer: "Misfits Boxing" } },
    { kind: "person", value: "subject2", source: "News", metadata: { company: "Acme Corp" } },
  ];
  const patches = structuredContradictionPatches(artifacts, NOW);
  assertEquals(patches.length >= 2, true);
  assertEquals(patches[0].entry.field, "employer");
  assertEquals(patches[0].entry.kind, "employer_conflict");
});

Deno.test("advisory heuristics WITHOUT explicit conflicting claims are NOT structured", () => {
  // thin_name / common_handle_collision lack `claims` → must be skipped, so we
  // never invent structured contradictions from weak single-artifact signals.
  const artifacts = [
    { kind: "username", value: "admin", source: "sweep", metadata: {} },
    { kind: "name", value: "Cher", source: "web", metadata: {} },
  ];
  const findings = detectContradictions(artifacts);
  // The detector still surfaces them as advisory findings...
  assertEquals(findings.some((f) => f.kind === "common_handle_collision"), true);
  assertEquals(findings.some((f) => f.kind === "thin_name"), true);
  // ...but none are promoted to structured patches.
  const patches = structuredContradictionPatches(artifacts, NOW);
  assertEquals(patches.length, 0);
});

// ---------------------------------------------------------------------------
// Persistence / normalization survival — the merge that the detect_contradictions
// tool applies before UPDATE.
// ---------------------------------------------------------------------------

Deno.test("merge appends a structured contradiction onto an empty field", () => {
  const entry: StructuredContradiction = {
    kind: "location_conflict", field: "location", reason: "r", severity: "high",
    claims: [{ value: "Tampa", source: "A" }, { value: "LA", source: "B" }], detected_at: NOW,
  };
  const merged = mergeStructuredContradictions([], [entry]);
  assertEquals(merged.length, 1);
  assertEquals((merged[0] as StructuredContradiction).field, "location");
});

Deno.test("merge is idempotent — re-running detect does not duplicate the same conflict", () => {
  const entry: StructuredContradiction = {
    kind: "location_conflict", field: "location", reason: "r", severity: "high",
    claims: [{ value: "Tampa", source: "A" }, { value: "LA", source: "B" }], detected_at: NOW,
  };
  const once = mergeStructuredContradictions([], [entry]);
  const twice = mergeStructuredContradictions(once, [entry]);
  assertEquals(twice.length, 1);
});

Deno.test("merge preserves prior entries (including legacy string contradictions)", () => {
  const legacy = "location_conflict: noted earlier in prose";
  const entry: StructuredContradiction = {
    kind: "employer_conflict", field: "employer", reason: "r", severity: "medium",
    claims: [{ value: "X", source: "A" }, { value: "Y", source: "B" }], detected_at: NOW,
  };
  const merged = mergeStructuredContradictions([legacy], [entry]);
  assertEquals(merged.length, 2);
  assertEquals(merged[0], legacy);
});
