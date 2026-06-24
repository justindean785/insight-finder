// Integration regression — the BACKEND half of the chain where the original bug
// surfaced: safety scrub + evidence-cap/source-classification, proven together on
// a small, fully synthetic, NON-SENSITIVE fixture. No live tools, no network, no
// real-person seed. Pairs with src/test/integrity-report-fixture.test.ts, which
// covers the report-render half (buildReportMarkdown) over the same fixture values.
//
// Mirrors what record_artifacts does per artifact in production:
//   applyEvidenceCaps(source) -> write source_category/reason/cap into metadata
//   -> scrubArtifactRow(row)
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyEvidenceCaps } from "./confidence.ts";
import { scrubArtifactRow } from "./safety.ts";

interface FixtureArtifact {
  kind: string;
  value: string;
  source: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

function recordLikeBackend(a: FixtureArtifact) {
  const aMeta = a.metadata ?? {};
  const cap = applyEvidenceCaps({
    rawConfidence: a.confidence ?? 50,
    sources: [a.source, ...((aMeta.sources as string[]) ?? [])].filter(Boolean),
  });
  const row: Record<string, unknown> = {
    kind: a.kind,
    value: a.value,
    confidence: cap.confidence,
    source: a.source,
    metadata: {
      ...aMeta,
      source_category: cap.source_classes,
      reason_for_confidence: cap.reason_for_confidence,
      confidence_cap_applied: cap.cap,
    },
  };
  return { cap, scrubbed: scrubArtifactRow(row) };
}

Deno.test("fixture(backend): date-like DOB does not trip the minor-safety scrubber", () => {
  // Synthetic date — the month "10" must NOT be read as a minor's age.
  const { cap, scrubbed } = recordLikeBackend({
    kind: "other",
    value: "1958-10-11",
    source: "leakcheck_lookup/Acme breach",
    metadata: { original_kind: "dob", cluster_id: "cluster-syn" },
  });
  const m = scrubbed.metadata as Record<string, unknown>;
  assertEquals(m.possible_minor, undefined);
  assertEquals(m.minor_warning, undefined);
  assertEquals(m.auto_pivot_blocked, undefined);
  assert(!Array.isArray(m.minor_signals), "no bare-10 minor signal");
  // The minor cap (<=35) must NOT have clamped the evidence-cap confidence.
  assertEquals(scrubbed.confidence, cap.confidence);
  assert((scrubbed.confidence as number) > 35);
});

Deno.test("fixture(backend): compound breach source classifies as breach, not unknown", () => {
  const { cap } = recordLikeBackend({
    kind: "email",
    value: "qa.fixture@example.com", // synthetic, non-real
    source: "breach_check+leakcheck+oathnet_lookup+deepfind_email_breach+serus_darkweb_scan",
  });
  assert(cap.source_classes.includes("breach"), `expected breach, got ${cap.source_classes.join(",")}`);
  assert(!cap.source_classes.includes("unknown"), "unknown must not survive once breach is present");
  assert(
    !cap.reason_for_confidence.includes("single source class: unknown"),
    cap.reason_for_confidence,
  );
  assert(cap.cap >= 60, `breach cap expected >= 60, got ${cap.cap}`);
});

Deno.test("fixture(backend): a real age cue still flags (detection not weakened)", () => {
  // Guard rail: the DOB fix must not silence genuine minor-age signals.
  const { scrubbed } = recordLikeBackend({
    kind: "social",
    value: "qa_fixture_handle",
    source: "username_sweep",
    metadata: { bio: "fan account, age 15" },
  });
  assertEquals((scrubbed.metadata as Record<string, unknown>).possible_minor, true);
});
