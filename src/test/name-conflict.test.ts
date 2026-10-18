/**
 * name-conflict.test.ts — an analyst-supplied name that record-derived names
 * contradict is an OPEN QUESTION the report must raise, not something the model's
 * prose resolves.
 *
 * Shape taken from a live scan (2026-10-06): the seed named one surname, breach
 * records returned the same first name with a different surname (twice, from two
 * source labels) plus an unrelated name, and nothing flagged the disagreement.
 *
 * VALUES ARE SYNTHETIC — CLAUDE.md forbids real investigation PII in this repo.
 */
import { describe, expect, it } from "vitest";
import { detectNameConflict, formatNameConflict, type NameRow } from "@/lib/name-conflict";
import { buildIdentityClusters } from "@/lib/intel";
import type { Artifact } from "@/hooks/useThreadArtifacts";

const row = (value: string, source: string | null, meta: Record<string, unknown> | null = null, kind = "name"): NameRow => ({
  kind, value, source, metadata: meta,
});

const SEED = row("Jordan Vale", "user_provided");

describe("detectNameConflict", () => {
  it("flags a record-derived name that shares the seed's first name but not its surname", () => {
    const c = detectNameConflict([
      SEED,
      row("Jordan Reyes", "oathnet_lookup"),
      row("Jordan Reyes", "oathnet_lookup+rapidapi_breach_search"),
      row("Casey Watts", "serus_darkweb_scan"),
    ]);
    expect(c).not.toBeNull();
    expect(c!.anchor).toBe("Jordan Vale");
    expect(c!.conflicting).toHaveLength(1);
    expect(c!.conflicting[0]).toMatchObject({ name: "Jordan Reyes", rows: 2 });
    expect(c!.conflicting[0].sources).toEqual(["oathnet_lookup", "oathnet_lookup+rapidapi_breach_search"]);
  });

  it("a different first name is a different person, not a conflict", () => {
    expect(detectNameConflict([SEED, row("Casey Watts", "serus_darkweb_scan")])).toBeNull();
  });

  it("needs an ANALYST-supplied anchor — two record-derived names disagreeing is not a contradiction", () => {
    expect(detectNameConflict([row("Jordan Reyes", "oathnet_lookup"), row("Jordan Vale", "oathnet_lookup")])).toBeNull();
  });

  it("the same surname never conflicts — middle initials and generational suffixes are tolerated", () => {
    expect(detectNameConflict([SEED, row("Jordan Q. Vale Jr.", "oathnet_lookup"), row("jordan vale", "rapidapi_breach_search")])).toBeNull();
  });

  it("an initial-only surname cannot contradict a full one", () => {
    expect(detectNameConflict([SEED, row("Jordan V.", "oathnet_lookup")])).toBeNull();
  });

  it("excluded / collision rows are already ruled out and are ignored", () => {
    expect(detectNameConflict([SEED, row("Jordan Reyes", "oathnet_lookup", { status: "excluded" })])).toBeNull();
    expect(detectNameConflict([SEED, row("Jordan Reyes", "oathnet_lookup", { excluded_collision: true })])).toBeNull();
  });

  it("only `name` rows count (a username or email that looks like a name does not)", () => {
    expect(detectNameConflict([SEED, row("jordan.reyes", "oathnet_lookup", null, "username")])).toBeNull();
  });

  it("an analyst-stamped metadata flag also anchors", () => {
    const c = detectNameConflict([row("Jordan Vale", "seed", { user_provided: true }), row("Jordan Reyes", "oathnet_lookup")]);
    expect(c?.conflicting[0].name).toBe("Jordan Reyes");
  });
});

describe("formatNameConflict", () => {
  const c = detectNameConflict([SEED, row("Jordan Reyes", "oathnet_lookup"), row("Jordan Reyes", "rapidapi_breach_search")])!;
  const text = formatNameConflict(c);

  it("names the disagreement and where it came from", () => {
    expect(text).toContain("Name conflict (open question)");
    expect(text).toContain("“Jordan Vale”");
    expect(text).toContain("“Jordan Reyes” (2 rows: oathnet_lookup, rapidapi_breach_search)");
  });

  it("never picks a side and never asserts they are different people", () => {
    expect(text).toContain("Nothing in this case establishes which surname is right");
    expect(text.toLowerCase()).not.toContain("different people");
    expect(text.toLowerCase()).not.toContain("confirmed");
  });
});

describe("buildIdentityClusters carries the warning", () => {
  const mk = (id: string, value: string, source: string, kind = "name", confidence = 60): Artifact => ({
    id, kind, value, confidence, source, created_at: "2026-10-06T18:00:00.000Z", metadata: {},
  });

  it("adds the open-question warning when the seed's surname is contradicted", () => {
    const r = buildIdentityClusters(
      [mk("a1", "Jordan Vale", "user_provided", "name", 50), mk("a2", "Jordan Reyes", "oathnet_lookup")],
      "@samplehandle Jordan Vale",
    );
    expect(r.warnings.some((w) => w.startsWith("Name conflict (open question)"))).toBe(true);
  });

  it("stays silent when the names agree", () => {
    const r = buildIdentityClusters(
      [mk("a1", "Jordan Vale", "user_provided", "name", 50), mk("a2", "Jordan Vale", "oathnet_lookup")],
      "@samplehandle Jordan Vale",
    );
    expect(r.warnings.some((w) => w.startsWith("Name conflict"))).toBe(false);
  });
});
