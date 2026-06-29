import { describe, it, expect } from "vitest";
import { extractDisplaySeed } from "@/lib/seed";

describe("extractDisplaySeed", () => {
  it("passes through a clean email", () => {
    const d = extractDisplaySeed("casey.rivera@example.com", "email");
    expect(d.kind).toBe("email");
    expect(d.selector).toBe("casey.rivera@example.com");
  });

  it("extracts the email from a raw OATHNET blob", () => {
    const blob =
      "=== OATHNET INTELLIGENCE === Found via oathnet.org Date: 2026-06-28T07:52:39.653Z " +
      "Database: zenbusiness.com Source: Security Breaches email: casey.rivera@example.com " +
      "phone national: 2674378035 phone number";
    const d = extractDisplaySeed(blob, "other");
    expect(d.selector).toBe("casey.rivera@example.com");
    expect(d.kind).toBe("email");
    expect(d.title).not.toContain("OATHNET");
  });

  it("falls back to phone when no email present", () => {
    const d = extractDisplaySeed("subject phone national: +12674378035 only", null);
    expect(d.kind).toBe("phone");
    expect(d.selector.replace(/\D/g, "")).toContain("2674378035");
  });

  it("handles empty seed", () => {
    const d = extractDisplaySeed(null, null);
    expect(d.selector).toBe("—");
  });

  it("does not misread an ISO date as a phone", () => {
    const d = extractDisplaySeed("Date: 2026-06-28T07:52:39.653Z domain zenbusiness.com", null);
    expect(d.kind).toBe("domain");
    expect(d.selector).toBe("zenbusiness.com");
  });
});
