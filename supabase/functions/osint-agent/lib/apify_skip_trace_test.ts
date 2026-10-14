// lib/apify_skip_trace_test.ts — the Apify skip-trace client (lib/apify-skip-trace.ts),
// driven with a scripted fetch. Synthetic values only.
//
// Contract under test: https://apify.com/one-api/skip-trace (README + input schema,
// read 2026-10-14), reached through the Lovable connector gateway.
import { assert, assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  APIFY_GATEWAY_BASE,
  APIFY_SKIP_TRACE_CLIENT_TIMEOUT_MS,
  APIFY_SKIP_TRACE_MAX_RESULTS_CAP,
  APIFY_SKIP_TRACE_RUN_TIMEOUT_S,
  apifySkipTrace,
  apifySkipTraceGate,
  apifySkipTraceHealthDetail,
  apifySkipTraceKillSwitchOn,
  normalizeSkipTraceInput,
  shapeSkipTraceRow,
  type ApifySkipTraceDeps,
} from "./apify-skip-trace.ts";

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };
type Reply = Response | (() => Response) | Error | "hang";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function harness(opts: { reply?: Reply; apiKey?: string | undefined; lovableKey?: string | undefined; disabled?: boolean; signal?: AbortSignal } = {}) {
  const calls: Call[] = [];
  const deps: ApifySkipTraceDeps = {
    apiKey: "apiKey" in opts ? opts.apiKey : "conn_test_key",
    lovableKey: "lovableKey" in opts ? opts.lovableKey : "lovable_test_key",
    disabled: opts.disabled ?? false,
    fetch: (url, init) => {
      calls.push({
        method: String(init.method ?? "GET"),
        url,
        headers: { ...(init.headers as Record<string, string>) },
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      const r = opts.reply;
      if (r === "hang") {
        return new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
        });
      }
      if (r instanceof Error) return Promise.reject(r);
      if (typeof r === "function") return Promise.resolve(r());
      return Promise.resolve((r ?? json(200, [])).clone());
    },
    signal: opts.signal,
  };
  return { deps, calls };
}

/** A README-shaped row with synthetic values. */
const ROW = (over: Record<string, unknown> = {}) => ({
  "Search Option": "Name Search",
  "Input Given": "Jordan Vale",
  "First Name": "Jordan",
  "Last Name": "Vale",
  "Age": "41",
  "Born": "March 1985",
  "Lives in": "12 Example Ct Springfield IL 62701",
  "Street Address": "12 Example Ct",
  "Address Locality": "Springfield",
  "Address Region": "IL",
  "Postal Code": "62701",
  "County Name": "Sangamon County",
  "Email-1": "jordan.vale@example.com",
  "Email-2": "",
  "Email-3": "not-an-email",
  "Phone-1": "(217) 555-0100",
  "Phone-1 Type": "Wireless",
  "Phone-1 First Reported": "June 2024",
  "Phone-1 Last Reported": "",
  "Phone-1 Provider": "Example Wireless",
  "Phone-2": "(217) 555-0101",
  "Phone-2 Type": "Landline",
  "Previous Addresses": [
    { streetAddress: "9 Old Rd", addressLocality: "Decatur", addressRegion: "IL", postalCode: "62521", county: "Macon County", timespan: "Recorded July 2010" },
  ],
  "Relatives": [{ Name: "Sam Vale", Age: "70" }, { Name: "Pat Vale", Age: "68" }],
  "Associates": [{ Name: "Lee Example", Age: "50" }],
  "Person Link": "https://www.fastpeoplesearch.com/jordan-vale_id_G-0",
  ...over,
});

// ── Gate ────────────────────────────────────────────────────────────────────

Deno.test("apify: key unset is a free skip that refunds the paid slot and never touches the network", async () => {
  const h = harness({ apiKey: undefined });
  const out = await apifySkipTrace({ name: ["Jordan Vale"] }, h.deps);
  assertEquals(out, { error: "APIFY_API_KEY not configured", skipped: true, provider_attempted: false });
  assertEquals(h.calls.length, 0);
});

Deno.test("apify: the connector gateway needs LOVABLE_API_KEY too — without it, skip, no network", async () => {
  const h = harness({ lovableKey: undefined });
  const out = await apifySkipTrace({ name: ["Jordan Vale"] }, h.deps);
  assertEquals(out.skipped, true);
  assertEquals(out.provider_attempted, false);
  assertStringIncludes(String(out.error), "LOVABLE_API_KEY");
  assertEquals(h.calls.length, 0);
});

Deno.test("apify: kill switch beats a configured key", async () => {
  const h = harness({ disabled: true });
  const out = await apifySkipTrace({ email: ["jordan.vale@example.com"] }, h.deps);
  assertEquals(out.skipped, true);
  assertEquals(out.provider_attempted, false);
  assertEquals(h.calls.length, 0);
  assertEquals(apifySkipTraceGate({ apiKey: "k", lovableKey: "l", disabled: false }), null);
  assertEquals(apifySkipTraceKillSwitchOn((k) => (k === "APIFY_SKIP_TRACE_DISABLED" ? " TRUE " : undefined)), true);
  assertEquals(apifySkipTraceKillSwitchOn(() => "false"), false);
});

