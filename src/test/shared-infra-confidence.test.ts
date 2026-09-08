import { describe, expect, it } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { buildIdentityClusters } from "@/lib/intel";

/**
 * Shared infrastructure is a RELATIONSHIP lead, never identity corroboration.
 *
 * A cluster whose only merge evidence is repeated handles is capped at 60 (the
 * VERIFY band) because a username seen on many platforms does not establish who
 * the person is. `hasIdentityCorroboration` lifts that cap — and it counted
 * SHARED_INFRASTRUCTURE, a bare `addresses` list and a bare `ips` list as
 * corroboration. All three are shared-by-construction:
 *
 *   - an address is shared by a HOUSEHOLD, a building, a mail drop, a registered agent
 *   - an IP is shared by a VPN exit, a carrier NAT, a corporate egress, a coffee shop
 *   - a parent domain is shared by every tenant of a hosting provider
 *
 * So two unrelated people behind one CGNAT, or a subject and their landlord at
 * one building, could reach CONFIRMED (>=85) on handle breadth alone. That is
 * the inflation these tests pin shut.
 *
 * What must NOT change: shared infra still MERGES the cluster and still appears
 * as a merge reason. It is demoted from proof to lead, not deleted.
 */

let seq = 0;
function artifact(
  kind: string,
  value: string,
  metadata: Record<string, unknown> | null = null,
  confidence = 80,
): Artifact {
  seq += 1;
  return {
    id: `art-${seq}`,
    kind,
    value,
    confidence,
    source: "test",
    created_at: "2026-08-29T00:00:00.000Z",
    metadata,
  };
}

/** A handle observation on one platform — the raw material of a handle-only cluster. */
function profile(platform: string, handle: string): Artifact {
  seq += 1;
  return {
    id: `art-${seq}`,
    kind: "social_profile",
    value: `https://${platform}.example/@${handle}`,
    confidence: 60,
    source: platform,
    created_at: "2026-08-29T00:00:00.000Z",
    metadata: { handle, platform },
  };
}

/** Handle breadth alone drives the raw score well above the cap. */
function handleSpread(handle: string): Artifact[] {
  return ["twitter", "github", "tiktok", "instagram", "reddit"].map((p) => profile(p, handle));
}

function topConfidence(artifacts: Artifact[]): number {
  const report = buildIdentityClusters(artifacts, null);
  expect(report.clusters.length, "expected at least one cluster").toBeGreaterThan(0);
  return Math.max(...report.clusters.map((c) => c.confidence));
}

const CAP = 60;

/**
 * THREE DOORS lift the cap, and shared infrastructure can reach all of them:
 *
 *   A. the selector-list door — `addresses.length > 0` / `ips.length > 0`
 *   B. the merge-signal door  — `signalsPresent.has("SHARED_INFRASTRUCTURE")`,
 *      reachable from an address / ip / wallet / parent key shared by >=2 artifacts
 *   C. the identity-record door — a metadata row whose only identity-bearing key
 *      is `address`
 *
 * The parent-domain path has no selector list, so it reaches only door B. Each
 * door is tested separately: closing one and leaving another open would look
 * green on a summary test.
 */
describe("shared infrastructure is a lead, not identity corroboration", () => {
  it("baseline: handles alone stay at or below the cap", () => {
    // Guards the guard — if this ever exceeds the cap the tests below prove nothing.
    expect(topConfidence(handleSpread("nightjar"))).toBeLessThanOrEqual(CAP);
  });

  it("PATH 1 / door A — a shared ADDRESS selector must not lift the cap", () => {
    // A household, a building, a mail drop. Two people at one address are not
    // one person.
    const artifacts = [
      ...handleSpread("nightjar"),
      artifact("address", "1110 Sample Ave Apt 3F, Anytown NY 10001"),
    ];
    expect(topConfidence(artifacts)).toBeLessThanOrEqual(CAP);
  });

  it("PATH 1 / door B — an address shared by two artifacts must not lift the cap", () => {
    // Reaches the SHARED_INFRASTRUCTURE merge signal rather than the list.
    const artifacts = [
      ...handleSpread("nightjar"),
      artifact("social_profile", "https://x.example/@nightjar", {
        handle: "nightjar", platform: "x", address: "1110 Sample Ave Apt 3F",
      }),
      artifact("social_profile", "https://y.example/@nightjar", {
        handle: "nightjar", platform: "y", address: "1110 Sample Ave Apt 3F",
      }),
    ];
    expect(topConfidence(artifacts)).toBeLessThanOrEqual(CAP);
  });

  it("PATH 2 / door A — a shared IP selector must not lift the cap", () => {
    // VPN exit, carrier NAT, corporate egress, coffee shop.
    const artifacts = [
      ...handleSpread("nightjar"),
      artifact("ip", "203.0.113.42"),
    ];
    expect(topConfidence(artifacts)).toBeLessThanOrEqual(CAP);
  });

  it("PATH 2 / door B — an IP shared by two artifacts must not lift the cap", () => {
    const artifacts = [
      ...handleSpread("nightjar"),
      artifact("ip", "203.0.113.42"),
      artifact("ip", "203.0.113.42"),
    ];
    expect(topConfidence(artifacts)).toBeLessThanOrEqual(CAP);
  });

  it("PATH 3 / door B — a shared PARENT DOMAIN must not lift the cap", () => {
    // Every tenant of a hosting provider shares this. There is no `parents`
    // selector list, so the merge signal is the ONLY door this path reaches —
    // which needs the key on two artifacts to count as a merge.
    const artifacts = [
      ...handleSpread("nightjar"),
      artifact("domain", "a.example.com", { parent: "example.com" }),
      artifact("domain", "b.example.com", { parent: "example.com" }),
    ];
    expect(topConfidence(artifacts)).toBeLessThanOrEqual(CAP);
  });

  it("door C — an address-ONLY metadata record must not lift the cap", () => {
    // IDENTITY_BEARING_META_KEYS contains "address", so a row carrying nothing
    // but an address counted as an identity-bearing record. An address does not
    // name a person.
    const artifacts = [
      ...handleSpread("nightjar"),
      artifact("breach_exposure", "acme-2019", { address: "1110 Sample Ave Apt 3F" }),
    ];
    expect(topConfidence(artifacts)).toBeLessThanOrEqual(CAP);
  });

  it("all paths together still do not lift the cap", () => {
    // Stacking weak signals must not manufacture strength.
    const artifacts = [
      ...handleSpread("nightjar"),
      artifact("address", "1110 Sample Ave Apt 3F, Anytown NY 10001"),
      artifact("ip", "203.0.113.42"),
      artifact("ip", "203.0.113.42"),
      artifact("domain", "a.example.com", { parent: "example.com" }),
      artifact("domain", "b.example.com", { parent: "example.com" }),
    ];
    expect(topConfidence(artifacts)).toBeLessThanOrEqual(CAP);
  });
});

