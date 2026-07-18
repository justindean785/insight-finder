// oathnet_test.ts — wire-shape + POOLED-quota + REDACTION proofs for the OathNet v2
// surface. The redaction tests are integrity-critical: they assert no plaintext
// credential/cookie/token can survive a trimmer into model context or an artifact.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@^1";
import {
  oathnetBreachSearchUrl,
  oathnetStealerSearchUrl,
  oathnetVictimsSearchUrl,
  oathnetVictimManifestUrl,
  oathnetVictimFileUrl,
  oathnetSubdomainUrl,
  oathnetDbnamesUrl,
  noteOathnetQuota,
  oathnetQuotaLeft,
  oathnetExhausted,
  resetOathnetQuota,
  stripSecrets,
  trimStealerItems,
  trimVictimItems,
  summarizeManifest,
  maskSecrets,
  safeVictimFile,
  classifyIpBreach,
  breachHitCount,
  SECRET_REDACTION,
} from "./oathnet.ts";

// ---- URL builders -------------------------------------------------------------

Deno.test("breach search: q + limit + dbname[] + filter_id", () => {
  const u = oathnetBreachSearchUrl("user@example.com", { dbnames: ["linkedin_2012", "canva"], filter_id: "flt_1" });
  assertStringIncludes(u, "/service/v2/breach/search?");
  assertStringIncludes(u, "q=user%40example.com");
  assertStringIncludes(u, "dbname%5B%5D=linkedin_2012");
  assertStringIncludes(u, "dbname%5B%5D=canva");
  assertStringIncludes(u, "filter_id=flt_1");
  assertStringIncludes(u, "limit=50");
});

Deno.test("stealer search: has_log_id + domain[] repeat", () => {
  const u = oathnetStealerSearchUrl("user@example.com", { hasLogId: true, domains: ["google.com", "roblox.com"] });
  assertStringIncludes(u, "/service/v2/stealer/search?");
  assertStringIncludes(u, "has_log_id=true");
  assertStringIncludes(u, "domain%5B%5D=google.com");
  assertStringIncludes(u, "domain%5B%5D=roblox.com");
});

Deno.test("victims search: total_docs_min", () => {
  const u = oathnetVictimsSearchUrl("user@example.com", { totalDocsMin: 10 });
  assertStringIncludes(u, "/service/v2/victims/search?");
  assertStringIncludes(u, "total_docs_min=10");
});

Deno.test("victim manifest + file + subdomain + dbnames encode path/query safely", () => {
  assertStringIncludes(oathnetVictimManifestUrl("vic_1/abc"), "/victims/vic_1%2Fabc");
  const f = oathnetVictimFileUrl("vic 1", "creds passwords");
  assertStringIncludes(f, "/victims/vic%201/files/creds%20passwords");
  assertStringIncludes(oathnetSubdomainUrl("example.com"), "/stealer/subdomain?domain=example.com");
  assertStringIncludes(oathnetDbnamesUrl("link"), "/breach/autocomplete/dbnames?q=link");
});

// ---- Pooled quota -------------------------------------------------------------

Deno.test("pooled quota: reads _meta.lookups.left_today; exhausted at 0", () => {
  resetOathnetQuota();
  assertEquals(oathnetQuotaLeft(), null);
  assertEquals(oathnetExhausted(), false, "null pool must not read as exhausted");
  noteOathnetQuota({ data: { items: [] }, _meta: { lookups: { left_today: 9995 } } });
  assertEquals(oathnetQuotaLeft(), 9995);
  assertEquals(oathnetExhausted(), false);
  noteOathnetQuota({ _meta: { lookups: { left_today: 0 } } });
  assertEquals(oathnetExhausted(), true, "0 remaining must exhaust the pool");
  // A payload without the field must NOT clobber the last known value.
  noteOathnetQuota({ data: { items: [] } });
  assertEquals(oathnetQuotaLeft(), 0);
  resetOathnetQuota();
});

Deno.test("pooled quota: reads the per-family field name variants", () => {
  resetOathnetQuota();
  // OSINT lookups echo a top-level lookups_left.
  noteOathnetQuota({ success: true, data: {}, lookups_left: 812 });
  assertEquals(oathnetQuotaLeft(), 812);
  // search-session init nests it under data.user.daily_lookups.remaining.
  noteOathnetQuota({ data: { user: { daily_lookups: { remaining: 550, limit: 1000 } } } });
  assertEquals(oathnetQuotaLeft(), 550);
  resetOathnetQuota();
});

// ---- Redaction: the integrity-critical proofs ---------------------------------

Deno.test("stripSecrets masks secret-keyed fields, keeps identity fields, caps arrays", () => {
  const out = stripSecrets({
    username: "victim@gmail.com",
    password: "SuperSecret123!",
    auth_token: "eyJhbGciOi...",
    cookies: "sessionid=abc; csrftoken=def",
    domain: ["a.com"],
    big: Array.from({ length: 100 }, (_, i) => i),
  }) as Record<string, unknown>;
  assertEquals(out.username, "victim@gmail.com");
  assertEquals(out.password, SECRET_REDACTION);
  assertEquals(out.auth_token, SECRET_REDACTION);
  assertEquals(out.cookies, SECRET_REDACTION);
  assertEquals((out.big as unknown[]).length, 40, "arrays capped");
});

