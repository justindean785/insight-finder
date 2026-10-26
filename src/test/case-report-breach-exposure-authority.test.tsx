import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { CaseReport } from "@/components/panel/CaseReport";

/**
 * The report's "Breach Exposure" table presents each row as a breach the SUBJECT
 * appears in, with its captured values. Every sibling subject surface in
 * CaseReport (profile, aliases, analyst confidence, the breach-corpora note) is
 * gated by `isSubjectAuthorityEligible`; this table was not, so a quarantined
 * namesake's breach, an analyst-dismissed breach, and a breach derived from an
 * analyst-rejected email all rendered as the subject's.
 *
 * Fixtures are fictional. The control test proves the fixture trips the table
 * when the gates are absent, so a passing gated test is not an empty fixture.
 */

type Over = Partial<{ id: string; kind: string; value: string; confidence: number; metadata: Record<string, unknown> | null }>;
const art = (over: Over) => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  thread_id: "t1",
  kind: over.kind ?? "breach_exposure",
  value: over.value ?? "x",
  source: "oathnet_lookup",
  confidence: over.confidence ?? 60,
  created_at: "2026-10-18T09:00:00Z",
  updated_at: "2026-10-18T09:00:00Z",
  metadata: over.metadata ?? null,
  label: "VERIFY" as const,
  is_key: false,
  is_dismissed: false,
  notes: null,
  review_state: null,
  group: "identity" as const,
});

const UNLINKED = { subject_unlinked: true, subject_unlinked_reason: "harvested from a name-only query" };

function fixture(gated: boolean) {
  const g = (m: Record<string, unknown>) => (gated ? m : {});
  return [
    art({ id: "seed", kind: "email", value: "quietfalcon77@example.com", confidence: 70 }),
    art({ id: "rej-email", kind: "email", value: "other.person@example.com", confidence: 55 }),
    art({
      id: "subject-breach",
      value: "quietfalcon77@example.com - Canva",
      metadata: { breach_name: "Canva", breach_date: "2019-05-24", exposed_fields: ["email", "password"] },
    }),
    art({
      id: "quarantined-breach",
      value: "Jordan Vale - StrangerCorp",
      metadata: { breach_name: "StrangerCorp", breach_date: "2020-01-01", exposed_fields: ["email"], ...g(UNLINKED) },
    }),
    art({
      id: "dismissed-breach",
      value: "quietfalcon77@example.com - DismissedCorp",
      metadata: { breach_name: "DismissedCorp", breach_date: "2021-02-02", exposed_fields: ["email"] },
    }),
    art({
      id: "derived-breach",
      value: "other.person@example.com - DerivedCorp",
      metadata: {
        breach_name: "DerivedCorp",
        breach_date: "2022-03-03",
        exposed_fields: ["email", "password"],
        parent_selector: "other.person@example.com",
      },
    }),
  ];
}

const REVIEWS = { "dismissed-breach": "dismissed", "rej-email": "wrong" } as const;

afterEach(cleanup);

/** Text of the Breach Exposure table (the one whose header has "Exposed fields"). */
function breachTableText(gated: boolean): string {
  const { container } = render(
    <CaseReport
      seedValue="quietfalcon77@example.com"
      seedType="email"
      artifacts={fixture(gated) as never}
      reviews={gated ? (REVIEWS as never) : undefined}
      messages={[]}
      reportType="full"
    />,
  );
  const table = Array.from(container.querySelectorAll("table")).find((t) =>
    (t.querySelector("thead")?.textContent ?? "").includes("Exposed fields"),
  );
  return table?.textContent ?? "";
}

describe("CaseReport Breach Exposure table honours subject authority", () => {
  it("control: without quarantine or reviews, every breach row renders", () => {
    const text = breachTableText(false);
    for (const site of ["Canva", "StrangerCorp", "DismissedCorp", "DerivedCorp"]) {
      expect(text).toContain(site);
    }
  });

  it("a quarantined (subject_unlinked) breach row is not presented as the subject's", () => {
    expect(breachTableText(true)).not.toContain("StrangerCorp");
  });

  it("an analyst-dismissed breach row is not presented as the subject's", () => {
    expect(breachTableText(true)).not.toContain("DismissedCorp");
  });

  it("a breach row derived from an analyst-rejected selector leaves with it", () => {
    expect(breachTableText(true)).not.toContain("DerivedCorp");
  });

  it("the subject's own breach row stays", () => {
    expect(breachTableText(true)).toContain("Canva");
  });
});

/**
 * The remaining authority states, each through the canonical predicates
 * (`isSubjectAuthorityEligible` → `isQuarantined` / `isRejectedArtifact`), plus
 * the same breach reported for the subject and for a quarantined namesake, and
 * the narrative count that sits beside the table.
 */
