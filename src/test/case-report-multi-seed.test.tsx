import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { CaseReport } from "@/components/panel/CaseReport";
import { assessArtifacts } from "@/lib/agent-assessment";

/**
 * Stage 2 of the 2026-11-13 audit remediation. SYNTHETIC values only.
 *
 * A seed that holds several selectors ("a@example.test, b@example.test", or an
 * email and a phone) matched no row: the assessment compared each row with the
 * WHOLE seed string. With no seed row nothing was linked, so the Subject Profile
 * listed the very contacts the analyst typed as "ownership unresolved".
 *
 * JD's rulings (2026-11-14): every selector typed in the seed is the subject's
 * and reads "Supplied as the case seed"; every seed contact of a kind is shown;
 * a bare word is never a handle inside a composite seed; a selector that touches
 * the 200-character cut is dropped.
 */
type Over = Partial<{ id: string; kind: string; value: string; confidence: number; source: string; metadata: Record<string, unknown> | null }>;
const art = (over: Over) => ({
  id: over.id ?? Math.random().toString(36).slice(2), thread_id: "t1", kind: over.kind ?? "email", value: over.value ?? "x",
  source: over.source ?? "oathnet_lookup", confidence: over.confidence ?? 50,
  created_at: "2026-11-14T12:00:00Z", updated_at: "2026-11-14T12:00:00Z", metadata: over.metadata ?? null,
  label: "VERIFY" as const, is_key: false, is_dismissed: false, notes: null, review_state: null, group: "identity" as const,
});
type Row = ReturnType<typeof art>;
afterEach(cleanup);

function renderCase(artifacts: Row[], seed: string, seedType = "other") {
  return render(<CaseReport seedValue={seed} seedType={seedType} artifacts={artifacts as never} messages={[]} reportType="full" />).container;
}
const LISTS = '[data-testid="profile-unresolved-contacts"], [data-testid="profile-name-candidates"]';
function cells(c: HTMLElement, label: RegExp): string[] {
  return Array.from(c.querySelectorAll("span"))
    .filter((s) => !s.closest(LISTS) && label.test(s.textContent ?? ""))
    .map((s) => s.parentElement?.textContent ?? "");
}
const unresolved = (c: HTMLElement) => c.querySelector('[data-testid="profile-unresolved-contacts"]')?.textContent ?? "";

const A = "first@example.test";
const B = "second@example.test";
const PHONE = "+1 555 010 0100";

