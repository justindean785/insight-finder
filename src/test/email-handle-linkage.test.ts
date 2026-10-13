import { describe, it, expect } from "vitest";
import { buildIdentityClusters } from "@/lib/intel";
import type { Artifact } from "@/hooks/useThreadArtifacts";

/**
 * An email's local-part IS a handle, and clustering never knew it.
 *
 * Production thread `b4e575a6` (2026-09-03), phone seed. The run found
 * `vernjjulian@gmail.com` from a breach corpus, and `hackerrank.com/vernjjulian`
 * plus `t.me/vernjjulian` from a username sweep. All three carry the same
 * literal token. They landed in THREE different clusters, because an email emits
 * `email:<address>` and a profile emits `handle:<username>` — different
 * keyspaces that can never union.
 *
 * The cost is not cosmetic. Merged, that cluster holds two independent source
 * classes (breach + username_sweep) and clears the CONFIRMED bar. Fragmented,
 * every cluster holds one, so the engine adjudicated ZERO findings on a case
 * whose answer was sitting in the artifact table. Corpus-wide that is 17
 * findings across 10,933 artifacts.
 *
 * THE LINK IS NOT FREE, AND THE SECOND HALF OF THIS FILE IS WHY. Measured on
 * that same thread: `oathnet_lookup(5307105091)` at 11:10:44 produced the
 * email, and `username_sweep(vernjjulian)` ran 19 seconds later on the email's
 * own local-part. The sweep hits EXIST BECAUSE the local-part was pivoted, so
 * they cannot be read back as independent corroboration OF that email. Corpus
 * scan (2026-09-07): 95 (thread, local-part) pairs union this way, and five of
 * them declare the derivation in the artifact's own `source` string —
 * `derived_from_email`, `email_localpart`, `seed_derivation`,
 * `derived from email dilei870430@yahoo.com.ca (local-part)`,
 * `seed email local-part + fingerprint.to export`.
 *
 * So the link ships, and the derived key is marked non-corroborating: it merges,
 * it shows up as a merge reason, and it may NOT lift HANDLE_ONLY_CLUSTER_CAP.
 *
 * The emission guard is operator-specified and deliberately blunt: a local-part
 * must be >= 8 characters RAW **and** >= 8 after `normalizeHandle` strips
 * separators, and must not be a generic role address. All must pass.
 */
const CAP = 60;

const mk = (p: {
  id: string;
  kind: string;
  value: string;
  metadata?: Record<string, unknown>;
  confidence?: number;
  source?: string;
}): Artifact => ({
  id: p.id,
  kind: p.kind,
  value: p.value,
  confidence: p.confidence ?? 60,
  source: p.source ?? "oathnet_lookup",
  created_at: "2026-09-03T11:10:45Z",
  metadata: p.metadata ?? null,
});

const clustered = (arts: Artifact[], seed: string | null, a: string, b: string): boolean => {
  const { clusters } = buildIdentityClusters(arts, seed);
  return clusters.some((c) => c.artifacts.some((x) => x.id === a) && c.artifacts.some((x) => x.id === b));
};

/** Confidence of the cluster holding `id`, or null when nothing clusters it. */
const clusterConfidenceOf = (arts: Artifact[], id: string): number | null => {
  const { clusters } = buildIdentityClusters(arts, null);
  const c = clusters.find((x) => x.artifacts.some((a) => a.id === id));
  return c ? c.confidence : null;
};

// ── Production fixture, transcribed from thread b4e575a6 ────────────────────
// Values, kinds, sources, stored confidences and confidence_cap_applied are the
// real persisted columns (read 2026-09-07 via query_database).
const prodEmailOathnet = mk({
  id: "e1", kind: "email", value: "vernjjulian@gmail.com",
  confidence: 45, source: "oathnet_lookup",
  metadata: { confidence_cap_applied: 60, source_category: ["breach"] },
});
const prodEmailBreachCheck = mk({
  id: "e2", kind: "email", value: "vernjjulian@gmail.com",
  confidence: 60, source: "breach_check (ApexSMS breach)",
  metadata: { confidence_cap_applied: 60, source_category: ["breach"] },
});
const prodSweptHackerRank = mk({
  id: "s1", kind: "social_profile", value: "https://www.hackerrank.com/vernjjulian",
  confidence: 45, source: "username_sweep",
  metadata: { confidence_cap_applied: 45, platform: "HackerRank", username: "vernjjulian", source_category: ["username_sweep"] },
});
const prodSweptTelegram = mk({
  id: "s2", kind: "social_profile", value: "https://t.me/vernjjulian",
  confidence: 45, source: "username_sweep",
  metadata: { confidence_cap_applied: 45, platform: "Telegram", username: "vernjjulian", source_category: ["username_sweep"] },
});
const PROD = [prodEmailOathnet, prodEmailBreachCheck, prodSweptHackerRank, prodSweptTelegram];