function renderReport(artifacts: ReturnType<typeof art>[], reviews: Record<string, string> = {}) {
  return render(
    <CaseReport
      seedValue="quietfalcon77@example.com"
      seedType="email"
      artifacts={artifacts as never}
      reviews={reviews as never}
      messages={[]}
      reportType="full"
    />,
  ).container;
}
function tableOf(container: HTMLElement): string {
  const table = Array.from(container.querySelectorAll("table")).find((t) =>
    (t.querySelector("thead")?.textContent ?? "").includes("Exposed fields"),
  );
  return table?.textContent ?? "";
}
const breach = (id: string, name: string, extra: Record<string, unknown> = {}) =>
  art({
    id,
    value: `quietfalcon77@example.com - ${name}`,
    metadata: { breach_name: name, breach_date: "2020-01-01", exposed_fields: ["email"], ...extra },
  });

describe("Breach Exposure: every authority state through the canonical predicates", () => {
  it("a 'wrong' review excludes the row", () => {
    const c = renderReport([breach("ok", "Canva"), breach("w", "WrongCorp")], { w: "wrong" });
    expect(tableOf(c)).toContain("Canva");
    expect(tableOf(c)).not.toContain("WrongCorp");
  });

  it("legacy metadata.false_positive excludes the row with no review row", () => {
    const c = renderReport([breach("ok", "Canva"), breach("fp", "LegacyFpCorp", { false_positive: true })]);
    expect(tableOf(c)).not.toContain("LegacyFpCorp");
  });

  it("an explicitly released quarantine (linkage_confirmed) speaks for the subject again", () => {
    const c = renderReport([breach("rel", "ReleasedCorp", { ...UNLINKED, linkage_confirmed: true })]);
    expect(tableOf(c)).toContain("ReleasedCorp");
  });

  it("release does not override an independent analyst rejection", () => {
    const c = renderReport(
      [breach("ok", "Canva"), breach("rel-rej", "ReleasedRejectedCorp", { ...UNLINKED, linkage_confirmed: true })],
      { "rel-rej": "dismissed" },
    );
    expect(tableOf(c)).not.toContain("ReleasedRejectedCorp");
  });

  it("the same breach seen for the subject and for a quarantined namesake keeps only the subject's values", () => {
    // The subject's row captured no hash, so the merge (one value per label) has
    // no reason to drop the namesake's: only the authority filter can keep it out.
    const c = renderReport([
      breach("subj", "Canva", { city: "Subjectville" }),
      art({
        id: "namesake",
        value: "Jordan Vale - Canva",
        metadata: {
          breach_name: "Canva",
          breach_date: "2020-01-01",
          exposed_fields: ["email", "password"],
          password_hash: "strangerhash999",
          ...UNLINKED,
        },
      }),
    ]);
    const text = tableOf(c);
    expect(text).toContain("Canva");
    expect(text).toContain("Subjectville");
    expect(text).not.toContain("strangerhash999");
  });
});

/**
 * One extra breach row (`ExtraCorp`) in each authority state, beside three clean
 * subject breaches. The table, the Hunter's Note count and the Key risks count
 * must make the same call: 4 when the row speaks for the subject, 3 when it
 * does not. Both narrative lines fire at >= 3, so a disagreement is visible.
 */
describe("table, breach-corpora note and Key risks agree in every authority state", () => {
  const base = [breach("b1", "Canva"), breach("b2", "Wattpad"), breach("b3", "Dropbox")];
  const rejectedEmail = art({ id: "rej-email", kind: "email", value: "other.person@example.com", confidence: 55 });
  const STATES: Array<{
    state: string;
    rows: ReturnType<typeof art>[];
    reviews: Record<string, string>;
    speaksForSubject: boolean;
  }> = [
    { state: "clean", rows: [breach("x", "ExtraCorp")], reviews: {}, speaksForSubject: true },
    { state: "active quarantine", rows: [breach("x", "ExtraCorp", UNLINKED)], reviews: {}, speaksForSubject: false },
    {
      state: "explicit linkage release",
      rows: [breach("x", "ExtraCorp", { ...UNLINKED, linkage_confirmed: true })],
      reviews: {},
      speaksForSubject: true,
    },
    { state: "dismissed review", rows: [breach("x", "ExtraCorp")], reviews: { x: "dismissed" }, speaksForSubject: false },
    { state: "wrong review", rows: [breach("x", "ExtraCorp")], reviews: { x: "wrong" }, speaksForSubject: false },
    {
      state: "legacy false_positive",
      rows: [breach("x", "ExtraCorp", { false_positive: true })],
      reviews: {},
      speaksForSubject: false,
    },
    {
      state: "released but rejected",
      rows: [breach("x", "ExtraCorp", { ...UNLINKED, linkage_confirmed: true })],
      reviews: { x: "wrong" },
      speaksForSubject: false,
    },
    {
      state: "derived from a rejected selector",
      rows: [
        rejectedEmail,
        art({
          id: "x",
          value: "other.person@example.com - ExtraCorp",
          metadata: { breach_name: "ExtraCorp", breach_date: "2020-01-01", parent_selector: "other.person@example.com" },
        }),
      ],
      reviews: { "rej-email": "wrong" },
      speaksForSubject: false,
    },
  ];

  it.each(STATES)("$state", ({ rows, reviews, speaksForSubject }) => {
    const c = renderReport([...base, ...rows], reviews);
    const text = c.textContent ?? "";
    const n = speaksForSubject ? 4 : 3;
    const other = speaksForSubject ? 3 : 4;
    // Table
    if (speaksForSubject) expect(tableOf(c)).toContain("ExtraCorp");
    else expect(tableOf(c)).not.toContain("ExtraCorp");
    // Hunter's Note
    expect(text).toContain(`Subject appears in ${n} distinct breach corpora`);
    expect(text).not.toContain(`Subject appears in ${other} distinct breach corpora`);
    // Key risks
    expect(text).toContain(`Subject appears in ${n} breach corpora — assume broad credential exposure.`);
    expect(text).not.toContain(`Subject appears in ${other} breach corpora — assume broad credential exposure.`);
  });
});

