import { describe, it, expect } from "vitest";
import { buildReportMarkdown, buildEvidenceMatrixMarkdown } from "@/lib/intel";
import { redactionFor, buildEvidenceViews } from "@/lib/exclusion";
import {
  REDACTED_COLLISION_PLACEHOLDER,
  REDACTED_MINOR_PLACEHOLDER,
  isRuledOutNamesake,
} from "@/lib/artifact-exclusion";
import type { Artifact } from "@/hooks/useThreadArtifacts";

const art = (over: Partial<Artifact> & { id: string }): Artifact => ({
  kind: "email",
  value: "a@b.com",
  confidence: 60,
  source: "whois",
  created_at: "2026-08-01T00:00:00.000Z",
  metadata: null,
  ...over,
});

// ---------------------------------------------------------------------------
// The ruled-out-namesake redaction class.
//
// The case that motivated it, from a live run: the investigation identified a
// second "Joseph Michael Schott" in Santa Maria and correctly EXCLUDED him,
// citing his phone number as the discriminator. That number then sat in the
// dossier — the selector of a named third party the investigation had
// affirmatively determined is NOT the subject.
//
// The row must stay (it records that the collision was found and resolved) and
// the reason must stay (it is the audit trail). The raw selector is masked.
//
// TWO PATHS reach the report and only one of them is the appendix: a namesake
// carries `excluded_collision`, whose exclusion reason is `collision`, and
// `REPORT_EXCLUSION_REASONS` deliberately omits `collision` so those rows land
// in "Collision / Likely Unrelated" instead. Both paths are asserted below;
// fixing only the appendix would have left the real leak open.
// ---------------------------------------------------------------------------

const NAMESAKE_PHONE = "8054409318";
const namesake = art({
  id: "namesake",
  kind: "excluded_collision",
  value: NAMESAKE_PHONE,
  source: "oathnet_lookup",
  metadata: { excluded_collision: true, reason: "different person — Santa Maria OT" },
});
const subject = art({ id: "subject", kind: "email", value: "basketballbsk4@yahoo.com", confidence: 60 });

const report = (artifacts: Artifact[]) =>
  buildReportMarkdown({ seedValue: "basketballbsk4@yahoo.com", seedType: "email", artifacts });

describe("ruled-out namesake — the primitive", () => {
  it("recognises a decided negative", () => {
    expect(isRuledOutNamesake(namesake)).toBe(true);
    expect(isRuledOutNamesake({ kind: "phone", metadata: { status: "excluded" } })).toBe(true);
    expect(isRuledOutNamesake({ kind: "phone", metadata: { excluded_collision: true } })).toBe(true);
  });

  it("does NOT mask an unresolved conflict", () => {
    // `collision` / `possible_collision` mean the question is still open. That
    // row may yet be the subject's, so masking it would hide live evidence.
    expect(isRuledOutNamesake({ kind: "phone", metadata: { collision: true } })).toBe(false);
    expect(isRuledOutNamesake({ kind: "phone", metadata: { possible_collision: true } })).toBe(false);
    expect(isRuledOutNamesake({ kind: "phone", metadata: null })).toBe(false);
  });
});

describe("ruled-out namesake — precedence", () => {
  it("masks a ruled-out namesake with its own placeholder", () => {
    const r = redactionFor(namesake);
    expect(r.redactionClass).toBe("ruled_out_namesake");
    expect(r.displayValue).toBe(REDACTED_COLLISION_PLACEHOLDER);
  });

  it("MINOR SAFETY WINS when a row is both", () => {
    // The stronger obligation, and the note the analyst must see. If this ever
    // inverts, a child's identifier would be labelled "ruled out".
    const both = art({
      id: "both",
      kind: "excluded_collision",
      value: "child@example.com",
      metadata: { excluded_collision: true, possible_minor: true },
    });
    const r = redactionFor(both);
    expect(r.redactionClass).toBe("possible_minor");
    expect(r.displayValue).toBe(REDACTED_MINOR_PLACEHOLDER);
  });

  it("leaves an ordinary excluded row's value intact", () => {
    const plain = art({ id: "plain", value: "kept@example.com", metadata: null });
    expect(redactionFor(plain).redactionClass).toBe("none");
    expect(redactionFor(plain).displayValue).toBe("kept@example.com");
  });
});

describe("ruled-out namesake — the report never prints the selector", () => {
  it("masks it in the Collision / Likely Unrelated section", () => {
    const md = report([subject, namesake]);
    expect(md).toContain(REDACTED_COLLISION_PLACEHOLDER);
    expect(md).toMatch(/value withheld — ruled out as not the subject/);
  });

  it("LEAK CHECK: the raw value appears nowhere in the whole document", () => {
    // The assertion that actually matters. Section-scoped checks miss a leak
    // through the artifact table, timeline, network or matrix.
    expect(report([subject, namesake])).not.toContain(NAMESAKE_PHONE);
  });

  it("keeps the row and its reason — this is an audit record, not a deletion", () => {
    const md = report([subject, namesake]);
    const section = md.slice(md.indexOf("## Collision / Likely Unrelated"));
    expect(section).not.toMatch(/_No collisions flagged\._/);
    expect(md).toMatch(/namesakes \/ unrelated entities/i);
  });

  it("masks it in the standalone evidence matrix appendix too", () => {
    const matrix = buildEvidenceMatrixMarkdown([subject, namesake], undefined, {
      includeExcludedAppendix: true,
    });
    expect(matrix).not.toContain(NAMESAKE_PHONE);
  });

  it("still prints an UNRESOLVED conflict's value", () => {
    // Guard against over-redaction: masking everything would be its own defect.
    const unresolved = art({
      id: "unresolved",
      kind: "phone",
      value: "5595550101",
      metadata: { collision: true },
    });
    const md = report([subject, unresolved]);
    expect(md).toContain("5595550101");
  });
});

describe("ruled-out namesake — the minor path is unchanged", () => {
  it("still redacts a rejected possible-minor row with the minor placeholder", () => {
    const minor = art({
      id: "minor",
      kind: "email",
      value: "child@example.com",
      metadata: { possible_minor: true, status: "excluded" },
    });
    const views = buildEvidenceViews([minor]);
    expect(views.excludedArtifacts[0].redactionClass).toBe("possible_minor");
    expect(views.excludedArtifacts[0].displayValue).toBe(REDACTED_MINOR_PLACEHOLDER);
    expect(report([subject, minor])).not.toContain("child@example.com");
  });
});