describe("genuine identity corroboration still lifts the cap", () => {
  it("an EMAIL selector lifts it", () => {
    // The address is deliberately NOT `nightjar@…`. An email whose local-part
    // spells the cluster's own handle is a different case entirely — it unions
    // through `emailHandleKey`, and that derived link is non-corroborating by
    // design (see the derived-link test below, and email-handle-linkage.test.ts).
    // Before that link existed the two shapes were indistinguishable here, so
    // this fixture was ambiguous rather than wrong; disambiguating it keeps the
    // test measuring what its name says.
    const artifacts = [...handleSpread("nightjar"), artifact("email", "j.vale.1987@example.test")];
    expect(topConfidence(artifacts)).toBeGreaterThan(CAP);
  });

  it("but an email spelled FROM the handle does NOT lift it", () => {
    // `nightjar@…` reaches the cluster only because its local-part is the same
    // string as the handle. One name compared with itself is not a second
    // source, so the cap stands.
    const artifacts = [...handleSpread("nightjar"), artifact("email", "nightjar@example.test")];
    expect(topConfidence(artifacts)).toBe(CAP);
  });

  it("a PHONE selector lifts it", () => {
    const artifacts = [...handleSpread("nightjar"), artifact("phone", "+19175550123")];
    expect(topConfidence(artifacts)).toBeGreaterThan(CAP);
  });

  it("an identity-bearing record NAMING a person lifts it", () => {
    const artifacts = [
      ...handleSpread("nightjar"),
      artifact("breach_exposure", "acme-2019", { full_name: "Jordan Vale", address: "1110 Sample Ave" }),
    ];
    expect(topConfidence(artifacts)).toBeGreaterThan(CAP);
  });

  it("shared infra PLUS a genuine signal lifts it — infra is not penalised", () => {
    // The fix demotes infra; it must not make a corroborated cluster worse.
    const artifacts = [
      ...handleSpread("nightjar"),
      artifact("ip", "203.0.113.42"),
      artifact("email", "j.vale.1987@example.test"),
    ];
    expect(topConfidence(artifacts)).toBeGreaterThan(CAP);
  });
});

describe("shared infrastructure still merges — demoted, not deleted", () => {
  it("a shared address still groups the artifacts into one cluster", () => {
    const artifacts = [
      artifact("email", "a@example.test", { address: "1110 Sample Ave Apt 3F" }),
      artifact("email", "b@example.test", { address: "1110 Sample Ave Apt 3F" }),
    ];
    const report = buildIdentityClusters(artifacts, null);
    const merged = report.clusters.find((c) => c.artifacts.length >= 2);
    expect(merged, "shared address must still merge the cluster").toBeDefined();
  });

  it("the shared-infrastructure merge reason is still reported", () => {
    const artifacts = [
      artifact("email", "a@example.test", { address: "1110 Sample Ave Apt 3F" }),
      artifact("email", "b@example.test", { address: "1110 Sample Ave Apt 3F" }),
    ];
    const report = buildIdentityClusters(artifacts, null);
    const reasons = report.clusters.flatMap((c) => c.mergeReasons ?? []).join(" ");
    expect(reasons).toMatch(/SHARED_INFRASTRUCTURE/);
  });
});
