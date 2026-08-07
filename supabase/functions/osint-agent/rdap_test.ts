/**
 * rdap_test.ts — item 1.1 acceptance.
 *
 * The defect being fixed is not "RDAP is broken" — `whois_lookup` was already an
 * RDAP call and it worked. The defect is that it could not tell three different
 * things apart:
 *
 *   - the registry saying "no such domain"  (a real, measured negative)
 *   - rdap.org having no route for that TLD (an aggregator gap, not a fact
 *     about the domain)
 *   - the registry being down or refusing   (no answer at all)
 *
 * All three arrived as `ok:false`, so a domain-seeded run could record a
 * confident absence it had never established. Every case below pins one of
 * those three apart from the others.
 *
 * All fixtures are RFC 2606 reserved names or synthetic registry hosts.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  _expireBootstrapCache,
  _resetBootstrapCache,
  parseRdapDoc,
  rdapLookup,
  tldOf,
} from "./rdap.ts";

const IANA = "https://data.iana.org/rdap/dns.json";

/** A minimal but realistic RDAP domain record. */
function domainDoc(opts: { registrar?: string; redactedRemark?: boolean } = {}) {
  return {
    ldhName: "EXAMPLE.COM",
    status: ["client transfer prohibited"],
    events: [{ eventAction: "registration", eventDate: "1995-08-14T04:00:00Z" }],
    nameservers: [{ ldhName: "A.IANA-SERVERS.NET" }],
    entities: [{
      roles: ["registrar"],
      vcardArray: ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", opts.registrar ?? "Example Registrar, Inc."]]],
      ...(opts.redactedRemark
        ? { remarks: [{ title: "REDACTED FOR PRIVACY", type: "object redacted due to authorization", description: ["Some fields have been removed."] }] }
        : {}),
    }],
  };
}

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));

/** Route by URL so each test states exactly which endpoint answers what. */
function router(routes: Array<[RegExp, () => Promise<Response>]>) {
  return (url: string) => {
    for (const [re, fn] of routes) if (re.test(url)) return fn();
    return Promise.resolve(new Response("unrouted", { status: 599 }));
  };
}

function bootstrapDoc(tld: string, base: string) {
  return { services: [[[tld], [base]]] };
}

Deno.test("ACCEPTANCE 1: a normal domain returns registrar and status", async () => {
  _resetBootstrapCache();
  const r = await rdapLookup("example.com", router([[/rdap\.org/, () => json(domainDoc())]]));
  assertEquals(r.outcome, "found");
  assertEquals(r.registrar, "Example Registrar, Inc.");
  assert(r.statuses?.includes("client transfer prohibited"));
  assert(r.nameservers?.includes("A.IANA-SERVERS.NET"));
  assertEquals(r.redacted, false);
});

Deno.test("ACCEPTANCE 2: a ccTLD rdap.org cannot route resolves via IANA bootstrap", async () => {
  _resetBootstrapCache();
  let registryHits = 0;
  const r = await rdapLookup(
    "example.test",
    router([
      // The aggregator has no route for this zone and 404s — which is exactly
      // the ambiguous case the old code recorded as "domain does not exist".
      [/rdap\.org/, () => json({ errorCode: 404 }, 404)],
      [/data\.iana\.org/, () => json(bootstrapDoc("test", "https://rdap.registry.test"))],
      [/rdap\.registry\.test/, () => { registryHits++; return json(domainDoc({ registrar: "Registry Test Ltd." })); }],
    ]),
  );
  assertEquals(r.outcome, "found", "the registry knows the domain even though the aggregator did not");
  assertEquals(r.registrar, "Registry Test Ltd.");
  assertEquals(registryHits, 1);
  assert(r.source?.includes("rdap.registry.test"));
});

Deno.test("ACCEPTANCE 3: a registry 502 is `failed`, never `measured_empty`", async () => {
  _resetBootstrapCache();
  let registryHits = 0;
  const r = await rdapLookup(
    "example.test",
    router([
      [/rdap\.org/, () => json({ errorCode: 404 }, 404)],
      [/data\.iana\.org/, () => json(bootstrapDoc("test", "https://rdap.registry.test"))],
      [/rdap\.registry\.test/, () => { registryHits++; return Promise.resolve(new Response("bad gateway", { status: 502 })); }],
    ]),
  );
  assert(r.outcome !== "measured_empty", "an outage is not evidence the domain is absent");
  assertEquals(registryHits, 2, "exactly one retry is spent on a failed registry response");
});

