import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildTools } from "./tool-registry.ts";

/**
 * youtube_oembed / roblox_user / steam_profile — the free, keyless replacements
 * for the three hosts socialfetch_web_read provably cannot read (2026-09-30
 * audit: 0 of 10 real YouTube reads, 0 of 3 Roblox, every Steam attempt aborted
 * at the 18s cap).
 *
 * Each tool is asserted on FOUR shapes, because each means something different
 * to the analyst and they must never collapse into one another:
 *   success        → ok:true,  found:true
 *   not found      → ok:true,  found:false   (a real negative about the target)
 *   malformed body → ok:false, error         (a tool fault, never a negative)
 *   transport fail → { error }, never a throw (an unhandled throw kills the run)
 *
 * The not-found/fault split is the point: "this account does not exist" is
 * evidence, "the provider sent us garbage" is not, and an upstream 200 with an
 * error document inside it (Steam) or an empty array (Roblox) is the former
 * dressed as the latter.
 */

type Exec = { execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>> };

function tool(name: string): Exec {
  const ctx = {
    supabase: { from: () => ({ insert: () => Promise.resolve({ error: null }) }) },
    supabaseAdmin: { from: () => ({ insert: () => Promise.resolve({ error: null }) }) },
    userId: "free-tools-test-user",
    threadId: "free-tools-test-thread",
    archiveEnabled: false,
    detectedSeedType: "username",
    messages: [],
    manualOverrideSelector: null,
  } as unknown as Parameters<typeof buildTools>[0];
  const { tools } = buildTools(ctx);
  return (tools as Record<string, Exec>)[name];
}

async function withFetch(
  handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  body: () => Promise<void>,
) {
  const orig = globalThis.fetch;
  try {
    globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) =>
      await handler(input instanceof Request ? input.url : String(input), init)) as typeof globalThis.fetch;
    await body();
  } finally {
    globalThis.fetch = orig;
  }
}

const abortError = () => {
  throw new DOMException("The signal has been aborted", "AbortError");
};

// ---- youtube_oembed --------------------------------------------------------

Deno.test("youtube_oembed: success returns title + channel", async () => {
  await withFetch(
    () => new Response(JSON.stringify({
      title: "Example Video", author_name: "Example Channel",
      author_url: "https://www.youtube.com/@example", thumbnail_url: "https://i.ytimg.com/x.jpg",
    }), { status: 200 }),
    async () => {
      const r = await tool("youtube_oembed").execute({ url: "https://www.youtube.com/watch?v=u4uo2Y-fsgU" }, {});
      assertEquals(r.ok, true);
      assertEquals(r.found, true);
      assertEquals(r.title, "Example Video");
      assertEquals(r.author_name, "Example Channel");
    },
  );
});

Deno.test("youtube_oembed: 401/404 are real negatives, not faults", async () => {
  for (const [status, reason] of [[401, "private"], [404, "not_found"]] as const) {
    await withFetch(
      () => new Response("", { status }),
      async () => {
        const r = await tool("youtube_oembed").execute({ url: "https://youtu.be/gone" }, {});
        // ok:true — the lookup worked; the VIDEO is absent. A false here would
        // let the failed-tools panel count a correct answer as a broken tool.
        assertEquals(r.ok, true);
        assertEquals(r.found, false);
        assertEquals(r.reason, reason);
      },
    );
  }
});

Deno.test("youtube_oembed: malformed JSON is a fault, not a negative", async () => {
  await withFetch(
    () => new Response("<html>nope</html>", { status: 200 }),
    async () => {
      const r = await tool("youtube_oembed").execute({ url: "https://youtu.be/x" }, {});
      assertEquals(r.ok, false);
      assert(String(r.error).includes("non-JSON"));
    },
  );
});

Deno.test("youtube_oembed: transport abort returns { error }, never throws", async () => {
  await withFetch(abortError, async () => {
    const r = await tool("youtube_oembed").execute({ url: "https://youtu.be/x" }, {});
    assert(typeof r.error === "string" && r.error.length > 0);
  });
});

// ---- roblox_user -----------------------------------------------------------

Deno.test("roblox_user: username resolves to id then profile", async () => {
  await withFetch(
    (url) => url.includes("/usernames/users")
      ? new Response(JSON.stringify({ data: [{ id: 12345 }] }), { status: 200 })
      : new Response(JSON.stringify({
        id: 12345, name: "someuser", displayName: "Some User",
        created: "2015-01-02T03:04:05Z", isBanned: false, description: "hello",
      }), { status: 200 }),
    async () => {
      const r = await tool("roblox_user").execute({ username: "someuser" }, {});
      assertEquals(r.ok, true);
      assertEquals(r.found, true);
      assertEquals(r.id, 12345);
      assertEquals(r.displayName, "Some User");
      assertEquals(r.profile_url, "https://www.roblox.com/users/12345/profile");
    },
  );
});

Deno.test("roblox_user: unknown username returns 200 with an EMPTY array — found:false", async () => {
  await withFetch(
    () => new Response(JSON.stringify({ data: [] }), { status: 200 }),
    async () => {
      const r = await tool("roblox_user").execute({ username: "definitely-not-real" }, {});
      assertEquals(r.ok, true);
      assertEquals(r.found, false);
    },
  );
});

