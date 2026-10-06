// source_origin_rules_test.ts — a source's class may come from its HOST.
//
// Production 2026-10-01: a finding resting on a federal wanted notice, a DOJ
// release and ~20 news reports sat at 45–50, because "Agency notice (fbi.gov/…)"
// and "Regional Paper (paper.example)" carry no keyword the label regexes know
// and fell to `unknown` (cap 50). Fixtures here are neutral; hostnames are the
// public sites the rules name, never case content.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  classifyOriginHost,
  classifySource,
  classifySourceInput,
  classifySourceWithOrigin,
  countIndependentClasses,
  isLlmAssertedDomainSource,
  sourceOriginRulesSelfTest,
  splitSourceLabels,
} from "./source-classification.ts";
import { applyEvidenceCapsLegacyOccurrenceBaseline } from "./confidence.ts";

const KILL = "SOURCE_ORIGIN_RULES_DISABLED";
function withLegacy<T>(fn: () => T): T {
  Deno.env.set(KILL, "true");
  try {
    return fn();
  } finally {
    Deno.env.delete(KILL);
  }
}

Deno.test("host rules: federal law-enforcement/court hosts, .gov courts and police, news outlets", () => {
  assertEquals(classifyOriginHost("fbi.gov"), "court_record");
  assertEquals(classifyOriginHost("www.justice.gov"), "court_record");
  assertEquals(classifyOriginHost("cand.uscourts.gov"), "court_record");
  assertEquals(classifyOriginHost("courts.example-state.gov"), "court_record");
  assertEquals(classifyOriginHost("examplepolice.gov"), "court_record");
  assertEquals(classifyOriginHost("apnews.com"), "news");
  assertEquals(classifyOriginHost("www.nytimes.com"), "news");
  // Unlisted hosts, non-law .gov, and lookalikes change nothing.
  assertEquals(classifyOriginHost("irs.gov"), null);
  assertEquals(classifyOriginHost("example-city.gov"), null);
  assertEquals(classifyOriginHost("courts.example.org"), null, ".org is open registration");
  assertEquals(classifyOriginHost("courts.example.us"), null, ".us is open registration");
  assertEquals(classifyOriginHost("notfbi.gov.example.com"), null);
  assertEquals(classifyOriginHost("fakenytimes.com"), null);
});

Deno.test("a page a fetch tool READ takes its host's class", () => {
  for (const tool of ["jina_reader_scrape", "exa_get_contents", "minimax_extract", "socialfetch_web_read"]) {
    assertEquals(classifySource(`${tool} (https://www.fbi.gov/wanted/example)`), "court_record", tool);
    assertEquals(classifySource(`${tool} (apnews.com/article/example)`), "news", tool);
    // An unlisted host keeps the tool's own class.
    const own = classifySource(tool);
    assertEquals(classifySource(`${tool} (unvetted-example.org/post)`), own, tool);
  }
});

Deno.test("a search or summary tool that merely CITES the host keeps its class", () => {
  for (const tool of ["minimax_web_search", "exa_search", "google_dorks", "minimax_correlate"]) {
    assertEquals(classifySource(`${tool} (justice.gov/usao/pr/example)`), "ai_summary", tool);
    assertEquals(classifySource(`${tool} (nytimes.com)`), "ai_summary", tool);
  }
  assertEquals(classifySource("breach_check (nytimes.com)"), "breach");
  assertEquals(classifySource("username_sweep (fbi.gov)"), "username_sweep");
});

Deno.test("a weak free-text label takes its host's class; a discovery or lead label does not", () => {
  assertEquals(classifySource("Agency notice (fbi.gov/wanted/example)"), "court_record");
  assertEquals(classifySource("Daily (latimes.com/example)"), "news");
  assertEquals(classifySource("Station (ktla.com/example)"), "news");
  // A news-worded label on an official host is the official page.
  assertEquals(classifySource("Press release"), "news");
  assertEquals(classifySource("Press release (fbi.gov/example)"), "court_record");
  // Discovery, archive, breach and broker labels stay what they say they are.
  assertEquals(classifySource("Google search (fbi.gov/wanted/example)"), "web_search");
  assertEquals(classifySource("Wayback snapshot (nytimes.com/example)"), "archive");
  assertEquals(classifySource("leak paste (nytimes.com/example)"), "breach");
  assertEquals(classifySource("Whitepages (nytimes.com)"), "public_record");
  // No qualifier, or a non-URL one: unchanged.
  assertEquals(classifySource("Agency notice"), "unknown");
  assertEquals(classifySource("socialfetch_lookup (instagram)"), "social_profile_passive");
});

