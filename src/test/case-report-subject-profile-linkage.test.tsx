import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { CaseReport } from "@/components/panel/CaseReport";

/**
 * Audit A01 (2026-11-13), SYNTHETIC: every value below is fictional and uses a
 * reserved domain; only the shape of the failure is real.
 *
 * The Subject Profile picked its Email / Phone / Address by confidence among rows
 * that were merely NOT quarantined, NOT collision-flagged and NOT rejected. That
 * is a negative gate. A clean, high-confidence row about an ASSOCIATE therefore
 * outranked the subject's own lower-confidence contact and was printed as the
 * subject's, while the narrative on the same page said it belonged to someone
 * else.
 *
 * The rule: a contact field may speak for the subject only when the row is
 * positively linked to the seed. Everything else stays in the report, labelled
 * as unresolved ownership.
 */

type Over = Partial<{ id: string; kind: string; value: string; confidence: number; source: string; metadata: Record<string, unknown> | null }>;
const art = (over: Over) => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  thread_id: "t1",
  kind: over.kind ?? "email",
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

const SEED = "subject@example.test";

/** The subject's own seed email at modest confidence, plus an associate's clean, stronger rows. */
function fixture() {
  return [
    art({ id: "seed-email", kind: "email", value: SEED, confidence: 55 }),
    art({ id: "assoc-email", kind: "email", value: "associate@example.test", confidence: 90, source: "web_scrape" }),
    art({ id: "assoc-venue", kind: "address", value: "100 Example Plaza, Springfield", confidence: 85, source: "web_scrape" }),
    art({ id: "assoc-phone", kind: "phone", value: "+15555550142", confidence: 80, source: "web_scrape" }),
  ];
}

afterEach(cleanup);

function renderCase(artifacts = fixture(), reviews?: Record<string, string>) {
  const { container } = render(
    <CaseReport seedValue={SEED} seedType="email" artifacts={artifacts as never} reviews={reviews as never} messages={[]} reportType="full" />,
  );
  return container;
}

const unresolvedText = (c: HTMLElement) => c.querySelector('[data-testid="profile-unresolved-contacts"]')?.textContent ?? "";

/**
 * Text of the ASSERTED Subject Profile cell whose label is exactly `label`. The
 * unresolved list repeats the kind labels, so its spans are not candidates.
 */
function profileCell(container: HTMLElement, label: string): string | null {
  const spans = Array.from(container.querySelectorAll("span")).filter(
    (s) => !s.closest('[data-testid="profile-unresolved-contacts"]'),
  );
  const lab = spans.find((s) => s.textContent === label);
  return lab?.parentElement?.textContent?.slice(label.length) ?? null;
}

