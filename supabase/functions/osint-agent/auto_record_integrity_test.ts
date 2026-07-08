import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildAutoRecordedRow } from "./auto-record-integrity.ts";

Deno.test("buildAutoRecordedRow: dork_harvest document is capped at ai_summary ceiling (55)", () => {
  const row = buildAutoRecordedRow({
    kind: "document",
    value: "https://example.com/resume.pdf",
    source: "dork_harvest",
    rawConfidence: 65,
    metadata: { seed: "test@example.com" },
  });
  assertEquals(row.confidence, 55);
  assertEquals(row.metadata.auto_recorded, true);
  assertEquals(Array.isArray(row.metadata.source_category), true);
  assertEquals(typeof row.metadata.reason_not_confirmed, "string");
  assertEquals(typeof row.metadata.status, "string");
});

Deno.test("buildAutoRecordedRow: gemini_deep_dork leak_paste respects cap", () => {
  const row = buildAutoRecordedRow({
    kind: "leak_paste",
    value: "https://pastebin.com/abc123",
    source: "gemini_deep_dork",
    rawConfidence: 60,
  });
  assertEquals(row.confidence, 55);
});

Deno.test("buildAutoRecordedRow: preserves caller metadata", () => {
  const row = buildAutoRecordedRow({
    kind: "url",
    value: "https://news.example.com/story",
    source: "gemini_deep_dork",
    rawConfidence: 55,
    metadata: { seed: "Jane Doe", focus: "breach exposure" },
  });
  assertEquals(row.metadata.seed, "Jane Doe");
  assertEquals(row.metadata.focus, "breach exposure");
});

// #119: the auto-record path must also honor the breach-metadata laundering
// guard — a breach-derived row whose surface source looks like a public record
// must be demoted to the breach cap, not recorded at public_record (75).
Deno.test("buildAutoRecordedRow: breach metadata blocks public_record laundering (#119, 5th call site)", () => {
  const row = buildAutoRecordedRow({
    kind: "email",
    value: "leaked@example.com",
    source: "opencorporates_search", // classifies public_record (cap 75) on the surface
    rawConfidence: 95,
    metadata: { breach_count: 3, breach_names: ["fling.com"] },
  });
  const classes = row.metadata.source_category as string[];
  assertEquals(classes.includes("breach"), true);
  assertEquals(classes.includes("public_record"), false);
  assertEquals(row.confidence <= 65, true);
});
