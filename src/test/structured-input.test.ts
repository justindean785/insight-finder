import { describe, it, expect } from "vitest";
import { classifyStructuredInput } from "@/lib/structured-input";
import { extractDisplaySeed, STRUCTURED_INPUT_SELECTOR } from "@/lib/seed";
import { looksLikeStructuredBlob, detectNameLocationSeed, buildReportMarkdown } from "@/lib/intel";
import type { Artifact } from "@/hooks/useThreadArtifacts";

const art = (over: Partial<Artifact> = {}): Artifact => ({
  id: "1",
  kind: "email",
  value: "a@b.com",
  confidence: 60,
  source: "whois",
  created_at: "2026-08-01T00:00:00.000Z",
  metadata: null,
  ...over,
});

// ---------------------------------------------------------------------------
// Contract 8 — staged structured-input handling.
//
// The requirement is TWO-SIDED and satisfying only one side is the regression:
//   1. a structured payload must not become a fabricated subject/person, AND
//   2. it must not silently disappear as though nothing was submitted.
// Plus: selector extraction stays separate from structured-input handling,
// provenance is preserved, arbitrary JSON keys never become identity claims,
// and malformed input is handled as conservatively as valid input.
// ---------------------------------------------------------------------------

const JSON_OBJECT = '{"module":"dhgate","schema":"module","hits":3}';
const JSON_ARRAY = '[{"module":"dhgate","schema":"module"},{"module":"x","schema":"y"}]';
const JSON_TRUNCATED = '[{"module":"dhgate","schema":"modu';
const MARKUP = '<div class="result"><span>Ronny Doe</span></div>';
const NAME_LOCATION = "John Smith, Sacramento, CA 95814";

describe("Contract 8 — stage 1: classify the shape of the submission", () => {
  it("classifies a valid JSON object, with a countable record shape", () => {
    const s = classifyStructuredInput(JSON_OBJECT);
    expect(s.structured).toBe(true);
    expect(s.form).toBe("json_object");
    expect(s.malformed).toBe(false);
    expect(s.recordCount).toBe(3);
    expect(s.summary).toContain("JSON object");
  });

  it("classifies a valid JSON array", () => {
    const s = classifyStructuredInput(JSON_ARRAY);
    expect(s.structured).toBe(true);
    expect(s.form).toBe("json_array");
    expect(s.recordCount).toBe(2);
  });

  it("treats a malformed/truncated JSON-like blob as structured, and says so", () => {
    const s = classifyStructuredInput(JSON_TRUNCATED);
    expect(s.structured).toBe(true);
    expect(s.malformed).toBe(true);
    // Conservative: unknown count rather than a guessed one.
    expect(s.recordCount).toBeNull();
    expect(s.summary).toMatch(/malformed or truncated/i);
  });

  it("classifies HTML/XML-ish markup", () => {
    const s = classifyStructuredInput(MARKUP);
    expect(s.structured).toBe(true);
    expect(s.form).toBe("markup");
  });

  it("leaves an ordinary Name, City, ST seed alone — commas are not structure", () => {
    expect(classifyStructuredInput(NAME_LOCATION).structured).toBe(false);
    expect(classifyStructuredInput(NAME_LOCATION).form).toBe("none");
  });

  it("leaves ordinary username / domain / email selectors alone", () => {
    for (const v of ["ronnydoe", "example.com", "casey.rivera@example.com", "Ronny.doe"]) {
      expect(classifyStructuredInput(v).structured).toBe(false);
    }
  });

  it("is the single implementation — looksLikeStructuredBlob delegates to it", () => {
    for (const v of [JSON_OBJECT, JSON_ARRAY, JSON_TRUNCATED, MARKUP, NAME_LOCATION, "ronnydoe"]) {
      expect(looksLikeStructuredBlob(v)).toBe(classifyStructuredInput(v).structured);
    }
  });
});

