// a11y-wcag-aa.test.ts — pins the WCAG 2.2 AA fixes from the 2026-11-02 audit of the
// Investigate tab. jsdom cannot compute a stylesheet's cascade, so these read the
// REAL sources: the token values from index.css and the class strings from the
// components. A failure here means a measured accessibility defect has come back.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
const css = read("src/index.css");

/** Every .tsx under `dir`, excluding tests. */
function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (f !== "test") out.push(...tsxFiles(p)); }
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** `--name: H S% L%;` → [r,g,b], from the FIRST declaration (the dark :root default). */
function token(name: string): [number, number, number] {
  const m = css.match(new RegExp(`--${name}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`));
  if (!m) throw new Error(`token --${name} not found`);
  const h = Number(m[1]), s = Number(m[2]) / 100, l = Number(m[3]) / 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
  };
  return [f(0), f(8), f(4)].map((x) => Math.round(x * 255)) as [number, number, number];
}
const lum = ([r, g, b]: [number, number, number]) => {
  const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const ratio = (a: [number, number, number], b: [number, number, number]) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** DESIGN.md "Surface 1" — the plate, the surface most labels sit on. */
const PLATE: [number, number, number] = [0x0b, 0x0b, 0x0e];

describe("authority chip labels clear WCAG 1.4.3 (4.5:1) on the plate", () => {
  const src = read("src/components/ui/authority.tsx");
  const start = src.indexOf("const CHIP");
  const block = src.slice(start, src.indexOf("};", start));
  const states = [...block.matchAll(/^\s+(\w+):\s+"text-(\S+)/gm)].map((m) => ({ state: m[1], cls: m[2] }));

  it("finds all eight states", () => {
    expect(states.map((s) => s.state).sort()).toEqual(
      ["conflict", "failed", "infrastructure", "probable", "quarantined", "review", "verified", "weak"],
    );
  });

  for (const s of ["verified", "infrastructure", "probable", "review", "weak", "quarantined", "conflict", "failed"]) {
    it(`${s}`, () => {
      const entry = states.find((x) => x.state === s)!;
      const name = entry.cls === "faint-foreground" ? "faint-foreground" : entry.cls.match(/--([a-z-]+)/)![1];
      expect(ratio(token(name), PLATE), `${s} label uses --${name}`).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("weak and failed keep their DIM token for the border and fill; only the text moved", () => {
    expect(block).toMatch(/weak:\s+"text-faint-foreground border-\[hsl\(var\(--authority-weak\)\)\]/);
    expect(block).toMatch(/failed:\s+"text-faint-foreground border-\[hsl\(var\(--authority-failed\)\)\]/);
  });
});

describe("pointer targets (WCAG 2.5.8)", () => {
  it("the confidence 'Why is this N%?' trigger is at least 24px and grows on coarse pointers", () => {
    const src = read("src/components/ConfidenceExplain.tsx");
    expect(src).toContain("w-6 h-6");
    expect(src).toContain("[@media(pointer:coarse)]:w-11");
    expect(src).not.toMatch(/inline-grid[^"]*\bw-4 h-4\b/);
  });
});

describe("informative text is not drawn at an opacity that falls under 4.5:1", () => {
  it("text-muted-foreground/55 (4.49:1) is gone, except on an inactive struck-through toggle", () => {
    const hits: string[] = [];
    for (const p of tsxFiles(join(process.cwd(), "src"))) {
      readFileSync(p, "utf8").split("\n").forEach((line, i) => {
        if (line.includes("text-muted-foreground/55") && !line.includes("line-through")) hits.push(`${p}:${i + 1}`);
      });
    }
    expect(hits).toEqual([]);
  });
});

describe("landmarks", () => {
  it("every <aside> in src/components is labelled or is a role=note callout", () => {
    const bad: string[] = [];
    for (const p of tsxFiles(join(process.cwd(), "src/components"))) {
      const s = readFileSync(p, "utf8");
      for (const m of s.matchAll(/<aside\b/g)) {
        // The opening tag's attributes: up to the first line that closes it.
        const head = s.slice(m.index!, m.index! + 400);
        const tag = head.slice(0, head.search(/>\s*(?:\n|\{|<)/) + 1 || 400);
        if (!/aria-label|aria-labelledby|role=/.test(tag)) bad.push(p);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe("graph keyboard focus (WCAG 2.4.7)", () => {
  it("a focused node gets a visible ring even when it is not selected", () => {
    expect(css).toMatch(/\.react-flow__node:focus-visible\s*>\s*\*\s*\{[^}]*outline:\s*2px solid hsl\(var\(--ring\)\)/);
  });
});
