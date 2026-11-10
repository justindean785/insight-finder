/**
 * evidence-record-expand.test.ts — the chat shows the whole finding behind a
 * cut-off Evidence Record line, and nothing else changes.
 *
 * The pins run the REAL edge renderer (lib/evidence-record.ts is import-free, the
 * seam evidence-record-ladder-pin.test.ts already uses) so the frontend's copy of
 * the sanitizing rules and the 300-character cut cannot drift from it silently.
 * All values are synthetic.
 */
import { describe, expect, it } from "vitest";
import {
  buildEvidenceRecord,
  EVIDENCE_RECORD_HEADING as EDGE_HEADING,
} from "../../supabase/functions/osint-agent/lib/evidence-record";
import {
  buildFindingFullText,
  EVIDENCE_RECORD_HEADING,
  evidenceRecordExpandDisabled,
  expandEvidenceRecordLines,
  RECORD_VALUE_MAX_CHARS,
  sanitizeRecordValue,
  STORED_CAP_NOTE,
} from "@/lib/evidence-record-expand";

const LONG =
  "The handle quiet-wren-08 on social.example.com belongs to the subject: the profile [verified] lists " +
  "subject@example.com | its creation date matches the breach row\u0007 registered to that address, and the bio " +
  "names the same city.   Two independent sources agree; a third (a broker listing) is weaker and is not relied on " +
  "here. Further detail that pushes this well past three hundred characters so the record has to cut it short.";

const finding = (id: string, value: string, confidence = 48) => ({
  id, kind: "finding", value, confidence, metadata: {},
});

function edgeRecord(rows: unknown[]): string {
  return buildEvidenceRecord({
    rows,
    totalArtifactCount: rows.length,
    retrieval: "complete",
    reviews: "applied",
    rejectedFindingCount: 0,
  });
}

const report = (record: string) => `## Findings\n\nSome narrative text.\n\n${record}\n`;

describe("pinned to the edge renderer", () => {
  it("uses the same heading", () => {
    expect(EVIDENCE_RECORD_HEADING).toBe(EDGE_HEADING);
  });

  it("the edge cuts a long finding at exactly the prefix the index keys on", () => {
    const record = edgeRecord([finding("f1", LONG)]);
    const line = record.split("\n").find((l) => l.startsWith("- "))!;
    expect(line).toMatch(/… — 48% — Weak$/);
    const stored = line.slice(2, line.indexOf("… — "));
    expect(stored).toHaveLength(RECORD_VALUE_MAX_CHARS);
    expect(stored).toBe(sanitizeRecordValue(LONG).slice(0, RECORD_VALUE_MAX_CHARS));
  });
});

describe("expandEvidenceRecordLines", () => {
  it("replaces a cut line with the finding's full sanitized value, keeping the engine's percent and tier", () => {
    const prose = report(edgeRecord([finding("f1", LONG)]));
    const out = expandEvidenceRecordLines(prose, buildFindingFullText([finding("f1", LONG)]));
    expect(out).toContain(`- ${sanitizeRecordValue(LONG)} — 48% — Weak`);
    expect(out).not.toContain("… — 48%");
    // The full value is sanitized the same way: no table pipe, no bracketed label.
    const line = out.split("\n").find((l) => l.startsWith("- "))!;
    expect(line).not.toMatch(/\|/);
    expect(line).not.toMatch(/\[/);
  });

  it("leaves the stored message untouched when nothing matches", () => {
    const prose = report(edgeRecord([finding("f1", LONG)]));
    expect(expandEvidenceRecordLines(prose, buildFindingFullText([]))).toBe(prose);
    expect(expandEvidenceRecordLines(prose, null)).toBe(prose);
  });

  it("never guesses: two findings sharing the cut prefix leave the line as stored", () => {
    const a = finding("a", LONG + " Ending A.");
    const b = finding("b", LONG + " Ending B.");
    const prose = report(edgeRecord([a]));
    expect(expandEvidenceRecordLines(prose, buildFindingFullText([a, b]))).toBe(prose);
  });

  it("only reads finding rows", () => {
    const prose = report(edgeRecord([finding("f1", LONG)]));
    const notAFinding = { id: "x", kind: "other", value: LONG, confidence: 48, metadata: {} };
    expect(expandEvidenceRecordLines(prose, buildFindingFullText([notAFinding]))).toBe(prose);
  });

  it("only touches lines inside the Evidence Record block", () => {
    const cut = sanitizeRecordValue(LONG).slice(0, RECORD_VALUE_MAX_CHARS);
    const narrativeLine = `- ${cut}… — 48% — Weak`;
    const prose = `## Notes\n\n${narrativeLine}\n\n${edgeRecord([finding("f1", LONG)])}\n\n## After\n\n${narrativeLine}\n`;
    const out = expandEvidenceRecordLines(prose, buildFindingFullText([finding("f1", LONG)]));
    const lines = out.split("\n");
    expect(lines.filter((l) => l === narrativeLine)).toHaveLength(2); // before and after the block
    expect(lines.filter((l) => l.startsWith(`- ${sanitizeRecordValue(LONG)} —`))).toHaveLength(1);
  });

  it("says when the stored finding itself was cut at the 500-character record cap", () => {
    const atCap = (LONG + " " + "More detail. ".repeat(40)).slice(0, 500);
    const out = expandEvidenceRecordLines(report(edgeRecord([finding("f1", atCap)])), buildFindingFullText([finding("f1", atCap)]));
    expect(out).toContain(STORED_CAP_NOTE);
  });

  it("does not expand a short finding (nothing was cut)", () => {
    const short = finding("s", "A short finding that fits.");
    const prose = report(edgeRecord([short]));
    expect(expandEvidenceRecordLines(prose, buildFindingFullText([short]))).toBe(prose);
  });
});

describe("kill switch", () => {
  it("reads VITE_EVIDENCE_RECORD_EXPAND_DISABLED", () => {
    expect(evidenceRecordExpandDisabled({})).toBe(false);
    expect(evidenceRecordExpandDisabled({ VITE_EVIDENCE_RECORD_EXPAND_DISABLED: "true" })).toBe(true);
    expect(evidenceRecordExpandDisabled({ VITE_EVIDENCE_RECORD_EXPAND_DISABLED: "false" })).toBe(false);
  });
});
