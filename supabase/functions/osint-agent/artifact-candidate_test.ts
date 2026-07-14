// deno-lint-ignore no-import-prefix no-unversioned-import
import { assertEquals } from "jsr:@std/assert";

import type { ArtifactCandidate } from "./artifact-candidate.ts";
import { toPersistenceRow } from "./artifact-candidate.ts";

function candidate(overrides: Partial<ArtifactCandidate> = {}): ArtifactCandidate {
  return {
    kind: "email",
    value: "alice@example.com",
    source: "breach_check",
    sourceUrl: null,
    discoveredVia: "test fixture",
    rationale: "Observed in test data",
    confidence: 72,
    metadata: {},
    autoRecorded: false,
    ...overrides,
  };
}

Deno.test("candidate rejects process telemetry", () => {
  for (const kind of [
    "cluster_decision",
    "triage_summary",
    "tool_failure",
    "risk_assessment",
    "pivot_decision",
    "run_health",
  ]) {
    assertEquals(toPersistenceRow(candidate({ kind })), null);
  }
});

Deno.test("candidate preserves raw display value and normalized identity", () => {
  assertEquals(
    toPersistenceRow(candidate({ kind: "email", value: " A@EXAMPLE.COM " })),
    {
      kind: "email",
      value: " A@EXAMPLE.COM ",
      normalized_value: "a@example.com",
      confidence: 60,
      source: "breach_check",
      evidence_tool_name: "breach_check",
      evidence_source: "breach_check",
      metadata: {
        auto_recorded: false,
        source_url: null,
        discovered_via: "test fixture",
        rationale: "Observed in test data",
        source_category: ["breach"],
        query_types: ["email", "username", "domain"],
        status: "observed",
        cluster_id: null,
        reason_for_confidence: "single source class: breach",
        reason_not_confirmed: "needs second independent class of evidence",
        contradictions: [],
        next_verification_step: null,
        confidence_cap_applied: 60,
      },
    },
  );
});

Deno.test("candidate repairs unverifiable provenance without inventing a provider", () => {
  assertEquals(
    toPersistenceRow(candidate({
      source: "totally-made-up.example",
      metadata: { note: "Source was asserted in reasoning, not fetched." },
    })),
    {
      kind: "email",
      value: "alice@example.com",
      normalized_value: "alice@example.com",
      confidence: 50,
      source: "totally-made-up.example",
      evidence_tool_name: "llm_asserted_unverified",
      evidence_source: "llm_asserted_unverified",
      metadata: {
        auto_recorded: false,
        source_url: null,
        discovered_via: "test fixture",
        rationale: "Observed in test data",
        note: "Source was asserted in reasoning, not fetched.",
        source_category: ["unknown"],
        query_types: ["email", "username", "domain"],
        status: "observed",
        cluster_id: null,
        reason_for_confidence: "single source class: unknown",
        reason_not_confirmed: "needs second independent class of evidence",
        contradictions: [],
        next_verification_step: null,
        confidence_cap_applied: 50,
        provenance: "llm_asserted_unverified",
        provenance_verified: false,
      },
    },
  );
});

Deno.test("candidate recognizes a whitelisted seed domain without changing artifact source", () => {
  const row = toPersistenceRow(
    candidate({ source: "seed.example" }),
    { recognizedDomains: ["seed.example"] },
  );

  assertEquals(row?.source, "seed.example");
  assertEquals(row?.evidence_tool_name, "seed.example");
  assertEquals(row?.evidence_source, "seed.example");
  assertEquals(row?.metadata.provenance, undefined);
  assertEquals(row?.metadata.provenance_verified, undefined);
});

Deno.test("candidate flags a bare domain when no recognition context is supplied", () => {
  const row = toPersistenceRow(candidate({ source: "seed.example" }));

  assertEquals(row?.source, "seed.example");
  assertEquals(row?.evidence_tool_name, "llm_asserted_unverified");
  assertEquals(row?.evidence_source, "llm_asserted_unverified");
  assertEquals(row?.metadata.provenance, "llm_asserted_unverified");
  assertEquals(row?.metadata.provenance_verified, false);
});

Deno.test("candidate rejects an invented artifact kind", () => {
  assertEquals(toPersistenceRow(candidate({ kind: "invented_identity_fact" })), null);
});

Deno.test("candidate preserves an inferred taxonomy kind", () => {
  const row = toPersistenceRow(candidate({
    kind: "username",
    value: "Jane Doe",
    source: "minimax_web_search",
  }));

  assertEquals(row?.kind, "name");
  assertEquals(row?.value, "Jane Doe");
  assertEquals(row?.normalized_value, "jane doe");
  assertEquals(row?.metadata.reclassified_from, "username");
});

Deno.test("candidate rejects a validator reclassification outside the strict taxonomy", () => {
  assertEquals(
    toPersistenceRow(candidate({
      kind: "person",
      value: "Subject 123",
      source: "minimax_web_search",
    })),
    null,
  );
});
