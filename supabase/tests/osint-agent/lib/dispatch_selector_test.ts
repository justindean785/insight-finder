// dispatch_selector_test.ts — the pure extractor behind the Serus / Indicia /
// CordCat dispatch aliases. The wrapper-level behaviour (refusal, taint, cache
// identity, kill switch) is pinned in ../dispatch_selector_aliases_test.ts.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  dispatchSelectorAliasesSelfTest,
  dispatchSelectorCandidates,
} from "../../../functions/osint-agent/lib/dispatch-selector.ts";

const on = (_k: string) => undefined;
const off = (k: string) => (k === "DISPATCH_SELECTOR_ALIASES_DISABLED" ? "true" : undefined);
const types = (input: unknown, tool = "any_tool", env = on) =>
  dispatchSelectorCandidates(input, tool, env).map((c) => c.type);

Deno.test("Serus identifierType maps onto the dispatch keyspace", () => {
  assertEquals(types({ identifierValue: "a@b.co", identifierType: "email" }), ["email"]);
  assertEquals(types({ identifierValue: "+15550100000", identifierType: "phone" }), ["phone"]);
  assertEquals(types({ identifierValue: "jordan.vale", identifierType: "username" }), ["username"]);
  assertEquals(types({ identifierValue: "example.com", identifierType: "domain" }), ["domain"]);
});

Deno.test("a Serus keyword can be a person's name or a handle", () => {
  assertEquals(types({ identifierValue: "Jordan Vale", identifierType: "keyword" }), ["name", "username"]);
  assertEquals(types({ identifierValue: "a@b.co", identifierType: "keyword" }), ["name", "username", "email"]);
});

Deno.test("a Serus password is never a selector", () => {
  assertEquals(types({ identifierValue: "hunter2", identifierType: "password" }), []);
  assertEquals(types({ identifierValue: "a@b.co", identifierType: "password" }), []);
});

Deno.test("query / q count only when the whole value IS one exact selector", () => {
  assertEquals(types({ query: "a@b.co" }), ["email"]);
  assertEquals(types({ query: "+1 (555) 010-0000" }), ["phone"]);
  assertEquals(types({ query: "203.0.113.7" }), ["ip"]);
  assertEquals(types({ q: "example.com" }), ["domain"]);
  assertEquals(types({ query: "\"a@b.co\" leak OR breach" }), []);
  assertEquals(types({ query: "tools to find who registered a domain" }), []);
  assertEquals(types({ q: "link" }), [], "a DB-name fragment is not a selector");
});

Deno.test("query extraction is tool-aware: some tools' query IS a selector, one tool's q never is", () => {
  // Indicia: the query is the selector, so a bare handle counts.
  assertEquals(types({ query: "a@b.co" }, "indicia_email"), ["email"]);
  assertEquals(types({ query: "5550100000" }, "indicia_phone"), ["phone"]);
  assertEquals(types({ query: "jordanvale" }, "indicia_web_dbs"), ["username"]);
  assertEquals(types({ query: "a@b.co" }, "indicia_web_dbs"), ["email"]);
  // Hudson Rock: a declared type wins; otherwise the tool's own inference.
  assertEquals(types({ query: "jordan.vale", type: "username" }, "indicia_hudsonrock"), ["username"]);
  assertEquals(types({ query: "jordanvale" }, "indicia_hudsonrock"), ["username"]);
  assertEquals(types({ query: "example.com" }, "indicia_hudsonrock"), ["domain"]);
  assertEquals(types({ query: "hunter2", type: "password" }, "indicia_hudsonrock"), [], "a password is never a selector");
  // A breach-DB NAME search is not a lookup on a selector.
  assertEquals(types({ q: "example.com" }, "oathnet_breach_dbnames"), []);
  // Free-text search tools: a bare word is not a selector.
  assertEquals(types({ query: "jordanvale" }, "exa_search"), []);
});

Deno.test("discord_id is an account id, and only a real snowflake counts", () => {
  assertEquals(types({ discord_id: "123456789012345678" }), ["account_id"]);
  assertEquals(types({ discord_id: "12345" }), []);
});

Deno.test("no alternate field, no candidates", () => {
  assertEquals(types({ email: "a@b.co" }), [], "the central detector already owns this input");
  assertEquals(types({}), []);
  assertEquals(types(null), []);
});

Deno.test("kill switch: DISPATCH_SELECTOR_ALIASES_DISABLED=true yields nothing", () => {
  assertEquals(types({ identifierValue: "a@b.co", identifierType: "email" }, "serus_darkweb_scan", off), []);
});

Deno.test("/health self-test passes, and reports the switch", () => {
  const live = dispatchSelectorAliasesSelfTest(on);
  assertEquals(live.ok, true, live.detail);
  assertEquals(live.switch, "DISPATCH_SELECTOR_ALIASES_DISABLED=false");
  const legacy = dispatchSelectorAliasesSelfTest(off);
  assertEquals(legacy.ok, true);
  assertEquals(legacy.switch, "DISPATCH_SELECTOR_ALIASES_DISABLED=true");
});