Deno.test("roblox_user: bio is bounded to 500 chars (prompt budget)", async () => {
  await withFetch(
    (url) => url.includes("/usernames/users")
      ? new Response(JSON.stringify({ data: [{ id: 7 }] }), { status: 200 })
      : new Response(JSON.stringify({ id: 7, name: "a", description: "x".repeat(4000) }), { status: 200 }),
    async () => {
      const r = await tool("roblox_user").execute({ username: "a" }, {});
      assertEquals(String(r.description).length, 500);
    },
  );
});

Deno.test("roblox_user: needs a selector; malformed body is a fault; abort returns { error }", async () => {
  const missing = await tool("roblox_user").execute({}, {});
  assert(String(missing.error).includes("username or user_id"));

  await withFetch(
    () => new Response("not json", { status: 200 }),
    async () => {
      const r = await tool("roblox_user").execute({ user_id: 7 }, {});
      assertEquals(r.ok, false);
      assert(String(r.error).includes("non-JSON"));
    },
  );
  await withFetch(abortError, async () => {
    const r = await tool("roblox_user").execute({ user_id: 7 }, {});
    assert(typeof r.error === "string" && r.error.length > 0);
  });
});

// ---- steam_profile ---------------------------------------------------------

const STEAM_OK = `<?xml version="1.0"?><profile>
<steamID64>76561197960287930</steamID64><steamID><![CDATA[Rabscuttle]]></steamID>
<realname><![CDATA[Real Name]]></realname><location>CA</location>
<memberSince>January 1, 2004</memberSince><privacyState>public</privacyState></profile>`;

Deno.test("steam_profile: parses the ?xml=1 document", async () => {
  await withFetch(
    () => new Response(STEAM_OK, { status: 200 }),
    async () => {
      const r = await tool("steam_profile").execute({ vanity: "rabscuttle" }, {});
      assertEquals(r.ok, true);
      assertEquals(r.found, true);
      assertEquals(r.steamID64, "76561197960287930");
      assertEquals(r.steamID, "Rabscuttle");
      assertEquals(r.realname, "Real Name");
      assertEquals(r.privacyState, "public");
      assertEquals(r.profile_url, "https://steamcommunity.com/id/rabscuttle");
    },
  );
});

Deno.test("steam_profile: HTTP 200 carrying an <error> document is found:false, not ok:false", async () => {
  await withFetch(
    () => new Response("<?xml version=\"1.0\"?><response><error>The specified profile could not be found.</error></response>", { status: 200 }),
    async () => {
      const r = await tool("steam_profile").execute({ vanity: "nope" }, {});
      // This is the trap the tool exists to avoid: Steam answers 200 for a
      // profile that does not exist, so status alone would record a hit.
      assertEquals(r.ok, true);
      assertEquals(r.found, false);
      assert(String(r.reason).includes("could not be found"));
    },
  );
});

Deno.test("steam_profile: accepts a full URL and needs some selector", async () => {
  await withFetch(
    () => new Response(STEAM_OK, { status: 200 }),
    async () => {
      const r = await tool("steam_profile").execute(
        { url: "https://steamcommunity.com/profiles/76561197960287930/?snr=1" }, {});
      assertEquals(r.found, true);
      assertEquals(r.profile_url, "https://steamcommunity.com/profiles/76561197960287930");
    },
  );
  const missing = await tool("steam_profile").execute({}, {});
  assert(String(missing.error).includes("url, steamid64 or vanity"));
});

// ⚠️ This test previously asserted `ok:true, found:false` for a maintenance
// page, which contradicted this file's own header contract and MANUFACTURED
// EVIDENCE: Steam answers 200 with a maintenance page, an age/consent
// interstitial, a rate-limit notice or a truncated body, none of which carry an
// <error> element — and "no <steamID64>" was being reported as "this account
// does not exist", then cached as that for the TTL. Only a recognized <error>
// document is a successful negative. Raised in review on this branch.
Deno.test("steam_profile: an unrecognized 200 body is a tool FAULT, never a negative", async () => {
  for (const body of [
    "<html>maintenance</html>",
    "",
    "<?xml version=\"1.0\"?><profile><steamI",            // truncated
    "<html><body>Age verification required</body></html>",
  ]) {
    await withFetch(
      () => new Response(body, { status: 200 }),
      async () => {
        const r = await tool("steam_profile").execute({ vanity: "x" }, {});
        assertEquals(r.ok, false, `must not be a success: ${body.slice(0, 24)}`);
        assertEquals(r.found, undefined, "must not claim anything about the account");
        assertEquals(r.failure_class, "malformed_response");
      },
    );
  }
});

Deno.test("steam_profile: the <error> document stays the ONLY successful negative", async () => {
  await withFetch(
    () => new Response("<response><error>The specified profile could not be found.</error></response>", { status: 200 }),
    async () => {
      const r = await tool("steam_profile").execute({ vanity: "nope" }, {});
      assertEquals(r.ok, true);
      assertEquals(r.found, false);
    },
  );
});

Deno.test("steam_profile: abort returns { error }, never a throw", async () => {
  await withFetch(abortError, async () => {
    const r = await tool("steam_profile").execute({ vanity: "x" }, {});
    assert(typeof r.error === "string" && r.error.length > 0);
  });
});
