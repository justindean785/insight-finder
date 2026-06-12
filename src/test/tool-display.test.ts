import { describe, it, expect } from "vitest";
import { toolDisplayName, toolActionLabel, toolAgentRole } from "@/lib/tool-display";

const KNOWN_TOOLS = [
  "list_tools", "triage_seed",
  "breach_check", "hibp_lookup", "leakcheck_lookup", "oathnet_lookup",
  "stolentax_footprint", "serus_darkweb_scan",
  "emailrep", "gravatar_profile", "hunter_domain_search", "hunter_email_finder",
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
  "osint_navigator_query", "osint_navigator_search", "synapsint_lookup",
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
      "serus_darkweb_scan", "stolentax_footprint", "deepfind_reverse_email",
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