describe("CaseReport Subject Profile requires positive subject linkage (audit A01)", () => {
  it("a higher-confidence associate email does not replace the subject's own email", () => {
    const c = renderCase();
    const email = profileCell(c, "Email") ?? "";
    expect(email.startsWith(SEED)).toBe(true);
    expect(email).not.toContain("associate@example.test");
  });

  it("an unlinked address and phone are not printed as the subject's", () => {
    const c = renderCase();
    expect(profileCell(c, "Address")).toBeNull();
    expect(profileCell(c, "Phone")).toBeNull();
  });

  it("unlinked contacts stay in the profile section, labelled as unresolved ownership", () => {
    const c = renderCase();
    const unresolved = c.querySelector('[data-testid="profile-unresolved-contacts"]');
    expect(unresolved).not.toBeNull();
    const text = unresolved?.textContent ?? "";
    expect(text).toMatch(/ownership unresolved/i);
    expect(text).toContain("associate@example.test");
    expect(text).toContain("100 Example Plaza, Springfield");
    expect(text).toContain("+15555550142");
  });

  it("disclosure, not deletion: the associate rows are still in the report body", () => {
    const text = renderCase().textContent ?? "";
    expect(text).toContain("associate@example.test");
    expect(text).toContain("100 Example Plaza, Springfield");
  });

  it("with no linked contact at all, no contact field is asserted for the subject", () => {
    const c = renderCase(fixture().filter((a) => a.id !== "seed-email"));
    expect(profileCell(c, "Email")).toBeNull();
    expect(profileCell(c, "Address")).toBeNull();
  });

  it("the seed's own email says it was supplied as the seed", () => {
    expect(profileCell(renderCase(), "Email")).toContain("Supplied as the case seed");
  });

  it("an analyst-confirmed associate email is still not the subject's", () => {
    // "Confirmed" says the value is real. It does not say whose it is.
    for (const verdict of ["confirmed", "key"]) {
      const c = renderCase(fixture(), { "assoc-email": verdict });
      const email = profileCell(c, "Email") ?? "";
      expect(email.startsWith(SEED)).toBe(true);
      expect(email).not.toContain("associate@example.test");
      expect(unresolvedText(c)).toContain("associate@example.test");
      cleanup();
    }
  });

  it("a contact joined to the seed by a shared record is shown as LINKED, not as verified ownership", () => {
    // The record carries both the seed email and the phone, so the cluster
    // engine joins them at the support threshold.
    const joiner = art({ id: "rec", kind: "person", value: "Sam Example", metadata: { email: SEED, phone: "+15555550142", source_category: ["data_broker"] } });
    const c = renderCase([...fixture(), joiner]);
    const phone = profileCell(c, "Phone") ?? "";
    expect(phone.startsWith("+15555550142")).toBe(true);
    expect(phone).toContain("Linked to the subject");
    expect(phone).toContain("not independently verified");
    expect(unresolvedText(c)).not.toContain("+15555550142");
    // The associate's other rows gained nothing from it.
    expect(profileCell(c, "Address")).toBeNull();
  });

  it("a long unresolved list says how many more there are instead of dropping them silently", () => {
    const many = Array.from({ length: 11 }, (_, i) =>
      art({ id: `other-${i}`, kind: "email", value: `other${i}@example.test`, confidence: 40 }),
    );
    // 3 associate contacts + 11 others = 14 unresolved; 8 are listed.
    expect(unresolvedText(renderCase([...fixture(), ...many]))).toContain("6 more in Evidence");
    cleanup();
    expect(unresolvedText(renderCase())).not.toContain("more in Evidence");
  });

  // ── Found by the review of this PR ───────────────────────────────────────
  const joinerFor = (id: string, phone: string) =>
    art({ id, kind: "person", value: "Sam Example", metadata: { email: SEED, phone, source_category: ["data_broker"] } });

  it("a lookup that found nothing is not listed as a contact", () => {
    const c = renderCase([
      ...fixture(),
      art({ id: "neg-e", kind: "email", value: "other@example.test - no breach hits", confidence: 95 }),
      art({ id: "neg-p", kind: "phone", value: "no results found", confidence: 95 }),
    ]);
    expect(unresolvedText(c)).not.toMatch(/no breach hits|no results found/);
    expect(profileCell(c, "Email")?.startsWith(SEED)).toBe(true);
  });

  it("a contact derived from a rejected selector gains no authority by also joining the seed", () => {
    const rows = [
      art({ id: "seed-email", kind: "email", value: SEED, confidence: 55 }),
      art({ id: "rej", kind: "email", value: "rejected@example.test", confidence: 70 }),
      joinerFor("rec", "+15555550133"),
      art({ id: "drv", kind: "phone", value: "+15555550133", confidence: 85, metadata: { parent_selector: "rejected@example.test" } }),
    ];
    // Without the rejection the phone is linked: the gate under test is provenance.
    expect(profileCell(renderCase(rows), "Phone")).toContain("+15555550133");
    cleanup();
    const c = renderCase(rows, { rej: "dismissed" });
    expect(profileCell(c, "Phone")).toBeNull();
    // Rejected by provenance, like a rejected row: in neither list. It stays in Evidence.
    expect(unresolvedText(c)).not.toContain("+15555550133");
  });

  it("an analyst-rejected contact is in neither the asserted fields nor the unresolved list", () => {
    const c = renderCase(fixture(), { "assoc-venue": "dismissed" });
    expect(profileCell(c, "Address")).toBeNull();
    expect(unresolvedText(c)).not.toContain("100 Example Plaza");
  });

  it("a linked email with a higher score does not displace the seed email", () => {
    const c = renderCase([
      art({ id: "seed-email", kind: "email", value: SEED, confidence: 55 }),
      art({ id: "rec", kind: "person", value: "Sam Example", metadata: { email: SEED, source_category: ["data_broker"] } }),
      art({ id: "second", kind: "email", value: "second@example.test", confidence: 95, metadata: { email: SEED } }),
    ]);
    expect(profileCell(c, "Email")?.startsWith(SEED)).toBe(true);
    expect(profileCell(c, "Email")).toContain("Supplied as the case seed");
  });

  it("the contact fields and the unresolved list do not depend on the order rows arrived in", () => {
    const base = [
      art({ id: "seed-email", kind: "email", value: SEED, confidence: 55 }),
      joinerFor("recA", "+15555550142"),
      joinerFor("recB", "+15555550177"),
      art({ id: "phA", kind: "phone", value: "+15555550142", confidence: 70 }),
      art({ id: "phB", kind: "phone", value: "+15555550177", confidence: 70 }),
      art({ id: "u1", kind: "email", value: "u1@example.test", confidence: 70 }),
      art({ id: "u2", kind: "email", value: "u2@example.test", confidence: 70 }),
    ];
    const orders = [base, base.slice().reverse(), [base[4], base[2], base[6], base[0], base[3], base[5], base[1]]];
    const seen = new Set<string>();
    for (const o of orders) {
      const c = renderCase(o);
      seen.add(JSON.stringify([profileCell(c, "Email"), profileCell(c, "Phone"), profileCell(c, "Address"), unresolvedText(c)]));
      cleanup();
    }
    expect(seen.size).toBe(1);
  });

  it("CURRENT BEHAVIOUR, ruling pending: a released quarantine with no link to the seed stays unresolved", () => {
    // `linkage_confirmed` clears the quarantine; it does not join the row to the
    // seed. Whether an explicit release should assert ownership is JD's ruling.
    const c = renderCase([
      ...fixture(),
      art({ id: "rel", kind: "phone", value: "+15555550155", confidence: 80, metadata: { subject_unlinked: true, linkage_confirmed: true, linkage_confirmed_at: "2026-11-13T00:00:00Z" } }),
    ]);
    expect(profileCell(c, "Phone")).toBeNull();
    expect(unresolvedText(c)).toContain("+15555550155");
  });

  it("a quarantined seed email is not asserted for the subject", () => {
    const rows = fixture().map((a) =>
      a.id === "seed-email" ? { ...a, metadata: { subject_unlinked: true, subject_unlinked_reason: "harvested from a name-only query" } } : a,
    );
    expect(profileCell(renderCase(rows), "Email")).toBeNull();
  });
});
