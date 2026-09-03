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
 * The guard is operator-specified and deliberately blunt: a local-part must be
 * >= 8 characters AND not a generic role address. Both must pass. Without it,
 * every `info@` in the corpus would merge into one entity.
 */
const mk = (p: { id: string; kind: string; value: string; metadata?: Record<string, unknown> }): Artifact => ({
  id: p.id,
  kind: p.kind,
  value: p.value,
  confidence: 60,
  source: "oathnet_lookup",
  created_at: "2026-09-03T11:10:45Z",
  metadata: p.metadata ?? null,
});

const clustered = (arts: Artifact[], seed: string | null, a: string, b: string): boolean => {
  const { clusters } = buildIdentityClusters(arts, seed);
  return clusters.some((c) => c.artifacts.some((x) => x.id === a) && c.artifacts.some((x) => x.id === b));
};

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
    // dotted local-part could never match the handle it obviously is.
    const email = mk({ id: "e", kind: "email", value: "vern.jjulian@gmail.com" });
    const handle = mk({ id: "u", kind: "username", value: "vernjjulian" });
    expect(clustered([email, handle], null, "e", "u")).toBe(true);
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

  // OPEN QUESTION — pins CURRENT spec behaviour, not a recommendation.
  //
  // The floor is measured on the RAW local-part, as specified. `v.e.r.n.j@` is 9
  // raw characters so it clears the >= 8 floor, but `normalizeHandle` strips the
  // separators and it becomes the 5-character handle `vernj`. Separators can
  // therefore pad a short handle over the floor.
  //
  // Closing it means requiring the NORMALISED form to clear the floor too, which
  // costs almost nothing legitimate (`vern.jjulian` -> `vernjjulian` = 11,
  // `fitz.vette` -> `fitzvette` = 9 both still pass). Left as specified pending
  // the operator's ruling; flip this assertion when it is made.
  it("SPEC AS WRITTEN: separators can pad a short local-part over the floor", () => {
    const email = mk({ id: "e", kind: "email", value: "v.e.r.n.j@example.com" });
    const handle = mk({ id: "u", kind: "username", value: "vernj" });
    expect(clustered([email, handle], null, "e", "u")).toBe(true);
  });

  it("two unrelated people are NOT merged just because both have emails", () => {
    const a = mk({ id: "a", kind: "email", value: "vernjjulian@gmail.com" });
    const b = mk({ id: "b", kind: "email", value: "sactownyaya@yahoo.com" });
    expect(clustered([a, b], null, "a", "b")).toBe(false);
  });

  it("existing email-to-email merging is untouched", () => {
    const email = mk({ id: "e", kind: "email", value: "vernjjulian@gmail.com" });
    const breach = mk({ id: "b", kind: "breach_exposure", value: "vernjjulian@gmail.com in ApexSMS", metadata: { email: "vernjjulian@gmail.com" } });
    expect(clustered([email, breach], null, "e", "b")).toBe(true);
  });
});
