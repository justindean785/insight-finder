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

/**
 * REVIEW FIX — the echo test must find EVIDENCE, not coincidence.
 *
 * The first cut of `bodyEvidencesAccount` was a bare
 * `body.toLowerCase().includes(username.toLowerCase())`. That reintroduced the
 * very defect this file pins, only inverted: instead of a status counting as
 * proof, an incidental substring did. A handle matches inside any longer run of
 * characters — a CSS class, a minified identifier, a base64 blob, or an
 * ordinary English word — so a 200 that never mentions the account could still
 * be scored a confirmed registration.
 *
 * Two guards now hold the line, and both are pinned below.
 */

Deno.test("a handle buried inside a longer word is NOT evidence", async () => {
  // "chris" occurs inside "christmas", but never as a token of its own.
  stubFetch(() => ({ status: 200, body: "<title>christmas sale</title><p>christopher</p>" }));
  try {
    const r = await sweepUsername("chris");
    assertEquals(r.hits, 0, "a substring match is coincidence, not a registration");
    assert(r.unverified.length > 0, "the pages are reachable — they stay visible as leads");
  } finally {
    restore();
  }
});

Deno.test("a handle on a token boundary IS evidence", async () => {
  // Same handle, now delimited — the page genuinely names the account.
  stubFetch(() => ({ status: 200, body: "<title>chris | profile</title>" }));
  try {
    const r = await sweepUsername("chris");
    assert(r.hits > 0, "a whole-token echo is the positive proof the gate asks for");
    assert(r.found.every((f) => f.found === true));
  } finally {
    restore();
  }
});

Deno.test("punctuation around the handle does not defeat the match", async () => {
  stubFetch(() => ({ status: 200, body: '<meta property="og:url" content="/u/exampleuser710">' }));
  try {
    const r = await sweepUsername("exampleuser710");
    assert(r.hits > 0, "slashes and quotes are token delimiters, not part of the handle");
  } finally {
    restore();
  }
});

/**
 * The length floor. Three characters occur as a standalone token all over
 * ordinary HTML — in attribute values, minified identifiers and stop-words — so
 * even a whole-token match cannot carry the claim. Such a handle is provable
 * only by a measured, per-platform `confirm` marker; no site carries one yet
 * (see the note on `SweepSite.confirm`), so today these always come back
 * unverified. That is the intended, honest outcome, not a gap to paper over.
 */
Deno.test("a handle below the length floor is never a hit on an echo alone", async () => {
  stubFetch(() => ({ status: 200, body: "<title>abc</title> welcome abc, member since 2019" }));
  try {
    const r = await sweepUsername("abc");
    assertEquals(r.hits, 0, "three characters cannot evidence an account by echo");
    assert(r.unverified.length > 0, "it is surfaced as a lead, not silently dropped");
  } finally {
    restore();
  }
});

Deno.test("a regex-special handle cannot break or widen the match", async () => {
  // An unescaped handle would compile into a pattern that matches far too much
  // (or throws). Both failure modes are silent scoring errors.
  stubFetch(() => ({ status: 200, body: "<title>unrelated page</title>" }));
  try {
    const r = await sweepUsername("a.b*c+d");
    assertEquals(r.hits, 0, "the handle is matched literally, never as a pattern");
  } finally {
    restore();
  }
});

/**
 * The three coincidence shapes JD called out by name. Each is a real thing that
 * appears in ordinary page source, and each one scored a registration under the
 * original `includes()` test.
 *
 * "ben" is BELOW the length floor, so it is refused twice over — once by the
 * floor and once by the boundary. The `mercury`/`mercurial` pair beside it
 * isolates the BOUNDARY guard on a handle long enough to clear the floor, so a
 * future change to MIN_ECHO_LEN cannot quietly turn these into vacuous passes.
 */
Deno.test("'ben' does not match inside 'benchmark'", async () => {
  stubFetch(() => ({ status: 200, body: "<h1>benchmark results</h1><p>benign</p>" }));
  try {
    const r = await sweepUsername("ben");
    assertEquals(r.hits, 0);
  } finally {
    restore();
  }
});

Deno.test("a long handle does not match inside a longer word", async () => {
  stubFetch(() => ({ status: 200, body: "<p>mercurial repositories</p>" }));
  try {
    const r = await sweepUsername("mercury");
    assertEquals(r.hits, 0, "boundary guard, independent of the length floor");
  } finally {
    restore();
  }
});

Deno.test("a handle occurring inside a base64 blob is not evidence", async () => {
  // Base64 is dense enough that almost any short token appears somewhere.
  stubFetch(() => ({
    status: 200,
    body: '<script>var d="aGVsbG9tZXJjdXJ5d29ybGRkYXRhYmxvYg==mercuryX9zdHVmZg";</script>',
  }));
  try {
    const r = await sweepUsername("mercury");
    assertEquals(r.hits, 0, "a run of base64 is not a page naming the account");
  } finally {
    restore();
  }
});

Deno.test("a handle occurring inside a CSS class name is not evidence", async () => {
  stubFetch(() => ({
    status: 200,
    body: '<div class="mercury-banner mercury_wrap"><style>.mercuryIcon{}</style></div>',
  }));
  try {
    const r = await sweepUsername("mercury");
    assertEquals(r.hits, 0, "hyphen/underscore/camel class names are not a profile");
  } finally {
    restore();
  }
});

/**
 * OUTCOME VOCABULARY. A probe that never reached the site establishes nothing —
 * least of all absence. It used to land in `missed` alongside proven 404s, which
 * is the same category error as counting a soft-404 as a hit.
 */
Deno.test("a network error is reported as error, never as proven absence", async () => {
  globalThis.fetch = (() => Promise.reject(new Error("ECONNRESET"))) as typeof fetch;
  try {
    const r = await sweepUsername("exampleuser710");
    assertEquals(r.hits, 0);
    assertEquals(r.missed.length, 0, "nothing was PROVEN absent — we never arrived");
    assert(r.errored.length > 0, "the unreachable sites are surfaced under `errored`");
  } finally {
    restore();
  }
});

Deno.test("every result carries exactly one outcome from the shared vocabulary", async () => {
  stubFetch((url) => (
    url.includes("pypi.org")
      ? { status: 200, body: "<title>Sign up</title>" }   // unverified
      : { status: 404, body: "no such user" }             // not_found
  ));
  try {
    const r = await sweepUsername("exampleuser710");
    const vocab = new Set(["found", "not_found", "unverified", "error"]);
    for (const g of [...r.found, ...r.unverified]) {
      assert(vocab.has(g.outcome), `unknown outcome ${g.outcome}`);
    }
    assert(r.unverified.every((x) => x.outcome === "unverified"));
    assert(r.found.every((x) => x.outcome === "found"));
    assert(r.missed.length > 0, "the 404s are proven absences");
  } finally {
    restore();
  }
});
