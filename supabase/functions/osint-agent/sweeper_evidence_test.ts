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
import {
  accountIsProven,
  echoAnywhereInBody,
  highSignalRegions,
  regionEchoImpliesBodyEcho,
  sweepUsername,
} from "./sweeper.ts";

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

// Fixture moved into <title> by item 2.11. This case tests CASING, not
// location; the original `<h1>` fixture was body-only, which 2.11 correctly
// demotes to `unverified`. Asserting casing from the identity surface keeps the
// test measuring what it is named for instead of quietly re-testing 2.11.
Deno.test("case-insensitive: ExampleUser710 on the page evidences exampleuser710", async () => {
  stubFetch(() => ({ status: 200, body: "<title>ExampleUser710</title>" }));
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

/**
 * REVIEW ROUND 2 — three corrections, each with the failure it prevents.
 */

/** (1) The floor is 5, so an ordinary four-letter token cannot carry a claim. */
Deno.test("a four-character handle is not proven by an echo", async () => {
  // "mark" is a real handle shape AND an everyday word in page furniture.
  stubFetch(() => ({ status: 200, body: "<p>mark as read</p><span>mark</span>" }));
  try {
    const r = await sweepUsername("mark");
    assertEquals(r.hits, 0, "four characters is inside the identified 3-4 char risk band");
    assert(r.unverified.length > 0, "still surfaced as a lead");
  } finally {
    restore();
  }
});

/**
 * (2) `confirm` must REPLACE the generic echo, not race it.
 *
 * The old form was `(s.confirm && body.includes(s.confirm)) || bodyEvidencesAccount(...)`.
 * On a platform whose not-found page repeats the requested handle, the echo
 * arm still fired — so configuring a marker for exactly that platform could
 * never take effect. The one available remedy was unreachable.
 */
Deno.test("a configured confirm marker replaces the echo test, and its absence is decisive", () => {
  const site = { confirm: "data-profile-id=" };
  const notFoundPageThatEchoes = "<h1>No account named mercury</h1><a>/u/mercury</a>";
  assert(
    !accountIsProven(site, notFoundPageThatEchoes, "mercury"),
    "the handle is echoed, but the configured marker is absent — that is decisive",
  );
  assert(
    accountIsProven(site, '<div data-profile-id="99">mercury</div>', "mercury"),
    "with the marker present the page is proven",
  );
});

Deno.test("with no confirm configured the generic echo still applies", () => {
  assert(accountIsProven({}, "<title>mercury | profile</title>", "mercury"));
  assert(!accountIsProven({}, "<title>mercurial docs</title>", "mercury"));
});

/**
 * (3) ONLY a configured absent signal or a bare 404/410 proves absence.
 *
 * The old rule was `r.status >= 400 -> not_found`. Probing this sweep's estate
 * from the build environment returned 403 for 92 of 99 sites — every one of
 * which that rule would have reported as a proven absence, when it was an
 * interposing proxy and not the platform at all.
 */
for (const [status, bucket] of [
  [403, "unverified"], [401, "unverified"], [451, "unverified"],
  [429, "error"], [500, "error"], [503, "error"],
] as Array<[number, "unverified" | "error"]>) {
  Deno.test(`HTTP ${status} is ${bucket}, never a proven absence`, async () => {
    stubFetch(() => ({ status, body: "" }));
    try {
      const r = await sweepUsername("exampleuser710");
      assertEquals(r.hits, 0);
      assertEquals(r.missed.length, 0, `${status} does not prove the account is absent`);
      if (bucket === "error") assert(r.errored.length > 0);
      else assert(r.unverified.length > 0, "refused, but the account may exist behind the wall");
    } finally {
      restore();
    }
  });
}

Deno.test("404 and 410 remain proven absences", async () => {
  for (const status of [404, 410]) {
    stubFetch(() => ({ status, body: "gone" }));
    try {
      const r = await sweepUsername("exampleuser710");
      assert(r.missed.length > 0, `${status} means no such resource`);
      assertEquals(r.errored.length, 0);
    } finally {
      restore();
    }
  }
});

Deno.test("budget exhaustion is an error, never a proven absence", async () => {
  // Every request stalls until the sweep's own per-request timeout aborts it.
  globalThis.fetch = ((_i: unknown, init?: { signal?: AbortSignal }) =>
    new Promise((_res, rej) => {
      const sig = init?.signal;
      if (sig?.aborted) return rej(new DOMException("Aborted", "AbortError"));
      sig?.addEventListener("abort", () => rej(new DOMException("Aborted", "AbortError")));
    })) as unknown as typeof fetch;
  try {
    const r = await sweepUsername("exampleuser710");
    assertEquals(r.missed.length, 0, "running out of time proves nothing about any account");
    assert(r.errored.length > 0);
  } finally {
    restore();
  }
});

/**
 * ITEM 2.11 — WHERE the echo appears decides whether it is evidence.
 *
 * Guards 1 and 2 cannot see the residual this closes: a not-found page that
 * repeats the REQUESTED handle produces a genuine whole-token echo of a
 * long-enough handle. Only its LOCATION separates "this is that account's
 * profile" from "this page is repeating your query".
 */

Deno.test("2.11: a handle in the BODY ONLY is not evidence", async () => {
  stubFetch(() => ({
    status: 200,
    body: "<html><head><title>Page not found</title></head><body><h1>No account named mercury</h1></body></html>",
  }));
  try {
    const r = await sweepUsername("mercury");
    assertEquals(r.hits, 0, "an error page echoing the request is not a registration");
    assert(r.unverified.length > 0, "still surfaced as a lead");
  } finally {
    restore();
  }
});

Deno.test("2.11: a handle in <title> IS evidence", async () => {
  stubFetch(() => ({ status: 200, body: "<html><head><title>mercury (@mercury)</title></head><body>x</body></html>" }));
  try {
    const r = await sweepUsername("mercury");
    assert(r.hits > 0, "the document's identity surface names the account");
  } finally {
    restore();
  }
});

Deno.test("2.11: og:* and canonical are identity surfaces too", async () => {
  for (const head of [
    '<meta property="og:title" content="mercury on Example">',
    '<meta name="og:url" content="https://example.com/u/mercury">',
    '<link rel="canonical" href="https://example.com/u/mercury">',
  ]) {
    stubFetch(() => ({ status: 200, body: `<html><head>${head}</head><body>nothing here</body></html>` }));
    try {
      const r = await sweepUsername("mercury");
      assert(r.hits > 0, `expected a hit from: ${head}`);
    } finally {
      restore();
    }
  }
});

Deno.test("2.11: an absent handle stays a proven absence", async () => {
  stubFetch(() => ({ status: 404, body: "<title>Not Found</title>" }));
  try {
    const r = await sweepUsername("mercury");
    assertEquals(r.hits, 0);
    assert(r.missed.length > 0, "404 is decided before any body is read");
    assertEquals(r.unverified.length, 0);
  } finally {
    restore();
  }
});

/**
 * NEGATIVE CONTROL 1 — the ratchet. Every region is a substring of the body, so
 * a region echo must always imply a body echo. If this ever fails, the
 * restriction has stopped narrowing and started inventing evidence.
 */
Deno.test("2.11 NEGATIVE CONTROL: no input can yield unverified -> found", () => {
  const cases = [
    "<title>mercury</title>",
    '<meta property="og:title" content="mercury">',
    '<link rel="canonical" href="/u/mercury">',
    "<body>mercury</body>",
    "<title>nothing</title><body>mercury-banner</body>",
    "",
    "<title></title>",
    "<title>MERCURY</title>",
    '<meta property="og:description" content="a page about mercurial">',
  ];
  for (const body of cases) {
    assert(
      regionEchoImpliesBodyEcho(body, "mercury"),
      `ratchet violated — region matched where the body did not: ${body}`,
    );
  }
});

/**
 * NEGATIVE CONTROL 2 — `not_found` is structurally unreachable from this guard.
 * The definitive absent signals run BEFORE any body is read, so no page content
 * can promote a proven absence to a hit.
 */
Deno.test("2.11 NEGATIVE CONTROL: no page content can turn not_found into found", async () => {
  // A body that would PASS the region test, served under every proven-absence signal.
  const provingBody = "<title>mercury (@mercury)</title>";
  for (const status of [404, 410]) {
    stubFetch(() => ({ status, body: provingBody }));
    try {
      const r = await sweepUsername("mercury");
      assertEquals(r.hits, 0, `status ${status} must stay a proven absence`);
      assert(r.missed.length > 0);
    } finally {
      restore();
    }
  }
});

Deno.test("2.11: highSignalRegions extracts only the identity surface", () => {
  const regions = highSignalRegions(
    '<title>T</title><meta property="og:url" content="OG"><link rel="canonical" href="C">' +
      "<body>BODYTEXT</body><script>SCRIPTTEXT</script>",
  );
  assert(regions.includes("T") && regions.includes("OG") && regions.includes("C"));
  assert(!regions.includes("BODYTEXT"), "body text is not an identity surface");
  assert(!regions.includes("SCRIPTTEXT"), "hydration blobs are not an identity surface");
});

Deno.test("2.11: a configured confirm marker still bypasses the region test", () => {
  // `confirm` is a MEASURED per-platform assertion; region restriction is a
  // heuristic. The measurement must keep winning.
  assert(accountIsProven({ confirm: "data-profile-id=" }, "<body>data-profile-id=9</body>", "mercury"));
  assert(!accountIsProven({}, "<body>mercury</body>", "mercury"), "no marker → region rules apply");
});

Deno.test("2.11: echoAnywhereInBody still sees what the region test now rejects", () => {
  const body = "<title>Not found</title><body>No account named mercury</body>";
  assert(echoAnywhereInBody(body, "mercury"), "the pre-2.11 test would have called this a hit");
  assert(!accountIsProven({}, body, "mercury"), "2.11 correctly refuses it");
});

/**
 * REVIEW FIX — markup-shaped TEXT is not markup.
 *
 * The region rule was sound; reading regions with a document-wide regex was
 * not. A literal "<title>handle</title>" appearing inside a script string, an
 * HTML comment, or a <template> was extracted as the page's title and scored as
 * proof — the exact echo-on-404 shape 2.11 exists to reject, re-entering
 * through the extractor instead of the matcher. All three were reproduced
 * against the previous commit.
 *
 * The pre-existing exclusion test used plain `SCRIPTTEXT`, which is why it
 * never caught this: it proved script CONTENT was excluded, not that script
 * content SHAPED LIKE MARKUP was.
 */
const MARKUP_SHAPED_TEXT: Array<[string, string]> = [
  ["script string", '<html><head><title>Not found</title></head><body><script>var t = "<title>mercury</title>";</script></body></html>'],
  ["template literal in script", "<html><head><title>Not found</title></head><body><script>const h = `<title>mercury</title>`;</script></body></html>"],
  ["HTML comment", "<html><head><title>Not found</title></head><body><!-- <title>mercury</title> --></body></html>"],
  ["<template> element", "<html><head><title>Not found</title></head><body><template><title>mercury</title></template></body></html>"],
  ["<textarea> content", "<html><head><title>Not found</title></head><body><textarea><title>mercury</title></textarea></body></html>"],
  ["og:title inside a comment", '<html><head><title>Not found</title><!-- <meta property="og:title" content="mercury"> --></head></html>'],
  ["canonical inside a script", '<html><head><title>Not found</title><script>var s = \'<link rel="canonical" href="/u/mercury">\';</script></head></html>'],
];

for (const [label, html] of MARKUP_SHAPED_TEXT) {
  Deno.test(`2.11 REVIEW: markup-shaped text in a ${label} is not the identity surface`, async () => {
    stubFetch(() => ({ status: 200, body: html }));
    try {
      const r = await sweepUsername("mercury");
      assertEquals(r.hits, 0, `${label} must not be read as the page's identity`);
      assert(r.unverified.length > 0, "the page is reachable — still a lead");
    } finally {
      restore();
    }
  });
}

Deno.test("2.11 REVIEW: highSignalRegions does not see markup-shaped text", () => {
  for (const [label, html] of MARKUP_SHAPED_TEXT) {
    const regions = highSignalRegions(html);
    assert(!regions.includes("mercury"), `${label} leaked into the identity surface`);
    assert(regions.includes("Not found"), `${label}: the REAL title must still be read`);
  }
});

/**
 * A <title> in the BODY is not the document's title — browsers honour only the
 * one in <head>. Documents that omit <head> fall back to the stripped document,
 * which stays safe because raw text and comments are already gone.
 */
Deno.test("2.11 REVIEW: a <title> in the body is not the document title", async () => {
  stubFetch(() => ({
    status: 200,
    body: "<html><head><title>Not found</title></head><body><title>mercury</title></body></html>",
  }));
  try {
    const r = await sweepUsername("mercury");
    assertEquals(r.hits, 0, "only <head>'s title is the document's title");
  } finally {
    restore();
  }
});

Deno.test("2.11 REVIEW: a document with no <head> still reads its title", async () => {
  stubFetch(() => ({ status: 200, body: "<title>mercury</title><p>x</p>" }));
  try {
    const r = await sweepUsername("mercury");
    assert(r.hits > 0, "head-less documents are common; do not lose them");
  } finally {
    restore();
  }
});

Deno.test("2.11 REVIEW: the ratchet still holds over markup-shaped inputs", () => {
  for (const [, html] of MARKUP_SHAPED_TEXT) {
    assert(regionEchoImpliesBodyEcho(html, "mercury"), "region matched where the body did not");
  }
});
