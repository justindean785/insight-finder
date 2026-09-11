import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { CaseReport, buildAnalyticRadar, countCrossSourceCorroborated } from "@/components/panel/CaseReport";
import type { ReviewState } from "@/lib/review";

/**
 * The rendered report must honour the analyst's verdicts and quarantine in every
 * section that says "this is the subject's".
 *
 * From a live case printed on 2026-09-11 (shapes and values sanitised):
 *   - "Digital Footprint" listed a DNS provider's nameservers the analyst had
 *     REJECTED, as the subject's domains;
 *   - "Breach Exposure" listed rejected rows and a quarantined same-name
 *     collision, as the subject's exposures;
 *   - "Auto-corroboration — findings backed by ≥2 independent source classes"
 *     printed 33, the Confirmed bucket (which includes analyst confirmations),
 *     while the report's own Cross-source axis printed 1.
 * The Markdown export already dropped rejected rows "from every active section";
 * the rendered report — and so every printed copy — did not.
 *
 * These drive the REAL component. Rejected and quarantined rows must still be
 * DISCLOSED (quarantine is disclosure, not deletion) — just not as the subject's.
 */

const art = (over: { id: string; kind: string; value: string; source?: string; confidence?: number; metadata?: Record<string, unknown> }) => ({
  id: over.id,
  thread_id: "t1",
  kind: over.kind,
  value: over.value,
  source: over.source ?? "whois_lookup",
  confidence: over.confidence ?? 60,
  created_at: "2026-09-11T11:58:46Z",
  updated_at: "2026-09-11T11:58:46Z",
  metadata: over.metadata ?? null,
});

const ARTIFACTS = [
  // In scope.
  art({ id: "d1", kind: "domain", value: "subject-llc.example", source: "whois_lookup", metadata: { source_category: ["infra_registry"] } }),
  art({ id: "u1", kind: "username", value: "subject22", source: "serus_darkweb_scan", metadata: { source_category: ["breach"] } }),
  art({ id: "b1", kind: "breach_exposure", value: "subject@mail.example — exposed in 12 breaches", source: "rapidapi_breach_search", metadata: { source_category: ["breach"] } }),
  art({ id: "n1", kind: "name", value: "Subject Person", source: "indicia_address", metadata: { source_category: ["data_broker"] } }),
  // Genuinely corroborated across two independent classes.
  art({ id: "p1", kind: "phone", value: "+15550100", source: "indicia_phone", metadata: { source_category: ["data_broker", "breach"] } }),
  // Analyst-rejected.
  art({ id: "ns1", kind: "domain", value: "ns-cloud-x1.dns-provider.example", source: "dns_records", confidence: 40, metadata: { source_category: ["infra_dns"] } }),
  art({ id: "b2", kind: "breach_exposure", value: "SUBJECT@LLC.EXAMPLE — 0 breaches found, email is clean", source: "rapidapi_breach_search", metadata: { source_category: ["breach"] } }),
  art({ id: "u2", kind: "username", value: "rejected-handle", source: "serus_darkweb_scan", metadata: { source_category: ["breach"] } }),
  // Quarantined same-name collision (never reviewed — quarantine alone excludes it).
  art({
    id: "b3", kind: "breach_exposure", value: "Breach exposure: common name (oathnet_db)", source: "oathnet_lookup", confidence: 55,
    metadata: { source_category: ["breach"], subject_unlinked: true, subject_unlinked_reason: "harvested from a name-only query — same-name collision axis" },
  }),
];

const REVIEWS: Record<string, ReviewState> = {
  ns1: "wrong", b2: "wrong", u2: "dismissed",
  // Analyst confirmations — a decision, not a second source.
  d1: "confirmed", u1: "confirmed", b1: "confirmed", n1: "confirmed",
};

afterEach(cleanup);

function renderReport() {
  const { container } = render(
    <CaseReport seedValue="subject@mail.example" seedType="email" artifacts={ARTIFACTS as never} reviews={REVIEWS} messages={[]} reportType="full" />,
  );
  return container;
}

/** The content block that follows a section heading. */
function section(container: HTMLElement, title: string): string {
  const h = Array.from(container.querySelectorAll("h3")).find((el) => el.textContent?.trim() === title);
  expect(h, `section "${title}" rendered`).toBeTruthy();
  return h!.parentElement!.nextElementSibling?.textContent ?? "";
}

describe("the rendered report honours verdicts and quarantine where it speaks for the subject", () => {
  it("Digital Footprint lists in-scope domains and handles, never a rejected one", () => {
    const text = section(renderReport(), "Digital Footprint");
    expect(text).toContain("subject-llc.example");
    expect(text).toContain("subject22");
    expect(text).not.toContain("ns-cloud-x1.dns-provider.example");
    expect(text).not.toContain("rejected-handle");
  });

  it("Breach Exposure lists the subject's exposures, not rejected rows or a quarantined collision", () => {
    const text = section(renderReport(), "Breach Exposure");
    expect(text).toContain("exposed in 12 breaches");
    expect(text).not.toContain("0 breaches found");
    expect(text).not.toContain("common name (oathnet_db)");
  });

  it("Aliases follow the Subject Profile's rule: a rejected handle is not the subject's", () => {
    const container = renderReport();
    const aliases = Array.from(container.querySelectorAll("span")).find((el) => el.textContent === "Aliases / handles");
    const value = aliases?.nextElementSibling?.textContent ?? "";
    expect(value).toContain("subject22");
    expect(value).not.toContain("rejected-handle");
  });

  it("the excluded rows are still disclosed in the report — quarantine is disclosure, not deletion", () => {
    const text = renderReport().textContent ?? "";
    expect(text).toContain("ns-cloud-x1.dns-provider.example");
    expect(text).toContain("common name (oathnet_db)");
  });

  it("Auto-corroboration prints the cross-source count — the same one the Cross-source axis prints", () => {
    const container = renderReport();
    const label = Array.from(container.querySelectorAll("div")).find((el) => el.textContent === "Auto-corroboration");
    const value = label?.nextElementSibling?.textContent?.replace(/\s+/g, " ").trim();
    // Four analyst confirmations, ONE finding backed by two independent classes.
    expect(value).toBe(`1 / ${ARTIFACTS.length}`);
    expect(countCrossSourceCorroborated(ARTIFACTS as never, REVIEWS)).toBe(1);
    const axis = buildAnalyticRadar(ARTIFACTS as never, "MEDIUM", REVIEWS).find((m) => m.label === "Cross-source");
    expect(axis?.detail).toMatch(new RegExp(`^1/${ARTIFACTS.length} `));
  });
});

