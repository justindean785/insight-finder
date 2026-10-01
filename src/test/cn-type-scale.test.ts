// cn-type-scale.test.ts — the type scale must survive cn().
//
// `text-*` sets a font size OR a text colour, and tailwind-merge resolves that
// ambiguity from a table of Tailwind's own size names. This project replaced
// that scale with named steps, so every one of them was filed as a colour and
// collided with the actual colour in the same cn() call — silently, in whichever
// direction the argument order happened to fall. Measured on 2026-09-22: 515
// uses of a scale token across src/components and src/pages, and the Overview
// instrument labels were rendering at the inherited 16px instead of 10px.
//
// These drive cn() itself, so they fail if the extension is removed, and the
// last one fails if a step is added to tailwind.config.ts and not to TYPE_SCALE.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cn, TYPE_SCALE } from "@/lib/utils";

describe("cn keeps a type-scale size beside a text colour", () => {
  for (const step of TYPE_SCALE) {
    it(`keeps text-${step} when a colour follows it`, () => {
      const out = cn(`flex text-${step} uppercase`, "text-muted-foreground");
      expect(out).toContain(`text-${step}`);
      expect(out).toContain("text-muted-foreground");
    });

    it(`keeps text-${step} when a colour precedes it`, () => {
      const out = cn("text-muted-foreground", `text-${step}`);
      expect(out).toContain(`text-${step}`);
      expect(out).toContain("text-muted-foreground");
    });
  }

  it("still collapses two sizes to the last one", () => {
    // The extension must teach tailwind-merge the group, not disable merging:
    // two sizes are a genuine conflict and the later one still has to win.
    expect(cn("text-eyebrow", "text-h2")).toBe("text-h2");
  });

  it("still collapses two colours to the last one", () => {
    expect(cn("text-muted-foreground", "text-foreground")).toBe("text-foreground");
  });

  it("leaves Tailwind's own sizes working", () => {
    expect(cn("text-sm", "text-lg")).toBe("text-lg");
    expect(cn("text-sm text-red-500")).toBe("text-sm text-red-500");
  });
});

describe("TYPE_SCALE matches tailwind.config.ts", () => {
  it("names every fontSize step the config defines", () => {
    // A step added to the config and forgotten here silently goes back to being
    // treated as a colour, which is the whole defect returning for one token.
    const config = readFileSync(resolve(process.cwd(), "tailwind.config.ts"), "utf8");
    const block = config.slice(config.indexOf("fontSize: {"));
    const body = block.slice(0, block.indexOf("\n      },"));
    const declared = [...body.matchAll(/^\s{8}([A-Za-z0-9]+):\s*\[/gm)].map((m) => m[1]);
    expect(declared.length).toBeGreaterThan(0);
    expect([...declared].sort()).toEqual([...TYPE_SCALE].sort());
  });
});
