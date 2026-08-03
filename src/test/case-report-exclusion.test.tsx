/**
 * Item 3 of the report-integrity amendment contract: `CaseReport` must not
 * render analyst-rejected rows as live evidence.
 *
 * These assertions are deliberately made against the REAL component rather than
 * the builder functions. The builders were already correct — `labelForArtifact`
 * has always handled `dismissed`/`wrong`. The defect is plumbing: the component
 * threaded `reviews` into two consumers and derived every other analytical
 * surface from the unfiltered `artifacts` array. Only a render can catch that.
 *
 * Scoping note: after the fix, rejected rows are still PRINTED — in the excluded
 * audit section, which is the point of retaining them. So absence is asserted
 * over the document with that section removed (`analysisText`), never over the
 * whole document.
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, it, expect } from "vitest";
import { CaseReport } from "@/components/panel/CaseReport";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import type { ReviewState } from "@/lib/review";
import { REDACTED_MINOR_PLACEHOLDER } from "@/lib/artifact-exclusion";

const art = (over: Partial<Artifact> & { id: string }): Artifact => ({
  kind: "email",
  value: "a@b.com",
  confidence: 60,
  source: "alpha",
  created_at: "2026-08-01T00:00:00.000Z",
  metadata: null,
  ...over,
});

/* The three rows an analyst has NOT rejected. Every denominator below is
 * derived from exactly these: 3 artifacts, sources {alpha,beta,gamma},
 * mean confidence (70+60+50)/3 = 60. */
const KEPT: Artifact[] = [
  art({ id: "keep-name", kind: "name", value: "Kept Person", confidence: 70, source: "alpha" }),
  art({
    id: "keep-handle",
    kind: "handle",
    value: "kepthandle",
    confidence: 60,
    source: "beta",
    metadata: { site: "KeptSite", next_verification_step: "KeptPivotStep" },
  }),
  art({
    id: "keep-breach",
    kind: "breach_exposure",
    value: "KeptBreach",
    confidence: 50,
    source: "gamma",
    metadata: { breach_name: "KeptBreach", breach_date: "2019-01-01", exposed_fields: ["Email"] },
  }),
];

/* Rejected rows, every one of them scoring HIGHER than the kept rows — so any
 * surface that ranks by confidence will visibly prefer them if it is fed the
 * unfiltered array. They all share source "zeta", which must not be counted. */
const REJECTED: Artifact[] = [
  // First in the list on purpose: `nextPivots` reads only the first 8 leads, and
  // every fixture row buckets as a lead. Placed any later, the pivot assertion
  // would pass without ever exercising the code path.
  art({
    id: "rej-pivot",
    kind: "email",
    value: "rejected@example.com",
    confidence: 93,
    source: "zeta",
    metadata: { next_verification_step: "RejectedPivotStep" },
  }),
  art({ id: "rej-name", kind: "name", value: "Rejected Person", confidence: 99, source: "zeta" }),
  art({ id: "rej-handle", kind: "handle", value: "rejectedhandle", confidence: 98, source: "zeta", metadata: { site: "RejSite" } }),
  art({
    id: "rej-breach",
    kind: "breach_exposure",
    value: "RejectedBreach",
    confidence: 97,
    source: "zeta",
    metadata: { breach_name: "RejectedBreach", breach_date: "2020-01-01", exposed_fields: ["Password"], password_hash: "rejhash" },
  }),
  art({ id: "rej-phone", kind: "phone", value: "+15550009999", confidence: 96, source: "zeta" }),
  art({ id: "rej-pw1", kind: "password", value: "hunter2", confidence: 95, source: "zeta" }),
  art({ id: "rej-pw2", kind: "password", value: "hunter3", confidence: 94, source: "zeta" }),
  art({
    id: "rej-minor",
    kind: "account",
    value: "minorhandle-do-not-print",
    confidence: 80,
    source: "zeta",
    metadata: { possible_minor: true, site: "MinorSite" },
  }),
];

const REVIEWS: Record<string, ReviewState> = {
  "rej-name": "wrong",
  "rej-handle": "dismissed",
  "rej-breach": "dismissed",
  "rej-phone": "wrong",
  "rej-pw1": "dismissed",
  "rej-pw2": "dismissed",
  "rej-pivot": "dismissed",
  "rej-minor": "dismissed",
};