describe("email local-part links to a same-named handle", () => {
  it("⛔ THE CASE: the breach email and the swept profile land in one cluster", () => {
    const email = mk({ id: "e", kind: "email", value: "vernjjulian@gmail.com" });
    const profile = mk({
      id: "p", kind: "social_profile", value: "https://www.hackerrank.com/vernjjulian",
      metadata: { platform: "HackerRank", username: "vernjjulian" },
    });
    expect(clustered([email, profile], "5307105091", "e", "p")).toBe(true);
  });

  it("links a standalone username artifact too", () => {
    const email = mk({ id: "e", kind: "email", value: "fitzvette5370@sbcglobal.net" });
    const handle = mk({ id: "u", kind: "username", value: "fitzvette5370" });
    expect(clustered([email, handle], null, "e", "u")).toBe(true);
  });

  it("normalises the emitted key into the handle keyspace, so separators do not block a merge", () => {
    // `normalizeHandle` strips _ . - , so the email key must go through it or a
    // dotted local-part could never match the handle it obviously is. The
    // normalised form is 11 characters, so the floor below is not in play.
    const email = mk({ id: "e", kind: "email", value: "vern.jjulian@gmail.com" });
    const handle = mk({ id: "u", kind: "username", value: "vernjjulian" });
    expect(clustered([email, handle], null, "e", "u")).toBe(true);
  });

  it("the production rows merge into ONE cluster, not four", () => {
    const { clusters } = buildIdentityClusters(PROD, "5307105091");
    const c = clusters.find((x) => x.artifacts.some((a) => a.id === "e2"));
    expect(c, "the email must be clustered").toBeTruthy();
    expect(c!.artifacts.map((a) => a.id).sort()).toEqual(["e1", "e2", "s1", "s2"]);
  });

  it("keeps the merge legible — the handle match is still a stated reason", () => {
    const { clusters } = buildIdentityClusters(PROD, "5307105091");
    const c = clusters.find((x) => x.artifacts.some((a) => a.id === "e2"))!;
    expect(c.mergeReasons.some((r) => r.startsWith("HANDLE_MATCH"))).toBe(true);
    // Quarantine-by-silence is the failure mode this project keeps hitting: a
    // refusal has to be legible AS a refusal. The link is demoted, not deleted.
    expect(c.mergeReasons.some((r) => r.includes("vernjjulian"))).toBe(true);
  });
});

