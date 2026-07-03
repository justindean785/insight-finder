import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  detectContradictions,
  structuredContradictionPatches,
  clusterScopedContradictionPatches,
  artifactsForFinding,
  mergeStructuredContradictions,
  type StructuredContradiction,
} from "./contradictions.ts";
import { computeAxes } from "./confidence.ts";

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

// ---------------------------------------------------------------------------
// Cluster-scoped persistence — a contradiction is only real WITHIN a single
// candidate identity. Distinct hypotheses (different cluster_id) must never be
// cross-marked as contradicting each other.
// ---------------------------------------------------------------------------

Deno.test("cluster-scoped: conflicting locations in DIFFERENT clusters are NOT cross-marked", () => {
  const artifacts = [
    { kind: "address", value: "Tampa, FL", source: "A", metadata: { cluster_id: "c1", residence: "Tampa, Florida" } },
    { kind: "address", value: "Los Angeles, CA", source: "B", metadata: { cluster_id: "c2", residence: "Los Angeles, CA" } },
  ];
  // Thread-wide detection WOULD flag a location_conflict...
  assertEquals(structuredContradictionPatches(artifacts, NOW).length > 0, true);
  // ...but cluster-scoped persistence must NOT, since they're separate candidates.
  assertEquals(clusterScopedContradictionPatches(artifacts, NOW).length, 0);
});

Deno.test("cluster-scoped: conflicting locations WITHIN the same cluster ARE structured", () => {
  const artifacts = [
    { kind: "address", value: "Tampa, FL", source: "A", metadata: { cluster_id: "c1", residence: "Tampa, Florida" } },
    { kind: "employer", value: "OpenSponsorship", source: "B", metadata: { cluster_id: "c1", based: "Los Angeles, CA" } },
  ];
  const patches = clusterScopedContradictionPatches(artifacts, NOW);
  assertEquals(patches.length, 2);
  assertEquals(patches[0].entry.field, "location");
});

Deno.test("cluster-scoped: patches carry the source artifact id (not just value)", () => {
  const artifacts = [
    { id: "A1", kind: "address", value: "123 Main St", source: "A", metadata: { cluster_id: "c1", residence: "Tampa, Florida" } },
    { id: "A2", kind: "employer", value: "Shared Value", source: "B", metadata: { cluster_id: "c1", based: "Los Angeles, CA" } },
  ];
  const patches = clusterScopedContradictionPatches(artifacts, NOW);
  // Every patch resolves to a concrete in-cluster artifact id.
  assertEquals(patches.every((p) => typeof p.id === "string"), true);
  const ids = patches.map((p) => p.id).sort();
  assertEquals(ids, ["A1", "A2"]);
});

Deno.test("cluster-scoped: a value shared across clusters is NOT cross-marked (id-keyed)", () => {
  // "Shared Value" is the c1 employer (A2) AND a c2 address (B1). The c1
  // location conflict must attach to A2 — never to B1 in the other cluster.
  // A value-only persistence match (the pre-fix behavior) could write it onto
  // whichever same-value row sorts first, cross-marking a distinct candidate.
  const artifacts = [
    { id: "B1", kind: "address", value: "Shared Value", source: "Z", metadata: { cluster_id: "c2", residence: "Tampa, Florida" } },
    { id: "A1", kind: "address", value: "123 Main St", source: "A", metadata: { cluster_id: "c1", residence: "Tampa, Florida" } },
    { id: "A2", kind: "employer", value: "Shared Value", source: "B", metadata: { cluster_id: "c1", based: "Los Angeles, CA" } },
  ];
  const patches = clusterScopedContradictionPatches(artifacts, NOW);
  // The conflict touches only the c1 artifacts.
  assertEquals(patches.some((p) => p.id === "A2"), true);
  assertEquals(patches.some((p) => p.id === "B1"), false);
  // The "Shared Value" patch is bound to the c1 row, not the c2 row.
  const sharedPatch = patches.find((p) => p.value === "Shared Value");
  assertEquals(sharedPatch?.id, "A2");
});

Deno.test("cluster-scoped: unclustered artifacts (no cluster_id) are NOT auto-persisted", () => {
  const artifacts = [
    { kind: "address", value: "Tampa, FL", source: "A", metadata: { residence: "Tampa, Florida" } },
    { kind: "address", value: "Los Angeles, CA", source: "B", metadata: { residence: "Los Angeles, CA" } },
  ];
  assertEquals(clusterScopedContradictionPatches(artifacts, NOW).length, 0);
});

// ---------------------------------------------------------------------------
// Finding-scoped contradictions — record_finding must dock a finding's
// confidence only for contradictions belonging to its OWN identity candidate,
// never for an unrelated candidate that happens to share the thread. This
// mirrors the exact scope→detect→computeAxes path record_finding runs.
// ---------------------------------------------------------------------------

/** Reproduce record_finding's penalty computation for a single finding. */
function findingIdentity(
  allRows: Parameters<typeof detectContradictions>[0],
  supportingValues: string[],
  sources: string[],
): number {
  const scoped = artifactsForFinding(allRows, supportingValues);
  const contras = detectContradictions(scoped.length > 0 ? scoped : allRows);
  return computeAxes({
    sources,
    corroborationCount: 1,
    contradictions: contras,
    identityEvidenceStrength: 60,
    relationshipEvidenceStrength: 60,
  }).identity;
}

