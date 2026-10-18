import {
  assertEquals,
  assertStrictEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyEvidenceCapsLegacyOccurrenceBaseline } from "../../functions/osint-agent/confidence.ts";
import {
  applyRecordingSourcePolicy,
  resolveRecordingStatus,
} from "../../functions/osint-agent/recording-source-policy.ts";

Deno.test("metadata property prose cannot promote an AI-summary surface", () => {
  const result = applyRecordingSourcePolicy({
    rawConfidence: 95,
    source: "minimax_web_search",
    kind: "weak_lead",
    metadata: { source: "Placer County Recorder" },
  });

  assertEquals(result.surfaceOnly.cap, 55);
  assertEquals(result.withMetadata.cap, 95);
  assertEquals(result.effective.cap, 55);
  assertEquals(result.effective.confidence, 55);
  assertEquals(result.effective.source_classes, ["ai_summary"]);
});

for (const corpusName of ["Twitter scraping 2022", "Foodora 2016"]) {
  Deno.test(`metadata breach corpus ${corpusName} preserves its 65 to 60 demotion`, () => {
    const result = applyRecordingSourcePolicy({
      rawConfidence: 95,
      source: "breach_check+oathnet_lookup",
      kind: "breach_exposure",
      metadata: { source: corpusName },
    });

    assertEquals(result.surfaceOnly.cap, 65);
    assertEquals(result.withMetadata.cap, 60);
    assertEquals(result.effective.cap, 60);
    assertEquals(result.effective.source_classes, ["breach", "unknown"]);
  });
}

Deno.test("compound authoritative surface retains all production source classes", () => {
  const result = applyRecordingSourcePolicy({
    rawConfidence: 95,
    source: "minimax_web_search + jina_reader_scrape + socialfetch_web_read",
    kind: "username",
    metadata: null,
  });

  assertEquals(result.surfaceOnly.source_classes, [
    "ai_summary",
    "independent_public",
    "social_profile_active",
  ]);
  assertEquals(
    result.effective.source_classes,
    result.surfaceOnly.source_classes,
  );
});

Deno.test("metadata breach slug contributes no upward authority", () => {
  const result = applyRecordingSourcePolicy({
    rawConfidence: 95,
    source: "minimax_web_search",
    kind: "weak_lead",
    metadata: { source: "breach_check" },
  });

  assertEquals(result.surfaceOnly.cap, 55);
  assertEquals(result.withMetadata.cap, 65);
  assertEquals(result.effective.cap, 55);
  assertEquals(result.effective.source_classes, ["ai_summary"]);
});

Deno.test("one logical breach provenance cannot satisfy the two-source rule twice", () => {
  const result = applyRecordingSourcePolicy({
    rawConfidence: 95,
    source: "breach_check",
    kind: "breach_exposure",
    metadata: { source: "breach_check", sources: ["breach_check"] },
  });

  assertEquals(result.surfaceOnly.cap, 60);
  assertEquals(result.withMetadata.cap, 60);
  assertEquals(result.effective.cap, 60);
  assertEquals(result.effective.source_classes, ["breach"]);
});

for (const separator of ["+", ",", "/", "|", ";", " and "]) {
  Deno.test(`recording policy counts a repeated breach tool through ${JSON.stringify(separator)} once`, () => {
    const result = applyRecordingSourcePolicy({
      rawConfidence: 95,
      source: `breach_check${separator} BREACH_CHECK`,
      kind: "breach_exposure",
      metadata: null,
    });
    assertEquals(result.effective.cap, 60);
    assertEquals(result.effective.source_classes, ["breach"]);
  });
}

Deno.test("recording policy canonicalizes leakcheck alias across source channels", () => {
  const result = applyRecordingSourcePolicy({
    rawConfidence: 95,
    source: "leakcheck",
    kind: "breach_exposure",
    metadata: { source: "leakcheck_lookup" },
  });
  assertEquals(result.surfaceOnly.cap, 60);
  assertEquals(result.withMetadata.cap, 60);
  assertEquals(result.effective.cap, 60);
});

Deno.test("recording policy canonicalizes leakcheck alias inside a compound", () => {
  const result = applyRecordingSourcePolicy({
    rawConfidence: 95,
    source: "leakcheck+leakcheck_lookup",
    kind: "breach_exposure",
    metadata: null,
  });
  assertEquals(result.effective.cap, 60);
  assertEquals(result.effective.source_classes, ["breach"]);
});