describe("Breach narrative count agrees with the filtered table", () => {
  it("'Subject appears in N breach corpora' does not count a breach derived from a rejected selector", () => {
    const c = renderReport(
      [
        breach("b1", "Canva"),
        breach("b2", "Wattpad"),
        breach("b3", "Dropbox"),
        art({ id: "rej-email", kind: "email", value: "other.person@example.com", confidence: 55 }),
        art({
          id: "derived",
          value: "other.person@example.com - DerivedCorp",
          metadata: { breach_name: "DerivedCorp", breach_date: "2022-03-03", parent_selector: "other.person@example.com" },
        }),
      ],
      { "rej-email": "wrong" },
    );
    const text = c.textContent ?? "";
    expect(tableOf(c)).not.toContain("DerivedCorp");
    expect(text).toContain("Subject appears in 3 distinct breach corpora");
    expect(text).not.toContain("Subject appears in 4 distinct breach corpora");
  });
});


describe("Sensitive Registrations subject authority", () => {
  function registrations(arts: ReturnType<typeof art>[], reviews: Record<string, string> = {}) {
    const c = renderReport(arts, reviews);
    return Array.from(c.querySelectorAll("table")).find(t =>
      t.querySelector("thead")?.textContent?.includes("Account identifier"))?.textContent ?? "";
  }
  it("retains accepted registrations and excludes quarantined, dismissed, rejected-derived and negative rows", () => {
    const arts = [
      art({ id: "email", kind: "email", value: "unrelated@example.com" }),
      breach("accepted", "Accepted", { site: "Accepted", identifier: "subject@example.com" }),
      breach("quarantine", "Quarantined", { site: "Quarantined", ...UNLINKED }),
      breach("dismissed", "Dismissed", { site: "Dismissed" }),
      breach("derived", "Derived", { site: "Derived", parent_selector: "unrelated@example.com" }),
      art({ id: "negative", value: "No breach hits", metadata: { site: "Negative" } }),
      art({ id: "account", kind: "account", value: "unrelated", metadata: { site: "RejectedAccount", ...UNLINKED } }),
    ];
    const originals = JSON.stringify(arts);
    const text = registrations(arts, { email: "wrong", dismissed: "dismissed", quarantine: "confirmed" });
    expect(text).toContain("Accepted");
    for (const label of ["Quarantined", "Dismissed", "Derived", "Negative", "RejectedAccount"]) expect(text).not.toContain(label);
    expect(JSON.stringify(arts)).toBe(originals);
  });
  it("keeps excluded evidence available with its original quarantine reason", () => {
    const c = renderReport([breach("q", "Quarantined", { site: "Quarantined", ...UNLINKED })]);
    expect(c.textContent).toContain("Excluded / Collision Clusters");
    expect(c.textContent).toContain("Quarantined");
    expect(Array.from(c.querySelectorAll("table")).some(t => t.querySelector("thead")?.textContent?.includes("Account identifier"))).toBe(false);
  });
  it("excludes legacy collision and false-positive records without changing their history", () => {
    const arts = [
      breach("ok", "Accepted", { site: "Accepted" }),
      breach("collision", "Collision", { site: "Collision", possible_collision: true }),
      breach("legacy", "LegacyFalse", { site: "LegacyFalse", false_positive: true }),
    ];
    const text = registrations(arts);
    expect(text).toContain("Accepted");
    expect(text).not.toContain("Collision");
    expect(text).not.toContain("LegacyFalse");
  });
  it("permits explicitly released linkage while preserving rejection precedence", () => {
    const arts = [breach("released", "Released", { site: "Released", ...UNLINKED, linkage_confirmed: true })];
    expect(registrations(arts)).toContain("Released");
    cleanup();
    expect(registrations(arts, { released: "wrong" })).not.toContain("Released");
  });
});