Deno.test("scope: artifactsForFinding keeps the cited cluster, drops the other candidate", () => {
  const artifacts = [
    { kind: "address", value: "Rocklin, CA", source: "A", metadata: { cluster_id: "c1", residence: "Rocklin, CA" } },
    { kind: "email", value: "ca@example.com", source: "A2", metadata: { cluster_id: "c1" } },
    { kind: "address", value: "Austin, TX", source: "B", metadata: { cluster_id: "c2", residence: "Austin, TX" } },
  ];
  // A CA finding cites only its own address — scope expands to its cluster (c1)
  // but never reaches the TX (c2) artifact.
  const scoped = artifactsForFinding(artifacts, ["Rocklin, CA"]);
  const values = scoped.map((a) => a.value).sort();
  assertEquals(values, ["Rocklin, CA", "ca@example.com"]);
});

Deno.test("false-positive fixed: a CA finding is NOT docked for a TX candidate's location conflict", () => {
  const artifacts = [
    { kind: "address", value: "Rocklin, CA", source: "A", metadata: { cluster_id: "c1", residence: "Rocklin, CA" } },
    { kind: "address", value: "Austin, TX", source: "B", metadata: { cluster_id: "c2", residence: "Austin, TX" } },
  ];
  // Thread-wide, the two distinct locations look like a high-severity conflict…
  assertEquals(detectContradictions(artifacts).some((c) => c.kind === "location_conflict"), true);
  // …but that conflict belongs to two DIFFERENT candidates. The CA finding must
  // keep its full identity strength (60), not eat the -25 high-severity dock.
  assertEquals(findingIdentity(artifacts, ["Rocklin, CA"], ["linkedin"]), 60);
});

Deno.test("advisory scoping: a CA finding is NOT docked for a TX candidate's thin_name / over_broad_username", () => {
  const artifacts = [
    { kind: "email", value: "ca@example.com", source: "A", metadata: { cluster_id: "c1" } },
    { kind: "name", value: "Bob", source: "B", metadata: { cluster_id: "c2" } }, // thin_name (unrelated candidate)
    { kind: "username", value: "shadow", source: "C", metadata: { cluster_id: "c2", platforms_confirmed: 40 } }, // over_broad (unrelated)
  ];
  // Those advisory signals exist thread-wide…
  const wide = detectContradictions(artifacts);
  assertEquals(wide.some((c) => c.kind === "thin_name"), true);
  assertEquals(wide.some((c) => c.kind === "over_broad_username"), true);
  // …but they belong to c2, so the c1 finding is untouched.
  assertEquals(findingIdentity(artifacts, ["ca@example.com"], ["linkedin"]), 60);
});

Deno.test("genuine conflict still fires: a self-contradiction WITHIN the finding's cluster still docks", () => {
  // Cross-state (CA vs CO), not same-state-different-city (Sacramento is also
  // CA) — after #194, location_conflict only fires HIGH on a genuine state
  // mismatch, so the within-cluster fixture must actually cross a state line
  // to exercise a real conflict here.
  const artifacts = [
    { kind: "address", value: "Rocklin, CA", source: "A", metadata: { cluster_id: "c1", residence: "Rocklin, CA" } },
    { kind: "employer", value: "Acme", source: "B", metadata: { cluster_id: "c1", based: "Denver, CO" } },
    { kind: "address", value: "Austin, TX", source: "C", metadata: { cluster_id: "c2", residence: "Austin, TX" } },
  ];
  // The finding cites the CA address; scope pulls in its c1 sibling, which
  // carries a CONFLICTING within-candidate location. That real self-conflict
  // must still dock identity by the high-severity 25 (60 → 35) — and only once
  // (the c2 Austin location must not add a second dock).
  assertEquals(findingIdentity(artifacts, ["Rocklin, CA"], ["linkedin"]), 35);
});

Deno.test("conservative fallback: an unresolvable finding keeps the thread-wide penalty", () => {
  const artifacts = [
    { kind: "address", value: "Rocklin, CA", source: "A", metadata: { cluster_id: "c1", residence: "Rocklin, CA" } },
    { kind: "address", value: "Austin, TX", source: "B", metadata: { cluster_id: "c2", residence: "Austin, TX" } },
  ];
  // Finding cites nothing that resolves → we can't attribute a cluster, so we
  // must NOT silently inflate confidence: the thread-wide dock still applies.
  assertEquals(findingIdentity(artifacts, [], ["linkedin"]), 35);
  assertEquals(findingIdentity(artifacts, ["no-such-value"], ["linkedin"]), 35);
});

Deno.test("unclustered thread: a genuine self-conflict is retained (thread-wide fallback, no inflation)", () => {
  const artifacts = [
    { kind: "address", value: "Rocklin, CA", source: "A", metadata: { residence: "Rocklin, CA" } },
    { kind: "address", value: "Austin, TX", source: "B", metadata: { residence: "Austin, TX" } },
  ];
  // Cited artifact carries NO cluster_id → we cannot attribute candidates, so the
  // scope must fall back to the FULL thread set (both rows). Narrowing to the
  // cited row alone would silently drop the Rocklin/Austin conflict and inflate.
  const scoped = artifactsForFinding(artifacts, ["Rocklin, CA"]);
  assertEquals(scoped.length, 2);
});

Deno.test("clustered finding: excludes a DIFFERENT candidate cluster but keeps unclustered siblings", () => {
  const artifacts = [
    { kind: "address", value: "Rocklin, CA", source: "A", metadata: { cluster_id: "c1", residence: "Rocklin, CA" } },
    { kind: "email", value: "sib@example.com", source: "S", metadata: {} }, // unclustered sibling
    { kind: "address", value: "Austin, TX", source: "B", metadata: { cluster_id: "c2", residence: "Austin, TX" } }, // different candidate
  ];
  const scoped = artifactsForFinding(artifacts, ["Rocklin, CA"]);
  const vals = scoped.map((a) => a.value).sort();
  // c1 cited + unclustered sibling kept; the c2 candidate is excluded.
  assertEquals(vals, ["Rocklin, CA", "sib@example.com"]);
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
