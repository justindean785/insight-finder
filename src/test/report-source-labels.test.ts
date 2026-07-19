import { describe, expect, it } from "vitest";
import { humanizeSourceChain, tokenizeSourceChain } from "@/lib/report-source-labels";

const RAW_SLUG_RE = /\b[a-z0-9]+_[a-z0-9_]+\b/; // any snake_case token

describe("humanizeSourceChain", () => {
  it("converts a single raw tool ID to a readable label", () => {
    const out = humanizeSourceChain("username_sweep");
    expect(out).toBe("username sweep");
    expect(out).not.toContain("username_sweep");
  });

  it("humanizes a plus-joined breach chain without leaking raw IDs", () => {
    const out = humanizeSourceChain("oathnet_lookup+serus_darkweb_scan+bosint_email_lookup+deepfind_email_breach");
    expect(out).toBe("breach/profile lookup + dark-web scan + email intelligence lookup + email breach lookup");
    expect(out).not.toMatch(RAW_SLUG_RE);
  });

  it("humanizes a web/deep-search chain", () => {
    const out = humanizeSourceChain("minimax_web_search+gemini_deep_dork");
    expect(out).toContain("web search");
    expect(out).toContain("AI-assisted deep search");
    expect(out).not.toMatch(RAW_SLUG_RE);
  });

  it("humanizes an email-verification chain", () => {
    const out = humanizeSourceChain("hunter_email_verifier+leakcheck_lookup+minimax_web_search");
    expect(out).toBe("email verification + credential exposure lookup + web search");
    expect(out).not.toMatch(RAW_SLUG_RE);
  });

  it("degrades an unknown tool ID safely (no raw snake_case)", () => {
    const out = humanizeSourceChain("new_unknown_tool");
    expect(out).toBe("new unknown tool");
    expect(out).not.toContain("new_unknown_tool");
  });

  it("dedupes repeated sources", () => {
    expect(humanizeSourceChain("username_sweep+username_sweep")).toBe("username sweep");
  });

  it("tokenizes comma-separated tools into distinct sources", () => {
    expect(tokenizeSourceChain("breach_check, leakcheck_lookup, breach_check"))
      .toEqual(["breach_check", "leakcheck_lookup"]);
  });

  it("keeps free text / mixed tokens readable", () => {
    expect(humanizeSourceChain("username_sweep+scrape analysis")).toBe("username sweep + scrape analysis");
  });

  it("humanizes a slug that carries a trailing descriptor word", () => {
    // Real backend shape: the source is "<slug> analysis", a single token.
    expect(humanizeSourceChain("username_sweep analysis")).toBe("username sweep analysis");
    expect(humanizeSourceChain("minimax_web_search analysis")).toBe("web search analysis");
    expect(humanizeSourceChain("username_sweep analysis")).not.toMatch(RAW_SLUG_RE);
  });

  it("humanizes an embedded slug inside a compound chain element", () => {
    const out = humanizeSourceChain("oathnet_lookup+username_sweep analysis");
    expect(out).toBe("breach/profile lookup + username sweep analysis");
    expect(out).not.toMatch(RAW_SLUG_RE);
  });

  it("leaves human-readable sources (domains, providers) untouched", () => {
    expect(humanizeSourceChain("mindjolt.com")).toBe("mindjolt.com");
    expect(humanizeSourceChain("LinkedIn")).toBe("LinkedIn");
  });

  it("accepts arrays (cluster source-tool lists)", () => {
    expect(humanizeSourceChain(["oathnet_lookup", "minimax_web_search"]))
      .toBe("breach/profile lookup + web search");
  });

  it("returns a safe non-empty fallback for null/empty", () => {
    expect(humanizeSourceChain(null)).toBe("tool");
    expect(humanizeSourceChain("")).toBe("tool");
    expect(humanizeSourceChain(null, "—")).toBe("—");
  });

  it("maps ransomware sources to conservative threat-intel wording", () => {
    expect(humanizeSourceChain("ransomwarelive_lookup")).toBe("threat-intel lookup");
  });
});