const ALL = [...KEPT, ...REJECTED];

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const mounted: Array<{ root: Root; host: HTMLElement }> = [];

afterEach(() => {
  for (const { root, host } of mounted.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
});

function renderReport(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  act(() => {
    root.render(
      <CaseReport seedValue="kepthandle" seedType="username" artifacts={ALL} reviews={REVIEWS} />,
    );
  });
  return host;
}

/** The header's metadata chips, as discrete strings. Read as elements rather
 *  than by regex over `textContent`, which concatenates to "…domain3 artifacts4
 *  tools…" and leaves no word boundary in front of the number. */
function headerChips(container: HTMLElement): string[] {
  const header = container.querySelector("header");
  return Array.from(header?.querySelectorAll("span") ?? []).map((s) => s.textContent?.trim() ?? "");
}

/** Everything the report renders EXCEPT the excluded-audit section. */
function analysisText(container: HTMLElement): string {
  const clone = container.cloneNode(true) as HTMLElement;
  clone.querySelector('[data-testid="excluded-audit"]')?.remove();
  return clone.textContent ?? "";
}

describe("CaseReport — analyst-rejected rows are not evidence", () => {
  it("keeps a rejected name out of the subject profile", () => {
    const text = analysisText(renderReport());
    expect(text).not.toContain("Rejected Person");
    expect(text).toContain("Kept Person");
  });

  it("keeps a rejected handle out of the alias list", () => {
    const text = analysisText(renderReport());
    expect(text).not.toContain("rejectedhandle");
    expect(text).toContain("kepthandle");
  });

  it("keeps a rejected phone out of the identity table", () => {
    expect(analysisText(renderReport())).not.toContain("+15550009999");
  });

  it("keeps a rejected breach out of the breach-exposure table", () => {
    const text = analysisText(renderReport());
    expect(text).not.toContain("RejectedBreach");
    expect(text).toContain("KeptBreach");
  });

  it("counts only analysed rows in the header artifact total", () => {
    // 11 rows recorded, 8 rejected, 3 analysed.
    expect(headerChips(renderReport())).toContain("3 artifacts");
  });

  it("averages confidence over analysed rows only", () => {
    // (70 + 60 + 50) / 3 = 60. Including the rejected rows yields 85.
    expect(headerChips(renderReport())).toContain("60% avg confidence");
  });

  it("counts only sources that back analysed rows", () => {
    // alpha, beta, gamma — never zeta.
    expect(headerChips(renderReport())).toContain("3 sources");
  });

  it("does not let rejected credentials drive risk or hunter notes", () => {
    expect(analysisText(renderReport())).not.toContain("Password reuse pattern detected");
  });

  it("does not recommend a pivot off a rejected row", () => {
    const text = analysisText(renderReport());
    expect(text).not.toContain("RejectedPivotStep");
    // Positive half: proves the pivot section still renders, so the negative
    // assertion above cannot pass merely because pivots vanished entirely.
    expect(text).toContain("KeptPivotStep");
  });

  it("retains rejected rows in a labelled excluded section", () => {
    const excluded = renderReport().querySelector('[data-testid="excluded-audit"]');
    expect(excluded).not.toBeNull();
    const text = excluded?.textContent ?? "";
    expect(text).toContain("Rejected by analyst");
    expect(text).toContain("Rejected Person");
  });

  it("redacts a possible-minor value in the excluded section", () => {
    const excluded = renderReport().querySelector('[data-testid="excluded-audit"]');
    const text = excluded?.textContent ?? "";
    expect(text).not.toContain("minorhandle-do-not-print");
    expect(text).toContain(REDACTED_MINOR_PLACEHOLDER);
  });

  it("reconciles recorded = analyzed + excluded rather than showing one number", () => {
    // 11 rows recorded, 3 analysed, 8 excluded. Showing only the analysed count
    // beside an exclusions notice invites the reader to subtract twice.
    const text = renderReport().textContent ?? "";
    expect(text).toContain("11 recorded");
    expect(text).toContain("3 analyzed");
    expect(text).toContain("8 excluded");
  });

  it("still raises the safety flag for a REJECTED possible-minor row", () => {
    // Safety warnings read the full population, never the analysis view — a
    // dismissal must not delete the warning that a minor is implicated.
    expect(renderReport().textContent ?? "").toContain("Safety / Legal Flags");
  });
});