Deno.test("ACCEPTANCE 4: a redacted registrant sets redacted:true and does not throw", async () => {
  _resetBootstrapCache();
  const r = await rdapLookup(
    "example.com",
    router([[/rdap\.org/, () => json(domainDoc({ redactedRemark: true }))]]),
  );
  assertEquals(r.outcome, "found", "withheld contact data is a successful lookup");
  assertEquals(r.redacted, true);
  assertEquals(r.ok, true);
});

/**
 * The distinction the whole item exists for. Both of these were `ok:false`
 * before, so a run could not tell "this domain is not registered" from "we
 * could not find out".
 */
Deno.test("a registry 404 is measured_empty and is NOT retried", async () => {
  _resetBootstrapCache();
  let registryHits = 0;
  const r = await rdapLookup(
    "nonexistent.test",
    router([
      [/rdap\.org/, () => json({ errorCode: 404 }, 404)],
      [/data\.iana\.org/, () => json(bootstrapDoc("test", "https://rdap.registry.test"))],
      [/rdap\.registry\.test/, () => { registryHits++; return json({ errorCode: 404 }, 404); }],
    ]),
  );
  assertEquals(r.outcome, "measured_empty");
  assertEquals(r.ok, true, "a measured negative is a successful measurement");
  assertEquals(registryHits, 1, "there is nothing to wait for, so no retry");
});

Deno.test("a network failure is `failed`, not an absence", async () => {
  _resetBootstrapCache();
  const r = await rdapLookup("example.com", () => Promise.reject(new Error("ECONNRESET")));
  assertEquals(r.outcome, "failed");
  assertEquals(r.ok, false);
});

Deno.test("a 403 refusal is `failed` — a refusal is not a measured negative", async () => {
  _resetBootstrapCache();
  const r = await rdapLookup(
    "example.com",
    router([
      [/rdap\.org/, () => Promise.resolve(new Response("forbidden", { status: 403 }))],
      [/data\.iana\.org/, () => json({ services: [] })],
    ]),
  );
  assertEquals(r.outcome, "failed");
});

Deno.test("a 200 carrying no record is measured_empty, not a bogus hit", async () => {
  _resetBootstrapCache();
  const r = await rdapLookup(
    "example.com",
    router([
      [/rdap\.org/, () => json({ notices: [] })],
      [/data\.iana\.org/, () => json({ services: [] })],
    ]),
  );
  assertEquals(r.outcome, "measured_empty");
});

Deno.test("a failed IANA bootstrap is survivable — the aggregator answer stands", async () => {
  _resetBootstrapCache();
  const r = await rdapLookup(
    "example.test",
    router([
      [/rdap\.org/, () => json({ errorCode: 404 }, 404)],
      [/data\.iana\.org/, () => Promise.resolve(new Response("down", { status: 503 }))],
    ]),
  );
  assertEquals(r.outcome, "measured_empty", "we cannot do better, but we do not invent a failure either");
});

Deno.test("the bootstrap table is fetched once and cached across lookups", async () => {
  _resetBootstrapCache();
  let ianaHits = 0;
  const f = router([
    [/rdap\.org/, () => json({ errorCode: 404 }, 404)],
    [/data\.iana\.org/, () => { ianaHits++; return json(bootstrapDoc("test", "https://rdap.registry.test")); }],
    [/rdap\.registry\.test/, () => json(domainDoc())],
  ]);
  await rdapLookup("a.test", f);
  await rdapLookup("b.test", f);
  assertEquals(ianaHits, 1, "24h TTL — a per-request fetch would dominate the tool's latency");
});

Deno.test("input is normalised, and a non-domain is refused without a network call", async () => {
  _resetBootstrapCache();
  let calls = 0;
  const r = await rdapLookup("not-a-domain", () => { calls++; return json({}); });
  assertEquals(r.outcome, "failed");
  assertEquals(calls, 0);
  assertEquals(tldOf("SUB.Example.CO.UK."), "uk");
});

Deno.test("parseRdapDoc tolerates a sparse record without throwing", () => {
  const p = parseRdapDoc({ ldhName: "example.com" });
  assertEquals(p.registrar, null);
  assertEquals(p.statuses, []);
  assertEquals(p.nameservers, []);
  assertEquals(p.redacted, false);
});