describe("a derived email→handle link cannot corroborate the evidence that produced it", () => {
  it("⛔ THE DEFECT: a pivot-derived handle does not lift the handle-only cap", () => {
    // The ONE fixture change from production: the breach email's stored
    // confidence and server cap are raised 60 -> 85.
    //
    // WHY THAT CHANGE IS NECESSARY AND WHAT IT COSTS. On the literal production
    // figures every member is capped at 45-60, so `memberMax` alone pins the
    // headline to 60 and this assertion would pass with the guard DELETED —
    // vacuous. Raising the email's own ceiling is the minimum edit that makes
    // the guard the only thing standing between the cluster and 85. It also
    // means the 85 -> 60 correction below is a MODELLED consequence, not an
    // observed production regression: what production proves is the pivot
    // provenance, not this arithmetic.
    const richEmail = mk({
      id: "e2", kind: "email", value: "vernjjulian@gmail.com",
      confidence: 85, source: "breach_check (ApexSMS breach)",
      metadata: { confidence_cap_applied: 85, source_category: ["breach"] },
    });
    const arts = [prodEmailOathnet, richEmail, prodSweptHackerRank, prodSweptTelegram];

    // Still one cluster — the link is permitted.
    expect(clustered(arts, null, "e2", "s1")).toBe(true);
    // But the headline stays in the VERIFY band.
    expect(clusterConfidenceOf(arts, "e2")).toBeLessThanOrEqual(CAP);
  });

  it("the cap holds even though the email side agrees with itself (EMAIL_MATCH)", () => {
    // Two artifacts carry `vernjjulian@gmail.com` from two INDEPENDENT source
    // classes (breach + public_record), so EMAIL_MATCH is a genuine merge
    // signal. It corroborates THE EMAIL. It says nothing about whether the
    // swept accounts belong to that email's owner, and the only thing joining
    // them is the local-part spelled twice.
    //
    // (#593: the second row used to be a second BREACH record, the same class as
    // the first. Two rows of one selector from ONE class are a duplicate, not a
    // corroboration — see the next test — so this fixture now brings its own
    // class, keeping the test about the cap and not about duplicate counting.)
    const richEmail = mk({
      id: "e2", kind: "email", value: "vernjjulian@gmail.com",
      confidence: 85, source: "breach_check (ApexSMS breach)",
      metadata: { confidence_cap_applied: 85, source_category: ["public_record"] },
    });
    const { clusters } = buildIdentityClusters(
      [prodEmailOathnet, richEmail, prodSweptHackerRank, prodSweptTelegram], null);
    const c = clusters.find((x) => x.artifacts.some((a) => a.id === "e2"))!;
    expect(c.mergeReasons.some((r) => r.startsWith("EMAIL_MATCH"))).toBe(true);
    expect(c.confidence).toBeLessThanOrEqual(CAP);
  });

  it("two rows of the same email from ONE class are a duplicate: no EMAIL_MATCH, and the cap still holds", () => {
    const sameClassTwin = mk({
      id: "e2", kind: "email", value: "vernjjulian@gmail.com",
      confidence: 85, source: "breach_check (ApexSMS breach)",
      metadata: { confidence_cap_applied: 85 },
    });
    const { clusters } = buildIdentityClusters(
      [prodEmailOathnet, sameClassTwin, prodSweptHackerRank, prodSweptTelegram], null);
    const c = clusters.find((x) => x.artifacts.some((a) => a.id === "e2"))!;
    expect(c.mergeReasons.some((r) => r.startsWith("EMAIL_MATCH"))).toBe(false);
    expect(c.confidence).toBeLessThanOrEqual(CAP);
  });

  it("an email that joins by something REAL still lifts the cap", () => {
    // Same shape, one difference that matters: the swept profile independently
    // carries the address, so the two sides are joined by `email:` as well as by
    // the derived handle. Remove the derived key and the cluster still stands —
    // so the link is not load-bearing and nothing is withheld.
    const email = mk({
      id: "e", kind: "email", value: "vernjjulian@gmail.com", confidence: 85,
      metadata: { confidence_cap_applied: 85 },
    });
    const profile = mk({
      id: "p", kind: "social_profile", value: "https://www.hackerrank.com/vernjjulian",
      confidence: 80, source: "socialfetch_lookup",
      metadata: { platform: "HackerRank", username: "vernjjulian", email: "vernjjulian@gmail.com" },
    });
    expect(clustered([email, profile], null, "e", "p")).toBe(true);
    expect(clusterConfidenceOf([email, profile], "e")).toBeGreaterThan(CAP);
  });

  it("a phone in the cluster still lifts the cap — only the email door is conditioned", () => {
    const email = mk({
      id: "e", kind: "email", value: "vernjjulian@gmail.com", confidence: 85,
      metadata: { confidence_cap_applied: 85, phone: "+15307105091" },
    });
    const phone = mk({ id: "ph", kind: "phone", value: "+15307105091", confidence: 85 });
    const profile = mk({
      id: "p", kind: "social_profile", value: "https://t.me/vernjjulian",
      metadata: { platform: "Telegram", username: "vernjjulian" },
    });
    expect(clusterConfidenceOf([email, phone, profile], "p")).toBeGreaterThan(CAP);
  });

  it("an identity-bearing record still lifts the cap", () => {
    const email = mk({
      id: "e", kind: "email", value: "vernjjulian@gmail.com", confidence: 85,
      metadata: { confidence_cap_applied: 85 },
    });
    const breach = mk({
      id: "b", kind: "breach_exposure", value: "vernjjulian@gmail.com in ApexSMS", confidence: 85,
      metadata: { email: "vernjjulian@gmail.com", full_name: "Vernon Julian" },
    });
    const profile = mk({
      id: "p", kind: "social_profile", value: "https://t.me/vernjjulian",
      metadata: { platform: "Telegram", username: "vernjjulian" },
    });
    expect(clusterConfidenceOf([email, breach, profile], "p")).toBeGreaterThan(CAP);
  });

  it("NO DOUBLE COUNTING: the derived key does not invent a second platform", () => {
    // The reinforce bonus pays per PLATFORM beyond the first two. An email is not
    // a platform observation of the handle, so a lone email plus a lone profile
    // must not read as two platforms' worth of breadth.
    const email = mk({ id: "e", kind: "email", value: "vernjjulian@gmail.com" });
    const profile = mk({
      id: "p", kind: "social_profile", value: "https://t.me/vernjjulian",
      metadata: { platform: "Telegram", username: "vernjjulian" },
    });
    expect(clusterConfidenceOf([email, profile], "e")).toBeLessThanOrEqual(CAP);
  });

  it("NO DOUBLE COUNTING: an artifact stating the handle twice counts once", () => {
    // value AND metadata.username carry the same handle; the pre-existing
    // per-artifact de-dup must survive the derived-key change.
    const email = mk({ id: "e", kind: "email", value: "vernjjulian@gmail.com" });
    const twice = mk({
      id: "p", kind: "username", value: "vernjjulian",
      metadata: { username: "vernjjulian", handle: "vernjjulian" },
    });
    const { clusters } = buildIdentityClusters([email, twice], null);
    const c = clusters.find((x) => x.artifacts.some((a) => a.id === "e"))!;
    const handleReasons = c.mergeReasons.filter((r) => r === "HANDLE_MATCH: vernjjulian");
    expect(handleReasons).toHaveLength(1);
  });

  it("quarantined rows stay out — the derived key is not a way back in", () => {
    const email = mk({ id: "e", kind: "email", value: "vernjjulian@gmail.com" });
    const quarantined = mk({
      id: "q", kind: "username", value: "vernjjulian",
      metadata: {
        subject_unlinked: true,
        subject_unlinked_reason: "harvested from a name-only query — same-name collision axis",
      },
    });
    expect(clustered([email, quarantined], null, "e", "q")).toBe(false);
  });
});

