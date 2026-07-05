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
