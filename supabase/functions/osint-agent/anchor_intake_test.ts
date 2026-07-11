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

interface Captured { rows: Array<Record<string, unknown>>; rpc: Array<{ fn: string; args: Record<string, unknown> }>; costs: number[] }

function fakeSupabase(cap: Captured, existing: unknown[] = []) {
  const filter: { eq: (c: string, v: unknown) => typeof filter; limit: (n: number) => Promise<{ data: unknown[]; error: null }> } = {
    eq: () => filter,
    limit: () => Promise.resolve({ data: existing, error: null }),
  };
  return {
    from: (_t: string) => ({
      insert: (rows: unknown[]) => { cap.rows.push(...(rows as Array<Record<string, unknown>>)); return Promise.resolve({ error: null }); },
      select: (_cols: string) => filter,
    }),
    rpc: (fn: string, args: Record<string, unknown>) => { cap.rpc.push({ fn, args }); return Promise.resolve({ data: null, error: null }); },
  };
}

function stubFetch() {
  const orig = globalThis.fetch;
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
  return () => { globalThis.fetch = orig; };
}

Deno.test("anchor read records the anchor as READ, appends chain-of-custody, and meters cost", async () => {
  const restore = stubFetch();
  Deno.env.set("SOCIALFETCH_API_KEY", "test-key");
  Deno.env.set("PERPLEXITY_API_KEY", "test-key");
  try {
    const cap: Captured = { rows: [], rpc: [], costs: [] };
    const res = await runAnchorIntake(
      { kind: "username", raw: "@pjsmakka", normalized: "pjsmakka" },
      { supabase: fakeSupabase(cap), userId: "u1", threadId: "t1", onCost: (m) => cap.costs.push(m) },
    );

    assert(res.ran && res.profile_read && res.serp_read, "profile + SERP were read");
    assert(cap.rows.length > 0, "recorded anchor artifacts before reasoning");

    // READ via a DIRECT_PROFILE source — NOT inferred; execution path is transparent.
    const anchor = cap.rows.find((r) => r.value === "https://www.instagram.com/pjsmakka/" && r.source === "socialfetch_lookup");
    assert(anchor, "anchor IG profile recorded with source=socialfetch_lookup");
    const am = anchor!.metadata as Record<string, unknown>;
    assertEquals(am.provenance, "read_from_profile");
    assertEquals(am.anchor_direct_fetch, true, "execution path is transparent (direct fetch)");
    assertEquals(am.metered_via_wrapper, false);
    assertEquals(am.provider, "socialfetch");
    assertEquals(am.anchor_intake_seed, "pjsmakka", "carries the idempotency key");

    // Review finding #1 — chain of custody: EVERY inserted row also appended evidence.
    const appended = cap.rpc.filter((c) => c.fn === "append_evidence");
    assertEquals(appended.length, cap.rows.length, "one append_evidence per anchor artifact");

    // Review finding #4 — metering: each paid provider read debited cost.
    assert(cap.costs.length >= 2, "socialfetch + perplexity reads were metered via onCost");
    assert(cap.costs.every((c) => c > 0), "each metered read has a positive cost");

    // Review finding #3 — the raw bio is NOT in the (system-prompt) summary; it is
    // isolated inside the untrusted envelope, sanitized.
    assert(!res.summary.includes("LLPOPS"), "raw bio prose stays OUT of the trusted summary");
    assert(res.untrusted.includes("<untrusted_fetched_content"), "external prose is enveloped");
    assert(res.untrusted.includes("LLPOPS"), "bio survives as inert DATA inside the envelope");

    // RELATED accounts carry a relationship, not subject status.
    assert(cap.rows.some((r) => {
      const m = (r.metadata ?? {}) as Record<string, unknown>;
      return m.related_entity === true && String(r.value).includes("raphousetvhq");
    }), "SERP amplifier accounts recorded as RELATED entities");
  } finally {
    restore();
    Deno.env.delete("SOCIALFETCH_API_KEY");
    Deno.env.delete("PERPLEXITY_API_KEY");
  }
});

Deno.test("review finding #2 — a follow-up turn is idempotent (no repeat paid calls/inserts)", async () => {
  const restore = stubFetch();
  Deno.env.set("SOCIALFETCH_API_KEY", "test-key");
  Deno.env.set("PERPLEXITY_API_KEY", "test-key");
  try {
    // The thread already carries an anchor row for this seed → guard returns a hit.
    const cap: Captured = { rows: [], rpc: [], costs: [] };
    const res = await runAnchorIntake(
      { kind: "username", raw: "@pjsmakka", normalized: "pjsmakka" },
      { supabase: fakeSupabase(cap, [{ id: "existing-anchor" }]), userId: "u1", threadId: "t1", onCost: (m) => cap.costs.push(m) },
    );
    assertEquals(res.skipped_existing, true, "second turn skips — already anchored");
    assertEquals(res.ran, false);
    assertEquals(cap.rows.length, 0, "no duplicate artifacts inserted");
    assertEquals(cap.costs.length, 0, "no repeat paid provider calls");
  } finally {
    restore();
    Deno.env.delete("SOCIALFETCH_API_KEY");
    Deno.env.delete("PERPLEXITY_API_KEY");
  }
});
