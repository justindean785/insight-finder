/**
 * sweeper_evidence_test.ts — a 2xx is NOT proof of registration.
 *
 * THE BUG THIS PINS (measured in production 2026-08-06 on a live username run):
 * `sweepUsername` decided existence from the HTTP STATUS alone for 89 of its 95
 * sites (`found = r.status !== 404 && r.status < 400`). Any platform that serves a
 * signup form or an SPA shell at 200 for a missing user — a soft-404 — was counted
 * as a confirmed registration.
 *
 * Downstream that became `"<handle> — 21 platform registrations"`, and the
 * independent scrapes disagreed with it in the same run: Bandcamp "domain is
 * available/unclaimed. No active profile", HackTheBox "'Not Found' — account may
 * not exist", Bluesky "returned empty/no content". The same platform set had
 * already been marked FALSE by the analyst on an earlier case.
 * Verified against the live endpoint: `pypi.org/user/<impossible-handle>/`
 * returns 200 with a body that never names the user.
 *
 * All fixtures below are SYNTHETIC (RFC 2606-style reserved names). Never pin a
 * test to a real investigation subject: this file is mirror-synced to a
 * third-party-owned repository.
 *
 * The contract: a hit requires POSITIVE evidence. Everything reachable-but-
 * unproven is reported as `unverified` — surfaced as a lead, never counted.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { sweepUsername } from "./sweeper.ts";

const realFetch = globalThis.fetch;

/** Serve a canned (status, body) for every sweep URL, keyed by substring. */
function stubFetch(route: (url: string) => { status: number; body: string }) {
  globalThis.fetch = ((input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    const { status, body } = route(url);
    return Promise.resolve(new Response(body, { status }));
  }) as typeof fetch;
}

function restore() {
  globalThis.fetch = realFetch;
}

Deno.test("a 200 soft-404 that never names the user is NOT a registration", async () => {
  // Every site answers 200 with a signup page — the PyPI/Bandcamp shape.
  stubFetch(() => ({
    status: 200,
    body: "<html><title>Sign up</title><body>Create your account today</body></html>",
  }));
  try {
    const r = await sweepUsername("exampleuser710");
    assertEquals(r.hits, 0, "a signup shell must never count as a registration");
    assertEquals(r.found.length, 0);
    assert(r.unverified.length > 0, "it must still be surfaced as an unverified lead");
    // The evidence is not destroyed — just correctly labelled.
    assert(r.unverified.every((u) => u.found === false && u.unverified === true));
  } finally {
    restore();
  }
});

Deno.test("a 200 whose body names the account IS a registration", async () => {
  stubFetch(() => ({
    status: 200,
    body: "<html><title>exampleuser710 (Example User)</title><body>profile</body></html>",
  }));
  try {
    const r = await sweepUsername("exampleuser710");
    assert(r.hits > 0, "a page that evidences the account must still be found");
    assertEquals(r.unverified.length, 0);
  } finally {
    restore();
  }
});

Deno.test("case-insensitive: ExampleUser710 on the page evidences exampleuser710", async () => {
  stubFetch(() => ({ status: 200, body: "<h1>ExampleUser710</h1>" }));
  try {
    const r = await sweepUsername("exampleuser710");
    assert(r.hits > 0, "handle casing must not decide existence");
  } finally {
    restore();
  }
});

Deno.test("a definitive 404 stays a proven absence, not an unverified lead", async () => {
  stubFetch(() => ({ status: 404, body: "not found" }));
  try {
    const r = await sweepUsername("exampleuser710");
    assertEquals(r.hits, 0);
    assertEquals(r.unverified.length, 0, "404 is PROVEN absent — never 'unverified'");
    assert(r.missed.length > 0);
  } finally {
    restore();
  }
});

Deno.test("an explicit absent-marker body still wins over a username echo", async () => {
  // Telegram's marker is `tgme_page_title`; the page also echoes the handle.
  // A not-found page that names the user must not be rescued by the echo test.
  // NB: match the ORIGIN exactly — "about.me/<u>" also contains the substring
  // "t.me/", which would hand this stub to the wrong site.
  stubFetch((url) => (
    url.startsWith("https://t.me/")
      ? { status: 200, body: "<div>tgme_page_title</div> exampleuser710" }
      : { status: 404, body: "nope" }
  ));
  try {
    const r = await sweepUsername("exampleuser710");
    assertEquals(r.hits, 0, "the absent marker is authoritative");
    assert(!r.found.some((f) => f.site === "Telegram"));
  } finally {
    restore();
  }
});

Deno.test("the reported count never absorbs unverified pages", async () => {
  // Half the estate evidences the account, half serves a shell.
  stubFetch((url) => (
    url.includes("pypi.org") || url.includes("bandcamp") || url.includes("hackthebox")
      ? { status: 200, body: "<title>Sign up</title>" }
      : { status: 404, body: "no" }
  ));
  try {
    const r = await sweepUsername("exampleuser710");
    assertEquals(r.hits, r.found.length, "hits must equal the confirmed list");
    assert(r.found.every((f) => f.found === true));
    assertEquals(r.hits, 0, "three soft-404s must produce zero registrations");
    assertEquals(r.unverified.length, 3);
  } finally {
    restore();
  }
});