// ── Input ───────────────────────────────────────────────────────────────────

Deno.test("apify: empty input is a structured input error, no HTTP call", async () => {
  const h = harness();
  for (const input of [{}, { name: [] }, { name: ["   "] }, { phone_number: [""] }, null as unknown as Record<string, never>]) {
    const out = await apifySkipTrace(input as Record<string, never>, h.deps);
    assertEquals(out.ok, false);
    assertEquals(out.code, "empty_input");
    assertEquals(out.provider_attempted, false);
  }
  assertEquals(h.calls.length, 0);
});

Deno.test("apify: one query entry per call — two entries or two kinds are refused before the network", async () => {
  const h = harness();
  const two = await apifySkipTrace({ name: ["A B", "C D"] }, h.deps);
  assertEquals(two.code, "one_query_per_call");
  const mixed = await apifySkipTrace({ name: ["A B"], email: ["a@example.com"] }, h.deps);
  assertEquals(mixed.code, "one_query_per_call");
  assertEquals(h.calls.length, 0);
});

Deno.test("apify: max_results defaults to 1 and is clamped to the cap; junk falls back to the default", () => {
  const q = (mr: unknown) => normalizeSkipTraceInput({ name: ["Jordan Vale"], max_results: mr as number }) as { maxResults: number; body: Record<string, unknown> };
  assertEquals(q(undefined).maxResults, 1);
  assertEquals(q(2).maxResults, 2);
  assertEquals(q(99).maxResults, APIFY_SKIP_TRACE_MAX_RESULTS_CAP);
  assertEquals(q(0).maxResults, 1);
  assertEquals(q(2.7).maxResults, 2);
  assertEquals(q("3").maxResults, 1);
  assertEquals(q(2).body, { name: ["Jordan Vale"], max_results: 2 });
});

// ── Transport ───────────────────────────────────────────────────────────────

Deno.test("apify: the request goes to the Lovable gateway run-sync endpoint with both headers and no token in the URL", async () => {
  const h = harness({ reply: json(200, [ROW()]) });
  await apifySkipTrace({ street_citystatezip: [" 12 Example Ct;  Springfield, IL 62701 "] }, h.deps);
  assertEquals(h.calls.length, 1);
  const c = h.calls[0];
  assertEquals(c.method, "POST");
  assert(c.url.startsWith(`${APIFY_GATEWAY_BASE}/acts/one-api~skip-trace/run-sync-get-dataset-items?`), c.url);
  assertStringIncludes(c.url, `timeout=${APIFY_SKIP_TRACE_RUN_TIMEOUT_S}`);
  assert(!c.url.includes("api.apify.com"), "must never call api.apify.com directly");
  assert(!c.url.includes("conn_test_key") && !c.url.includes("lovable_test_key") && !/token=/.test(c.url), "no credential in the URL");
  assertEquals(c.headers["Authorization"], "Bearer lovable_test_key");
  assertEquals(c.headers["X-Connection-Api-Key"], "conn_test_key");
  assertEquals(c.body, { street_citystatezip: ["12 Example Ct; Springfield, IL 62701"], max_results: 1 });
});

// ── Happy path ──────────────────────────────────────────────────────────────

Deno.test("apify: a README-shaped row is shaped into leads with provenance, counts for third parties, and the person link", async () => {
  const h = harness({ reply: json(200, [ROW()]) });
  const out = await apifySkipTrace({ name: ["Jordan Vale"] }, h.deps);
  assertEquals(out.ok, true);
  assertEquals(out.source, "apify:one-api/skip-trace");
  assertEquals(out.query_kind, "name");
  assertEquals(out.results_total, 1);
  assertEquals(out.results_returned, 1);
  assertEquals(out.fallback_rows, 0);
  const row = (out.results as Array<Record<string, unknown>>)[0];
  assertEquals(row.full_name, "Jordan Vale");
  assertEquals(row.age, "41");
  assertEquals(row.emails, ["jordan.vale@example.com"]); // blanks and non-emails dropped
  const phones = row.phones as Array<Record<string, unknown>>;
  assertEquals(phones.length, 2);
  assertEquals(phones[0], { number: "(217) 555-0100", type: "Wireless", provider: "Example Wireless", first_reported: "June 2024", last_reported: null });
  assertEquals((row.current_address as Record<string, unknown>).postal_code, "62701");
  assertEquals((row.previous_addresses as unknown[]).length, 1);
  // Relatives / associates are counted, never inlined.
  assertEquals(row.relatives_count, 2);
  assertEquals(row.associates_count, 1);
  assertEquals("relatives" in row, false);
  assertEquals(row.person_link, "https://www.fastpeoplesearch.com/jordan-vale_id_G-0");
  assertEquals(row.name_match, null);
  assertStringIncludes(String(out.note), "never identity proof");
});