describe("Subject Profile — only rows that may speak for the subject", () => {
  // A quarantined same-name collision (a different person the engine already
  // refused to link) with the HIGHEST score used to headline the profile and set
  // the "Analyst confidence" figure. Rejection was checked; quarantine was not.
  const rows = [
    art({ id: "good", kind: "name", value: "Subject Person", source: "indicia_address", confidence: 60, metadata: { source_category: ["data_broker"] } }),
    art({
      id: "collision", kind: "name", value: "Common Namesake", source: "oathnet_lookup", confidence: 88,
      metadata: { source_category: ["breach"], subject_unlinked: true, subject_unlinked_reason: "echo of a name-only query — same-name collision axis" },
    }),
    art({
      id: "qhandle", kind: "username", value: "namesake99", source: "oathnet_lookup", confidence: 70,
      metadata: { source_category: ["breach"], subject_unlinked: true, subject_unlinked_reason: "co-tenant row in a breach corpus" },
    }),
    art({ id: "h1", kind: "username", value: "subject22", source: "serus_darkweb_scan", confidence: 45, metadata: { source_category: ["breach"] } }),
  ];

  function profile() {
    const { container } = render(
      <CaseReport seedValue="subject@mail.example" seedType="email" artifacts={rows as never} reviews={{}} messages={[]} reportType="full" />,
    );
    const field = (label: string) =>
      Array.from(container.querySelectorAll("span")).find((el) => el.textContent === label)?.nextElementSibling?.textContent ?? "";
    const confLabel = Array.from(container.querySelectorAll("div")).find((el) => el.textContent === "Analyst confidence");
    return { container, field, analystConf: confLabel?.nextElementSibling?.textContent ?? "" };
  }

  it("a quarantined collision cannot headline the Name, even with the highest score", () => {
    const { field } = profile();
    expect(field("Name")).toContain("Subject Person");
    expect(field("Name")).not.toContain("Common Namesake");
  });

  it("nor set the Analyst-confidence figure", () => {
    expect(profile().analystConf).toMatch(/^60%/);
  });

  it("nor appear among the subject's handles", () => {
    const { field } = profile();
    expect(field("Aliases / handles")).toContain("subject22");
    expect(field("Aliases / handles")).not.toContain("namesake99");
  });

  it("the collision is still disclosed in the report", () => {
    expect(profile().container.textContent).toContain("Common Namesake");
  });
});

describe("a value that asserts its own confidence is printed as a claim", () => {
  it("the report table shows the claim beside the engine's score", () => {
    const rows = [
      art({
        id: "m1", kind: "source_person", value: "Subject — primary identity cluster confirmed at 92% confidence by minimax_correlate",
        source: "minimax_correlate", confidence: 55, metadata: { source_category: ["ai_summary"] },
      }),
    ];
    const { container } = render(
      <CaseReport seedValue="subject@mail.example" seedType="email" artifacts={rows as never} reviews={{}} messages={[]} reportType="full" />,
    );
    const cell = Array.from(container.querySelectorAll("td")).find((td) => td.textContent?.includes("confirmed at 92% confidence"));
    expect(cell?.textContent).toMatch(/claims 92% · engine \d+%/);
    expect(cell?.textContent).not.toMatch(/engine 92%/);
  });
});

describe("cross-source corroboration uses the engine's definition of independent", () => {
  // Codex review, #579: a raw two-category count granted corroboration the label
  // engine withholds. `['breach', 'ai_summary']` is ONE independent class, and a
  // quarantined row corroborates nothing however many classes it carries.
  const rows = [
    art({ id: "c1", kind: "phone", value: "+15550100", source: "indicia_phone", metadata: { source_category: ["data_broker", "breach"] } }),
    art({ id: "c2", kind: "email", value: "a@mail.example", source: "rapidapi_breach_search", metadata: { source_category: ["breach", "ai_summary"] } }),
    art({
      id: "c3", kind: "name", value: "Common Namesake", source: "oathnet_lookup",
      metadata: { source_category: ["data_broker", "breach"], subject_unlinked: true, subject_unlinked_reason: "same-name collision axis" },
    }),
  ];

  it("counts only the row with two INDEPENDENT classes that may link to the subject", () => {
    expect(countCrossSourceCorroborated(rows as never, {})).toBe(1);
    const axis = buildAnalyticRadar(rows as never, "LOW", {}).find((m) => m.label === "Cross-source");
    expect(axis?.detail).toMatch(/^1\/3 /);
  });
});
