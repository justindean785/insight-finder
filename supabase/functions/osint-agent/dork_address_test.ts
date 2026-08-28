/**
 * dork_address_test.ts — the address-seed → google_dorks routing contract.
 *
 * Regression cover for the production run on
 *
 *     79 WAVERLY AVE
 *     CINCINNATI OH, 45215
 *
 * which classified as `other`, then dispatched google_dorks TWICE with
 * kind:"domain" and produced `site:79 Waverly Ave Cincinnati OH 45215`,
 * `%.79 Waverly Ave Cincinnati OH 45215`, private-key / .env / admin-panel /
 * certificate / subdomain templates, and — on the compound selector —
 * `""79 Waverly Ave" Cincinnati "Patrick Damon""`.
 *
 * Every test drives the REAL exported paths: detectSeedServer from
 * validation.ts and the google_dorks tool built by buildTools(), never a
 * copied fixture of either.
 */
import { assert, assertEquals } from "jsr:@std/assert@^1";
import { buildTools, type ToolContext } from "./tool-registry.ts";
import { detectSeedServer } from "./validation.ts";
import { TOOL_CATALOG } from "./catalog.ts";
import { engineOfUrl, isHostname, searchUrl, splitQuotedSeed } from "./dork-queries.ts";
import { parseUsAddress } from "./address.ts";

// The two selectors the production run actually sent.
const MULTILINE_SEED = "79 WAVERLY AVE\nCINCINNATI OH, 45215";
const COMPOUND_SEED = '"79 Waverly Ave" Cincinnati "Patrick Damon"';

function stubCtx(): ToolContext {
  // buildTools() only CONSTRUCTS the definitions; google_dorks' execute is pure
  // (no network, no supabase), so a bare stub context is sufficient.
  return {
    supabase: {}, supabaseAdmin: {}, userId: "t", threadId: "t",
    archiveEnabled: false, detectedSeedType: "address", messages: [],
    manualOverrideSelector: null,
  } as unknown as ToolContext;
}

type DorkResult = {
  seed?: string;
  kind?: string;
  ok?: boolean;
  error?: string;
  dorks?: Array<{ category: string; query: string; url: string }>;
  kind_corrected?: { from: string; to: string; reason: string };
};

async function dorks(seed: string, kind: string): Promise<DorkResult> {
  const { tools } = buildTools(stubCtx());
  const tool = (tools as Record<string, { execute: (i: unknown, o: unknown) => Promise<DorkResult> }>)
    .google_dorks;
  return await tool.execute({ seed, kind }, {});
}

const queriesOf = (r: DorkResult) => (r.dorks ?? []).map((d) => d.query);

/** What a search URL actually executes, decoded back out of the URL. */
function executedQuery(url: string): string {
  const u = new URL(url);
  return u.searchParams.get("q") ?? u.searchParams.get("text") ?? "";
}

// ---- 1. Server-side seed detection ------------------------------------------

Deno.test("address seed: the exact multiline/comma Cincinnati input is detected as an address", () => {
  const d = detectSeedServer(MULTILINE_SEED);
  assertEquals(d?.kind, "address", "the production seed classified as 'other' before this fix");
  assertEquals(d?.raw, MULTILINE_SEED, "raw is preserved verbatim for display");
  assertEquals(d?.normalized, "79 waverly ave cincinnati oh 45215");
});

Deno.test("address seed: a normal one-line address is still an address", () => {
  for (
    const line of [
      "79 Waverly Ave, Cincinnati, OH 45215",
      "79 Waverly Ave Cincinnati OH 45215",
      "1600 Pennsylvania Ave NW Washington DC 20500",
      "742 Evergreen Terrace, Springfield, OR 97477-1234",
    ]
  ) {
    assertEquals(detectSeedServer(line)?.kind, "address", `expected address for: ${line}`);
  }
});

Deno.test("address seed: every punctuation/line layout normalizes to ONE cache key", () => {
  const key = "79 waverly ave cincinnati oh 45215";
  for (
    const variant of [
      MULTILINE_SEED,
      "79 Waverly Ave, Cincinnati, OH 45215",
      "79 Waverly Ave  Cincinnati   OH 45215",
      "79 WAVERLY AVE\nCINCINNATI, OH 45215",
    ]
  ) {
    assertEquals(detectSeedServer(variant)?.normalized, key, `cache key drift for: ${variant}`);
  }
});

