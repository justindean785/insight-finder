/**
 * source_classification_origin_test.ts — origin identity vs source reliability.
 *
 * FIXTURES ARE SYNTHETIC. Nothing here is real case data. (`asec.ahnlab.com`
 * and `x.com` are public hostnames named because they are the two shapes in
 * ORIGIN_CLASS_MAP's motivating defect; no case content is reproduced.)
 *
 * THE DEFECT. `classifySource`'s slug fast path strips a trailing parenthetical
 * qualifier BEFORE classifying, so "socialfetch_web_read (asec.ahnlab.com/...)"
 * and "socialfetch_web_read (x.com/...)" both reduced to the bare tool slug and
 * classified identically — a security vendor's published threat research read
 * as equivalent to viewing an active social-media profile, purely because one
 * generic web-read tool fetched both.
 *
 * These tests DRIVE `countIndependentClasses` (the shipped corroboration
 * counter that `lib/finding-row.ts` calls on the record_finding path), not just
 * `classifySource`, because the count is where the defect had consequences.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifySource,
  classifySourceWithOrigin,
  countIndependentClasses,
  type SourceClass,
} from "./source-classification.ts";

const count = (sources: readonly string[]): number =>
  countIndependentClasses(sources.map(classifySourceWithOrigin));

/* ── reliability: an explicitly mapped origin overrides the tool slug ────── */

Deno.test("a mapped origin classifies by ORIGIN, not by the tool that fetched it", () => {
  assertEquals(
    classifySource("socialfetch_web_read (asec.ahnlab.com/en/94918)"),
    "independent_public",
  );
  // The regression this closes: the same tool, an unmapped origin, still
  // classifies by slug — so the assertion above is about the ORIGIN, not about
  // socialfetch_web_read having been reclassified wholesale.
  assertEquals(
    classifySource("socialfetch_web_read (x.com/DarkWebInformer/status/1)"),
    "social_profile_active",
  );
});

Deno.test("a www. prefix and a deep path reach the same origin identity", () => {
  for (
    const s of [
      "socialfetch_web_read (asec.ahnlab.com)",
      "socialfetch_web_read (www.asec.ahnlab.com/en/94918)",
      "socialfetch_web_read (https://asec.ahnlab.com/en/1?x=2)",
    ]
  ) {
    assertEquals(classifySourceWithOrigin(s).originId, "asec.ahnlab.com", s);
    assertEquals(classifySource(s), "independent_public", s);
  }
});

/* ── non-URL parentheticals must not engage origin logic AT ALL ──────────── */

Deno.test("a non-URL parenthetical qualifier is untouched by origin logic", () => {
  // These two shapes are load-bearing elsewhere in the codebase. If origin
  // extraction ever starts matching them, their classification silently moves.
  const unchanged: ReadonlyArray<[string, SourceClass]> = [
    ["socialfetch_lookup (instagram)", "social_profile_passive"],
    ["serus_darkweb_scan (reveal:true)", "breach"],
  ];
  for (const [source, expected] of unchanged) {
    assertEquals(classifySourceWithOrigin(source).originId, null, source);
    assertEquals(classifySource(source), expected, source);
  }
});

Deno.test("an IP-address qualifier yields no origin identity", () => {
  // Deliberate: an IP is not a vetted publisher identity, and treating one as
  // an origin would let a shared host masquerade as a distinct source.
  assertEquals(
    classifySourceWithOrigin("socialfetch_web_read (198.51.100.7/x)").originId,
    null,
  );
});

/* ── independence: the count is what the defect actually corrupted ───────── */

Deno.test("two genuinely different origins corroborate each other", () => {
  assertEquals(
    count([
      "socialfetch_web_read (asec.ahnlab.com/en/94918)",
      "socialfetch_web_read (x.com/DarkWebInformer/status/1)",
    ]),
    2,
  );
});

Deno.test("one mapped origin reached by two different tools is ONE source", () => {
  assertEquals(
    count([
      "socialfetch_web_read (asec.ahnlab.com/en/1)",
      "jina_reader_scrape (asec.ahnlab.com/en/2)",
    ]),
    1,
  );
});

