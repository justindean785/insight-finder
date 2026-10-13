import { describe, expect, it } from "vitest";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { buildClusterSection, buildIdentityClusters, normalizeHandle } from "@/lib/intel";

let artifactId = 0;

function artifact(
  kind: string,
  value: string,
  metadata: Record<string, unknown> | null = null,
): Artifact {
  artifactId += 1;
  return {
    id: `artifact-${artifactId}`,
    kind,
    value,
    confidence: 80,
    source: "test",
    created_at: "2026-06-12T00:00:00.000Z",
    metadata,
  };
}

/** A passive social-profile observation carrying a platform handle in metadata,
 * the shape SocialFetch/scrape tools actually emit. */
function profile(
  platform: string,
  handle: string,
  opts: { confidence?: number; displayName?: string; bio?: string } = {},
): Artifact {
  artifactId += 1;
  return {
    id: `artifact-${artifactId}`,
    kind: "social_profile",
    value: `https://${platform}.example/@${handle}`,
    confidence: opts.confidence ?? 40,
    source: platform,
    created_at: "2026-06-12T00:00:00.000Z",
    metadata: {
      handle,
      platform,
      ...(opts.displayName ? { display_name: opts.displayName } : {}),
      ...(opts.bio ? { bio: opts.bio } : {}),
    },
  };
}

describe("buildIdentityClusters respects analyst dismissals (integrity)", () => {
  it("an analyst-dismissed email is excluded from identity clusters", () => {
    // Cross-linked email+phone (each names the other) cluster together.
    const email = artifact("email", "kota09131989@gmail.com", { phone: "5307638184" });
    const phone = artifact("phone", "5307638184", { email: "kota09131989@gmail.com" });
    const arts = [email, phone];

    // Baseline: no review → the pair clusters, so the email appears.
    const base = buildIdentityClusters(arts, null);
    expect(base.clusters.flatMap((c) => c.emails)).toContain("kota09131989@gmail.com");

    // Analyst marks the email False → it must NOT seed/strengthen a cluster.
    const reviews = { [email.id]: "dismissed" as const };
    const after = buildIdentityClusters(arts, null, reviews);
    expect(after.clusters.flatMap((c) => c.emails)).not.toContain("kota09131989@gmail.com");
  });

  it("a cluster built only from dismissed artifacts does not survive as CONFIRMED", () => {
    const email = artifact("email", "a@dismissed.com", { phone: "5551110000" });
    const phone = artifact("phone", "5551110000", { email: "a@dismissed.com" });
    const reviews = { [email.id]: "dismissed" as const, [phone.id]: "wrong" as const };
    const report = buildIdentityClusters([email, phone], null, reviews);
    // Dismissed-only evidence yields no surviving identifiers in any cluster.
    expect(report.clusters.flatMap((c) => [...c.emails, ...c.phones])).toHaveLength(0);
    expect(report.clusters.every((c) => c.confidence < 85)).toBe(true);
  });

  it("keeps live evidence while dropping a dismissed sibling in the same bucket", () => {
    const goodEmail = artifact("email", "real@subject.com", { handle: "realsub" });
    const goodHandle = artifact("username", "realsub", { email: "real@subject.com" });
    const wrongEmail = artifact("email", "wrong@person.com", { handle: "realsub" });
    const reviews = { [wrongEmail.id]: "wrong" as const };
    const report = buildIdentityClusters([goodEmail, goodHandle, wrongEmail], null, reviews);
    const emails = report.clusters.flatMap((c) => c.emails);
    expect(emails).toContain("real@subject.com");
    expect(emails).not.toContain("wrong@person.com");
  });
});

