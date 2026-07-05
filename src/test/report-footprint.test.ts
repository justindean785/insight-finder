import { describe, it, expect } from "vitest";
import { buildProfileLinks, buildAliases } from "@/components/panel/CaseReport";

// Minimal artifact fixture matching the shape CaseReport consumes.
const art = (over: Partial<{ id: string; kind: string; value: string; metadata: Record<string, unknown> | null }> = {}) => ({
  id: over.id ?? Math.random().toString(36).slice(2),
  thread_id: "t1",
  kind: over.kind ?? "username",
  value: over.value ?? "craftin247",
  source: "username_sweep",
  confidence: 50,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z",
  metadata: over.metadata ?? null,
  label: "VERIFY" as const,
  is_key: false,
  is_dismissed: false,
  notes: null,
  review_state: null,
  group: "social" as const,
});

describe("buildProfileLinks (Digital Footprint — display only)", () => {
  it("links a full URL value directly", () => {
    const links = buildProfileLinks([art({ kind: "url", value: "https://steamcommunity.com/id/craftin247", metadata: { platform: "Steam" } })]);
    expect(links).toHaveLength(1);
    expect(links[0].href).toBe("https://steamcommunity.com/id/craftin247");
    expect(links[0].platform).toBe("Steam");
  });

  it("derives https:// for a bare domain handle", () => {
    const links = buildProfileLinks([art({ kind: "domain", value: "craftin247.bandcamp.com" })]);
    expect(links[0].href).toBe("https://craftin247.bandcamp.com");
  });

  it("prefers metadata.profile_url when the value itself is not a URL", () => {
    const links = buildProfileLinks([art({ kind: "username", value: "craftin247", metadata: { platform: "Twitch", profile_url: "https://www.twitch.tv/craftin247" } })]);
    expect(links[0].href).toBe("https://www.twitch.tv/craftin247");
  });

  it("leaves a plain handle unlinked (no fabricated URL)", () => {
    const links = buildProfileLinks([art({ kind: "account", value: "craftin247", metadata: { platform: "Venmo" } })]);
    expect(links[0].href).toBeNull();
  });

  it("does not fabricate links for file names / version strings / dates", () => {
    for (const v of ["resume.pdf", "report.docx", "v1.2.3", "Node.js", "2024.01.15", "3.14"]) {
      const links = buildProfileLinks([art({ kind: "profile", value: v })]);
      expect(links[0]?.href, v).toBeNull();
    }
  });

  it("flags AI-asserted-unverified entries as inferred", () => {
    const links = buildProfileLinks([art({ kind: "account_id", value: "375687201121501195", metadata: { platform: "Discord", provenance_verified: false } })]);
    expect(links[0].inferred).toBe(true);
  });

  it("dedupes the same platform+value and ignores non-footprint kinds", () => {
    const links = buildProfileLinks([
      art({ kind: "username", value: "craftin247", metadata: { platform: "X" } }),
      art({ kind: "username", value: "craftin247", metadata: { platform: "X" } }),
      art({ kind: "email", value: "a@b.com" }),
      art({ kind: "phone", value: "+15551234567" }),
    ]);
    expect(links).toHaveLength(1);
  });

  it("does not throw on malformed kind/value", () => {
    expect(() => buildProfileLinks([art({ kind: undefined as unknown as string, value: undefined as unknown as string })])).not.toThrow();
  });
});

describe("buildAliases", () => {
  it("collects distinct username/handle values", () => {
    const aliases = buildAliases([
      art({ kind: "username", value: "craftin247" }),
      art({ kind: "handle", value: "craftin248" }),
      art({ kind: "username", value: "craftin247" }),
      art({ kind: "email", value: "x@y.com" }),
    ]);
    expect(aliases).toEqual(["craftin247", "craftin248"]);
  });
});
