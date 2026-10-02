import { describe, it, expect } from "vitest";
import { toolDisplayName, toolActionLabel, toolAgentRole, humanizeStage } from "@/lib/tool-display";
import { buildReportMarkdown } from "@/lib/intel";

const KNOWN_TOOLS = [
  "list_tools", "triage_seed",
  "breach_check", "hibp_lookup", "leakcheck_lookup", "oathnet_lookup",
  "serus_darkweb_scan",
  "gravatar_profile", "hunter_domain_search", "hunter_email_finder",
  "hunter_email_verifier", "hunter_combined", "bosint_email_lookup", "bosint_phone_lookup",
  "deepfind_reverse_email", "deepfind_disposable_email", "intelbase_email_lookup",
  "socialfetch_lookup", "cordcat_discord_lookup", "username_sweep", "username_search",
  "github_user", "github_code_search", "reddit_user", "hackernews_user",
  "deepfind_profile_analyzer", "deepfind_telegram_channel", "deepfind_telegram_search",
  "whois_lookup", "crtsh_subdomains", "dns_records", "shodan_internetdb",
  "ip_intel", "ipgeolocation_lookup", "http_fingerprint", "virustotal_lookup",
  "hackertarget", "urlscan_search", "wayback_snapshots", "archive_url",
  "deepfind_ssl_inspect", "deepfind_tech_stack", "deepfind_url_unshorten",
  "deepfind_mac_lookup", "deepfind_dark_web_link",
  "google_dorks", "dork_harvest", "gemini_deep_dork",
  "exa_search", "exa_find_similar", "exa_get_contents",
  "jina_reader_scrape", "minimax_web_search", "minimax_extract",
  "minimax_correlate", "minimax_plan_pivots",
  "crypto_wallet",
  "deepfind_ransomware_exposure", "deepfind_vin_lookup",
  "deepfind_aircraft_lookup", "deepfind_vessel_lookup",
  "osint_navigator_query", "osint_navigator_search",
  "record_artifacts", "record_artifact", "record_evidence", "record_finding",
  "memory_recall", "memory_save",
  "coverage_audit", "detect_contradictions", "tool_audit",
];

describe("toolDisplayName", () => {
  it("never returns a raw tool name for any known tool", () => {
    for (const tool of KNOWN_TOOLS) {
      const display = toolDisplayName(tool);
      expect(display).not.toBe(tool);
      expect(display).not.toContain("_");
    }
  });

  it("follows the 'Role — Action' format for every known tool", () => {
    for (const tool of KNOWN_TOOLS) {
      const display = toolDisplayName(tool);
      expect(display).toMatch(/.+ — .+/);
    }
  });

  it("returns a fallback with Role — Action format for unknown tools", () => {
    const display = toolDisplayName("some_future_tool");
    expect(display).toMatch(/.+ — .+/);
    expect(display).not.toBe("some_future_tool");
  });

  it("sensitive tools do not expose raw identifiers in collapsed label", () => {
    const sensitive = [
      "breach_check", "hibp_lookup", "leakcheck_lookup", "oathnet_lookup",
      "serus_darkweb_scan", "deepfind_reverse_email",
      "intelbase_email_lookup",
    ];
    for (const tool of sensitive) {
      const display = toolDisplayName(tool);
      expect(display).not.toContain(tool);
      expect(display.toLowerCase()).not.toContain("breach");
      expect(display.toLowerCase()).not.toContain("darkweb");
      expect(display.toLowerCase()).not.toContain("leak");
    }
  });
});

describe("toolActionLabel", () => {
  it("returns only the action portion (no role prefix)", () => {
    const action = toolActionLabel("breach_check");
    expect(action).not.toContain(" — ");
    expect(action).toBe("Reviewing restricted indicators");
  });

  it("returns a clean label for unknown tools", () => {
    const action = toolActionLabel("mystery_tool_xyz");
    expect(action).not.toContain("_");
    expect(action).not.toBe("mystery_tool_xyz");
  });
});

describe("toolAgentRole", () => {
  it("returns the role portion for known tools", () => {
    expect(toolAgentRole("breach_check")).toBe("Risk Signal Analyst");
    expect(toolAgentRole("record_artifacts")).toBe("Case Manager");
    expect(toolAgentRole("coverage_audit")).toBe("Quality Control");
    expect(toolAgentRole("socialfetch_lookup")).toBe("Profile Analyst");
    expect(toolAgentRole("minimax_web_search")).toBe("Data Hunter");
    expect(toolAgentRole("jina_reader_scrape")).toBe("Source Analyst");
  });

  it("returns 'Analyst' for unknown tools", () => {
    expect(toolAgentRole("unknown_thing")).toBe("Analyst");
  });
});

