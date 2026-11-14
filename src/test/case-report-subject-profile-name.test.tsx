import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { CaseReport } from "@/components/panel/CaseReport";
import { assessArtifacts, SUPPORTED_LINKAGE_MIN } from "@/lib/agent-assessment";
import { buildCaseSheet } from "@/lib/case-sheet";
import { tallyAuthority } from "@/lib/authority";
import { pickSubjectName } from "@/lib/report-hygiene";

/**
 * Audit A01, the Name half (2026-11-13). SYNTHETIC: every value is fictional and
 * uses a reserved domain; only the shape of the failure is real.
 *
 * The Subject Profile picked its Name with `topByConfidence`: the highest
 * confidence among name rows that were merely NOT quarantined, NOT collision
 * flagged and NOT rejected. So an unrelated person's name was printed as the
 * subject's, a name seed lost to a stronger stranger, and a tie was settled by
 * the order the rows arrived in.
 *
 * The rule (v2, approved by JD, 2026-11-13) is ONE shared reading,
 * `readSubjectName`, shown by every surface that names the subject:
 *  1. candidates pass the gates the contact fields use;
 *  2. a name is tied to the subject when the analyst typed it in the seed, or
 *     when it is the subject's by linkage;
 *  3. a tied name whose claim is disputed keeps its tie and is never asserted
 *     (decision B);
 *  4. asserted: the seed-named name; without one, the single linked name; two
 *     different linked names are not reconciled by score; when the seed names a
 *     person only that name may be asserted;
 *  5. everything else, a released quarantine with no seed link included, is
 *     listed as ownership unresolved (decision A);
 *  6. DOB / Age comes only from a row a shared selector joins to the seed;
 *  7. when no name is established the field says so.
 */

type Over = Partial<{ id: string; kind: string; value: string; confidence: number; source: string; metadata: Record<string, unknown> | null }>;
const art = (over: Over) => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  thread_id: "t1",
  kind: over.kind ?? "name",
  value: over.value ?? "x",
  source: over.source ?? "oathnet_lookup",
  confidence: over.confidence ?? 50,
  created_at: "2026-11-13T12:00:00Z",
  updated_at: "2026-11-13T12:00:00Z",
  metadata: over.metadata ?? null,
  label: "VERIFY" as const,
  is_key: false,
  is_dismissed: false,
  notes: null,
  review_state: null,
  group: "identity" as const,
});
type Row = ReturnType<typeof art>;

const SEED = "subject@example.test";
const seedEmail = () => art({ id: "seed-email", kind: "email", value: SEED, confidence: 55 });
/** A record that carries the seed email, so the cluster engine joins the name to the seed. */
const linked = (id: string, value: string, confidence = 80, extra: Record<string, unknown> = {}) =>
  art({ id, kind: "person", value, confidence, metadata: { email: SEED, source_category: ["data_broker"], ...extra } });
/** A clean, strong name row that nothing joins to the seed. */
const stranger = (id = "stranger", value = "Robin Stranger", confidence = 90, metadata: Record<string, unknown> | null = null) =>
  art({ id, kind: "name", value, confidence, source: "web_scrape", metadata });

afterEach(cleanup);

function renderCase(artifacts: Row[], opts: { seed?: string; seedType?: string; reviews?: Record<string, string> } = {}) {
  const { container } = render(
    <CaseReport
      seedValue={opts.seed ?? SEED}
      seedType={opts.seedType ?? "email"}
      artifacts={artifacts as never}
      reviews={opts.reviews as never}
      messages={[]}
      reportType="full"
    />,
  );
  return container;
}

const LISTS = '[data-testid="profile-unresolved-contacts"], [data-testid="profile-name-candidates"]';

/** Text of the ASSERTED Subject Profile cell labelled exactly `label`; the candidate lists are not candidates for it. */
function profileCell(container: HTMLElement, label: string): string | null {
  const spans = Array.from(container.querySelectorAll("span")).filter((s) => !s.closest(LISTS));
  const lab = spans.find((s) => s.textContent === label);
  return lab?.parentElement?.textContent?.slice(label.length) ?? null;
}
const group = (c: HTMLElement, key: "linked" | "disputed" | "unresolved") =>
  c.querySelector(`[data-testid="profile-name-candidates"] [data-name-group="${key}"]`)?.textContent ?? "";