Deno.test("apify: a 'Name Match: fallback' row is labelled fallback and counted", async () => {
  const rows = [ROW({ "Target Name": "Jordan Vale", "Name Match": "matched" }), ROW({ "First Name": "Casey", "Target Name": "Jordan Vale", "Name Match": "Fallback" })];
  const h = harness({ reply: json(200, rows) });
  const out = await apifySkipTrace({ phone_number: ["(217) 555-0100 | Jordan Vale"], max_results: 2 }, h.deps);
  assertEquals(out.ok, true);
  const res = out.results as Array<Record<string, unknown>>;
  assertEquals(res[0].name_match, "matched");
  assertEquals(res[1].name_match, "fallback");
  assertEquals(res[1].target_name, "Jordan Vale");
  assertEquals(out.fallback_rows, 1);
});

Deno.test("apify: an empty dataset is ok with zero rows; a row with no person in it is dropped", async () => {
  const h = harness({ reply: json(200, [{}, { "Search Option": "Name Search" }]) });
  const out = await apifySkipTrace({ name: ["Jordan Vale"] }, h.deps);
  assertEquals(out.ok, true);
  assertEquals(out.results_total, 2);
  assertEquals(out.results_returned, 0);
  assertEquals(shapeSkipTraceRow(null), null);
  assertEquals(shapeSkipTraceRow([ROW()]), null);
  assertEquals(shapeSkipTraceRow({ "Person Link": "javascript:alert(1)", "First Name": "X" })?.person_link, null);
});

// ── Failures ────────────────────────────────────────────────────────────────

Deno.test("apify: 402 is a plain out-of-credits failure (ok:false, constant text, provider text bounded)", async () => {
  const h = harness({ reply: json(402, { error: { type: "insufficient-credits", message: "You have exceeded the usage credits.   " + "x".repeat(500) } }) });
  const out = await apifySkipTrace({ name: ["Jordan Vale"] }, h.deps);
  assertEquals(out.ok, false);
  assertEquals(out.status, 402);
  assertEquals(out.code, "out_of_credits");
  assertStringIncludes(String(out.error), "out of usage credits");
  assertEquals("skipped" in out, false, "a refusal is logged as a failure, never laundered into a skip");
  assert((out.provider_message as string).length <= 200);
});

Deno.test("apify: 404 (actor renamed/removed) is terminal; 401 names the gateway key problem", async () => {
  const h404 = harness({ reply: json(404, { error: { type: "record-not-found", message: "Actor was not found" } }) });
  const out = await apifySkipTrace({ name: ["Jordan Vale"] }, h404.deps);
  assertEquals(out.code, "actor_not_found");
  assertEquals(out.terminal, true);
  const h401 = harness({ reply: new Response("nope", { status: 401 }) });
  const o401 = await apifySkipTrace({ name: ["Jordan Vale"] }, h401.deps);
  assertEquals(o401.code, "invalid_api_key");
  assertEquals("provider_message" in o401, false);
});

Deno.test("apify: a hung run is cut at the client bound, reported as timeout, and never retried", async () => {
  const h = harness({ reply: "hang" });
  const t0 = Date.now();
  // Shorten the wait: abort through the forwarded signal the way the wrapper would.
  const ctrl = new AbortController();
  h.deps.signal = ctrl.signal;
  const p = apifySkipTrace({ name: ["Jordan Vale"] }, h.deps);
  setTimeout(() => ctrl.abort(), 20);
  const out = await p;
  assertEquals(out.ok, false);
  assertEquals(out.code, "timeout");
  assertEquals(h.calls.length, 1, "no retry storm");
  assert(Date.now() - t0 < APIFY_SKIP_TRACE_CLIENT_TIMEOUT_MS);
});

Deno.test("apify: malformed JSON and a non-array dataset are structured bad_response errors, no throw", async () => {
  const bad = harness({ reply: new Response("<html>oops", { status: 200, headers: { "Content-Type": "application/json" } }) });
  const out = await apifySkipTrace({ name: ["Jordan Vale"] }, bad.deps);
  assertEquals(out.ok, false);
  assertEquals(out.code, "bad_response");
  const obj = harness({ reply: json(200, { data: { items: [] } }) });
  const o2 = await apifySkipTrace({ name: ["Jordan Vale"] }, obj.deps);
  assertEquals(o2.code, "bad_response");
});

Deno.test("apify: a network error is request_failed, not a throw", async () => {
  const h = harness({ reply: new Error("ECONNRESET") });
  const out = await apifySkipTrace({ email: ["jordan.vale@example.com"] }, h.deps);
  assertEquals(out.ok, false);
  assertEquals(out.code, "request_failed");
});

// ── Health ──────────────────────────────────────────────────────────────────

Deno.test("apify: /health detail reports configured / missing key / missing gateway key / disabled, never the key", () => {
  const on = apifySkipTraceHealthDetail(true, true, false);
  assertEquals(on.ok, true);
  assertEquals(on.configured, true);
  assertStringIncludes(on.detail, "connector gateway");
  assertEquals(apifySkipTraceHealthDetail(false, true, false).configured, false);
  assertEquals(apifySkipTraceHealthDetail(true, false, false).configured, false);
  assertStringIncludes(apifySkipTraceHealthDetail(true, false, false).detail, "LOVABLE_API_KEY");
  assertStringIncludes(apifySkipTraceHealthDetail(true, true, true).detail, "disabled");
});
