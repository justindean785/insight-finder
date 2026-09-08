/**
 * analyst-lesson-wording.test.ts — the two halves of one contract.
 *
 * The frontend writes the analyst's Wrong verdict into agent_memory as a lesson
 * (`buildFalsePositiveLesson`). The edge function's memory reader
 * (supabase/functions/osint-agent/lib/memory-supersession.ts) recognises that
 * wording — `ANALYST_FALSE_LESSON_RE` — to tell a human ruling apart from the
 * agent's own identity theories, and to let the ruling supersede them at recall.
 * Production rows already carry this text. If either side changes alone, the
 * ruling silently stops superseding anything; this test is what makes that loud.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ANALYST_FALSE_POSITIVE_MARKER, buildFalsePositiveLesson } from "@/lib/analyst-decisions";

// Copied LITERALLY from the edge module; the test below asserts the copy is current.
const EDGE_RE_SOURCE = String.raw`/^\s*analyst marked\s+".+?"(?:\s*\([^)]*\))?\s+as\s+false\s*\/\s*incorrect data/i`;
const EDGE_RE = new RegExp(
  EDGE_RE_SOURCE.slice(1, EDGE_RE_SOURCE.lastIndexOf("/")),
  EDGE_RE_SOURCE.slice(EDGE_RE_SOURCE.lastIndexOf("/") + 1),
);

describe("analyst false-positive lesson wording", () => {
  it("the edge reader's regex in this test is the one actually shipped", () => {
    const edge = readFileSync(
      resolve(process.cwd(), "supabase/functions/osint-agent/lib/memory-supersession.ts"),
      "utf8",
    );
    expect(edge).toContain(EDGE_RE_SOURCE);
  });

  it("every lesson the frontend writes is recognised by the edge reader", () => {
    for (const [value, kind] of [
      ["Diamond Nicole", "name"],
      ["dgoff1276@gmail.com", "email"],
      ["104.54.98.171 — Springfield, Missouri, US (AT&T, residential, ASN AS7018)", "infrastructure"],
      ["  diamondnicole7  ", null],
    ] as Array<[string, string | null]>) {
      const lesson = buildFalsePositiveLesson(value, kind);
      expect(lesson.kind).toBe("lesson");
      expect(lesson.confidence).toBe(95);
      expect(lesson.subject).toBe(value.trim().toLowerCase());
      expect(lesson.content).toContain(ANALYST_FALSE_POSITIVE_MARKER);
      expect(EDGE_RE.test(lesson.content)).toBe(true);
    }
  });

  it("the agent's own confident lesson is NOT mistaken for a ruling", () => {
    expect(EDGE_RE.test("Breach data shows glitterkittens12 belonged to Diamond Nicole; handle likely transferred.")).toBe(false);
    expect(EDGE_RE.test("Marked as FALSE / incorrect data by the correlate step")).toBe(false);
  });
});
