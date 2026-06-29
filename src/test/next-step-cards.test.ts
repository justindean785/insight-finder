import { describe, expect, it } from "vitest";
import { cardDedupeKey, dedupeCards, humanizeLeadReason, normalizeTarget } from "@/lib/next-step-cards";
import { readableSourceLabel } from "@/lib/tool-display";

describe("normalizeTarget", () => {
  it("collapses apostrophe / spacing / case variants of a name", () => {
    expect(normalizeTarget("Damien O Brien")).toBe("damien o brien");
    expect(normalizeTarget("Damien O'Brien")).toBe("damien o brien");
    expect(normalizeTarget("damien o brien")).toBe(normalizeTarget("Damien O'Brien"));
  });

  it("keeps genuinely different entities distinct", () => {
    expect(normalizeTarget("Damien O'Brien")).not.toBe(normalizeTarget("Damien O'Reilly"));
  });
});

describe("dedupeCards", () => {
  it("collapses the duplicate Damien O Brien / O'Brien review-lead cards", () => {
    const cards = [
      { title: "Review lead", target: "Damien O Brien", id: 1 },
      { title: "Review lead", target: "Damien O'Brien", id: 2 },
      { title: "Verify email ownership", target: "drew.barber@example.com", id: 3 },
    ];
    const out = dedupeCards(cards);
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.id)).toEqual([1, 3]); // first of the pair survives
  });

  it("does NOT collapse same target with a different action", () => {
    const cards = [
      { title: "Review lead", target: "Damien O'Brien" },
      { title: "Check for breaches", target: "Damien O'Brien" },
    ];
    expect(dedupeCards(cards)).toHaveLength(2);
  });

  it("keeps generic (targetless) cards keyed by title", () => {
    const cards = [
      { title: "Summarize findings" },
      { title: "Summarize findings" },
      { title: "Find more pivots" },
    ];
    expect(dedupeCards(cards)).toHaveLength(2);
  });

  it("cardDedupeKey is stable for the same logical card", () => {
    expect(cardDedupeKey({ title: "Review lead", target: "Damien O Brien" }))
      .toBe(cardDedupeKey({ title: "Review lead", target: "Damien O'Brien" }));
  });
});

describe("humanizeLeadReason", () => {
  it("replaces a raw tool id after 'via' with a readable source label", () => {
    const out = humanizeLeadReason("Name discovered via oathnet_lookup. Expand to find linked accounts.");
    expect(out).not.toContain("oathnet_lookup");
    expect(out).toContain("breach/profile lookup");
    expect(out).toContain("Expand to find linked accounts.");
  });

  it("handles compound sources without leaking a raw id", () => {
    const out = humanizeLeadReason("Email discovered via breach_check+oathnet_lookup+serus_darkweb_scan");
    expect(out).not.toMatch(/[a-z]+_[a-z]+/); // no snake_case tool id survives
    expect(out).toContain("+2 more");
  });

  it("leaves a reason with no 'via <tool>' untouched", () => {
    expect(humanizeLeadReason("Artifact-derived lead")).toBe("Artifact-derived lead");
  });
});

describe("readableSourceLabel", () => {
  it("maps known tool ids to short plain-English labels", () => {
    expect(readableSourceLabel("oathnet_lookup")).toBe("breach/profile lookup");
    expect(readableSourceLabel("username_sweep")).toBe("username sweep");
    expect(readableSourceLabel("jina_reader_scrape")).toBe("source page review");
  });

  it("summarizes compound sources and never emits raw snake_case", () => {
    const out = readableSourceLabel("oathnet_lookup+serus_darkweb_scan+bosint_email_lookup");
    expect(out).toBe("breach/profile lookup +2 more");
  });

  it("falls back to de-underscored words for unknown tools", () => {
    expect(readableSourceLabel("some_new_tool")).toBe("some new tool");
  });

  it("leaves human-readable domains/platforms untouched (Evidence provenance)", () => {
    // Evidence rows pass provenance through this; a domain or a "breach · host"
    // string must NOT be mangled into a tool-style label.
    expect(readableSourceLabel("mindjolt.com")).toBe("mindjolt.com");
    expect(readableSourceLabel("breach · mindjolt.com")).toBe("breach · mindjolt.com");
    expect(readableSourceLabel("Twitter")).toBe("Twitter");
  });

  it("handles empty/null input", () => {
    expect(readableSourceLabel("")).toBe("tool");
    expect(readableSourceLabel(null)).toBe("tool");
  });
});