describe("buildIdentityClusters shared-infrastructure splitting", () => {
  it("does not collapse three distinct people bridged by one IP selector", () => {
    const artifacts = [
      artifact("name", "Maurice", { parent: "maurice-case" }),
      artifact("ip", "203.0.113.10", { parent: "maurice-case" }),
      artifact("name", "Kyle", { parent: "kyle-case" }),
      artifact("ip", "203.0.113.10", { parent: "kyle-case" }),
      artifact("name", "Angie", { parent: "angie-case" }),
      artifact("ip", "203.0.113.10", { parent: "angie-case" }),
    ];

    const report = buildIdentityClusters(artifacts, null);

    expect(report.clusters).toHaveLength(3);
    expect(report.clusters.map((cluster) => cluster.names[0]).sort()).toEqual([
      "Angie",
      "Kyle",
      "Maurice",
    ]);
    expect(report.clusters.every((cluster) => cluster.ips.includes("203.0.113.10"))).toBe(true);
    expect(report.warnings).toContainEqual(
      expect.stringContaining("Shared-infrastructure split: one ip selector"),
    );
  });

  it("preserves a hard email merge after excluding a shared IP selector", () => {
    const artifacts = [
      artifact("name", "Maurice", { parent: "maurice-case" }),
      artifact("ip", "203.0.113.10", { parent: "maurice-case" }),
      artifact("email", "maurice@example.com", { parent: "maurice-case" }),
      artifact("email", "maurice@example.com", { source_record: "second-source" }),
      artifact("name", "Kyle", { parent: "kyle-case" }),
      artifact("ip", "203.0.113.10", { parent: "kyle-case" }),
      artifact("name", "Angie", { parent: "angie-case" }),
      artifact("ip", "203.0.113.10", { parent: "angie-case" }),
    ];

    const report = buildIdentityClusters(artifacts, null);
    const mauriceCluster = report.clusters.find((cluster) =>
      cluster.emails.includes("maurice@example.com"),
    );

    expect(mauriceCluster?.artifacts).toHaveLength(4);
    expect(mauriceCluster?.names).toContain("Maurice");
    expect(report.clusters.some((cluster) => cluster.names.includes("Kyle"))).toBe(true);
    expect(report.clusters.some((cluster) => cluster.names.includes("Angie"))).toBe(true);
  });

  it("keeps existing infrastructure clustering below the fanout threshold", () => {
    const artifacts = [
      artifact("name", "Maurice", { parent: "maurice-case" }),
      artifact("ip", "203.0.113.10", { parent: "maurice-case" }),
      artifact("name", "Kyle", { parent: "kyle-case" }),
      artifact("ip", "203.0.113.10", { parent: "kyle-case" }),
    ];

    const report = buildIdentityClusters(artifacts, null);

    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0].names.sort()).toEqual(["Kyle", "Maurice"]);
    expect(report.warnings.some((warning) => warning.includes("Shared-infrastructure split"))).toBe(false);
  });

  it("also guards a parent selector that directly fans out to three names", () => {
    const report = buildIdentityClusters([
      artifact("name", "Maurice", { parent: "shared-selector" }),
      artifact("name", "Kyle", { parent: "shared-selector" }),
      artifact("name", "Angie", { parent: "shared-selector" }),
    ], null);

    expect(report.clusters).toHaveLength(3);
    expect(report.warnings).toContainEqual(
      expect.stringContaining("Shared-infrastructure split: one parent selector"),
    );
  });

  it("still splits a surviving cluster when its artifacts conflict by state", () => {
    const report = buildIdentityClusters([
      artifact("name", "Maurice", { parent: "maurice-case" }),
      artifact("address", "10 Main St, Minneapolis, MN", { parent: "maurice-case" }),
      artifact("address", "20 Oak St, Austin, TX", { parent: "maurice-case" }),
    ], null);

    expect(report.clusters).toHaveLength(2);
    expect(report.clusters.map((cluster) => cluster.states[0]).sort()).toEqual(["MN", "TX"]);
    expect(report.clusters.every((cluster) =>
      cluster.warnings.some((warning) => warning.includes("Split from larger cluster")),
    )).toBe(true);
  });

  it("propagates the shared-infrastructure warning into report output", () => {
    const report = buildIdentityClusters([
      artifact("name", "Maurice", { parent: "maurice-case" }),
      artifact("ip", "203.0.113.10", { parent: "maurice-case" }),
      artifact("name", "Kyle", { parent: "kyle-case" }),
      artifact("ip", "203.0.113.10", { parent: "kyle-case" }),
      artifact("name", "Angie", { parent: "angie-case" }),
      artifact("ip", "203.0.113.10", { parent: "angie-case" }),
    ], null);

    expect(buildClusterSection(report)).toContain("Shared-infrastructure split");
  });
});