Deno.test("address seed: non-addresses are NOT swept into the address kind", () => {
  for (const v of ["example.com", "casey@example.com", "8.8.8.8", "josh gillman rocklin ca"]) {
    assert(detectSeedServer(v)?.kind !== "address", `${v} must not classify as an address`);
  }
});

Deno.test("address seed: the state position must be a real USPS code, not any two letters", () => {
  // Graphify review on #491: an unconstrained [A-Za-z]{2} let a street+ZIP with
  // NO state at all false-positive — the street suffix itself ("St") got
  // consumed as the "state" — and let a degenerate two-token value with no real
  // city or state false-positive too.
  for (
    const v of [
      "123 Main St 90210", // street suffix "St" is not a state
      "42 Oak Rd 10001",
      "5 AB CD 12345", // neither "AB" nor "CD" is a real state
    ]
  ) {
    assert(detectSeedServer(v)?.kind !== "address", `${v} must NOT classify as an address (no real state present)`);
  }
  // A real, if unusual, state code is still accepted.
  assertEquals(detectSeedServer("79 Waverly Ave, Cincinnati, OH 45215")?.kind, "address");
  assertEquals(detectSeedServer("1 Judiciary Sq NW, Washington, DC 20001")?.kind, "address");
});

Deno.test("address seed: 'in'/'or' as ordinary lowercase words are not mistaken for the states IN/OR", () => {
  // Graphify review on #491: two of the 57 USPS codes (Indiana=IN, Oregon=OR)
  // are also common lowercase English words. A case-insensitive-only state
  // match let an ordinary sentence that starts with digits and ends in a
  // 5-digit number false-positive as an address.
  for (
    const v of [
      "42 times he called in 12345",
      "5 things I like or 90210",
    ]
  ) {
    assert(detectSeedServer(v)?.kind !== "address", `${v} must NOT classify as an address (lowercase "in"/"or", not a state)`);
  }
  // Properly capitalized IN/OR addresses are unaffected.
  assertEquals(detectSeedServer("100 N Meridian St, Indianapolis, IN 46204")?.kind, "address");
  assertEquals(detectSeedServer("123 SW Main St, Portland, OR 97204")?.kind, "address");
});

Deno.test("parseUsAddress: bails out on an oversized input instead of running the regex", () => {
  // Graphify review on #491: US_POSTAL_PARSE_RE backtracks two lazy groups
  // (street, city) against each other on a non-matching tail. Unlike
  // looksLikePostalAddress/looksLikeStreetAddress, parseUsAddress had no
  // length cap of its own — and it IS reachable with a raw, unbounded
  // model-supplied seed (resolveDorkKind only re-validates when the model
  // claims kind:"domain"; kind:"address" goes straight through). A real,
  // normal-length address still parses; an oversized one is rejected before
  // the regex runs.
  const oversized = "1 " + "A".repeat(250) + " St, Springfield, OH 12345";
  assertEquals(parseUsAddress(oversized), null);
  assertEquals(parseUsAddress("79 Waverly Ave, Cincinnati, OH 45215"), {
    street: "79 Waverly Ave",
    city: "Cincinnati",
    state: "OH",
    zip: "45215",
  });
});

Deno.test("google_dorks(address): every OR-group is parenthesized, so the address prefix scopes ALL branches", async () => {
  // Graphify review on #491: "${street} site:A OR site:B OR site:C" (no
  // parens) is a real Google-syntax bug — unparenthesized OR only loosely
  // binds, so only the FIRST site: branch is actually scoped to the address;
  // "OR site:B" and "OR site:C" would match ANY page on those domains, address
  // or not. Every category that combines an address prefix with an OR list
  // must wrap the list in parens.
  const r = await dorks(MULTILINE_SEED, "address");
  for (const d of r.dorks ?? []) {
    if (!d.query.includes(" OR ")) continue;
    // Every top-level OR must sit inside a paren group. A crude but effective
    // check: strip quoted phrases (their internal "OR" text doesn't count),
    // then every remaining " OR " must have an unmatched '(' before it and an
    // unmatched ')' after it somewhere later on the line.
    const stripped = d.query.replace(/"[^"]*"/g, '""');
    assert(
      /\([^()]*\bOR\b[^()]*\)/.test(stripped),
      `OR appears outside a paren group, so it is not scoped to the prefix: ${d.query}`,
    );
  }
});

// ---- 2. google_dorks accepts and serves the address kind ---------------------

