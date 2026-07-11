// anchor_intake_test.ts — WP1: the anchor read runs deterministically at intake
// (before the model's first turn / the breadth sweep) and records the primary
// profile as a READ with real source attribution, plus SERP-surfaced related
// accounts as RELATED entities. Pure parsers covered too.
// Run: deno test --no-check --allow-env anchor_intake_test.ts
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { runAnchorIntake } from "./anchor-intake.ts";
import { extractProfileEntities, parseSerpEntities, seedToHandle } from "./anchor-parse.ts";

// ---- Pure parsers ------------------------------------------------------------

Deno.test("seedToHandle strips @ and reads a social URL", () => {
  assertEquals(seedToHandle({ kind: "username", raw: "@PJSmakka", normalized: "pjsmakka" }), "pjsmakka");
  assertEquals(seedToHandle({ kind: "url", raw: "https://www.instagram.com/pjsmakka/", normalized: "https://www.instagram.com/pjsmakka" }), "pjsmakka");
  assertEquals(seedToHandle({ kind: "email", raw: "a@b.com", normalized: "a@b.com" }), null);
});

Deno.test("extractProfileEntities reads bio/name/counts/links/related", () => {
  const ent = extractProfileEntities({
    handle: "onlythepressure_noextras", displayName: "onlythepressure_noextras",
    bio: "Lifestyle. Backup: @onlythepressure_noextrastv", followers: 15867, following: 79,
    verified: true, externalUrl: "http://x.com/p", bioLinks: ["linktr.ee/otp"],
  });
  assertEquals(ent.followers, 15867);
  assert(ent.verified);
  assert(ent.relatedHandles.includes("onlythepressure_noextrastv"));
  assert(!ent.relatedHandles.includes("onlythepressure_noextras"));
});

Deno.test("parseSerpEntities mines related accounts + seed profile url", () => {
  const answer = "Pj Smakka (@pjsmakka) — jail cooking. Related: @raphousetvhq @youngdeji_. https://www.instagram.com/pjsmakka/";
  const ent = parseSerpEntities(answer, ["https://www.instagram.com/dillonchaseok/"], "pjsmakka");
  assertEquals(ent.seedProfileUrl, "https://www.instagram.com/pjsmakka/");
  assert(ent.relatedHandles.includes("raphousetvhq"));
  assert(ent.relatedHandles.includes("dillonchaseok"));
  assert(!ent.relatedHandles.includes("pjsmakka"));
});

// ---- Integration: anchor read records READ provenance ------------------------

function fakeSupabase(captured: Array<Record<string, unknown>>) {
  return {
    from: (_t: string) => ({
      insert: (rows: unknown[]) => {
        captured.push(...(rows as Array<Record<string, unknown>>));
        return Promise.resolve({ error: null });
      },
    }),
  };
}

Deno.test("anchor read fetches the profile + SERP and records the anchor as READ (not inferred)", async () => {
  const origFetch = globalThis.fetch;
  Deno.env.set("SOCIALFETCH_API_KEY", "test-key");
  Deno.env.set("PERPLEXITY_API_KEY", "test-key");
  // Stub network: SocialFetch profile + Perplexity SERP.
  globalThis.fetch = ((input: Request | URL | string): Promise<Response> => {
    const url = String((input as Request).url ?? input);
    if (url.includes("socialfetch.dev")) {
      return Promise.resolve(new Response(JSON.stringify({
        data: { lookupStatus: "found", handle: "pjsmakka", displayName: "Pj Smakka", bio: "LLPOPS LLBOODAH LLRICH", followers: 512, following: 492, verified: false, bioLinks: [] },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    }
    if (url.includes("perplexity.ai")) {
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: "Pj Smakka (@pjsmakka) is a jail-cooking creator. Related: @raphousetvhq @inmateswithtalent. https://www.instagram.com/pjsmakka/" } }],
        citations: ["https://www.instagram.com/dillonchaseok/"],
      }), { status: 200, headers: { "content-type": "application/json" } }));
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  }) as typeof fetch;

  try {
    const captured: Array<Record<string, unknown>> = [];
    const res = await runAnchorIntake(
      { kind: "username", raw: "@pjsmakka", normalized: "pjsmakka" },
      { supabase: fakeSupabase(captured), userId: "u1", threadId: "t1" },
    );

    assert(res.ran, "anchor intake ran");
    assert(res.profile_read, "profile was read");
    assert(res.serp_read, "SERP was read");
    assert(captured.length > 0, "recorded anchor artifacts before reasoning");

    // The anchor Instagram profile is recorded as a READ via a DIRECT_PROFILE
    // source — NOT constructed/inferred from a search summary.
    const anchor = captured.find((r) => r.value === "https://www.instagram.com/pjsmakka/" && r.source === "socialfetch_lookup");
    assert(anchor, "anchor IG profile recorded with source=socialfetch_lookup (a real fetch)");
    const am = anchor!.metadata as Record<string, unknown>;
    assertEquals(am.provenance, "read_from_profile");
    assertEquals(am.read, true);
    assertEquals(am.bio, "LLPOPS LLBOODAH LLRICH");
    assertEquals(am.followers, 512);

    // SERP-surfaced amplifier accounts are RELATED entities, not subjects.
    const related = captured.filter((r) => {
      const m = (r.metadata ?? {}) as Record<string, unknown>;
      return m.related_entity === true && typeof m.relationship_to_subject === "string";
    });
    assert(related.length >= 1, "related accounts recorded with relationship_to_subject");
    assert(related.some((r) => String(r.value).includes("raphousetvhq")));

    // The SERP identity summary was READ (not a bare constructed URL).
    const serpSummary = captured.find((r) => {
      const m = (r.metadata ?? {}) as Record<string, unknown>;
      return m.provenance === "read_from_serp" && typeof m.identity_summary === "string";
    });
    assert(serpSummary, "SERP identity summary recorded as read_from_serp");
  } finally {
    globalThis.fetch = origFetch;
    Deno.env.delete("SOCIALFETCH_API_KEY");
    Deno.env.delete("PERPLEXITY_API_KEY");
  }
});