describe("normalizeHandle", () => {
  it("lowercases, trims, and strips a leading @", () => {
    expect(normalizeHandle("  @NuhDeem ")).toBe("nuhdeem");
  });

  it("removes underscores, periods, and hyphens", () => {
    expect(normalizeHandle("nuh_deem")).toBe("nuhdeem");
    expect(normalizeHandle("nuh.deem")).toBe("nuhdeem");
    expect(normalizeHandle("NUH-DEEM")).toBe("nuhdeem");
  });

  it("preserves alphanumerics so distinct handles stay distinct", () => {
    expect(normalizeHandle("nuhdeem1")).toBe("nuhdeem1");
    expect(normalizeHandle("realnuhdeem")).toBe("realnuhdeem");
    expect(normalizeHandle("nuhdeem_backup")).toBe("nuhdeembackup");
  });
});

describe("buildIdentityClusters handle-based merging (T1-2)", () => {
  const handleReasons = (report: ReturnType<typeof buildIdentityClusters>) =>
    report.clusters.flatMap((c) => c.mergeReasons);

  it("merges exact handle matches across platforms into one cluster", () => {
    const report = buildIdentityClusters([
      profile("instagram", "nuhdeem"),
      profile("tiktok", "nuhdeem"),
      profile("x", "nuhdeem"),
      artifact("username", "nuhdeem"),
    ], null);

    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0].artifacts).toHaveLength(4);
    expect(report.clusters[0].mergeReasons).toContain("HANDLE_MATCH: nuhdeem");
  });

  it("matches handles case-insensitively", () => {
    const report = buildIdentityClusters([
      profile("instagram", "NuhDeem"),
      profile("tiktok", "nuhdeem"),
    ], null);
    expect(report.clusters).toHaveLength(1);
  });

  it("normalizes underscores before matching and records the variant", () => {
    const report = buildIdentityClusters([
      profile("instagram", "nuh_deem"),
      profile("tiktok", "nuhdeem"),
    ], null);
    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0].mergeReasons).toContain("HANDLE_MATCH: nuhdeem");
    expect(report.clusters[0].mergeReasons).toContain("HANDLE_MATCH: nuh_deem -> nuhdeem");
  });

  it("normalizes periods before matching", () => {
    const report = buildIdentityClusters([
      profile("instagram", "nuh.deem"),
      profile("tiktok", "nuhdeem"),
    ], null);
    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0].mergeReasons).toContain("HANDLE_MATCH: nuh.deem -> nuhdeem");
  });

  it("normalizes hyphens before matching", () => {
    const report = buildIdentityClusters([
      profile("instagram", "nuh-deem"),
      profile("tiktok", "nuhdeem"),
    ], null);
    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0].mergeReasons).toContain("HANDLE_MATCH: nuh-deem -> nuhdeem");
  });

  it("platform breadth never scores a handle cluster above its strongest member", () => {
    // Reinforcement used to order handle-only clusters by platform breadth
    // below the handle-only cap. The headline is now bounded by the strongest
    // member's effective confidence (see "the headline never exceeds its
    // strongest member" below): breadth is disclosed in mergeReasons, it is not
    // evidence, and three 20-confidence profiles do not add up to a 40.
    const two = buildIdentityClusters([
      profile("instagram", "nuhdeem", { confidence: 20 }),
      profile("tiktok", "nuhdeem", { confidence: 20 }),
    ], null);
    const three = buildIdentityClusters([
      profile("instagram", "nuhdeem", { confidence: 20 }),
      profile("tiktok", "nuhdeem", { confidence: 20 }),
      profile("x", "nuhdeem", { confidence: 20 }),
    ], null);
    expect(two.clusters).toHaveLength(1);
    expect(three.clusters).toHaveLength(1);
    expect(three.clusters[0].confidence).toBe(20);
    expect(three.clusters[0].confidence).toBeGreaterThanOrEqual(two.clusters[0].confidence);
    expect(three.clusters[0].mergeReasons.some((r) => r.startsWith("HANDLE_MATCH"))).toBe(true);
    // with a stronger member the breadth bonus is visible up to that member
    const mixed = buildIdentityClusters([
      profile("instagram", "nuhdeem", { confidence: 20 }),
      profile("tiktok", "nuhdeem", { confidence: 20 }),
      profile("x", "nuhdeem", { confidence: 50 }),
    ], null);
    expect(mixed.clusters[0].confidence).toBe(50);
  });

  it("does NOT merge a handle with a numeric suffix", () => {
    const report = buildIdentityClusters([
      profile("instagram", "nuhdeem"),
      profile("tiktok", "nuhdeem1"),
    ], null);
    expect(report.clusters).toHaveLength(2);
  });

  it("does NOT merge a handle with a different prefix", () => {
    const report = buildIdentityClusters([
      profile("instagram", "nuhdeem"),
      profile("tiktok", "realnuhdeem"),
    ], null);
    expect(report.clusters).toHaveLength(2);
  });

  it("does NOT merge profiles that share only a display name", () => {
    const report = buildIdentityClusters([
      profile("instagram", "nuhdeem", { displayName: "Deem" }),
      profile("tiktok", "deemsworld", { displayName: "Deem" }),
    ], null);
    expect(report.clusters).toHaveLength(2);
    expect(handleReasons(report)).toHaveLength(0);
  });

  it("does NOT merge profiles that share only bio text", () => {
    const report = buildIdentityClusters([
      profile("instagram", "nuhdeem", { bio: "crash out princess" }),
      profile("tiktok", "someoneelse", { bio: "crash out princess" }),
    ], null);
    expect(report.clusters).toHaveLength(2);
  });

  it("never merges a multi-artifact cluster without an explicit merge reason (safety)", () => {
    const report = buildIdentityClusters([
      profile("instagram", "nuhdeem"),
      profile("tiktok", "nuhdeem"),
      profile("x", "someoneelse", { displayName: "Deem", bio: "crash out princess" }),
    ], null);
    for (const cluster of report.clusters) {
      if (cluster.artifacts.length > 1) {
        expect(cluster.mergeReasons.length).toBeGreaterThan(0);
      }
    }
  });

  it("does not treat one artifact's duplicated handle (value + metadata) as a merge", () => {
    // kind=username carries the handle in BOTH its value and metadata.handle.
    // That is one source, not two, so it must stay a singleton with no reason.
    const single: Artifact = {
      id: "artifact-dup", kind: "username", value: "soloact",
      confidence: 50, source: "test", created_at: "2026-06-12T00:00:00.000Z",
      metadata: { handle: "@soloact" },
    };
    const report = buildIdentityClusters([single], null);
    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0].mergeReasons).toHaveLength(0);
    expect(report.clusters[0].confidence).toBe(50);
  });

  it("leaves shared-infrastructure behavior unchanged and labels its reason", () => {
    // Below the fan-out threshold: a parent selector still merges two names,
    // exposes a SHARED_INFRASTRUCTURE reason, and emits no infra-split warning.
    const report = buildIdentityClusters([
      artifact("name", "Maurice", { parent: "case-x" }),
      artifact("email", "m@example.com", { parent: "case-x" }),
      artifact("email", "m@example.com", { source_record: "second" }),
    ], null);
    expect(report.clusters).toHaveLength(1);
    // The second email row records the SAME selector as the first (#593 keeps such rows separate when their authority
    // differs). Two rows of one email from ONE source class are one email, not a merge — so no EMAIL_MATCH reason.
    expect(report.clusters[0].mergeReasons).not.toContain("EMAIL_MATCH: m@example.com");
    expect(report.clusters[0].mergeReasons.some((r) => r.startsWith("SHARED_INFRASTRUCTURE"))).toBe(true);
    expect(report.warnings.some((w) => w.includes("Shared-infrastructure split"))).toBe(false);
  });
});