Deno.test("google_dorks: accepts kind 'address' and returns a real query family", async () => {
  const r = await dorks(MULTILINE_SEED, "address");
  assertEquals(r.kind, "address");
  assert((r.dorks?.length ?? 0) >= 12, `expected a substantive family, got ${r.dorks?.length}`);
});

Deno.test("google_dorks(address): covers exact-address, property and public-record ground", async () => {
  const r = await dorks(MULTILINE_SEED, "address");
  const all = queriesOf(r).join("\n");
  const cats = new Set((r.dorks ?? []).map((d) => d.category));

  assert(cats.has("Exact Address"), "no exact-address discovery queries");
  assert(cats.has("Property Records"), "no property/parcel queries");
  assert(cats.has("Ownership / Deeds"), "no ownership/deed queries");
  assert(cats.has("Public Records"), "no public-records queries");
  assert(cats.has("Documents"), "no document queries");
  assert(cats.has("Archives"), "no archive queries");
  assert(cats.has("Real Estate"), "no real-estate queries");

  assert(/"79 Waverly Ave Cincinnati OH 45215"/i.test(all), "no exact-address phrase query");
  assert(/parcel/i.test(all) && /assessor|auditor/i.test(all), "no parcel/assessor lead");
  assert(/deed|grantor|grantee/i.test(all), "no deed/ownership lead");
  assert(/filetype:pdf/i.test(all), "no document lead");
  assert(/web\.archive\.org/i.test(all), "no archive lead");
  assert(/zillow\.com|redfin\.com|realtor\.com/i.test(all), "no real-estate reference");
});

