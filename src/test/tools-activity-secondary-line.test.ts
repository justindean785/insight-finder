import { describe, it, expect } from "vitest";
import { toolSecondaryLine as secondaryLine, toolDisplayName, toolActionLabel } from "@/lib/tool-display";

/**
 * `toolActionLabel` is derived FROM `toolDisplayName` — it returns the slice
 * after " — ", or the whole string when there is no dash. So a row with no
 * reason previously rendered its own title again as the detail line, which read
 * as "Analyst — Socialfetch / Analyst — Socialfetch" in the Tools activity feed.
 */
describe("Tools activity — secondary detail line", () => {
  it("keeps the reason when one exists", () => {
    expect(
      secondaryLine({ reason: "timeout after 15000ms", actionLabel: "Scraping page", displayName: "Data Hunter — Scraping page" }),
    ).toBe("timeout after 15000ms");
  });

  it("drops an action label the title already contains", () => {
    expect(
      secondaryLine({ reason: null, actionLabel: "Querying domain registration", displayName: "Infrastructure Analyst — Querying domain registration" }),
    ).toBeNull();
  });

  it("drops an action label identical to the title", () => {
    expect(secondaryLine({ reason: null, actionLabel: "Analyst — Socialfetch", displayName: "Analyst — Socialfetch" })).toBeNull();
  });

  it("keeps an action label that genuinely adds information", () => {
    expect(secondaryLine({ reason: null, actionLabel: "Checking 12 breach corpora", displayName: "Breach Analyst" })).toBe(
      "Checking 12 breach corpora",
    );
  });

  it("drops an empty or whitespace-only action label", () => {
    expect(secondaryLine({ reason: null, actionLabel: "   ", displayName: "Analyst" })).toBeNull();
  });

  it("never restates the title for any real tool in the display registry", () => {
    // The regression this guards: every succeeded row in the feed carried a
    // duplicate line, because actionLabel is a substring of displayName by
    // construction for every tool that has a " — " in its display name.
    for (const tool of ["whois_lookup", "hunter_verify", "exa_search", "oathnet", "socialfetch", "deepfind_reverse"]) {
      const displayName = toolDisplayName(tool);
      const actionLabel = toolActionLabel(tool);
      expect(secondaryLine({ reason: null, actionLabel, displayName })).toBeNull();
    }
  });
});
