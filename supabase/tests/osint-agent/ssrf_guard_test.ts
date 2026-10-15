// SSRF guard (safety.ts isPrivateHost / assertSafeUrl). It had no tests.
// Audit 2026-09-24 F-7a: it checked literal IPv4 private ranges and ::1 only, so
// IPv4-mapped IPv6, CGNAT, IPv6 ULA and link-local addresses reached fetch().
// Hosts are passed exactly as `new URL(...).hostname` produces them.
import { assert, assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  assertSafeUrl, isPrivateHost, SSRF_GUARD_LEGACY_ENV, ssrfGuardHealthDetail, ssrfGuardLegacy,
} from "../../functions/osint-agent/safety.ts";

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
    "http://[fec0::1]/", "http://[feff::1]/",
    "http://[ff02::1]/",
  ]) assert(isPrivateHost(host(u)), `${u} → ${host(u)}`);
});

Deno.test("SSRF: blocks IPv4-compatible IPv6 (::/96), e.g. ::127.0.0.1 and ::169.254.169.254", () => {
  for (const u of ["http://[::127.0.0.1]/", "http://[::a9fe:a9fe]/", "http://[::10.0.0.1]/"]) {
    assert(isPrivateHost(host(u), false), `${u} → ${host(u)}`);
  }
});

Deno.test("SSRF kill switch: an unreadable env fails safe to the new guard instead of throwing", () => {
  const denied = (_k: string): string | undefined => { throw new Error("NotCapable: Requires env access"); };
  assertEquals(ssrfGuardLegacy(denied), false);
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

Deno.test("SSRF kill switch: legacy mode restores the old checker exactly", () => {
  // Newly blocked forms pass again under legacy; the old blocks still hold.
  for (const u of ["http://[::ffff:127.0.0.1]/", "http://100.64.0.1/", "http://[fc00::1]/", "http://[fec0::1]/"]) {
    assert(isPrivateHost(host(u), false), `new: ${u}`);
    assertEquals(isPrivateHost(host(u), true), false, `legacy: ${u}`);
  }
  for (const u of ["http://127.0.0.1/", "http://169.254.169.254/", "http://[::1]/", "http://localhost/"]) {
    assert(isPrivateHost(host(u), true), `legacy still blocks ${u}`);
  }
});

Deno.test("SSRF kill switch: read from env, default OFF, only an explicit 'true' enables it", () => {
  const env = (v: string | undefined) => (k: string) => (k === SSRF_GUARD_LEGACY_ENV ? v : undefined);
  assertEquals(ssrfGuardLegacy(env(undefined)), false);
  assertEquals(ssrfGuardLegacy(env("1")), false);
  assertEquals(ssrfGuardLegacy(env(" TRUE ")), true);
  assert(ssrfGuardHealthDetail(true).includes(SSRF_GUARD_LEGACY_ENV));
  assert(ssrfGuardHealthDetail(false).includes("site-local"));
});

Deno.test("health: checks.ssrf_guard reports the checker actually in force", async () => {
  const src = await Deno.readTextFile(new URL("../../functions/osint-agent/health-handler.ts", import.meta.url));
  assert(src.includes("r.checks.ssrf_guard = { ok: true, detail: ssrfGuardHealthDetail(ssrfGuardLegacy()) };"));
});
