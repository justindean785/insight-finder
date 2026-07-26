import { describe, expect, it } from "vitest";
import {
  displayKind,
  groupForKind,
  isBreachSource,
  isUnattributedCorpusName,
  GROUP_LABEL,
  GROUP_ORDER,
} from "@/lib/intel";

// Live case 44f6f429 ("Donte young aka Tizzle"): 164 artifacts, 0 findings. Thirty
// rows rendered under IDENTITY → Names, of which ~28 were not names at all — they
// were combolist row fields from `serus_darkweb_scan`: password-shaped strings
// (Coke4404, Forget123, Baseball7, Wutang420), a raw hex token (6e295e85), and
// real names belonging to OTHER people (Tyler C Vogt, Nguyễnthanh). Each was
// promoted to its own candidate identity cluster and rendered as an alias of the
// subject, and each is exported by evidence-export.
//
// The codebase already holds the governing principle at intel.ts SENSITIVE_KINDS:
// "PII kinds that should never be auto-confirmed from breach data alone" —
// name/person are on that list. These tests extend that principle from "cap the
// confidence" to "do not present it as identity evidence at all".

const art = (o: Partial<{ kind: string; source: string; metadata: Record<string, unknown> | null }>) => ({
  kind: o.kind ?? "name",
  source: o.source ?? null,
  metadata: o.metadata ?? null,
});

describe("breach-corpus source classification", () => {
  // serus_darkweb_scan and rapidapi_breach_search stamp source_category:["breach"]
  // on every row they emit, but neither was listed in BREACH_ONLY_SOURCES — so
  // isBreachSource() returned false and the breach-only confidence caps never
  // applied to the tool producing the most contaminated names in the case.
  it("recognises serus_darkweb_scan as a breach-only corpus", () => {
    expect(isBreachSource("serus_darkweb_scan")).toBe(true);
  });

  it("recognises rapidapi_breach_search as a breach-only corpus", () => {
    expect(isBreachSource("rapidapi_breach_search")).toBe(true);
  });

  it("still recognises the originally-listed corpora", () => {
    expect(isBreachSource("oathnet_lookup")).toBe(true);
    expect(isBreachSource("leakcheck_lookup")).toBe(true);
    expect(isBreachSource("breach_check")).toBe(true);
  });

  it("does not classify a people-search or live-profile source as a breach corpus", () => {
    expect(isBreachSource("indicia_person")).toBe(false);
    expect(isBreachSource("github_user")).toBe(false);
    expect(isBreachSource(null)).toBe(false);
  });
});

describe("isUnattributedCorpusName", () => {
  it("flags a name whose only provenance is a breach corpus", () => {
    expect(isUnattributedCorpusName(art({ kind: "name", source: "serus_darkweb_scan" }))).toBe(true);
    expect(isUnattributedCorpusName(art({ kind: "person", source: "oathnet_lookup" }))).toBe(true);
  });

  it("does NOT flag a name from a people-search or live source", () => {
    // The two rows in the live case that were genuinely about the subject.
    expect(isUnattributedCorpusName(art({ kind: "name", source: "indicia_person" }))).toBe(false);
    expect(isUnattributedCorpusName(art({ kind: "name", source: "minimax_web_search" }))).toBe(false);
  });

  it("only applies to the sensitive identity kinds, not every breach row", () => {
    // `username` is deliberately NOT remapped: it is absent from SENSITIVE_KINDS,
    // and a handle seen in a leak can be a genuine pivot. Breach rows themselves
    // must keep rendering under Breach / Exposure.
    expect(isUnattributedCorpusName(art({ kind: "username", source: "serus_darkweb_scan" }))).toBe(false);
    expect(isUnattributedCorpusName(art({ kind: "breach", source: "oathnet_lookup" }))).toBe(false);
    expect(isUnattributedCorpusName(art({ kind: "email", source: "leakcheck_lookup" }))).toBe(false);
  });
});