describe("humanizeStage", () => {
  it("maps every canonical runtime stage to a plain-language name (no SNAKE_CASE)", () => {
    const stages = ["TRIAGE", "REVIEW", "TARGETED_PIVOT", "VERIFY", "REPORT"];
    for (const stage of stages) {
      const label = humanizeStage(stage);
      expect(label).not.toContain("_");
      expect(label).not.toBe(stage);
    }
    expect(humanizeStage("TARGETED_PIVOT")).toBe("Targeted pivot");
    expect(humanizeStage("TRIAGE")).toBe("Triage");
  });

  it("de-cases an unknown/legacy token instead of leaking it verbatim", () => {
    expect(humanizeStage("SOME_FUTURE_STAGE")).toBe("Some future stage");
    expect(humanizeStage("some_future_stage")).not.toContain("_");
  });

  it("falls back to 'Review' for empty/nullish input", () => {
    expect(humanizeStage("")).toBe("Review");
    expect(humanizeStage(null)).toBe("Review");
    expect(humanizeStage(undefined)).toBe("Review");
  });
});

/**
 * Production 2026-10-01: GLM wrote its `<arg_key>/<arg_value>` call markup into
 * the tool NAME, and the fallback title-cased it into a cycle label carrying the
 * markup and the case's selectors.
 */
describe("malformed tool names", () => {
  const POLLUTED = 'minimax_correlate</arg_value>artifacts</arg_key><arg_value>[{"kind":"domain","value":"site.example"}]';

  it("are labelled as a malformed call, never rendered verbatim", () => {
    const display = toolDisplayName(POLLUTED);
    expect(display).toBe("Analyst — Malformed call (Minimax Correlate)");
    expect(display).not.toMatch(/[<>{}[\]"]/);
    expect(display).not.toContain("site.example");
  });

  it("toolActionLabel gives the action only, for malformed and unknown names alike", () => {
    expect(toolActionLabel(POLLUTED)).toBe("Malformed call (Minimax Correlate)");
    expect(toolActionLabel("mystery_tool_xyz")).toBe("Mystery Tool Xyz");
    expect(toolActionLabel("<arg_key>")).toBe("Malformed call");
  });

  // Production report 2026-10-01: Tool Coverage groups evidence by its RECORDED
  // source, which is free text, and printed "Malformed call (Fbi)" for it.
  it("shows a free-text source label as written, not as a malformed call", () => {
    expect(toolActionLabel("FBI Wanted (fbi.gov/wanted/cac)")).toBe("FBI Wanted (fbi.gov/wanted/cac)");
    expect(toolActionLabel("People profile (user-provided)")).toBe("People profile (user-provided)");
    expect(toolActionLabel("Mercury News  (mercurynews.com)")).toBe("Mercury News (mercurynews.com)");
    expect(toolActionLabel("x y".repeat(30))).toHaveLength(60);
    expect(toolActionLabel("   ")).toBe("Unknown source");
  });

  it("still labels markup that merely starts like a source as malformed", () => {
    expect(toolActionLabel('People search {"value":"site.example"}')).toBe("Malformed call (People)");
    expect(toolActionLabel("lookup <arg_value>x</arg_value>")).toBe("Malformed call (Lookup)");
  });
});

/**
 * Codex on #680: the report never hands the formatter the raw source. It groups
 * by `primaryToolSlug`, which lowercases free text and cuts it at "(", so the
 * label has to come back from the entry's recorded variant — driven here
 * through the real report builder, not the formatter alone.
 */
describe("report Tool Coverage / Source Appendix labels", () => {
  const art = (id: string, source: string, kind = "media_report") => ({
    id, thread_id: "t", user_id: "u", kind, value: `value ${id}`, confidence: 50,
    source, metadata: {}, created_at: "2026-10-01T00:00:00Z",
  });
  const md = buildReportMarkdown({
    seedValue: "+15550104477",
    seedType: "phone",
    artifacts: [
      art("1", "FBI Wanted (fbi.gov/wanted/cac)", "name"),
      art("2", "People profile (user-provided)", "address"),
      art("3", "Example News (news.example) + Other Daily (other.example)"),
      art("4", "username_sweep", "social_footprint"),
    ] as never,
    messages: [],
  });
  const section = (title: string) => {
    const start = md.indexOf(`## ${title}`);
    const next = md.indexOf("\n## ", start + 3);
    return md.slice(start, next === -1 ? undefined : next);
  };

  it("prints a free-text source as it was recorded, never 'Malformed call'", () => {
    for (const title of ["Tool Coverage Summary", "Source Appendix"]) {
      const s = section(title);
      expect(s).not.toContain("Malformed call");
      expect(s).toContain("- FBI Wanted (fbi.gov/wanted/cac) — ");
      expect(s).toContain("- People profile (user-provided) — ");
      expect(s).toContain("- Example News (news.example) — ");
      expect(s).not.toMatch(/- fbi wanted — /);
    }
  });

  it("still labels a real tool by its action", () => {
    expect(section("Tool Coverage Summary")).toContain(`- ${toolActionLabel("username_sweep")} — `);
  });
});
