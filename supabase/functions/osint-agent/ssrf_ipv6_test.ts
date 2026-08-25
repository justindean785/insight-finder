// SSRF guard — IPv6 and shared-address-space coverage.
//
// Every case goes through assertSafeUrl(), i.e. through `new URL()`, because
// that is what production does and URL parsing REWRITES the host before the
// guard ever sees it. That detail is the whole point of these tests: the
// obvious fix for IPv4-mapped addresses is a regex on `::ffff:127.0.0.1`, and
// it is dead code — WHATWG normalizes that to `::ffff:7f00:1`, so a
// dotted-quad pattern never matches real input. The guard recovers the v4
// address from the hex groups instead.

import { assert, assertThrows } from "jsr:@std/assert@1";
import { assertSafeUrl, isPrivateHost } from "./safety.ts";

const blocked = (url: string) =>
  assertThrows(() => assertSafeUrl(url), Error, "blocked", `${url} must be blocked`);

Deno.test("SSRF: URL normalization really does rewrite mapped IPv6 (premise check)", () => {
  // Pins the reason the dotted-quad approach cannot work. If a future runtime
  // stops normalizing, this fails loudly rather than silently weakening the guard.
  assert(new URL("http://[::ffff:127.0.0.1]/").hostname === "[::ffff:7f00:1]");
});

Deno.test("SSRF: IPv4-mapped IPv6 reaches loopback and metadata — blocked", () => {
  blocked("http://[::ffff:127.0.0.1]/");        // -> [::ffff:7f00:1]
  blocked("http://[::ffff:169.254.169.254]/");  // cloud metadata via mapped v6
  blocked("http://[::ffff:10.0.0.1]/");
  blocked("http://[::ffff:192.168.1.1]/");
  blocked("http://[0:0:0:0:0:ffff:7f00:1]/");   // fully-expanded spelling
  blocked("http://[::ffff:7f00:1]/");           // already-normalized spelling
});

Deno.test("SSRF: unique-local fc00::/7 — blocked across the range", () => {
  blocked("http://[fc00::1]/");
  blocked("http://[fd12:3456:789a::1]/");
  blocked("http://[fdff:ffff::ffff]/");
});

Deno.test("SSRF: link-local fe80::/10 — blocked across the range", () => {
  blocked("http://[fe80::1]/");
  blocked("http://[fe80::dead:beef]/");
  blocked("http://[febf::1]/"); // top of fe80::/10
});

Deno.test("SSRF: loopback, unspecified and multicast IPv6 — blocked", () => {
  blocked("http://[::1]/");
  blocked("http://[::]/");
  blocked("http://[ff02::1]/");
});

Deno.test("SSRF: NAT64 and deprecated IPv4-compatible embeddings — blocked", () => {
  blocked("http://[64:ff9b::7f00:1]/");  // NAT64 well-known prefix -> 127.0.0.1
  blocked("http://[::7f00:1]/");         // ::127.0.0.1, deprecated compat form
});

Deno.test("SSRF: CGNAT 100.64/10 — blocked (was NOT covered before)", () => {
  blocked("http://100.64.0.1/");
  blocked("http://100.100.50.1/");
  blocked("http://100.127.255.255/");
});

Deno.test("SSRF: addresses just OUTSIDE the private ranges stay reachable", () => {
  // The guard must not over-block: these are ordinary public addresses and
  // blocking them would silently break real OSINT lookups.
  for (const ok of [
    "http://100.63.0.1/",    // just below CGNAT
    "http://100.128.0.1/",   // just above CGNAT
    "http://8.8.8.8/",
    "http://172.15.0.1/",    // just below 172.16/12
    "http://172.32.0.1/",    // just above 172.31
    "http://192.167.1.1/",
    "http://[2606:4700::1111]/", // public IPv6 (Cloudflare)
    "http://[2001:4860:4860::8888]/",
  ]) {
    assertSafeUrl(ok); // must not throw
  }
});

Deno.test("SSRF: existing IPv4 obfuscations remain blocked", () => {
  // These already worked (URL normalizes them to dotted quads) — pinned so the
  // rewrite above cannot regress them.
  blocked("http://2130706433/");   // decimal 127.0.0.1
  blocked("http://0x7f000001/");   // hex
  blocked("http://127.1/");        // short form
  blocked("http://169.254.169.254/");
  blocked("http://10.0.0.1/");
  blocked("http://localhost/");
});

Deno.test("SSRF: non-http protocols stay blocked", () => {
  blocked("file:///etc/passwd");
  blocked("gopher://127.0.0.1/");
});

Deno.test("isPrivateHost: malformed IPv6 is not treated as private (no false block)", () => {
  // A hostname that merely contains colons must not crash or over-match.
  assert(!isPrivateHost("not:an:address"));
  assert(!isPrivateHost("example.com"));
  assert(!isPrivateHost("999.999.999.999"));
});