describe("a seed that holds several selectors", () => {
  it("two typed emails are both the subject's, and neither is listed as unresolved", () => {
    const rows = [art({ id: "a", value: A }), art({ id: "b", value: B }), art({ id: "x", value: "other@example.test", confidence: 90 })];
    const c = renderCase(rows, `${A}, ${B}`);
    const emails = cells(c, /^Email( \d+)?$/).join(" | ");
    expect(emails).toContain(A);
    expect(emails).toContain(B);
    expect(emails.match(/Supplied as the case seed/g)?.length).toBe(2);
    expect(unresolved(c)).not.toContain(A);
    expect(unresolved(c)).not.toContain(B);
    // A contact the analyst did not type gains nothing.
    expect(unresolved(c)).toContain("other@example.test");
  });

  it("an email and a phone typed together are both seed rows", () => {
    const rows = [art({ id: "a", value: A }), art({ id: "p", kind: "phone", value: "(555) 010-0100" })];
    const report = assessArtifacts(rows as never, `${A} ${PHONE}`);
    expect(report.byId.a.isSeed).toBe(true);
    expect(report.byId.p.isSeed).toBe(true);
    const c = renderCase(rows, `${A} ${PHONE}`);
    expect(cells(c, /^Phone$/).join("")).toContain("Supplied as the case seed");
  });

  it("one typed phone recorded in two formats is printed once", () => {
    const rows = [
      art({ id: "a", value: A }),
      art({ id: "p1", kind: "phone", value: "+15550100100", confidence: 70 }),
      art({ id: "p2", kind: "phone", value: "(555) 010-0100", confidence: 60 }),
    ];
    const c = renderCase(rows, `${A}, ${PHONE}`);
    expect(cells(c, /^Phone( \d+)?$/)).toHaveLength(1);
    cleanup();
    // The same through the whole-seed path: a seed that is one phone.
    const one = renderCase(rows.slice(1), PHONE, "phone");
    expect(cells(one, /^Phone( \d+)?$/)).toHaveLength(1);
  });

  it("the seed names a person whose row is quarantined: a different LINKED name is not asserted", () => {
    // The email is a typed selector, so the record that carries it is linked to
    // the subject. The seed still names Sam Example, and only that name may be
    // asserted, quarantined or not.
    const seed = `Sam Example ${A}`;
    const rows = [
      art({ id: "a", value: A }),
      art({ id: "typed", kind: "name", value: "Sam Example", confidence: 60, metadata: { subject_unlinked: true } }),
      art({ id: "other", kind: "person", value: "Lex Sample", confidence: 80, metadata: { email: A, source_category: ["data_broker"] } }),
    ];
    expect(assessArtifacts(rows as never, seed).byId.other.linkedToSeed).toBe(true);
    const c = renderCase(rows, seed);
    expect(cells(c, /^Name$/).join(" ")).toMatch(/Not established/);
    expect(cells(c, /^Name$/).join(" ")).not.toContain("Lex Sample");
  });

  it("a row linked to EITHER seed selector is linked to the subject", () => {
    const rows = [
      art({ id: "a", value: A, confidence: 70 }),
      art({ id: "b", value: B, confidence: 70 }),
      art({ id: "rec", kind: "person", value: "Sam Example", confidence: 80, metadata: { email: B, phone: "+15550100199", source_category: ["data_broker"] } }),
      art({ id: "ph", kind: "phone", value: "+15550100199", confidence: 75 }),
    ];
    const report = assessArtifacts(rows as never, `${A}, ${B}`);
    expect(report.byId.ph.linkedToSeed).toBe(true);
    expect(report.byId.ph.isSeed).toBe(false);
    // The figure is the cluster's own, never raised by being near a seed.
    expect(report.byId.ph.subjectLinkage).toBeLessThan(100);
  });

  it("free text around a selector does not hide it, and prose words are not handles", () => {
    const rows = [art({ id: "a", value: A }), art({ id: "u", kind: "username", value: "works" })];
    const report = assessArtifacts(rows as never, `${A} works at an example company`);
    expect(report.byId.a.isSeed).toBe(true);
    expect(report.byId.u.isSeed).toBe(false);
  });

  it("an explicit @handle in a composite seed is a seed row; the same word as a NAME row is not", () => {
    const rows = [
      art({ id: "h", kind: "username", value: "examplehandle77" }),
      art({ id: "n", kind: "name", value: "examplehandle77" }),
    ];
    const report = assessArtifacts(rows as never, `${A} @examplehandle77`);
    expect(report.byId.h.isSeed).toBe(true);
    expect(report.byId.n.isSeed).toBe(false);
  });

  it("a selector that touches the 200-character cut is dropped", () => {
    const pad = "note ".repeat(36); // 180 characters
    const cutSeed = `${A} ${pad}${B}`.slice(0, 200);
    expect(cutSeed.length).toBe(200);
    const rows = [art({ id: "a", value: A }), art({ id: "tail", value: cutSeed.split(" ").pop() as string })];
    const report = assessArtifacts(rows as never, cutSeed);
    expect(report.byId.a.isSeed).toBe(true);
    expect(report.byId.tail.isSeed).toBe(false);
  });

  it("a single-selector seed behaves exactly as before", () => {
    const rows = [art({ id: "a", value: A }), art({ id: "b", value: B })];
    const report = assessArtifacts(rows as never, A);
    expect(report.byId.a.isSeed).toBe(true);
    expect(report.byId.b.isSeed).toBe(false);
  });

  it("a quarantined seed selector is still not asserted", () => {
    const rows = [art({ id: "a", value: A, metadata: { subject_unlinked: true } }), art({ id: "b", value: B })];
    const c = renderCase(rows, `${A}, ${B}`);
    const emails = cells(c, /^Email( \d+)?$/).join(" | ");
    expect(emails).toContain(B);
    expect(emails).not.toContain(A);
  });

  it("the filenames in an upload are never selectors", () => {
    const upload = "Attached files:\n- [first@example.test.pdf](https://files.example.test/x.pdf) (application/pdf, 1 MB)";
    const report = assessArtifacts([art({ id: "a", value: A })] as never, upload);
    expect(report.byId.a.isSeed).toBe(false);
  });

  it("a name seed still anchors ONE cluster: a namesake record's contacts are not the subject's", () => {
    // Two records spell the seed's name. They are two people until a selector says otherwise.
    const rows = [
      art({ id: "n1", kind: "person", value: "Alex Example", confidence: 70, metadata: { email: "one@example.test" } }),
      art({ id: "e1", value: "one@example.test", confidence: 70 }),
      art({ id: "n2", kind: "person", value: "Alex Example", confidence: 70, metadata: { email: "two@example.test" } }),
      art({ id: "e2", value: "two@example.test", confidence: 70 }),
    ];
    const report = assessArtifacts(rows as never, "Alex Example");
    expect(report.seedClusterIds.length).toBeLessThanOrEqual(1);
    expect([report.byId.e1.linkedToSeed, report.byId.e2.linkedToSeed].filter(Boolean).length).toBeLessThanOrEqual(1);
  });
});