Deno.test("trimStealerItems NEVER emits a raw password; exposes credential_present bool", () => {
  const items = [{
    id: "doc_1", log_id: "vic_1", url_str: "https://accounts.google.com/signin",
    domain: ["google.com"], subdomain: ["accounts.google.com"], path: ["/signin"],
    username: "user@gmail.com", password: "SecretPass123", email: ["user@gmail.com"],
    pwned_at: "2024-03-15T10:30:00Z", indexed_at: "2024-03-20T12:00:00Z",
  }];
  const trimmed = trimStealerItems(items);
  const blob = JSON.stringify(trimmed);
  assert(!blob.includes("SecretPass123"), "raw password must not survive trimming");
  assertEquals(trimmed[0].credential_present, true);
  assertEquals(trimmed[0].log_id, "vic_1");
  assertEquals(trimmed[0].username, "user@gmail.com");
});

Deno.test("REVEAL policy: trimStealerItems(reveal=true) SURFACES the raw password", () => {
  const items = [{
    id: "doc_1", log_id: "vic_1", url_str: "https://accounts.google.com/signin",
    username: "user@gmail.com", password: "SecretPass123",
    pwned_at: "2024-03-15T10:30:00Z",
  }];
  const revealed = trimStealerItems(items, 25, true);
  const blob = JSON.stringify(revealed);
  assert(blob.includes("SecretPass123"), "reveal=true must surface the raw password");
  assertEquals(revealed[0].password, "SecretPass123");
  assertEquals(revealed[0].credential_present, true);
  assertEquals(revealed[0].username, "user@gmail.com");
});

Deno.test("REVEAL policy: stripSecrets(reveal=true) keeps secret values verbatim", () => {
  const out = stripSecrets({ username: "u", password: "hunter2", session: "abc.def" }, 40, 0, true) as Record<string, unknown>;
  assertEquals(out.password, "hunter2");
  assertEquals(out.session, "abc.def");
});

Deno.test("REVEAL policy: maskSecrets(reveal=true) returns the raw line unmasked", () => {
  const raw = "user@example.com:hunter2\npassword: topsecret";
  assertEquals(maskSecrets(raw, true), raw);
});

Deno.test("trimVictimItems keeps device metadata, no creds", () => {
  const items = [{
    log_id: "vic_2", device_user_str: ["Tyler"], hwids_str: ["HWID-9999"],
    device_ips: ["73.45.123.89"], device_emails_str: ["progamer@gmail.com"],
    discord_ids: ["396488966779392318"], total_docs: 54,
    pwned_at: "2024-03-15T10:30:00Z", indexed_at: "2024-11-24T12:00:00Z",
    password: "leaked", cookies: "sessionid=x",
  }];
  const trimmed = trimVictimItems(items);
  const blob = JSON.stringify(trimmed);
  assert(!blob.includes("leaked") && !blob.includes("sessionid=x"), "no creds in victim metadata");
  assertEquals(trimmed[0].discord_ids, ["396488966779392318"]);
  assertEquals(trimmed[0].total_docs, 54);
});

Deno.test("summarizeManifest keeps tree structure only, no file contents", () => {
  const m = {
    log_id: "vic_2", log_name: "xX_DragonSlayer_Xx",
    victim_tree: { id: "root", name: "StealerLog", type: "directory", children: [
      { id: "creds", name: "passwords.txt", type: "file", size_bytes: 4521, content: "u:p" },
    ] },
  };
  const s = summarizeManifest(m);
  const blob = JSON.stringify(s);
  assert(!blob.includes("u:p"), "manifest summary must not carry file content");
  assertEquals(s.log_id, "vic_2");
  assertStringIncludes(blob, "passwords.txt");
});

Deno.test("maskSecrets masks combolists + key:value secrets, keeps identity", () => {
  const raw = [
    "https://accounts.google.com/signin:user@gmail.com:HunterPass99",
    "user@gmail.com:MyPassw0rd",
    "password: TopSecret1",
    "cookie=sessionid=abc123def",
    "just a normal note line",
  ].join("\n");
  const masked = maskSecrets(raw);
  assert(!masked.includes("HunterPass99"), "combolist trailing password masked");
  assert(!masked.includes("MyPassw0rd"), "user:pass password masked");
  assert(!masked.includes("TopSecret1"), "key:value secret masked");
  assert(!masked.includes("abc123def"), "cookie value masked");
  assertStringIncludes(masked, "user@gmail.com", "identity pivot kept");
  assertStringIncludes(masked, "just a normal note line", "non-secret line untouched");
});