describe("displayKind routes combolist rows out of Identity", () => {
  it("remaps a breach-corpus name to combolist_row", () => {
    expect(displayKind(art({ kind: "name", source: "serus_darkweb_scan" }))).toBe("combolist_row");
  });

  it("leaves a real identity name alone", () => {
    expect(displayKind(art({ kind: "name", source: "indicia_person" }))).toBe("name");
  });

  it("still performs the pre-existing reputation remap", () => {
    expect(displayKind(art({ kind: "breach", source: "virustotal" }))).toBe("threat_reputation");
  });

  it("passes unrelated kinds through untouched", () => {
    expect(displayKind(art({ kind: "domain", source: "whois_lookup" }))).toBe("domain");
  });
});

describe("low-signal group", () => {
  it("combolist_row groups under low_signal, not identity", () => {
    expect(groupForKind("combolist_row")).toBe("low_signal");
    expect(groupForKind("name")).toBe("identity");
  });

  it("the low-signal bucket is labelled and ordered last", () => {
    expect(GROUP_LABEL.low_signal).toBeTruthy();
    expect(GROUP_ORDER[GROUP_ORDER.length - 1]).toBe("low_signal");
    expect(new Set(GROUP_ORDER).size).toBe(GROUP_ORDER.length);
  });

  it("composing displayKind → groupForKind keeps the subject's name in Identity", () => {
    const subject = art({ kind: "name", source: "indicia_person" });
    const corpusRow = art({ kind: "name", source: "serus_darkweb_scan" });
    expect(groupForKind(displayKind(subject))).toBe("identity");
    expect(groupForKind(displayKind(corpusRow))).toBe("low_signal");
  });

  it("live case 44f6f429: splits the 28 name rows correctly", () => {
    // Verbatim metadata shapes from the artifacts of thread 44f6f429.
    const corpusRow = {
      kind: "name",
      source: "serus_darkweb_scan",
      metadata: {
        via: "serus", tool: "serus_darkweb_scan", status: "observed",
        source_category: ["breach"], auto_persist_source: "tool_return_extractor",
        confidence_cap_applied: 60, sources: ["serus_darkweb_scan"],
      },
    };
    const subjectFromPeopleSearch = {
      kind: "name",
      source: "indicia_person",
      metadata: {
        via: "indicia", tool: "indicia_person", source_category: ["breach"],
        confidence_cap_applied: 60, sources: ["indicia_person"],
      },
    };
    const subjectCorroborated = {
      kind: "name",
      source: "indicia_person",
      metadata: {
        via: "indicia_aka", source_category: ["ai_summary"],
        sources: ["indicia_person", "newsreview.com + minimax_web_search + sacda.org"],
      },
    };

    // The 26 combolist rows leave Identity...
    expect(groupForKind(displayKind(corpusRow))).toBe("low_signal");
    // ...and both rows that are actually about the subject stay.
    expect(groupForKind(displayKind(subjectFromPeopleSearch))).toBe("identity");
    expect(groupForKind(displayKind(subjectCorroborated))).toBe("identity");
  });

  it("a name corroborated by a non-breach source is never demoted", () => {
    const mixed = {
      kind: "name",
      source: "serus_darkweb_scan",
      metadata: { sources: ["serus_darkweb_scan", "github_user"] },
    };
    expect(isUnattributedCorpusName(mixed)).toBe(false);
    expect(groupForKind(displayKind(mixed))).toBe("identity");
  });

  it("composing also pulls a reputation row out of Breach / Exposure", () => {
    // Pre-existing bug: the board grouped on the raw kind, so this remap — which
    // already existed and was already tested — never reached the Evidence board.
    const vt = art({ kind: "breach", source: "virustotal" });
    expect(groupForKind(vt.kind)).toBe("breach");
    expect(groupForKind(displayKind(vt))).not.toBe("breach");
  });
});
