import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { applyDateSanity, isHarmBearing } from "./date-sanity.ts";

const NOW = "2026-06-19T07:34:54.899Z";

// ---------------------------------------------------------------------------
// isHarmBearing
// ---------------------------------------------------------------------------

Deno.test("isHarmBearing: legal_record kind → true", () => {
  assertEquals(isHarmBearing("legal_record", "anything"), true);
});

Deno.test("isHarmBearing: generic kind but arrest in value → true", () => {
  assertEquals(isHarmBearing("other", "Miami Beach arrest - attempted strongarm robbery charge"), true);
});

Deno.test("isHarmBearing: benign artifact → false", () => {
  assertEquals(isHarmBearing("username", "deenthegreat"), false);
});

// ---------------------------------------------------------------------------
// applyDateSanity — the reported bug: a PAST date carrying a false
// "Future date detected" note on a legal_record.
// ---------------------------------------------------------------------------

Deno.test("past date does NOT get a future-date warning", () => {
  const r = applyDateSanity("legal_record", "Miami Beach arrest", { date_reported: "2026-05-27" }, NOW);
  assertEquals(r.changed, true);
  assertEquals(r.metaPatch.future_date_detected, false);
  assertEquals(r.metaPatch.date_sanity_status, "ok");
});

Deno.test("false model-authored future-date note is neutralized on a past-dated legal record", () => {
  const r = applyDateSanity(
    "legal_record",
    "Miami Beach arrest - attempted strongarm robbery charge",
    { date_reported: "2026-05-27", note: "Future date detected - possible test/synthetic data" },
    NOW,
  );
  assertEquals(r.metaPatch.future_date_detected, false);
  assertEquals(r.metaPatch.date_note_corrected, true);
  // The false future-date sentence is removed; provenance preserved.
  assertEquals(r.metaPatch.note, "");
  assertEquals(r.metaPatch.prior_note, "Future date detected - possible test/synthetic data");
});

Deno.test("a genuinely future date DOES get a structured warning", () => {
  const r = applyDateSanity("legal_record", "arrest", { date_reported: "2026-07-01" }, NOW);
  assertEquals(r.metaPatch.future_date_detected, true);
  assertEquals(r.metaPatch.date_sanity_status, "future_date");
});

Deno.test("today's date is not classified as future", () => {
  const r = applyDateSanity("legal_record", "arrest", { date_reported: "2026-06-19" }, NOW);
  assertEquals(r.metaPatch.future_date_detected, false);
  assertEquals(r.metaPatch.date_sanity_status, "ok");
});

Deno.test("ambiguous date (no parseable date field) stays conservative — no future/past assertion", () => {
  const r = applyDateSanity("legal_record", "arrest", { note: "some context, no date" }, NOW);
  // No future-date note and no date → nothing to do.
  assertEquals(r.changed, false);
  assertEquals(Object.keys(r.metaPatch).length, 0);
});

Deno.test("ambiguous date WITH a false future-date note → marked unknown, not 'past'", () => {
  const r = applyDateSanity("legal_record", "arrest", { note: "Future date detected" }, NOW);
  assertEquals(r.metaPatch.date_sanity_status, "unknown");
  // Must NOT assert future_date_detected either way when the date is unknown.
  assertEquals("future_date_detected" in r.metaPatch, false);
});

Deno.test("non-harm-bearing record is never touched, even with a future date", () => {
  const r = applyDateSanity("username", "deenthegreat", { date_reported: "2030-01-01", note: "Future date detected" }, NOW);
  assertEquals(r.changed, false);
  assertEquals(Object.keys(r.metaPatch).length, 0);
});

Deno.test("a past-dated record with a non-future note leaves the note intact", () => {
  const r = applyDateSanity("legal_record", "arrest", { date_reported: "2026-01-01", note: "Bond set at $2,500" }, NOW);
  assertEquals(r.metaPatch.future_date_detected, false);
  assertEquals(r.metaPatch.date_sanity_status, "ok");
  // No future-date claim present → note untouched, no correction flag.
  assertEquals("note" in r.metaPatch, false);
  assertEquals("date_note_corrected" in r.metaPatch, false);
});

Deno.test("multi-sentence note: only the future-date sentence is removed", () => {
  const r = applyDateSanity(
    "legal_record",
    "arrest",
    { date_reported: "2026-05-27", note: "Bond set at $2,500. Future date detected - synthetic." },
    NOW,
  );
  assertEquals(r.metaPatch.note, "Bond set at $2,500.");
  assertEquals(r.metaPatch.date_note_corrected, true);
});

// ── #9: scheduling (court) date must not flag a past event as future ──
Deno.test("#9: arrest in past + court_date future → NOT flagged future", () => {
  const r = applyDateSanity(
    "legal_record",
    "Eugene Horsch — June 19 2026 arrest",
    { arrest_date: "2026-06-19", court_date: "2026-07-06" },
    "2026-06-28T00:00:00Z",
  );
  assertEquals(r.metaPatch.future_date_detected, false);
  assertEquals(r.metaPatch.date_sanity_status, "ok");
});

Deno.test("#9: only a future court_date + false future-note → corrected to ok/scheduled", () => {
  const r = applyDateSanity(
    "legal_record",
    "arrest record",
    { court_date: "2026-07-06", note: "Future date detected - possible synthetic data" },
    "2026-06-28T00:00:00Z",
  );
  assertEquals(r.metaPatch.future_date_detected, false);
  assertEquals(r.metaPatch.scheduled_future_date, true);
  assertEquals(r.metaPatch.date_sanity_status, "ok");
});

Deno.test("#9: a genuinely future EVENT (arrest_date ahead) is still flagged", () => {
  const r = applyDateSanity(
    "legal_record",
    "arrest record",
    { arrest_date: "2026-12-31" },
    "2026-06-28T00:00:00Z",
  );
  assertEquals(r.metaPatch.future_date_detected, true);
  assertEquals(r.metaPatch.date_sanity_status, "future_date");
});