describe("Contract 8 — side 1: structured input yields no fabricated subject", () => {
  it("derives no person-name from any structured form", () => {
    for (const v of [JSON_OBJECT, JSON_ARRAY, JSON_TRUNCATED, MARKUP]) {
      expect(detectNameLocationSeed(v)).toBeNull();
    }
  });

  it("still derives a name from a legitimate free-form name+location seed", () => {
    const d = detectNameLocationSeed(NAME_LOCATION);
    expect(d).not.toBeNull();
    expect(d!.name).toBeTruthy();
  });

  it("never promotes a JSON key or value into the selector", () => {
    for (const v of [JSON_OBJECT, JSON_ARRAY, JSON_TRUNCATED, MARKUP]) {
      const d = extractDisplaySeed(v, null);
      expect(d.selector).toBe(STRUCTURED_INPUT_SELECTOR);
      for (const token of ["module", "dhgate", "schema", "result", "Ronny"]) {
        expect(d.selector).not.toContain(token);
      }
    }
  });
});

describe("Contract 8 — side 2: structured input does not silently disappear", () => {
  it("retains the structured context on the display seed", () => {
    const d = extractDisplaySeed(JSON_ARRAY, null);
    expect(d.structured).toBeDefined();
    expect(d.structured!.form).toBe("json_array");
    expect(d.title).toMatch(/^Structured input —/);
  });

  it("reports WHAT was submitted, and that no identity came from it", () => {
    const md = buildReportMarkdown({
      seedValue: JSON_ARRAY,
      seedType: "other",
      artifacts: [art({ id: "a", kind: "email", value: "kept@example.com" })],
    });
    expect(md).toContain("**Submitted input:**");
    expect(md).toMatch(/JSON array/);
    expect(md).toMatch(/no subject identity has been derived/i);
  });

  it("does not print a JSON fragment as the Selector", () => {
    const md = buildReportMarkdown({
      seedValue: JSON_ARRAY,
      seedType: "other",
      artifacts: [art({ id: "a" })],
    });
    const seedLine = md.split("\n").find((l) => l.startsWith("- **Selector:**")) ?? "";
    expect(seedLine).toContain(STRUCTURED_INPUT_SELECTOR);
    expect(seedLine).not.toContain("dhgate");
    expect(seedLine).not.toContain("{");
  });

  it("handles a malformed paste the same way as a valid one", () => {
    const md = buildReportMarkdown({
      seedValue: JSON_TRUNCATED,
      seedType: "other",
      artifacts: [art({ id: "a" })],
    });
    expect(md).toContain("**Submitted input:**");
    expect(md).toMatch(/malformed or truncated/i);
    expect(md).not.toContain("dhgate");
  });
});

describe("Contract 8 — stage 2: selector extraction stays separate and defensible", () => {
  it("extracts an explicit email from a structured payload AND keeps the provenance", () => {
    const withEmail = '{"contact":"casey.rivera@example.com","module":"dhgate"}';
    const d = extractDisplaySeed(withEmail, null);
    // Defensible selector — an explicit literal, not an inferred one.
    expect(d.selector).toBe("casey.rivera@example.com");
    expect(d.kind).toBe("email");
    // …and the payload it came out of is still recorded.
    expect(d.structured).toBeDefined();
    expect(d.structured!.form).toBe("json_object");
  });

  it("says the selector was extracted from a payload rather than submitted alone", () => {
    const md = buildReportMarkdown({
      seedValue: '{"contact":"casey.rivera@example.com","module":"dhgate"}',
      seedType: "other",
      artifacts: [art({ id: "a" })],
    });
    expect(md).toMatch(/The selector above was extracted from it/i);
  });

  it("leaves a non-structured blob's extraction path untouched", () => {
    const blob =
      "=== OATHNET INTELLIGENCE === Found via oathnet.org " +
      "email: casey.rivera@example.com phone national: 2674378035";
    const d = extractDisplaySeed(blob, "other");
    expect(d.selector).toBe("casey.rivera@example.com");
    expect(d.structured).toBeUndefined();
  });
});
