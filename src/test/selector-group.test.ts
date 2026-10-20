import { describe, expect, it } from "vitest";
import {
  distinctSelectorCount,
  expandRejections,
  groupBySelector,
  normalizeSelectorValue,
  protectMinorSelectors,
  rowCarriesMinorFlag,
  selectorKey,
  stripDerivedItemMetadata,
  MINOR_DERIVED_MARKER,
} from "@/lib/selector-group";

const row = (id: string, kind: string, value: string, metadata: Record<string, unknown> | null = null) => ({ id, kind, value, metadata });

describe("selectorKey / groupBySelector — the identity the hook dedupes on", () => {
  it("is case-insensitive on the kind and canonicalises the value per kind", () => {
    expect(selectorKey("EMAIL", " Jordan@Example.COM ")).toBe(selectorKey("email", "jordan@example.com"));
    expect(selectorKey("username", "@@Jordan")).toBe(selectorKey("social", "jordan").replace("social", "username"));
    expect(normalizeSelectorValue("ip", "010.001.002.003")).toBe("10.1.2.3");
    expect(normalizeSelectorValue("name", "Prince (Twitter display name)")).toBe("prince");
  });

  it("never merges across kinds: the same text under two kinds is two selectors", () => {
    expect(selectorKey("username", "jordan.vale")).not.toBe(selectorKey("name", "jordan.vale"));
  });

  it("groups rows, keeps input order inside a group, and counts distinct selectors", () => {
    const rows = [row("1", "email", "a@x.com"), row("2", "email", "B@x.com"), row("3", "email", "A@X.com")];
    const g = groupBySelector(rows);
    expect([...g.keys()]).toEqual([selectorKey("email", "a@x.com"), selectorKey("email", "b@x.com")]);
    expect(g.get(selectorKey("email", "a@x.com"))!.map((r) => r.id)).toEqual(["1", "3"]);
    expect(distinctSelectorCount(rows)).toBe(2);
    expect(distinctSelectorCount([])).toBe(0);
  });
});

describe("protectMinorSelectors — restricts, never lends authority", () => {
  it("recognises every flag a reader consults, and ignores look-alikes", () => {
    for (const m of [{ possible_minor: true }, { minor_warning: true }, { auto_pivot_blocked: true }, { flag: "minor_safety_flag" }]) {
      expect(rowCarriesMinorFlag(m)).toBe(true);
    }
    for (const m of [null, undefined, {}, { possible_minor: "true" }, { possible_minor: false }, { flag: "OTHER" }, [], "x"]) {
      expect(rowCarriesMinorFlag(m as never)).toBe(false);
    }
  });

  it("returns the SAME array when nothing is flagged and the same row objects when nothing is missing", () => {
    const plain = [row("1", "email", "a@x.com"), row("2", "email", "b@x.com")];
    expect(protectMinorSelectors(plain)).toBe(plain);
    const full = [row("1", "email", "a@x.com", { possible_minor: true, minor_warning: true, auto_pivot_blocked: true })];
    const out = protectMinorSelectors(full);
    expect(out[0]).toBe(full[0]);
  });

  it("is order independent and does not mutate its input", () => {
    const rows = [row("1", "email", "a@x.com", { status: "observed" }), row("2", "email", "A@x.com", { possible_minor: true })];
    const before = JSON.stringify(rows);
    const fwd = protectMinorSelectors(rows);
    const rev = protectMinorSelectors([...rows].reverse());
    expect(JSON.stringify(rows)).toBe(before);
    const byId = (list: typeof fwd) => Object.fromEntries(list.map((r) => [r.id, r.metadata]));
    expect(byId(fwd)).toEqual(byId(rev));
    expect(byId(fwd)["1"]).toMatchObject({ status: "observed", possible_minor: true, minor_warning: true, auto_pivot_blocked: true });
  });

  it("copies ONLY the three protective booleans (plus the marker): no other key crosses", () => {
    const rows = [
      row("1", "email", "a@x.com", { status: "observed" }),
      row("2", "email", "a@x.com", { possible_minor: true, reviewed: true, linkage_confirmed: true, cluster_id: "c", parent_seed: "p", confidence_cap_applied: 99, source_category: ["x"] }),
    ];
    const keys = Object.keys(protectMinorSelectors(rows)[0].metadata!).sort();
    expect(keys).toEqual([MINOR_DERIVED_MARKER, "auto_pivot_blocked", "minor_warning", "possible_minor", "status"].sort());
  });

  it("an explicit possible_minor:false on a twin is overridden: a ceiling beats a denial", () => {
    const rows = [row("1", "email", "a@x.com", { possible_minor: false }), row("2", "email", "a@x.com", { possible_minor: true })];
    expect(protectMinorSelectors(rows)[0].metadata!.possible_minor).toBe(true);
  });

  it("handles null/odd metadata and empty input", () => {
    expect(protectMinorSelectors([])).toEqual([]);
    const rows = [row("1", "email", "a@x.com", null), row("2", "email", "a@x.com", { possible_minor: true })];
    expect(protectMinorSelectors(rows)[0].metadata).toMatchObject({ possible_minor: true });
  });
});