Deno.test("safeVictimFile returns masked preview + metadata, never raw creds", () => {
  const text = "url:user@x.com:RawPassword1\napi_key=sk-live-9999\nfootprint line\n";
  const r = safeVictimFile({ logId: "vic_1", fileId: "creds", text, sha256: "deadbeef" });
  const blob = JSON.stringify(r);
  assert(!blob.includes("RawPassword1"), "no raw password in file result");
  assert(!blob.includes("sk-live-9999"), "no raw api key in file result");
  assertEquals(r.sha256, "deadbeef");
  assertEquals(r.line_count, 4);
  assert(typeof r.redacted_preview === "string");
});

// ---- IP breach-search partial-success contract --------------------------------

Deno.test("breachHitCount: recognizes shapes; unparseable → null (never 0)", () => {
  assertEquals(breachHitCount({ data: { items: [1, 2, 3] } }), 3);
  assertEquals(breachHitCount({ data: { items: [] } }), 0);
  assertEquals(breachHitCount({ data: { meta: { total: 7 } } }), 7);
  assertEquals(breachHitCount({ data: [1, 2] }), 2);
  assertEquals(breachHitCount({ results: [{}, {}, {}] }), 3);
  assertEquals(breachHitCount({ total: 0 }), 0);
  assertEquals(breachHitCount({ some_unknown_shape: true }), null, "unparseable must be null, never 0");
  assertEquals(breachHitCount(null), null);
  assertEquals(breachHitCount("raw text"), null);
});

Deno.test("IP breach state — HITS: weak/temporal [VERIFY], never merge", () => {
  const v = classifyIpBreach({ kind: "ok", hitCount: 4 });
  assertEquals(v.breach_status, "hits");
  assertEquals(v.breach_complete, true);
  assertEquals(v.exposure, "breach_hits");
  assertStringIncludes(v.note, "same-IP ≠ same-person");
  assertStringIncludes(v.note, "NEVER merge identities on an IP match alone");
});

Deno.test("IP breach state — ZERO hits: 'clean' is the ONLY route to no-exposure", () => {
  const v = classifyIpBreach({ kind: "ok", hitCount: 0 });
  assertEquals(v.breach_status, "clean");
  assertEquals(v.breach_complete, true);
  assertEquals(v.exposure, "no_breach_exposure");
  assertStringIncludes(v.note, "zero hits");
});

Deno.test("IP breach state — TIMEOUT: unknown/partial, not clean", () => {
  const v = classifyIpBreach({ kind: "timeout" });
  assertEquals(v.breach_status, "timeout");
  assertEquals(v.breach_complete, false);
  assertEquals(v.exposure, "unknown");
  assertStringIncludes(v.note, "UNKNOWN, NOT 'clean'");
});

Deno.test("IP breach state — QUOTA SKIP: unknown/partial, not clean", () => {
  const v = classifyIpBreach({ kind: "skipped_quota" });
  assertEquals(v.breach_status, "skipped_quota");
  assertEquals(v.breach_complete, false);
  assertEquals(v.exposure, "unknown");
  assertStringIncludes(v.note, "UNKNOWN, NOT 'clean'");
});

Deno.test("IP breach state — provider FAILURE: unknown/partial, not clean", () => {
  const v = classifyIpBreach({ kind: "failed", status: 502 });
  assertEquals(v.breach_status, "failed");
  assertEquals(v.breach_complete, false);
  assertEquals(v.exposure, "unknown");
  assertStringIncludes(v.note, "502");
  assertStringIncludes(v.note, "UNKNOWN, NOT 'clean'");
});

Deno.test("IP breach state — OK but unrecognized shape: unknown, NEVER clean", () => {
  const v = classifyIpBreach({ kind: "ok", hitCount: null });
  assertEquals(v.breach_status, "unknown");
  assertEquals(v.breach_complete, false);
  assertEquals(v.exposure, "unknown");
});

Deno.test("IP overall contract — ok = network_ok AND breach_complete (partial otherwise)", () => {
  const overall = (networkOk: boolean, complete: boolean) => ({ ok: networkOk && complete, partial: !(networkOk && complete) });
  // network ok + completed search (hits or confirmed zero) → full success
  assertEquals(overall(true, classifyIpBreach({ kind: "ok", hitCount: 2 }).breach_complete), { ok: true, partial: false });
  assertEquals(overall(true, classifyIpBreach({ kind: "ok", hitCount: 0 }).breach_complete), { ok: true, partial: false });
  // network ok + breach FAILED / QUOTA → partial, NOT success (can't assert clean)
  assertEquals(overall(true, classifyIpBreach({ kind: "failed", status: 500 }).breach_complete), { ok: false, partial: true });
  assertEquals(overall(true, classifyIpBreach({ kind: "skipped_quota" }).breach_complete), { ok: false, partial: true });
  // network FAILURE + breach success → partial (breach data usable, but not a full success)
  assertEquals(overall(false, classifyIpBreach({ kind: "ok", hitCount: 3 }).breach_complete), { ok: false, partial: true });
});