Deno.test("google_dorks(address): emits NO domain-infrastructure template", async () => {
  const r = await dorks(MULTILINE_SEED, "address");
  for (const d of r.dorks ?? []) {
    const q = d.query;
    // site:<postal address> / site:*.<postal address> / %.<postal address>
    assert(!/\bsite:\s*\d/.test(q), `site: applied to a street number: ${q}`);
    assert(!/\bsite:\*\./.test(q), `wildcard-subdomain template on an address: ${q}`);
    assert(!/^%\./.test(q), `crt.sh wildcard template on an address: ${q}`);
    assert(!/\bsite:\s*"/.test(q), `site: applied to a quoted phrase: ${q}`);
    // secret / infrastructure families
    assert(!/PRIVATE KEY|BEGIN CERTIFICATE|\bext:(crt|pem|cer)\b/i.test(q), `certificate/key template: ${q}`);
    assert(!/\.env\b|DB_PASSWORD|api_key|api_secret|GITHUB_TOKEN|AWS_ACCESS_KEY/i.test(q), `secret template: ${q}`);
    assert(!/inurl:(admin|wp-admin|phpmyadmin|login|oauth|saml)/i.test(q), `admin-panel template: ${q}`);
    assert(!/wp-config|docker-compose|terraform|sourceMappingURL|\.travis\.yml/i.test(q), `source-code template: ${q}`);
  }
});

// ---- 3. The untrusted-kind guard --------------------------------------------

Deno.test("google_dorks: kind 'domain' with a postal-address seed CANNOT enter the domain template", async () => {
  const r = await dorks(MULTILINE_SEED, "domain");
  assertEquals(r.kind, "address", "an address must be re-routed out of the domain family");
  assertEquals(r.kind_corrected?.from, "domain");
  assertEquals(r.kind_corrected?.to, "address");
  const all = queriesOf(r).join("\n");
  assert(!/\bsite:\s*(?:\d|")/.test(all), "domain template leaked through the guard");
  assert(!/%\.79/.test(all), "crt.sh wildcard leaked through the guard");
});

Deno.test("google_dorks: the compound address selector is also kept out of the domain family", async () => {
  const r = await dorks(COMPOUND_SEED, "domain");
  assertEquals(r.kind, "address");
  const all = queriesOf(r).join("\n");
  assert(!/\bsite:\*\./.test(all) && !/\bsite:\s*"/.test(all), `domain template on a compound address: ${all}`);
});

Deno.test("google_dorks: kind 'domain' with a non-hostname, non-address seed is REFUSED, not silently served", async () => {
  const r = await dorks("some free text selector", "domain");
  assertEquals(r.ok, false, "a refusal must read as a refusal, never ok:true with empty output");
  assertEquals(r.error, "kind_mismatch");
  assertEquals(r.dorks?.length, 0);
});

Deno.test("google_dorks: a real domain keeps the existing domain behaviour", async () => {
  const r = await dorks("example.com", "domain");
  assertEquals(r.kind, "domain");
  assertEquals(r.kind_corrected, undefined, "a valid hostname is never re-routed");
  const all = queriesOf(r).join("\n");
  assert(all.includes("site:example.com"), "domain family lost its site: query");
  assert(all.includes("site:*.example.com"), "domain family lost its subdomain query");
  assert(all.includes("%.example.com"), "domain family lost its crt.sh query");
  assert(/BEGIN RSA PRIVATE KEY/.test(all), "domain family lost its secret-exposure queries");
});

Deno.test("isHostname: hostnames pass, everything address-shaped fails", () => {
  for (const h of ["example.com", "sub.example.co.uk", "xn--80ak6aa92e.com"]) {
    assert(isHostname(h), `${h} should be a hostname`);
  }
  for (
    const bad of [
      "79 Waverly Ave Cincinnati OH 45215",
      '"79 Waverly Ave" Cincinnati "Patrick Damon"',
      "8.8.8.8",
      "no-dots",
      "",
    ]
  ) {
    assert(!isHostname(bad), `${bad} should NOT be a hostname`);
  }
});

// ---- 4. Compound selectors and quoting ---------------------------------------

Deno.test("splitQuotedSeed: separates already-quoted phrases from loose tokens", () => {
  const { phrases, loose } = splitQuotedSeed(COMPOUND_SEED);
  assertEquals(phrases, ["79 Waverly Ave", "Patrick Damon"]);
  assertEquals(loose, ["Cincinnati"]);
});

Deno.test("google_dorks(address): the quoted address-plus-name selector never doubles a quote", async () => {
  const r = await dorks(COMPOUND_SEED, "address");
  assertEquals(r.kind, "address");
  for (const d of r.dorks ?? []) {
    assert(!d.query.includes('""'), `nested/doubled quoting: ${d.query}`);
    assertEquals(
      (d.query.match(/"/g) ?? []).length % 2,
      0,
      `unbalanced quoting: ${d.query}`,
    );
  }
  const all = queriesOf(r).join("\n");
  assert(all.includes('"79 Waverly Ave"'), "lost the exact street phrase");
  assert(all.includes('"Patrick Damon"'), "lost the person disambiguator");
  assert(
    (r.dorks ?? []).some((d) => d.category === "Address + Person"),
    "compound selector produced no address+person query",
  );
});

// ---- 5. Displayed query == executed query -----------------------------------

Deno.test("every generated URL executes the complete displayed query — all kinds", async () => {
  const cases: Array<[string, string]> = [
    [MULTILINE_SEED, "address"],
    [COMPOUND_SEED, "address"],
    ["casey.rivera@example.com", "email"],
    ["caseyrivera", "username"],
    ["+1 415 555 0142", "phone"],
    ["Casey Rivera", "name"],
    ["example.com", "domain"],
    ["8.8.8.8", "ip"],
    ["5d41402abc4b2a76b9719d911017c592", "hash"],
    ["0x00000000219ab540356cbb839cbe05303d7705fa", "crypto_wallet"],
  ];
  for (const [seed, kind] of cases) {
    const r = await dorks(seed, kind);
    assert((r.dorks?.length ?? 0) > 0, `${kind} produced no dorks`);
    for (const d of r.dorks ?? []) {
      assertEquals(
        executedQuery(d.url),
        d.query,
        `${kind}: url executes a DIFFERENT query than the one displayed\n  shown: ${d.query}\n  runs:  ${executedQuery(d.url)}`,
      );
    }
  }
});

Deno.test("searchUrl: round-trips any query through one encoder", () => {
  const q = '"79 Waverly Ave" Cincinnati "Patrick Damon" filetype:pdf';
  for (const engine of ["google", "bing", "duckduckgo", "yandex"] as const) {
    assertEquals(executedQuery(searchUrl(engine, q)), q, `${engine} URL lost part of the query`);
  }
});

Deno.test("engineOfUrl: classifies by HOSTNAME, not by substring of the whole URL", () => {
  // A real, pre-existing dork: a Google "Cert Transparency" query whose QUERY
  // STRING embeds "site:crt.sh" as text. A whole-string .includes("crt.sh")
  // misread this as a crt.sh URL and canonicalizeDorks rewrote a working Google
  // search into an actual crt.sh lookup — wrong destination, and crt.sh's own
  // endpoint doesn't understand a Google boolean query.
  const googleCertTransparencyUrl =
    "https://www.google.com/search?q=%22example.com%22+site:censys.io+OR+site:crt.sh";
  assertEquals(engineOfUrl(googleCertTransparencyUrl), "google");

  // A seed whose own value contains another engine's domain as a substring
  // (an email at bing.com) must not turn that seed's Google dorks into Bing
  // URLs just because "bing.com" appears in the encoded query string.
  const googleUrlForBingComSeed =
    'https://www.google.com/search?q=%22foo%40bing.com%22+site%3Apastebin.com';
  assertEquals(engineOfUrl(googleUrlForBingComSeed), "google");

  // Genuine engine URLs still classify correctly.
  assertEquals(engineOfUrl("https://www.bing.com/search?q=x"), "bing");
  assertEquals(engineOfUrl("https://duckduckgo.com/?q=x"), "duckduckgo");
  assertEquals(engineOfUrl("https://yandex.com/search/?text=x"), "yandex");
  assertEquals(engineOfUrl("https://crt.sh/?q=%25.example.com"), "crtsh");
  assertEquals(
    engineOfUrl("https://webcache.googleusercontent.com/search?q=cache:x"),
    "googlecache",
  );

  // An unparseable URL falls back to google rather than throwing.
  assertEquals(engineOfUrl("not a url"), "google");
});

Deno.test("google_dorks(domain): the Cert Transparency query stays a Google URL after canonicalization", async () => {
  const r = await dorks("example.com", "domain");
  const certTransparency = (r.dorks ?? []).find((d) => d.category === "Cert Transparency");
  assert(certTransparency, "domain family lost its Cert Transparency category");
  assert(
    certTransparency!.url.startsWith("https://www.google.com/search?"),
    `Cert Transparency dork was rewritten off Google: ${certTransparency!.url}`,
  );
  assertEquals(executedQuery(certTransparency!.url), certTransparency!.query);
});

// ---- 6. Catalog ↔ schema ↔ runtime agreement --------------------------------

Deno.test("catalog advertises the same google_dorks contract the runtime enforces", async () => {
  const entry = TOOL_CATALOG.tools.find((t) => t.name === "google_dorks");
  assert(entry, "google_dorks missing from the catalog");
  assert(entry!.input.includes("seed"), "catalog still advertises the wrong input key");
  assert(!/\btarget\b/.test(entry!.input), "catalog still advertises `target`; runtime takes `seed`");
  assert(entry!.input.includes("address"), "catalog does not advertise kind:'address'");
  assert(/hostname/i.test(entry!.when_to_use), "catalog does not say domain requires a hostname");

  // every advertised kind must actually execute
  const advertised = entry!.input.match(/kind:\s*([a-z_|]+)/)?.[1]?.split("|") ?? [];
  assert(advertised.length >= 9, `could not parse advertised kinds from: ${entry!.input}`);
  for (const kind of advertised) {
    const seed = kind === "domain" ? "example.com" : kind === "address" ? MULTILINE_SEED : "casey.rivera@example.com";
    const r = await dorks(seed, kind);
    assert((r.dorks?.length ?? 0) > 0, `advertised kind '${kind}' produced no dorks`);
  }
});

Deno.test("existing kinds do not regress", async () => {
  const expectations: Array<[string, string, RegExp]> = [
    ["casey.rivera@example.com", "email", /site:pastebin\.com/],
    ["caseyrivera", "username", /site:github\.com\/caseyrivera/],
    ["+1 415 555 0142", "phone", /site:whitepages\.com/],
    ["Casey Rivera", "name", /site:linkedin\.com/],
    ["Casey Rivera", "person", /site:linkedin\.com/],
    ["8.8.8.8", "ip", /site:shodan\.io/],
    ["5d41402abc4b2a76b9719d911017c592", "hash", /site:virustotal\.com/],
    ["0x00000000219ab540356cbb839cbe05303d7705fa", "crypto_wallet", /site:etherscan\.io/],
  ];
  for (const [seed, kind, expected] of expectations) {
    const r = await dorks(seed, kind);
    assertEquals(r.kind, kind === "person" ? "name" : kind, `${kind} resolved to the wrong family`);
    assert(expected.test(queriesOf(r).join("\n")), `${kind} family lost ${expected}`);
  }
});
