/**
 * evidence-record-ladder-pin.test.ts — #479.
 *
 * The Evidence Record renders inside the edge function (Deno), which cannot import
 * `@/lib`. So the confidence ladder is DUPLICATED into
 * supabase/functions/osint-agent/lib/evidence-record.ts, and this test is the seam
 * that keeps the copy honest — the same duplicate-and-pin pattern META_KINDS uses
 * (benchmark-audit-policy.test.ts:48).
 *
 * This is the whole reason that module is import-free: vitest can only load it
 * while it has nothing Deno-specific to resolve. That property does NOT enforce
 * itself — an unused import is elided by esbuild and everything still passes, so
 * the drift would only surface later as a broken build. It is asserted directly
 * below instead.
 *
 * The pin compares BEHAVIOUR across the full domain, not the threshold constants,
 * because src/lib/confidence-tier.ts writes its thresholds as inline literals —
 * comparing numbers would pin a restatement, not the mapping that actually ships.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { tierOf } from "@/lib/confidence-tier";
import {
  CONFIDENCE_TIERS,
  confidenceTierLabel,
} from "../../supabase/functions/osint-agent/lib/evidence-record";

const EDGE_MODULE = resolve(process.cwd(), "supabase/functions/osint-agent/lib/evidence-record.ts");

describe("the seam that makes the duplicated ladder safe", () => {
  it("keeps the edge module import-free so vitest can load it", () => {
    // Not decorative. A Deno-style import ("./cluster.ts", "npm:@supabase/...")
    // is unresolvable here, which would take the pin below offline — and an
    // UNUSED one is elided by esbuild, so the tests above would keep passing
    // while the protection silently lapsed. Assert the source directly.
    const source = readFileSync(EDGE_MODULE, "utf8");
    const imports = source
      .split("\n")
      .filter((line) => /^\s*(import\s|export\s+[*{].*\sfrom\s|const\s+\w+\s*=\s*require\()/.test(line));
    expect(imports).toEqual([]);
  });
});

describe("the edge function's confidence ladder mirrors the frontend's", () => {
  it("agrees on every score the engine can produce", () => {
    const disagreements: Array<{ score: number; frontend: string; edge: string }> = [];
    for (let score = 0; score <= 100; score++) {
      const frontend = tierOf(score);
      const edge = confidenceTierLabel(score).toLowerCase();
      if (frontend !== edge) disagreements.push({ score, frontend, edge });
    }
    expect(disagreements).toEqual([]);
  });

  it("places the boundaries where the operator settled them", () => {
    // >=90 / >=75 / >=55 / >=35 — confidence-tier.ts, NOT lib/cluster.ts's 50/30.
    expect(CONFIDENCE_TIERS).toEqual({ CONFIRMED: 90, LIKELY: 75, POSSIBLE: 55, WEAK: 35 });
    expect(tierOf(CONFIDENCE_TIERS.POSSIBLE)).toBe("possible");
    expect(tierOf(CONFIDENCE_TIERS.POSSIBLE - 1)).toBe("weak");
  });

  it("renders the measured 50 as Weak on both sides", () => {
    // Thread 254e079e: record_finding computed 50 while the prose said
    // "CONFIRMED, 95%". Under the model-facing ladder 50 reads "Possible"; the
    // block must agree with the badge beside it instead.
    expect(tierOf(50)).toBe("weak");
    expect(confidenceTierLabel(50)).toBe("Weak");
  });

  it("treats an unusable score as unverified on both sides", () => {
    for (const bad of [null, undefined, NaN]) {
      expect(tierOf(bad as never)).toBe("unverified");
      expect(confidenceTierLabel(bad as never)).toBe("Unverified");
    }
  });
});