const allGroups = (c: HTMLElement) => c.querySelector('[data-testid="profile-name-candidates"]')?.textContent ?? "";
/** The profile states that no name is established, instead of printing one or leaving the field out. */
const expectNoName = (c: HTMLElement) => expect(profileCell(c, "Name") ?? "").toMatch(/^Not established/);
/** The Identity panel's "Real name" value on the same page, or null when the row is absent. */
function identityRealName(c: HTMLElement): string | null {
  const cell = Array.from(c.querySelectorAll("td")).find((td) => td.textContent === "Real name");
  return cell?.nextElementSibling?.textContent ?? null;
}
const banner = (c: HTMLElement) => c.querySelector("[data-report-subject-refused]") !== null;

/** What the assessment says about one row, so a fixture's premise fails loudly if cluster scoring moves. */
function assessed(rows: Row[], id: string, seed: string = SEED) {
  return assessArtifacts(rows as never, seed).byId[id];
}

describe("CaseReport Subject Profile Name requires positive subject linkage (audit A01, Name)", () => {
  it("an unrelated name is not printed as the subject's, however strong it is", () => {
    const c = renderCase([seedEmail(), stranger()]);
    expectNoName(c);
    expect(group(c, "unresolved")).toContain("Robin Stranger");
    expect(group(c, "unresolved")).toMatch(/ownership unresolved/i);
  });

  it("a name linked to the seed is asserted over a stronger unrelated name", () => {
    const rows = [seedEmail(), linked("rec", "Sam Example", 80), stranger("stranger", "Robin Stranger", 95)];
    expect(assessed(rows, "rec").subjectLinkage).toBeGreaterThanOrEqual(SUPPORTED_LINKAGE_MIN);
    const c = renderCase(rows);
    const name = profileCell(c, "Name") ?? "";
    expect(name.startsWith("Sam Example")).toBe(true);
    expect(name).not.toContain("Robin Stranger");
    expect(group(c, "unresolved")).toContain("Robin Stranger");
    expect(allGroups(c)).not.toContain("Sam Example");
  });

  it("a name seed is the subject's name even when a stranger scores higher", () => {
    const rows = [art({ id: "seed-name", kind: "name", value: "Alex Example", confidence: 40 }), stranger()];
    const c = renderCase(rows, { seed: "Alex Example", seedType: "name" });
    const name = profileCell(c, "Name") ?? "";
    expect(name.startsWith("Alex Example")).toBe(true);
    expect(name).toContain("Supplied as the case seed");
    expect(group(c, "unresolved")).toContain("Robin Stranger");
  });

  it("a seed that names a person whose own row is quarantined does not hand the Name to a stranger", () => {
    const rows = [
      art({ id: "seed-name", kind: "name", value: "Alex Example", confidence: 60, metadata: { subject_unlinked: true } }),
      stranger(),
    ];
    const c = renderCase(rows, { seed: "Alex Example, 12 Example St Springfield", seedType: "other" });
    expectNoName(c);
    expect(group(c, "unresolved")).toContain("Robin Stranger");
    // The quarantined row keeps its place in Evidence; the profile lists it nowhere.
    expect(allGroups(c)).not.toContain("Alex Example");
  });

  it("the Name and the candidate lists do not depend on the order rows arrived in", () => {
    const base = [
      seedEmail(),
      linked("rec", "Sam Example", 80),
      stranger("a", "Avery Other", 70),
      stranger("b", "Blake Other", 70),
      stranger("c", "Casey Other", 70),
    ];
    const orders = [base, base.slice().reverse(), [base[3], base[1], base[4], base[0], base[2]]];
    const seen = new Set<string>();
    for (const o of orders) {
      const c = renderCase(o);
      seen.add(JSON.stringify([profileCell(c, "Name"), profileCell(c, "DOB / Age"), allGroups(c)]));
      cleanup();
    }
    expect(seen.size).toBe(1);
  });

  it("two tied unrelated names: neither is asserted, whichever arrived first", () => {
    for (const rows of [
      [seedEmail(), stranger("a", "Avery Other", 70), stranger("b", "Blake Other", 70)],
      [seedEmail(), stranger("b", "Blake Other", 70), stranger("a", "Avery Other", 70)],
    ]) {
      const c = renderCase(rows);
      expectNoName(c);
      expect(group(c, "unresolved")).toContain("Avery Other");
      expect(group(c, "unresolved")).toContain("Blake Other");
      cleanup();
    }
  });

  it("decision A: a name released from quarantine with no link to the seed stays unresolved", () => {
    const released = stranger("rel", "Robin Stranger", 90, {
      subject_unlinked: true, linkage_confirmed: true, linkage_confirmed_at: "2026-11-13T00:00:00Z",
    });
    const rows = [seedEmail(), released];
    expect(assessed(rows, "rel").linkedToSeed).toBe(false);
    const c = renderCase(rows);
    expectNoName(c);
    expect(group(c, "unresolved")).toContain("Robin Stranger");
  });

  it("decision B: a linked name with a disputed claim keeps its linkage and is not asserted", () => {
    const rows = [seedEmail(), linked("rec", "Sam Example", 80, { conflict: true })];
    // Linkage is untouched by the conflict flag; only the claim is disputed.
    const a = assessed(rows, "rec");
    expect(a.linkedToSeed).toBe(true);
    expect(a.subjectLinkage).toBeGreaterThanOrEqual(SUPPORTED_LINKAGE_MIN);
    expect(a.group).toBe("conflict");
    const c = renderCase(rows);
    expectNoName(c);
    expect(group(c, "disputed")).toContain("Sam Example");
    expect(group(c, "disputed")).toMatch(/claim disputed/i);
    expect(group(c, "unresolved")).not.toContain("Sam Example");
  });

  it("decision B: one disputed row disputes the name, even beside a clean linked row of the same name", () => {
    const rows = [seedEmail(), linked("clean", "Sam Example", 80), linked("flagged", "Sam Example", 75, { conflict: true })];
    const c = renderCase(rows);
    expectNoName(c);
    expect(group(c, "disputed")).toContain("Sam Example");
  });

  it("two different linked names and no seed name: neither is asserted, both are kept", () => {
    const rows = [seedEmail(), linked("l1", "Sam Example", 70), linked("l2", "Samuel Exemplar", 85)];
    expect(assessed(rows, "l1").subjectLinkage).toBeGreaterThanOrEqual(SUPPORTED_LINKAGE_MIN);
    expect(assessed(rows, "l2").subjectLinkage).toBeGreaterThanOrEqual(SUPPORTED_LINKAGE_MIN);
    const c = renderCase(rows);
    expectNoName(c);
    expect(group(c, "linked")).toContain("Sam Example");
    expect(group(c, "linked")).toContain("Samuel Exemplar");
    expect(group(c, "linked")).toMatch(/not reconciled/i);
  });

  it("the same linked name recorded twice is one name, asserted once", () => {
    const rows = [seedEmail(), linked("l1", "Sam Example", 70), linked("l2", "sam example (age 41)", 85)];
    const c = renderCase(rows);
    const name = profileCell(c, "Name") ?? "";
    expect(name.toLowerCase().startsWith("sam example")).toBe(true);
    expect(allGroups(c).toLowerCase()).not.toContain("sam example");
  });

  it("a name seed is asserted; another linked name is kept beside it, not reconciled", () => {
    const rows = [
      art({ id: "seed-name", kind: "name", value: "Alex Example", confidence: 60, metadata: { email: "alex@example.test" } }),
      art({ id: "other", kind: "person", value: "Lex Sample", confidence: 80, metadata: { email: "alex@example.test", source_category: ["data_broker"] } }),
    ];
    const other = assessed(rows, "other", "Alex Example");
    expect(other.linkedToSeed).toBe(true);
    expect(other.subjectLinkage).toBeGreaterThanOrEqual(SUPPORTED_LINKAGE_MIN);
    const c = renderCase(rows, { seed: "Alex Example", seedType: "name" });
    expect((profileCell(c, "Name") ?? "").startsWith("Alex Example")).toBe(true);
    expect(group(c, "linked")).toContain("Lex Sample");
  });

  it("a name linked below the support threshold is not asserted", () => {
    const rows = [seedEmail(), linked("weak", "Sam Example", 50)];
    const a = assessed(rows, "weak");
    expect(a.linkedToSeed).toBe(true);
    expect(a.subjectLinkage).toBeLessThan(SUPPORTED_LINKAGE_MIN);
    const c = renderCase(rows);
    expectNoName(c);
    expect(group(c, "unresolved")).toContain("Sam Example");
  });

  it("an analyst-confirmed unrelated name is still not the subject's", () => {
    // "Confirmed" says the value is real. It does not say whose it is.
    for (const verdict of ["confirmed", "key"]) {
      const c = renderCase([seedEmail(), stranger()], { reviews: { stranger: verdict } });
      expectNoName(c);
      expect(group(c, "unresolved")).toContain("Robin Stranger");
      cleanup();
    }
  });

  it("a rejected name, a name derived from a rejected selector and a no-result row are in no list", () => {
    const rows = [
      seedEmail(),
      stranger("rejected", "Rejected Person", 90),
      art({ id: "rej-sel", kind: "email", value: "rejected@example.test", confidence: 70 }),
      stranger("derived", "Derived Person", 85, { parent_selector: "rejected@example.test" }),
      stranger("nothing", "no results found", 95),
    ];
    const c = renderCase(rows, { reviews: { rejected: "dismissed", "rej-sel": "dismissed" } });
    // Nothing is left to be a candidate, so there is no Name line at all.
    expect(profileCell(c, "Name")).toBeNull();
    expect(allGroups(c)).not.toMatch(/Rejected Person|Derived Person|no results found/);
  });

  it("DOB / Age is read only from the asserted name row", () => {
    // A stranger's DOB, on a stronger row, is not the subject's DOB.
    const withStrangerDob = [seedEmail(), linked("rec", "Sam Example", 80), stranger("stranger", "Robin Stranger", 95, { dob: "1980-02-03", age: 46 })];
    expect(profileCell(renderCase(withStrangerDob), "DOB / Age")).toBeNull();
    cleanup();
    // The same name on an UNLINKED row does not lend its DOB either.
    const sameNameUnlinked = [seedEmail(), linked("rec", "Sam Example", 80), stranger("namesake", "Sam Example", 95, { dob: "1980-02-03" })];
    expect(profileCell(renderCase(sameNameUnlinked), "DOB / Age")).toBeNull();
    cleanup();
    const own = [seedEmail(), linked("rec", "Sam Example", 80, { dob: "1975-06-07", age: 51 })];
    expect(profileCell(renderCase(own), "DOB / Age")).toContain("1975-06-07");
    cleanup();
    // No asserted name, no DOB: an unresolved name's DOB belongs to nobody yet.
    expect(profileCell(renderCase([seedEmail(), stranger("stranger", "Robin Stranger", 95, { dob: "1980-02-03" })]), "DOB / Age")).toBeNull();
  });

  it("a linked name says its basis and keeps its source-class note", () => {
    const name = profileCell(renderCase([seedEmail(), linked("rec", "Sam Example", 80)]), "Name") ?? "";
    expect(name).toContain("Linked to the subject");
    expect(name).toContain("not independently verified");
    expect(name).toMatch(/Candidate — needs review · 1 source class/);
  });

  it("a long unresolved list says how many more there are instead of dropping them silently", () => {
    const many = Array.from({ length: 11 }, (_, i) => stranger(`n-${i}`, `Other Person ${String(i).padStart(2, "0")}`, 40));
    const c = renderCase([seedEmail(), ...many]);
    expect(group(c, "unresolved")).toContain("3 more in Evidence");
    expect((group(c, "unresolved").match(/Other Person/g) ?? []).length).toBe(8);
  });

  it("disclosure, not deletion: an unasserted name is still in the report body", () => {
    const c = renderCase([seedEmail(), stranger()]);
    const outside = Array.from(c.querySelectorAll("*")).filter(
      (el) => !el.closest('[data-testid="profile-name-candidates"]') && el.children.length === 0 && el.textContent?.includes("Robin Stranger"),
    );
    expect(outside.length).toBeGreaterThan(0);
  });

  it("the contact fields are untouched: the seed email is still asserted with its basis", () => {
    const c = renderCase([seedEmail(), stranger()]);
    expect((profileCell(c, "Email") ?? "").startsWith(SEED)).toBe(true);
    expect(profileCell(c, "Email")).toContain("Supplied as the case seed");
  });

  // ── v2: the name the analyst typed ───────────────────────────────────────
  it("a name the analyst typed in a longer seed is the subject's name", () => {
    const rows = [art({ id: "typed", value: "Sam Example", confidence: 60 }), stranger()];
    const c = renderCase(rows, { seed: "Sam Example, Springfield", seedType: "other" });
    const name = profileCell(c, "Name") ?? "";
    expect(name.startsWith("Sam Example")).toBe(true);
    expect(name).toContain("Named in the case seed");
    expect(name).not.toContain("Candidate");
    expect(group(c, "unresolved")).toContain("Robin Stranger");
    expect(allGroups(c)).not.toContain("Sam Example");
  });

  it("a typed name recorded with a trailing annotation is still the name the seed names", () => {
    const rows = [art({ id: "typed", value: "Sam Example (age 41)", confidence: 60 }), stranger()];
    const c = renderCase(rows, { seed: "Sam Example, Springfield", seedType: "other" });
    const name = profileCell(c, "Name") ?? "";
    expect(name.startsWith("Sam Example (age 41)")).toBe(true);
    expect(name).toContain("Named in the case seed");
    expect(pickSubjectName(rows as never, undefined, "Sam Example, Springfield")?.value).toBe("Sam Example (age 41)");
  });

  it("one shared word is not the seed's name: a relative is not the subject", () => {
    const rows = [art({ id: "rel", value: "Jamie Example", confidence: 80 })];
    const c = renderCase(rows, { seed: "Sam Example, Springfield", seedType: "other" });
    expectNoName(c);
    expect(group(c, "unresolved")).toContain("Jamie Example");
  });

  it("a filename in an upload is not a typed name", () => {
    const rows = [art({ id: "infile", value: "Sam Example", confidence: 80 })];
    const upload = "Attached files:\n- [Sam Example background.pdf](https://files.example.test/x.pdf) (application/pdf, 1.2 MB)";
    expectNoName(renderCase(rows, { seed: upload, seedType: "other" }));
    cleanup();
    // Typed text plus an upload: only the typed words count.
    const typedPlus = `subject@example.test\n\n${upload}`;
    expectNoName(renderCase([seedEmail(), ...rows], { seed: typedPlus, seedType: "email" }));
  });

  it("a name tied to the subject by the name alone lends no DOB / Age", () => {
    // Typed in a longer seed: the row may be a namesake's record.
    const typed = [art({ id: "typed", value: "Sam Example", confidence: 60, metadata: { dob: "1980-02-03", age: 46 } })];
    const c1 = renderCase(typed, { seed: "Sam Example, Springfield", seedType: "other" });
    expect((profileCell(c1, "Name") ?? "").startsWith("Sam Example")).toBe(true);
    expect(profileCell(c1, "DOB / Age")).toBeNull();
    cleanup();
    // The whole seed is the name: a same-name record is still only a name match.
    const whole = [art({ id: "seed-name", value: "Alex Example", confidence: 60, metadata: { dob: "1970-05-06" } })];
    const c2 = renderCase(whole, { seed: "Alex Example", seedType: "name" });
    expect((profileCell(c2, "Name") ?? "").startsWith("Alex Example")).toBe(true);
    expect(profileCell(c2, "DOB / Age")).toBeNull();
  });

  it("when the seed names a person, a different linked name does not take the place", () => {
    // The seed's own name is disputed, so it is not asserted; the name linked to
    // it is kept beside it, never promoted over the person the analyst named.
    const rows = [
      art({ id: "seed-name", kind: "name", value: "Alex Example", confidence: 60, metadata: { email: "alex@example.test", conflict: true } }),
      art({ id: "other", kind: "person", value: "Lex Sample", confidence: 80, metadata: { email: "alex@example.test", source_category: ["data_broker"] } }),
    ];
    const other = assessed(rows, "other", "Alex Example");
    expect(other.linkedToSeed).toBe(true);
    expect(other.subjectLinkage).toBeGreaterThanOrEqual(SUPPORTED_LINKAGE_MIN);
    const c = renderCase(rows, { seed: "Alex Example", seedType: "name" });
    expectNoName(c);
    expect(group(c, "disputed")).toContain("Alex Example");
    expect(group(c, "linked")).toContain("Lex Sample");
  });

  it("a disputed linked name still counts: the other linked name is not asserted in its place", () => {
    // Dropping the disputed name before counting would settle the dispute in
    // the other name's favour.
    const rows = [seedEmail(), linked("clean", "Sam Example", 80), linked("flagged", "Samuel Exemplar", 85, { conflict: true })];
    const c = renderCase(rows);
    expectNoName(c);
    expect(group(c, "linked")).toContain("Sam Example");
    expect(group(c, "disputed")).toContain("Samuel Exemplar");
  });

  it("CURRENT BEHAVIOUR: two spellings of one linked person are two names, and neither is asserted", () => {
    // Names are compared by the assessment's own canonical form (case and a
    // trailing parenthetical). Nothing here decides that "Sam" is "Samuel".
    const rows = [seedEmail(), linked("l1", "Sam Example", 80), linked("l2", "Samuel Example", 80)];
    const c = renderCase(rows);
    expectNoName(c);
    expect(group(c, "linked")).toContain("Sam Example");
    expect(group(c, "linked")).toContain("Samuel Example");
  });

  it("a name that is only an annotation is listed, never dropped and never asserted as a blank", () => {
    const c = renderCase([seedEmail(), stranger("anno", "(name withheld)", 70)]);
    expectNoName(c);
    expect(group(c, "unresolved")).toContain("(name withheld)");
    cleanup();
    // A blank value is not a name at all: no Name line, no list.
    const blank = renderCase([seedEmail(), stranger("blank", "   ", 70)]);
    expect(profileCell(blank, "Name")).toBeNull();
    expect(allGroups(blank)).toBe("");
  });

  it("the asserted name's note says how well the value itself is sourced", () => {
    // Two independent source classes: no candidate note, the basis alone.
    const two = linked("rec", "Sam Example", 80, { source_category: ["data_broker", "social"] });
    const corroborated = profileCell(renderCase([seedEmail(), two]), "Name") ?? "";
    expect(corroborated).toContain("Linked to the subject");
    expect(corroborated).not.toContain("Candidate");
    cleanup();
    // No source class recorded.
    const none = art({ id: "rec", kind: "person", value: "Sam Example", confidence: 80, source: "", metadata: { email: SEED } });
    expect(profileCell(renderCase([seedEmail(), none]), "Name")).toContain("Candidate — needs review · no source class recorded");
    cleanup();
    // An analyst confirmation is said as such; it is not a second source.
    const confirmed = profileCell(renderCase([seedEmail(), linked("rec", "Sam Example", 80)], { reviews: { rec: "confirmed" } }), "Name") ?? "";
    expect(confirmed).toContain("Analyst-confirmed · single-source");
    cleanup();
    // The whole seed: the analyst's own premise carries its basis only.
    const whole = profileCell(renderCase([art({ id: "n", value: "Alex Example", confidence: 40 })], { seed: "Alex Example", seedType: "name" }), "Name") ?? "";
    expect(whole).toBe("Alex ExampleSupplied as the case seed");
  });

  it("a one-word name seed is the subject's name", () => {
    const rows = [art({ id: "mono", value: "Zephyrine", confidence: 40 }), stranger()];
    const c = renderCase(rows, { seed: "Zephyrine", seedType: "name" });
    expect(profileCell(c, "Name")).toBe("ZephyrineSupplied as the case seed");
  });

  it("the whole seed outranks another name made of the seed's words", () => {
    const rows = [
      art({ id: "whole", value: "Alex Example", confidence: 40 }),
      art({ id: "swapped", value: "Example Alex", confidence: 90 }),
    ];
    const c = renderCase(rows, { seed: "Alex Example", seedType: "name" });
    expect(profileCell(c, "Name")).toBe("Alex ExampleSupplied as the case seed");
    expect(group(c, "linked")).toContain("Example Alex");
  });

  it("two equal rows of the linked name: the DOB shown does not depend on arrival order", () => {
    const a = linked("row-a", "Sam Example", 80, { dob: "1975-06-07" });
    const b = linked("row-b", "Sam Example", 80, { dob: "1981-01-02" });
    const seen = new Set<string>();
    for (const rows of [[seedEmail(), a, b], [seedEmail(), b, a], [b, a, seedEmail()]]) {
      seen.add(profileCell(renderCase(rows), "DOB / Age") ?? "none");
      cleanup();
    }
    expect(seen.size).toBe(1);
    expect([...seen][0]).not.toBe("none");
  });

  it("with no name row at all the profile prints no Name line", () => {
    expect(profileCell(renderCase([seedEmail()]), "Name")).toBeNull();
  });

  // ── v2: every surface names the same person, or none does ────────────────
  const CASES: Array<{ label: string; rows: () => Row[]; seed?: string; seedType?: string; expected: string | null }> = [
    { label: "only an unrelated name", rows: () => [seedEmail(), stranger()], expected: null },
    { label: "a linked name and a stronger stranger", rows: () => [seedEmail(), linked("rec", "Sam Example", 80), stranger("stranger", "Robin Stranger", 95)], expected: "Sam Example" },
    { label: "a typed name and a stronger stranger", rows: () => [art({ id: "typed", value: "Sam Example", confidence: 60 }), stranger()], seed: "Sam Example, Springfield", seedType: "other", expected: "Sam Example" },
    { label: "a typed name whose row is quarantined", rows: () => [art({ id: "typed", value: "Sam Example", confidence: 60, metadata: { subject_unlinked: true } }), stranger()], seed: "Sam Example, Springfield", seedType: "other", expected: null },
    { label: "two different linked names", rows: () => [seedEmail(), linked("l1", "Sam Example", 70), linked("l2", "Samuel Exemplar", 85)], expected: null },
    { label: "a linked name with a disputed claim", rows: () => [seedEmail(), linked("rec", "Sam Example", 80, { conflict: true })], expected: null },
  ];
  for (const k of CASES) {
    it(`the profile, the Identity panel, the notice and the case sheet agree: ${k.label}`, () => {
      const rows = k.rows();
      const seed = k.seed ?? SEED;
      const c = renderCase(rows, { seed, seedType: k.seedType });
      const profile = profileCell(c, "Name") ?? "";
      if (k.expected === null) {
        expectNoName(c);
        expect(identityRealName(c)).toBeNull();
        expect(banner(c)).toBe(true);
      } else {
        expect(profile.startsWith(k.expected)).toBe(true);
        expect(identityRealName(c)).toBe(k.expected);
        expect(banner(c)).toBe(false);
      }
      // The shared picker, and the rail's case sheet that reads it.
      expect(pickSubjectName(rows as never, undefined, seed)?.value ?? null).toBe(k.expected);
      const sheet = buildCaseSheet(rows as never, {}, tallyAuthority(rows as never, () => "new"), seed);
      expect(sheet.subject?.artifact.value ?? null).toBe(k.expected);
    });
  }
});
