/**
 * infra_artifact_extraction_test.ts — a DOMAIN investigation must accumulate evidence.
 *
 * THE INCIDENT (production 2026-08-06, thread dd2514e3, build 6210ef9)
 * Seed `floeintel.com`. 33 tool calls, 21 of them `ok`, 148s, clean finish — and
 * FOUR artifacts. `record_artifacts` was called zero times, so everything depended
 * on the auto-persist extractor, and every one of its twelve branches targets
 * PERSON/identity shapes: breach corpora, emails, usernames, social profiles,
 * github accounts. Not one matches an infrastructure payload.
 *
 * So `whois_lookup`, `dns_records`, `shodan_internetdb`, `ip_intel`×2,
 * `urlscanner_scan`, `virustotal_lookup`, `oathnet_subdomains` all returned ok and
 * were all discarded. The only artifacts in the entire run came from
 * `crtsh_subdomains`, which survived by accident: it happens to emit the
 * `{ subdomains: [] }` shape that branch 7 already matched.
 *
 * Measured consequence: person-seeded runs land at 29/39/72/91/142 artifacts;
 * this domain-seeded run got 4. Domain investigations could not accumulate
 * evidence at all — the report's "Missing coverage" and empty "Key Findings"
 * were downstream of that, not of a thin target.
 *
 * FIXTURES ARE REAL SHAPES, taken from tool-registry.ts:
 *   dns_records       { ok, host, records: { A: [{ data }], NS: [...] } }  (Cloudflare DoH)
 *   ip_intel          { ...ip-api fields, query, isp, org, as, location_kind }
 *   shodan_internetdb { ok, status, data: { ip, ports, hostnames, cpes, tags, vulns } }
 * All values below are RFC 5737 / RFC 2606 reserved and belong to nobody.
 */
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { extractFindings } from "./auto-persist-findings.ts";

const kinds = (f: Array<{ kind: string }>) => f.map((x) => x.kind).sort();
const values = (f: Array<{ value: string }>) => f.map((x) => x.value).sort();

Deno.test("dns_records: A records become ip_address artifacts", () => {
  const out = extractFindings("dns_records", {
    ok: true,
    host: "example.com",
    records: {
      A: [{ name: "example.com", type: 1, TTL: 300, data: "192.0.2.10" }],
      AAAA: [{ name: "example.com", type: 28, TTL: 300, data: "2001:db8::1" }],
    },
  });
  assert(out.length > 0, "a resolved host is evidence about the seed");
  assert(values(out).includes("192.0.2.10"), "the A record's IP must be persisted");
});

Deno.test("dns_records: NS/MX hostnames become domain artifacts, trailing dot stripped", () => {
  // DNS answers are fully-qualified WITH a trailing dot. normalizeFinding's domain
  // regex rejects it, so an unstripped value is silently dropped — the failure this pins.
  const out = extractFindings("dns_records", {
    ok: true,
    host: "example.com",
    records: {
      NS: [{ data: "ns1.example.net." }],
      MX: [{ data: "10 mail.example.net." }],
    },
  });
  assert(values(out).includes("ns1.example.net"), "nameserver must persist without the trailing dot");
});

Deno.test("ip_intel: the queried IP and its owning org are persisted", () => {
  const out = extractFindings("ip_intel", {
    status: "success",
    query: "192.0.2.20",
    city: "Nowhere",
    isp: "Example Hosting",
    org: "Example Hosting LLC",
    as: "AS64496 Example Hosting",
    location_kind: "origin",
  });
  assert(values(out).includes("192.0.2.20"), "the geolocated IP is the finding");
  assert(kinds(out).includes("organization"), "the owning org is attributable infrastructure evidence");
});

Deno.test("shodan_internetdb: host IP and its hostnames are persisted", () => {
  const out = extractFindings("shodan_internetdb", {
    ok: true,
    status: 200,
    data: {
      ip: "192.0.2.30",
      ports: [80, 443],
      hostnames: ["api.example.com", "cdn.example.com"],
      cpes: [],
      tags: [],
      vulns: [],
    },
  });
  assert(values(out).includes("192.0.2.30"));
  assert(values(out).includes("api.example.com"), "a hostname on the seed's infrastructure is evidence");
});

Deno.test("subdomains nested under data[] are found, not just top-level", () => {
  // crtsh_subdomains survived only because it emits `{ subdomains: [] }` at the top
  // level. Providers that nest the same list under `data` were silently missed.
  const out = extractFindings("oathnet_subdomains", {
    ok: true,
    data: { subdomains: ["admin.example.com", "vpn.example.com"] },
  });
  assert(values(out).includes("admin.example.com"), "a nested subdomain list must extract too");
});

Deno.test("an errored infra call yields nothing", () => {
  assertEquals(extractFindings("dns_records", { ok: false, error: "SERVFAIL" }).length, 0);
  assertEquals(extractFindings("ip_intel", { error: "lookup failed" }).length, 0);
});

Deno.test("garbage in an infra payload is dropped, not persisted", () => {
  const out = extractFindings("dns_records", {
    ok: true,
    host: "example.com",
    records: { A: [{ data: "not-an-ip" }], NS: [{ data: "..." }] },
  });
  assertEquals(out.length, 0, "normalizeFinding must still gate every value");
});