describe("stripDerivedItemMetadata", () => {
  it("removes exactly the derived keys, tolerates a malformed marker, and never mutates", () => {
    const m = { a: 1, possible_minor: true, [MINOR_DERIVED_MARKER]: ["possible_minor"] };
    const out = stripDerivedItemMetadata(m);
    expect(out).toEqual({ a: 1 });
    expect(m.possible_minor).toBe(true);
    expect(stripDerivedItemMetadata({ a: 1, [MINOR_DERIVED_MARKER]: "nope" })).toEqual({ a: 1, [MINOR_DERIVED_MARKER]: "nope" });
    const plain = { a: 1 };
    expect(stripDerivedItemMetadata(plain)).toBe(plain);
  });
});

describe("expandRejections — a REJECTION is about the value; nothing positive ever moves", () => {
  const twins = [row("a", "email", "a@x.com"), row("b", "email", "A@x.com"), row("c", "email", "other@x.com")];

  it("returns the SAME map when there is no rejection (no allocation on the hot path)", () => {
    const states = { a: "confirmed", c: "key" } as const;
    expect(expandRejections(twins, states)).toBe(states);
    expect(expandRejections(twins, {})).toEqual({});
  });

  it("a dismissed/wrong row rejects its sibling rows, not other selectors", () => {
    expect(expandRejections(twins, { a: "dismissed" })).toEqual({ a: "dismissed", b: "dismissed" });
    expect(expandRejections(twins, { b: "wrong" })).toEqual({ b: "wrong", a: "wrong" });
  });

  it("POSITIVE and neutral decisions never propagate", () => {
    for (const s of ["confirmed", "key", "recheck"] as const) {
      expect(expandRejections(twins, { a: s })).toEqual({ a: s });
    }
  });

  it("a sibling's OWN decision wins over a propagated one", () => {
    expect(expandRejections(twins, { a: "dismissed", b: "confirmed" })).toEqual({ a: "dismissed", b: "confirmed" });
    expect(expandRejections(twins, { a: "dismissed", b: "wrong" })).toEqual({ a: "dismissed", b: "wrong" });
  });

  it("when two rows disagree on HOW it was rejected, 'wrong' (the stronger statement) is what the unreviewed rows inherit — in either order", () => {
    const three = [row("a", "email", "a@x.com"), row("b", "email", "a@x.com"), row("z", "email", "a@x.com")];
    expect(expandRejections(three, { a: "dismissed", b: "wrong" }).z).toBe("wrong");
    expect(expandRejections([...three].reverse(), { b: "wrong", a: "dismissed" }).z).toBe("wrong");
  });

  it("a positive decision beside a rejection never becomes what the unreviewed rows inherit — whichever row comes first", () => {
    const three = [row("a", "email", "a@x.com"), row("b", "email", "a@x.com"), row("z", "email", "a@x.com")];
    for (const positive of ["confirmed", "key", "recheck"] as const) {
      expect(expandRejections(three, { a: positive, b: "dismissed" }).z).toBe("dismissed");
      expect(expandRejections([...three].reverse(), { b: "dismissed", a: positive }).z).toBe("dismissed");
      // and the positive row keeps exactly its own decision
      expect(expandRejections(three, { a: positive, b: "dismissed" }).a).toBe(positive);
    }
  });

  it("ignores review ids with no row, rows with no id, and never mutates its inputs", () => {
    const states = { ghost: "dismissed", a: "dismissed" } as Record<string, string>;
    const before = JSON.stringify(states);
    const out = expandRejections([...twins, { id: "", kind: "email", value: "a@x.com", metadata: null }], states);
    expect(JSON.stringify(states)).toBe(before);
    expect(out.ghost).toBe("dismissed");
    expect(out.b).toBe("dismissed");
    expect("" in out).toBe(false);
  });

  it("null/absent rows leave the map alone", () => {
    const s = { a: "dismissed" };
    expect(expandRejections(null, s)).toBe(s);
    expect(expandRejections([], s)).toBe(s);
  });
});