Deno.test("the cap moves with the class: official 90, a news-only name stays a lead", () => {
  const cap = (source: string, kind: string) =>
    applyEvidenceCapsLegacyOccurrenceBaseline({ rawConfidence: 95, sources: [source], kind }).cap;
  assertEquals(cap("Agency notice (fbi.gov/wanted/example)", "name"), 90);
  assertEquals(withLegacy(() => cap("Agency notice (fbi.gov/wanted/example)", "name")), 50);
  assertEquals(cap("Daily (latimes.com/example)", "address"), 65);
  assertEquals(withLegacy(() => cap("Daily (latimes.com/example)", "address")), 50);
  // #17: a name from news alone is a lead — now including a FETCHED news page,
  // which used to escape the rule as independent_public (75).
  assertEquals(cap("jina_reader_scrape (apnews.com/article/example)", "name"), 55);
  assertEquals(withLegacy(() => cap("jina_reader_scrape (apnews.com/article/example)", "name")), 75);
});

Deno.test("the persisted source_category agrees: one source with a URL path is not split on '/'", () => {
  const cat = (source: string) => classifySourceInput({ source });
  // Split, the path fragment "news" made this a news row.
  assertEquals(cat("jina_reader_scrape (https://www.fbi.gov/news/stories/example)"), ["court_record"]);
  assertEquals(withLegacy(() => cat("jina_reader_scrape (https://www.fbi.gov/news/stories/example)")), ["news"]);
  assertEquals(cat("Agency notice (fbi.gov/wanted/example)"), ["court_record"]);
  // Any URL path stays whole, ruled host or not — the cap engine already read
  // it as the fetch tool's own class.
  assertEquals(cat("jina_reader_scrape (unvetted-example.org/news/1)"), ["independent_public"]);
  // A genuinely mixed label is still split into its sources, each by its host,
  // and the whole label does not borrow its LAST member's host.
  const mixed = "Paper A (apnews.com) + Records (fbi.gov/wanted/example)";
  assertEquals(classifySource(mixed), "unknown");
  assertEquals(cat(mixed).sort(), ["court_record", "news"]);
  assertEquals(splitSourceLabels(mixed), ["Paper A (apnews.com)", "Records (fbi.gov/wanted/example)"]);
  // A non-URL parenthetical splits exactly as before.
  assertEquals(splitSourceLabels("exa_search (release + other)"), ["exa_search (release", "other)"]);
  assertEquals(withLegacy(() => splitSourceLabels("Records (fbi.gov/wanted)")), ["Records (fbi.gov", "wanted)"]);
});

Deno.test("one host reached two ways is still ONE independent source", () => {
  const entries = [
    "Agency notice (fbi.gov/wanted/a)",
    "jina_reader_scrape (https://www.fbi.gov/wanted/b)",
  ].map(classifySourceWithOrigin);
  for (const e of entries) assertEquals(e.sourceClass, "court_record");
  assertEquals(countIndependentClasses(entries), 1);
});

Deno.test("a bare asserted domain is still flagged — the rules key on a qualifier", () => {
  assert(isLlmAssertedDomainSource("fbi.gov"));
  assert(isLlmAssertedDomainSource("nytimes.com"));
});

Deno.test("the kill switch restores label-only classification", () => {
  withLegacy(() => {
    assertEquals(classifySource("Agency notice (fbi.gov/wanted/example)"), "unknown");
    assertEquals(classifySource("jina_reader_scrape (https://www.fbi.gov/wanted/example)"), "independent_public");
    assertEquals(sourceOriginRulesSelfTest().detail, "LEGACY via SOURCE_ORIGIN_RULES_DISABLED");
  });
});

Deno.test("/health self-test passes on this build", () => {
  const r = sourceOriginRulesSelfTest();
  assert(r.ok, r.detail);
  assert(r.detail.includes("search tools unchanged"), r.detail);
});