describe("buildIdentityClusters handle-only confidence cap (no overstated certainty)", () => {
  it("a handle-only cluster across many platforms does NOT reach confirmed/high-confidence", () => {
    // Same handle seen on 5 platforms, each a high-confidence profile hit, but
    // with NO email/phone/address/identity record. Without the cap this inflated
    // to 100 (base 80 + HANDLE_MATCH 25 + reinforcement 20).
    const report = buildIdentityClusters([
      profile("instagram", "kota", { confidence: 80 }),
      profile("tiktok", "kota", { confidence: 80 }),
      profile("twitter", "kota", { confidence: 80 }),
      profile("twitch", "kota", { confidence: 80 }),
      profile("steam", "kota", { confidence: 80 }),
    ], null);
    // All 5 profiles merge on handle:kota → one cluster (handle lives in
    // metadata, so cluster.usernames is empty for social_profile artifacts).
    expect(report.clusters).toHaveLength(1);
    const c = report.clusters[0];
    expect(c.confidence).toBeLessThanOrEqual(60);
    // Stays in the VERIFY band — below INFERRED(65)/CONFIRMED(85) grade, so it
    // can't contradict the per-artifact labels or read as a confirmed identity.
    expect(c.confidence).toBeLessThan(65);
  });

  it("a broad username with many sweep hits does NOT inflate to 90-100", () => {
    const report = buildIdentityClusters(
      Array.from({ length: 6 }, (_, i) => profile(`platform${i}`, "broadhandle", { confidence: 45 })),
      null,
    );
    expect(report.clusters).toHaveLength(1);
    const c = report.clusters[0];
    expect(c.confidence).toBeLessThan(90);
    expect(c.confidence).toBeLessThanOrEqual(60);
  });

  it("a cluster with REAL corroborating identity evidence (email) is NOT capped", () => {
    // Same handle merge, but an email selector ties it to a real identity.
    const report = buildIdentityClusters([
      profile("instagram", "kota", { confidence: 80 }),
      profile("tiktok", "kota", { confidence: 80 }),
      artifact("email", "kota@example.com", { handle: "kota" }),
    ], null);
    const c = report.clusters.find((x) => x.emails.includes("kota@example.com"))!;
    expect(c).toBeTruthy();
    // Corroborated → keeps its full (high) confidence, well above the cap.
    expect(c.confidence).toBeGreaterThan(60);
  });

  it("an identity-bearing record (breach row with a name) is NOT capped as handle-only", () => {
    const report = buildIdentityClusters([
      profile("instagram", "kota", { confidence: 80 }),
      profile("tiktok", "kota", { confidence: 80 }),
      artifact("breach_exposure", "Acme 2019 — kota", { handle: "kota", full_name: "Real Person" }),
    ], null);
    expect(report.clusters).toHaveLength(1);
    const c = report.clusters[0];
    expect(c.confidence).toBeGreaterThan(60);
  });
});