Deno.test("one UNMAPPED origin reached by two different tools is ONE source", () => {
  // The scenario that needs origin TRACKING, not merely consistent
  // classification: x.com is not in ORIGIN_CLASS_MAP, so the two tools resolve
  // to two different default classes (social_profile_active vs
  // independent_public). Dedup by class alone would call that corroboration.
  const entries = [
    "socialfetch_web_read (x.com/acct/status/1)",
    "jina_reader_scrape (x.com/acct/status/1)",
  ].map(classifySourceWithOrigin);
  assertEquals(new Set(entries.map((e) => e.sourceClass)).size, 2);
  assertEquals(countIndependentClasses(entries), 1);
});

Deno.test("an origin nobody has vetted is still tracked for independence", () => {
  // "Fail conservatively" means "do not invent a new reliability tier for an
  // unrecognized hostname" — NOT "do not track it". An unmapped origin keeps
  // today's slug classification but must still collapse to one source.
  const entries = [
    "socialfetch_web_read (unvetted-example.org/a)",
    "jina_reader_scrape (unvetted-example.org/b)",
  ].map(classifySourceWithOrigin);
  for (const e of entries) {
    assertEquals(e.originId, "unvetted-example.org");
  }
  assertEquals(countIndependentClasses(entries), 1);
});

Deno.test("a non-corroborating class stays non-corroborating whatever its origin", () => {
  // gemini_vision -> ai_summary, which NON_CORROBORATING_CLASSES excludes. An
  // origin must not smuggle it back into the count.
  assertEquals(count(["gemini_vision (x.com/acct/status/1)"]), 0);
  assertEquals(
    count([
      "gemini_vision (x.com/acct/status/1)",
      "socialfetch_web_read (x.com/acct/status/1)",
    ]),
    1,
  );
});

/* ── direction of travel: origin tracking may only ever DEFLATE ──────────── */

Deno.test("an origin-keyed source does not also count through an origin-less entry", () => {
  // Both entries are independent_public; one carries an origin, one cannot.
  // Keying the first by origin and the second by class would report 2 where
  // the pre-origin code reported 1 — this PR INFLATING a corroboration count,
  // the exact failure mode it exists to close. Order must not matter, which is
  // why the counter resolves every origin before judging any origin-less entry.
  const a = "socialfetch_web_read (asec.ahnlab.com/en/1)";
  const b = "jina_reader_scrape";
  assertEquals(classifySource(a), "independent_public");
  assertEquals(classifySource(b), "independent_public");
  assertEquals(classifySourceWithOrigin(b).originId, null);
  assertEquals(count([a, b]), 1);
  assertEquals(count([b, a]), 1);
});

Deno.test("a distinct origin-less class is NOT swallowed by a covered one", () => {
  // The guard above must suppress only a DUPLICATE class, never a different
  // one — otherwise it would under-count real corroboration.
  assertEquals(
    count([
      "socialfetch_web_read (asec.ahnlab.com/en/1)", // independent_public
      "serus_darkweb_scan (reveal:true)", // breach
    ]),
    2,
  );
});

/* ── backward compatibility of the widened signature ─────────────────────── */

Deno.test("plain SourceClass[] input behaves exactly as before the signature widened", () => {
  // finding-synthesis.ts and confidence.ts's deriveStatus still pass bare
  // classes. Pinned against the original one-line implementation.
  const legacy = (classes: readonly SourceClass[]): number =>
    new Set(
      classes.filter((c) =>
        !(new Set<SourceClass>([
          "unknown",
          "web_search",
          "ai_summary",
          "username_sweep",
          "social_profile_passive",
          "social_review",
          "infra_shared_host",
          "threat_intel",
        ])).has(c)
      ),
    ).size;

  const cases: ReadonlyArray<readonly SourceClass[]> = [
    [],
    ["breach"],
    ["breach", "breach"],
    ["breach", "court_record"],
    ["web_search", "unknown", "ai_summary"],
    ["threat_intel", "breach"],
    ["independent_public", "social_profile_active", "infra_shared_host"],
    ["court_record", "news", "archive", "public_record"],
  ];
  for (const c of cases) {
    assertEquals(countIndependentClasses(c), legacy(c), JSON.stringify(c));
  }
});