Deno.test("recording policy keeps distinct DeepFind tool executions distinct", () => {
  const result = applyRecordingSourcePolicy({
    rawConfidence: 95,
    source: "deepfind_reverse_email+deepfind_email_breach",
    kind: "breach_exposure",
    metadata: null,
  });
  assertEquals(result.effective.cap, 65);
  assertEquals(result.effective.source_classes, ["breach"]);
});

Deno.test("one duplicated metadata breach slug cannot promote an absent authority channel", () => {
  const result = applyRecordingSourcePolicy({
    rawConfidence: 95,
    source: null,
    kind: "breach_exposure",
    metadata: { source: "breach_check", sources: ["breach_check"] },
  });

  assertEquals(result.surfaceOnly.cap, 50);
  assertEquals(result.withMetadata.cap, 60);
  assertEquals(result.effective.cap, 50);
  assertEquals(result.effective.source_classes, []);
});

Deno.test("surface-only wins cap ties", () => {
  const result = applyRecordingSourcePolicy({
    rawConfidence: 95,
    source: "minimax_web_search",
    kind: "weak_lead",
    metadata: { source: "opaque model-authored label" },
  });

  assertEquals(result.surfaceOnly.cap, 55);
  assertEquals(result.withMetadata.cap, 55);
  assertEquals(result.withMetadata.source_classes, ["ai_summary", "unknown"]);
  assertStrictEquals(result.effective, result.surfaceOnly);
});

Deno.test("recording status gives model reason_not_confirmed precedence", () => {
  const cap = applyEvidenceCapsLegacyOccurrenceBaseline({
    rawConfidence: 95,
    sources: ["pacer_docket", "reuters"],
  });
  const result = resolveRecordingStatus(cap, {
    status: "verified",
    reason_not_confirmed: "analyst confirmation is still required",
  });

  assertEquals(
    result.reasonNotConfirmed,
    "analyst confirmation is still required",
  );
  assertEquals(result.status, "needs_corroboration");
});

for (const emptyReason of ["", "   ", "\n\t"]) {
  Deno.test(`empty model reason ${JSON.stringify(emptyReason)} cannot erase a weak-source cap gap`, () => {
    const policy = applyRecordingSourcePolicy({
      rawConfidence: 95,
      source: "minimax_web_search",
      kind: "weak_lead",
      metadata: { status: "verified", reason_not_confirmed: emptyReason },
    });
    const result = resolveRecordingStatus(policy.effective, {
      status: "verified",
      reason_not_confirmed: emptyReason,
    });

    assertEquals(policy.effective.cap, 55);
    assertEquals(
      result.reasonNotConfirmed,
      "needs second independent class of evidence",
    );
    assertEquals(result.status, "observed");
  });
}

Deno.test("recording status applies contradictions from metadata", () => {
  const cap = applyEvidenceCapsLegacyOccurrenceBaseline({
    rawConfidence: 95,
    sources: ["pacer_docket", "reuters"],
  });
  const result = resolveRecordingStatus(cap, {
    contradictions: [{ field: "identity" }],
  });

  assertEquals(result.reasonNotConfirmed, null);
  assertEquals(result.status, "contradicted");
});

Deno.test("recording status honors exhausted only for a real dead end", () => {
  const cap = applyEvidenceCapsLegacyOccurrenceBaseline({
    rawConfidence: 95,
    sources: ["minimax_web_search"],
  });

  assertEquals(
    resolveRecordingStatus(cap, { status: "exhausted", http_status: 404 })
      .status,
    "exhausted",
  );
  assertEquals(
    resolveRecordingStatus(cap, { status: "exhausted" }).status,
    "needs_corroboration",
  );
});

Deno.test("equal cap ceilings can still produce different recording statuses", () => {
  const cap = applyEvidenceCapsLegacyOccurrenceBaseline({
    rawConfidence: 95,
    sources: ["pacer_docket", "reuters"],
  });
  const confirmed = resolveRecordingStatus(cap, null);
  const constrained = resolveRecordingStatus(cap, {
    reason_not_confirmed: "selector ownership is unresolved",
  });

  assertEquals(cap.cap, 95);
  assertEquals(confirmed.status, "confirmed");
  assertEquals(constrained.status, "needs_corroboration");
});
