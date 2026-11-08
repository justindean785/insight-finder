// indicia_web_dbs_default_test.ts — the default corpus list must not include a corpus
// the request cannot satisfy.
//
// Measured over 30 days (audit of 2026-11-08): 5 of the 8 `indicia_web_dbs` calls failed
// with `HTTP 400: snusbaseType is required when snusbase is selected`. The default
// `services` list contained `snusbase`, but the request body only ever carries
// `{ query, services }` — the provider's required `snusbaseType` is never sent, and its
// allowed values are not documented anywhere in this repo. Until they are known the safe
// default is the three corpora that need no extra field. An EXPLICIT request for snusbase
// is still forwarded (the caller named it); only the DEFAULT changes.
//
// Synthetic, non-sensitive fixtures only.
import { assert, assertEquals, assertFalse } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  resolveWebDbServices,
  WEB_DB_DEFAULT_SERVICES,
  WEB_DB_SERVICES,
  webDbsSnusbaseDefaultRestored,
  webDbsDefaultSelfTest,
} from "../../functions/osint-agent/lib/indicia-web-dbs.ts";

async function withEnv<T>(key: string, value: string | undefined, fn: () => T | Promise<T>): Promise<T> {
  const prev = Deno.env.get(key);
  if (value === undefined) Deno.env.delete(key); else Deno.env.set(key, value);
  try { return await fn(); } finally {
    if (prev === undefined) Deno.env.delete(key); else Deno.env.set(key, prev);
  }
}

Deno.test("the default list excludes snusbase and keeps the other three corpora", () => {
  assertFalse((WEB_DB_DEFAULT_SERVICES as readonly string[]).includes("snusbase"));
  assertEquals([...WEB_DB_DEFAULT_SERVICES], ["cloudsint", "leakcheck", "intelligencex.identityportal"]);
  for (const s of WEB_DB_DEFAULT_SERVICES) assert((WEB_DB_SERVICES as readonly string[]).includes(s));
});

Deno.test("an omitted, empty or wholly-invalid request resolves to the default, never the full closed set", () => {
  assertEquals(resolveWebDbServices(undefined), [...WEB_DB_DEFAULT_SERVICES]);
  assertEquals(resolveWebDbServices([]), [...WEB_DB_DEFAULT_SERVICES]);
  assertEquals(resolveWebDbServices(["not-a-service"]), [...WEB_DB_DEFAULT_SERVICES]);
});

Deno.test("an explicit request is honoured, case-folded, and filtered to the closed set", () => {
  assertEquals(resolveWebDbServices(["LeakCheck", "not-a-service"]), ["leakcheck"]);
  assertEquals(resolveWebDbServices([" snusbase "]), ["snusbase"], "named by the caller, so forwarded");
});

Deno.test("the kill switch restores the full closed set as the default, read at call time", async () => {
  await withEnv("INDICIA_WEB_DBS_SNUSBASE_DEFAULT", "true", () => {
    assert(webDbsSnusbaseDefaultRestored());
    assertEquals(resolveWebDbServices(undefined), [...WEB_DB_SERVICES]);
  });
  assertFalse(webDbsSnusbaseDefaultRestored());
  assertEquals(resolveWebDbServices(undefined), [...WEB_DB_DEFAULT_SERVICES]);
});

Deno.test("the /health self-test passes with the rule on and reports LEGACY when switched off", async () => {
  const on = webDbsDefaultSelfTest();
  assert(on.ok, on.detail);
  assertFalse(on.detail.startsWith("LEGACY"));
  await withEnv("INDICIA_WEB_DBS_SNUSBASE_DEFAULT", "true", () => {
    const off = webDbsDefaultSelfTest();
    assert(off.ok);
    assert(off.detail.startsWith("LEGACY"));
  });
});