/**
 * REVIEW FIX — a failed bootstrap must not be cached like a successful one.
 *
 * The first cut stored the empty map with the full 24h TTL, so one IANA blip on
 * an isolate's first lookup disabled the registry fallback for a day. Every
 * ccTLD rdap.org cannot route would have silently degraded to the aggregator's
 * unconfirmed answer for that whole window.
 */
Deno.test("a failed bootstrap is retried, not cached for 24h", async () => {
  _resetBootstrapCache();
  let ianaHits = 0;
  let ianaUp = false;
  const f = router([
    [/rdap\.org/, () => json({ errorCode: 404 }, 404)],
    [/data\.iana\.org/, () => {
      ianaHits++;
      return ianaUp
        ? json(bootstrapDoc("test", "https://rdap.registry.test"))
        : Promise.resolve(new Response("down", { status: 503 }));
    }],
    [/rdap\.registry\.test/, () => json(domainDoc({ registrar: "Registry Test Ltd." }))],
  ]);

  const first = await rdapLookup("a.test", f);
  assertEquals(first.outcome, "measured_empty", "no registry reachable — aggregator answer stands");
  assertEquals(first.unconfirmed, true, "and it is flagged as uncorroborated");

  // WITHIN the negative TTL the failure is honoured — that is the whole point
  // of caching it, so a hard IANA outage does not mean an IANA request per
  // lookup. This assertion pins the protection, not a bug.
  ianaUp = true;
  const immediate = await rdapLookup("b.test", f);
  assertEquals(ianaHits, 1, "inside the short negative TTL, the failure suppresses re-fetch");
  assertEquals(immediate.outcome, "measured_empty");

  // ONCE THE SHORT TTL ELAPSES the fallback comes back. Under the original
  // 24h TTL this lookup would still have been serving the cached failure, and
  // the registry fallback would have stayed dead for a day.
  _expireBootstrapCache();
  const later = await rdapLookup("c.test", f);
  assertEquals(ianaHits, 2, "a cached FAILURE must expire in seconds, not a day");
  assertEquals(later.outcome, "found", "the registry answers once bootstrap succeeds");
});

Deno.test("stale successful bootstrap data outranks a fresh failure", async () => {
  _resetBootstrapCache();
  let ianaUp = true;
  let registryHits = 0;
  const f = router([
    [/rdap\.org/, () => json({ errorCode: 404 }, 404)],
    [/data\.iana\.org/, () =>
      ianaUp
        ? json(bootstrapDoc("test", "https://rdap.registry.test"))
        : Promise.resolve(new Response("down", { status: 503 }))],
    [/rdap\.registry\.test/, () => {
      registryHits++;
      return json(domainDoc({ registrar: "Registry Test Ltd." }));
    }],
  ]);

  const warm = await rdapLookup("a.test", f);
  assertEquals(warm.outcome, "found");

  // IANA goes down AFTER we already have a good table. The table is days-stable,
  // so keeping it beats discarding it — the fallback must keep working.
  ianaUp = false;
  _expireBootstrapCache();
  const later = await rdapLookup("b.test", f);
  assertEquals(later.outcome, "found", "a stale table still routes to the registry");
  assertEquals(registryHits, 2);
});

/**
 * ACCEPTANCE BAR point 7 — "aggregator 404 plus unavailable registry remains
 * unconfirmed: true". Covers BOTH ways corroboration can fail, because a reader
 * should not need to know which one happened to know that it did.
 */
Deno.test("aggregator 404 + unreachable registry is failed AND unconfirmed", async () => {
  _resetBootstrapCache();
  const r = await rdapLookup(
    "example.test",
    router([
      [/rdap\.org/, () => json({ errorCode: 404 }, 404)],
      [/data\.iana\.org/, () => json(bootstrapDoc("test", "https://rdap.registry.test"))],
      [/rdap\.registry\.test/, () => Promise.resolve(new Response("gone", { status: 503 }))],
    ]),
  );
  assertEquals(r.outcome, "failed", "an unreachable registry is not an absence");
  assertEquals(r.unconfirmed, true, "and nothing corroborated the aggregator");
});

Deno.test("aggregator 404 + NO registry listed is measured_empty AND unconfirmed", async () => {
  _resetBootstrapCache();
  const r = await rdapLookup(
    "example.test",
    router([
      [/rdap\.org/, () => json({ errorCode: 404 }, 404)],
      [/data\.iana\.org/, () => json({ services: [] })],
    ]),
  );
  assertEquals(r.outcome, "measured_empty");
  assertEquals(r.unconfirmed, true);
});