describe("NEGATIVE CONTROLS — the guard that stops the corpus collapsing", () => {
  it("a denylisted role address never emits a handle key", () => {
    // 10 chars, clears the length floor, and is exactly why the floor alone is
    // not enough.
    const email = mk({ id: "e", kind: "email", value: "postmaster@example.com" });
    const handle = mk({ id: "u", kind: "username", value: "postmaster" });
    expect(clustered([email, handle], null, "e", "u")).toBe(false);
  });

  it("every generic prefix on the denylist is refused", () => {
    for (const local of [
      "info", "admin", "contact", "hello", "support", "noreply", "no-reply",
      "postmaster", "webmaster", "mail", "help", "team", "sales", "billing",
    ]) {
      const email = mk({ id: "e", kind: "email", value: `${local}@example.com` });
      const handle = mk({ id: "u", kind: "username", value: local });
      expect(clustered([email, handle], null, "e", "u"), `${local} must not link`).toBe(false);
    }
  });

  it("a short local-part is refused even when it is not generic", () => {
    const email = mk({ id: "e", kind: "email", value: "fitzvet@example.com" }); // 7 chars
    const handle = mk({ id: "u", kind: "username", value: "fitzvet" });
    expect(clustered([email, handle], null, "e", "u")).toBe(false);
  });

  // RULED 2026-09-07 (was an open question in the first cut of this file).
  // The floor is now measured on the NORMALISED form as well as the raw one,
  // because the normalised form is the key that actually unions.
  it("separators may NOT pad a short local-part over the floor", () => {
    const email = mk({ id: "e", kind: "email", value: "v.e.r.n.j@example.com" }); // 9 raw, 5 normalised
    const handle = mk({ id: "u", kind: "username", value: "vernj" });
    expect(clustered([email, handle], null, "e", "u")).toBe(false);
  });

  it("the seven production local-parts that clear the raw floor and fail the normalised one", () => {
    // Measured 2026-09-07 across the artifact corpus: 7 distinct local-parts, 8
    // rows, all 8 raw characters and 7 normalised. Initial-plus-surname stubs
    // are the shape most likely to collide across unrelated people.
    for (const local of ["dr_orian", "chad-lfc", "chad_438", "jon.lind", "m.newman", "t.sipply", "it.slife"]) {
      const norm = local.replace(/[_.-]/g, "");
      const email = mk({ id: "e", kind: "email", value: `${local}@example.com` });
      const handle = mk({ id: "u", kind: "username", value: norm });
      expect(clustered([email, handle], null, "e", "u"), `${local} must not link`).toBe(false);
    }
  });

  it("the floor is measured, not guessed — 8 normalised characters still links", () => {
    // `nando_mfr` -> `nandomfr` is exactly 8 and is a real production local-part.
    const email = mk({ id: "e", kind: "email", value: "nando_mfr@example.com" });
    const handle = mk({ id: "u", kind: "username", value: "nandomfr" });
    expect(clustered([email, handle], null, "e", "u")).toBe(true);
  });

  it("two unrelated people are NOT merged just because both have emails", () => {
    const a = mk({ id: "a", kind: "email", value: "vernjjulian@gmail.com" });
    const b = mk({ id: "b", kind: "email", value: "sactownyaya@yahoo.com" });
    expect(clustered([a, b], null, "a", "b")).toBe(false);
  });

  it("the metadata-email path emits the derived key too, and it is still non-corroborating", () => {
    // A breach row that NAMES an email in metadata (kind is breach_exposure, not
    // email) must reach the same handle keyspace — otherwise half the corpus's
    // emails never link. Production shape: `breach_check` rows carrying
    // `metadata.email`.
    const breach = mk({
      id: "b", kind: "breach_exposure", value: "vernjjulian@gmail.com in ApexSMS", confidence: 85,
      metadata: { email: "vernjjulian@gmail.com", confidence_cap_applied: 85 },
    });
    const profile = mk({
      id: "p", kind: "social_profile", value: "https://t.me/vernjjulian",
      metadata: { platform: "Telegram", username: "vernjjulian" },
    });
    expect(clustered([breach, profile], null, "b", "p")).toBe(true);
    expect(clusterConfidenceOf([breach, profile], "b")).toBeLessThanOrEqual(CAP);
  });

  it("a derived key reached through metadata is derived too", () => {
    // Mutation control (M4). If only the VALUE path is marked derived, the
    // metadata path silently re-opens the door: the breach row's
    // `metadata.email` would emit an "observed" handle key, the cluster would
    // hold together without the value-path key, and EMAIL_MATCH would lift the
    // cap on a group whose handle side still joined by name alone.
    const email = mk({
      id: "e", kind: "email", value: "vernjjulian@gmail.com", confidence: 85,
      metadata: { confidence_cap_applied: 85 },
    });
    const breach = mk({
      id: "b", kind: "breach_exposure", value: "vernjjulian@gmail.com in ApexSMS", confidence: 85,
      metadata: { email: "vernjjulian@gmail.com", confidence_cap_applied: 85 },
    });
    const profile = mk({
      id: "p", kind: "social_profile", value: "https://t.me/vernjjulian",
      metadata: { platform: "Telegram", username: "vernjjulian" },
    });
    const arts = [email, breach, profile];
    expect(clustered(arts, null, "e", "p")).toBe(true);
    expect(clusterConfidenceOf(arts, "e")).toBeLessThanOrEqual(CAP);
  });

  it("existing email-to-email merging is untouched", () => {
    const email = mk({ id: "e", kind: "email", value: "vernjjulian@gmail.com" });
    const breach = mk({ id: "b", kind: "breach_exposure", value: "vernjjulian@gmail.com in ApexSMS", metadata: { email: "vernjjulian@gmail.com" } });
    expect(clustered([email, breach], null, "e", "b")).toBe(true);
  });

  it("NOTHING OUTSIDE THE SCOPE MOVES: a cluster with no derived key is bit-identical", () => {
    // No email anywhere, so `emailHandleKey` is never called and the new
    // component walk can never find a second component. Drive the same
    // artifacts through and pin the whole shape, not just the headline.
    const arts = [
      mk({ id: "u", kind: "username", value: "vernjjulian", confidence: 70 }),
      mk({ id: "p1", kind: "social_profile", value: "https://t.me/vernjjulian", confidence: 70, metadata: { platform: "Telegram", username: "vernjjulian" } }),
      mk({ id: "p2", kind: "social_profile", value: "https://x.com/vernjjulian", confidence: 70, metadata: { platform: "X", username: "vernjjulian" } }),
      mk({ id: "ph", kind: "phone", value: "+15307105091", confidence: 70, metadata: { handle: "vernjjulian" } }),
    ];
    const { clusters } = buildIdentityClusters(arts, null);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].artifacts.map((a) => a.id).sort()).toEqual(["p1", "p2", "ph", "u"]);
    expect(clusters[0].confidence).toBe(70); // phone lifts the cap; memberMax bounds it
    expect(clusters[0].mergeReasons).toContain("HANDLE_MATCH: vernjjulian");
  });
});
