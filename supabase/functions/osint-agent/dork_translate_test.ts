import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { dorkToExaQuery } from "./dork-translate.ts";

// dorkToExaQuery — FIX 2: Exa keyword search ignores Google dork operators, so
// the raw dork must be reduced to core terms with site: domains lifted into the
// structured includeDomains filter.

Deno.test("dorkToExaQuery: strips filetype: and surrounding quotes", () => {
  const { query, includeDomains } = dorkToExaQuery(
    `"alice@example.com" (filetype:pdf OR filetype:docx OR filetype:csv)`,
  );
  assertEquals(query, "alice@example.com");
  assertEquals(includeDomains, []);
});

Deno.test("dorkToExaQuery: maps site:x.com into includeDomains and removes it from the query", () => {
  const { query, includeDomains } = dorkToExaQuery(`"bob" site:x.com`);
  assertEquals(includeDomains, ["x.com"]);
  assertEquals(query, "bob");
});

Deno.test("dorkToExaQuery: collects multiple site: domains and strips OR groups", () => {
  const { query, includeDomains } = dorkToExaQuery(
    `"carol" (site:pastebin.com OR site:rentry.co OR site:ghostbin.co)`,
  );
  assertEquals(includeDomains, ["pastebin.com", "rentry.co", "ghostbin.co"]);
  assertEquals(query, "carol");
});

Deno.test("dorkToExaQuery: strips site:*.DOMAIN wildcard prefix", () => {
  const { includeDomains } = dorkToExaQuery(`site:*.example.com ext:env`);
  assertEquals(includeDomains, ["example.com"]);
});

Deno.test("dorkToExaQuery: drops ext:/intitle:/inurl: operators (incl. quoted values)", () => {
  const { query, includeDomains } = dorkToExaQuery(
    `site:example.com intitle:"index of" inurl:admin ext:sql`,
  );
  assertEquals(includeDomains, ["example.com"]);
  // No operator tokens or their values survive into the keyword query.
  assertEquals(/filetype:|ext:|intitle:|inurl:|site:/i.test(query), false);
  assertEquals(query.includes("index"), false);
  assertEquals(query.includes("admin"), false);
});

Deno.test("dorkToExaQuery: dedupes repeated domains", () => {
  const { includeDomains } = dorkToExaQuery(`site:github.com OR site:github.com`);
  assertEquals(includeDomains, ["github.com"]);
});