describe("state-from-address parsing (Ct-suffix regression)", () => {
  it("reads MD, not CT, from a Baltimore address whose street suffix is 'Ct'", () => {
    const report = buildIdentityClusters(
      [artifact("address", "302 S Mason Ct, Baltimore MD 21231")],
      null,
    );
    const states = report.clusters.flatMap((c) => c.states);
    expect(states).toContain("MD");
    expect(states).not.toContain("CT");
  });

  it("reads the ZIP-anchored state for LA/FL/OR addresses and is not fooled by street words", () => {
    const cases: Array<[string, string]> = [
      ["5533 Hollywood Blvd Apt 424, Los Angeles CA 90028", "CA"],
      ["625 S 20th Ave Unit 4, Hollywood FL 33020", "FL"],
      ["123 Park Ave, Portland OR 97201", "OR"],
      ["1 Main St, Indianapolis IN 46204", "IN"],
    ];
    for (const [addr, want] of cases) {
      const report = buildIdentityClusters([artifact("address", addr)], null);
      expect(report.clusters.flatMap((c) => c.states)).toContain(want);
    }
  });
});

describe("buildIdentityClusters — the headline never exceeds its strongest member", () => {
  const mk = (kind: string, value: string, confidence: number, metadata: Record<string, unknown> = {}): Artifact => {
    artifactId += 1;
    return { id: `artifact-${artifactId}`, kind, value, confidence, source: "test", created_at: "2026-06-12T00:00:00.000Z", metadata };
  };

  it("EMAIL_MATCH bonus cannot lift a cluster above its best member", () => {
    const email = "qa.cap@example.invalid";
    const report = buildIdentityClusters([
      mk("email", email, 70),
      mk("breach_exposure", "Breach exposure: qa.cap (hibp)", 65, { email }),
      mk("name", "Q. A. Cap", 60, { email }),
    ], null);
    expect(report.clusters).toHaveLength(1);
    const c = report.clusters[0];
    expect(c.mergeReasons.some((r) => r.startsWith("EMAIL_MATCH"))).toBe(true);
    expect(c.confidence).toBeLessThanOrEqual(70);
    expect(c.confidence).toBeGreaterThanOrEqual(65); // mean 65 + bonus, then capped at 70
  });

  it("a member's server cap (confidence_cap_applied) bounds the mean AND the headline", () => {
    const email = "qa.capped@example.invalid";
    const report = buildIdentityClusters([
      mk("email", email, 55, { confidence_cap_applied: 65 }),
      mk("name", "Q. A. Capped", 95, { email, confidence_cap_applied: 70 }), // stored 95, effective 70
      mk("breach_exposure", "Breach exposure: qa.capped", 55, { email, confidence_cap_applied: 60 }),
    ], null);
    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0].confidence).toBeLessThanOrEqual(70);
    // and the raw 95 did not enter the mean: (55+70+55)/3 = 60, +35 bonus → capped at 70, not 95+
    expect(report.clusters[0].confidence).toBe(70);
  });

  it("a genuinely strong cluster still reads strong (cap is the member, not a constant)", () => {
    const email = "qa.strong@example.invalid";
    const report = buildIdentityClusters([
      mk("email", email, 90),
      mk("phone", "+15555550100", 88, { email }),
      mk("name", "Q. A. Strong", 85, { email, phone: "+15555550100" }),
    ], null);
    expect(report.clusters[0].confidence).toBe(90);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// #593 — twin rows (one selector recorded by two rows) are ONE holder of a key, not two.
// ---------------------------------------------------------------------------------------------------------------------
describe("buildIdentityClusters counts selector holders, not rows (#593 twin rows)", () => {
  const twin = (kind: string, value: string, id: string, source: string, metadata: Record<string, unknown> | null = null): Artifact => ({
    id,
    kind,
    value,
    confidence: 80,
    source,
    created_at: "2026-06-12T00:00:00.000Z",
    metadata,
  });

  it("two rows of the SAME email do not manufacture an EMAIL_MATCH merge reason or its bonus", () => {
    // One email, recorded twice (two tools). Nothing else links anything: this is one selector, not a merge.
    const solo = [twin("email", "m@example.com", "e1", "tool_a")];
    const twins = [twin("email", "m@example.com", "e1", "tool_a"), twin("email", "m@example.com", "e2", "tool_b")];
    const one = buildIdentityClusters(solo, null);
    const two = buildIdentityClusters(twins, null);
    const reasons = two.clusters.flatMap((c) => c.mergeReasons);
    expect(reasons.filter((r) => r.startsWith("EMAIL_MATCH"))).toEqual([]);
    // Same headline either way: a duplicate row neither adds a merge signal nor lifts the cluster.
    expect(two.clusters.map((c) => c.confidence)).toEqual(one.clusters.map((c) => c.confidence));
  });

  it("two rows of the same email from TWO independent source classes are still corroborated (EMAIL_MATCH kept)", () => {
    const twins = [twin("email", "m@example.com", "e1", "hibp"), twin("email", "m@example.com", "e2", "census")];
    const reasons = buildIdentityClusters(twins, null).clusters.flatMap((c) => c.mergeReasons);
    expect(reasons).toContain("EMAIL_MATCH: m@example.com");
  });

  it("ONE row citing two source classes is still one record: no EMAIL_MATCH", () => {
    const one = twin("email", "m@example.com", "e1", "hibp", { source_category: ["breach", "public_record"] });
    const reasons = buildIdentityClusters([one], null).clusters.flatMap((c) => c.mergeReasons);
    expect(reasons.filter((r) => r.startsWith("EMAIL_MATCH"))).toEqual([]);
  });

  it("two rows of the same handle across ONE platform are not a multi-platform HANDLE_MATCH", () => {
    const twins = [
      twin("username", "nuhdeem", "u1", "tool_a"),
      twin("username", "nuhdeem", "u2", "tool_b"),
    ];
    const r = buildIdentityClusters(twins, null);
    expect(r.clusters.flatMap((c) => c.mergeReasons).filter((x) => x.startsWith("HANDLE_MATCH"))).toEqual([]);
  });

  it("DISTINCT selectors that share a derived key still merge (the guard counts holders, it does not hide merges)", () => {
    // Two DIFFERENT selectors (two platform profile URLs) carrying one handle → a real HANDLE_MATCH.
    const r = buildIdentityClusters([profile("instagram", "nuhdeem"), profile("tiktok", "nuhdeem")], null);
    expect(r.clusters.flatMap((c) => c.mergeReasons)).toContain("HANDLE_MATCH: nuhdeem");
  });
});
