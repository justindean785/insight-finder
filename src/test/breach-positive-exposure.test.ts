import { describe, it, expect } from "vitest";
import { isBreachKind, isPositiveBreachExposure } from "@/lib/breach-kinds";

// A breach SWEEP that finds nothing still persists a `breach_exposure` row. Risk
// scoring counted those rows by kind, so "no exposure found" was read as
// exposure. Measured on a live report for thread 9ac01762: three negative rows
// tripped the >= 3 threshold and published
//
//   "Subject appears in 3 distinct breach corpora. Assume credential exposure is
//    broad and that any reused password is in attacker hands."
//
// plus a MEDIUM risk level — in the same report whose breach section stated that
// every one of the four providers returned zero hits.
//
// The three rows below are the real ones from that case.

const NEGATIVES = [
  {
    kind: "breach_exposure",
    value: "NO BREACH EXPOSURE FOUND — +18088974271 clean",
    metadata: { sources: ["oathnet", "serus", "breach_check", "leakcheck"], queries: 7 },
  },
  {
    kind: "breach_exposure",
    value: "ListCrawler has no Hawaii/Honolulu classifieds section — 404 on /classifieds/usa/hawaii",
    metadata: { status: 404 },
  },
  {
    kind: "breach_exposure",
    value: "No escort listing found on BackpageGals Honolulu containing 8088974271 — number absent from 1,768 active listings",
    metadata: { listings_checked: 1768 },
  },
];

describe("isPositiveBreachExposure", () => {
  it("does not count the three real negative rows that caused the false MEDIUM risk", () => {
    for (const a of NEGATIVES) {
      expect(isBreachKind(a.kind)).toBe(true); // still breach-SHAPED, for grouping
      expect(isPositiveBreachExposure(a)).toBe(false); // but not exposure
    }
    expect(NEGATIVES.filter(isPositiveBreachExposure)).toHaveLength(0);
  });

  it("counts a record carrying a corpus name", () => {
    expect(isPositiveBreachExposure({
      kind: "breach_exposure",
      metadata: { breach_name: "Collection #1", breach_date: "2019-01-07" },
    })).toBe(true);
  });

  it("counts a record carrying exposed field classes", () => {
    expect(isPositiveBreachExposure({
      kind: "breach_exposure",
      metadata: { exposed_fields: ["email", "password_hash"] },
    })).toBe(true);
  });

  it("counts a record carrying a concrete leaked value", () => {
    expect(isPositiveBreachExposure({
      kind: "credential_exposure",
      metadata: { password_hash: "5f4dcc3b5aa765d61d8327deb882cf99" },
    })).toBe(true);
  });

  it("counts a record carrying a non-empty corpus list", () => {
    expect(isPositiveBreachExposure({
      kind: "breach_exposure",
      metadata: { breach_corpora: ["LinkedIn", "Adobe"] },
    })).toBe(true);
  });

  it("treats EMPTY structural fields as no exposure", () => {
    // A provider that returns the shape but no content is still a negative.
    expect(isPositiveBreachExposure({
      kind: "breach_exposure",
      metadata: { breach_corpora: [], exposed_fields: [], breach_name: "  ", breach_count: 0 },
    })).toBe(false);
  });

  it("honours an explicit negative marker even if other fields are present", () => {
    expect(isPositiveBreachExposure({
      kind: "breach_exposure",
      metadata: { no_exposure: true, breach_name: "queried: Collection #1" },
    })).toBe(false);
    expect(isPositiveBreachExposure({
      kind: "breach_exposure",
      metadata: { exposure_found: false, exposed_fields: ["email"] },
    })).toBe(false);
  });

  it("never counts a non-breach kind, however rich its metadata", () => {
    expect(isPositiveBreachExposure({
      kind: "address",
      metadata: { breach_name: "Collection #1", exposed_fields: ["email"] },
    })).toBe(false);
  });

  it("is null-safe", () => {
    expect(isPositiveBreachExposure(null)).toBe(false);
    expect(isPositiveBreachExposure(undefined)).toBe(false);
    expect(isPositiveBreachExposure({ kind: "breach_exposure" })).toBe(false);
    expect(isPositiveBreachExposure({ kind: "breach_exposure", metadata: null })).toBe(false);
  });

  it("does not read the artifact's prose", () => {
    // Structural only. A record whose text says "breach found" but carries no
    // exposure metadata is still not counted — and, more importantly, a real
    // record is counted regardless of how the provider worded its summary.
    expect(isPositiveBreachExposure({
      kind: "breach_exposure",
      value: "MASSIVE BREACH FOUND — credentials exposed everywhere",
      metadata: {},
    })).toBe(false);
    expect(isPositiveBreachExposure({
      kind: "breach_exposure",
      value: "nothing to see here",
      metadata: { exposed_fields: ["password"] },
    })).toBe(true);
  });
});
