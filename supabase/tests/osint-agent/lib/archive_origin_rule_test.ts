// An archived copy read by a page-fetch tool is archive evidence, never a live social-profile view.
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  archiveOriginRuleDisabled,
  archiveOriginRuleSelfTest,
  classifySource,
  classifySourceLabel,
  isArchivedPageFetch,
} from "../../../functions/osint-agent/source-classification.ts";
import { applyEvidenceCapsWithDistinctBreachIdentities as capConfidence } from "../../../functions/osint-agent/confidence.ts";

Deno.test("Caraotta: archived news reads class as archive, not social_profile_active", () => {
  for (const s of [
    "socialfetch_web_read (INEDC/Placerville NewsWire archived)",
    "socialfetch_web_read (Wayback Machine archived copy)",
    "socialfetch_web_read (INEDC archived)",
    "jina_reader_scrape (web.archive.org/web/2025/https://inedc.com/story)",
    "exa_get_contents (archive.ph/abc12)",
  ]) {
    assertEquals(classifySource(s), "archive", s);
    assertEquals(classifySourceLabel(s), ["archive"], s);
  }
});

Deno.test("only page-fetch tools with an archive qualifier move; everything else is unchanged", () => {
  assertEquals(classifySource("socialfetch_web_read (instagram.com/someone)"), "social_profile_active");
  assertEquals(classifySource("socialfetch_web_read"), "social_profile_active");
  assertEquals(classifySource("exa_search (archived)"), "ai_summary", "a SEARCH tool did not read the archive");
  assertEquals(classifySource("wayback_cdx_search"), "archive");
  assertEquals(isArchivedPageFetch("socialfetch_web_read (archive of nothing)"), true);
  assertEquals(isArchivedPageFetch("socialfetch_web_read (searching)"), false);
});

Deno.test("no confidence rises: archive caps at the same 70 as social_profile_active", () => {
  const before = capConfidence({ rawConfidence: 70, sources: ["socialfetch_web_read"], kind: "media_report" });
  const after = capConfidence({ rawConfidence: 70, sources: ["socialfetch_web_read (INEDC archived)"], kind: "media_report" });
  assertEquals(after.confidence <= before.confidence, true, `${after.confidence} vs ${before.confidence}`);
});

Deno.test("mtdemocrat.com is a news host when the page was READ; a search hit naming it stays ai_summary", () => {
  assertEquals(classifySource("jina_reader_scrape (mtdemocrat.com/news/story)"), "news");
  assertEquals(classifySourceLabel("exa_search / mtdemocrat.com"), ["ai_summary"]);
});

Deno.test("kill switch parses only an explicit true; /health self-test passes", () => {
  assertEquals(archiveOriginRuleDisabled(() => "true"), true);
  assertEquals(archiveOriginRuleDisabled(() => "1"), false);
  assertEquals(archiveOriginRuleSelfTest().ok, true, archiveOriginRuleSelfTest().detail);
});
