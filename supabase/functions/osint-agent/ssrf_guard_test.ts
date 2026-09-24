// SSRF guard (safety.ts isPrivateHost / assertSafeUrl). It had no tests.
// Audit 2026-09-24 F-7a: it checked literal IPv4 private ranges and ::1 only, so
// IPv4-mapped IPv6, CGNAT, IPv6 ULA and link-local addresses reached fetch().
// Hosts are passed exactly as `new URL(...).hostname` produces them.
import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { assertSafeUrl, isPrivateHost } from "./safety.ts";

const host = (u: string) => new URL(u).hostname;

Deno.test("SSRF: still blocks what it blocked before", () => {
  for (const u of [
    "http://localhost/", "http://a.localhost/", "http://x.internal/", "http://[::1]/",
    "http://127.0.0.1/", "http://10.1.2.3/", "http://172.16.0.1/", "http://192.168.1.1/",
    "http://169.254.169.254/", "http://0.0.0.0/", "http://224.0.0.1/",
    "http://2130706433/", // decimal 127.0.0.1 — the URL parser normalises it
  ]) assert(isPrivateHost(host(u)), u);
});

Deno.test("SSRF: blocks IPv4-mapped / NAT64 IPv6 forms of internal addresses", () => {
  for (const u of [
    "http://[::ffff:127.0.0.1]/", "http://[::ffff:169.254.169.254]/", "http://[::ffff:10.0.0.1]/",
    "http://[64:ff9b::a9fe:a9fe]/",
  ]) assert(isPrivateHost(host(u)), `${u} → ${host(u)}`);
});

Deno.test("SSRF: blocks CGNAT, the unspecified address, IPv6 ULA, link-local and multicast", () => {
  for (const u of [
    "http://100.64.0.1/", "http://100.127.255.254/",
    "http://[::]/", "http://[fc00::1]/", "http://[fd12:3456::1]/", "http://[fe80::1]/", "http://[febf::1]/",
    "http://[ff02::1]/",
  ]) assert(isPrivateHost(host(u)), `${u} → ${host(u)}`);
});

Deno.test("SSRF: public hosts and addresses stay allowed", () => {
  for (const u of [
    "https://example.com/", "https://1.1.1.1/", "https://100.63.255.255/", "https://100.128.0.1/",
    "https://[2606:4700:4700::1111]/", "https://[::ffff:8.8.8.8]/", "https://172.32.0.1/",
  ]) assertEquals(isPrivateHost(host(u)), false, u);
});

Deno.test("SSRF: assertSafeUrl refuses a mapped-IPv6 metadata URL", () => {
  assertThrows(() => assertSafeUrl("http://[::ffff:169.254.169.254]/latest/meta-data/"), Error, "blocked");
});

Deno.test("health: checks.ssrf_guard reports the IPv6-aware guard", async () => {
  const src = await Deno.readTextFile(new URL("./health-handler.ts", import.meta.url));
  assert(src.includes("r.checks.ssrf_guard = { ok: true,"));
});
