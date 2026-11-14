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

// ── text-destructive is a FILL, not an ink ─────────────────────────────────────
// index.css "The one alarm": --destructive is the button fill (its label clears AA at
// 48% lightness), --danger is the ink for dark ground. Painting text with the fill
// measured 3.92:1 on the plate — a WCAG 1.4.3 failure on every "N excluded", "failed"
// chip and error line. The fix is to move the INK to --danger, never to lighten the
// fill (that would break the button label).
describe("alarm ink: --danger is the text token, --destructive stays a fill (WCAG 1.4.3)", () => {
  const rgbOf = (hex: string): [number, number, number] =>
    [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
  const mix = (fg: [number, number, number], bg: [number, number, number], a: number) =>
    fg.map((v, i) => Math.round(v * a + bg[i] * (1 - a))) as [number, number, number];

  it("--danger clears 4.5:1 on the plate and on every raised surface text sits on", () => {
    for (const ground of ["surface-1", "surface-2", "surface-3", "surface-4"]) {
      expect(ratio(token("danger"), token(ground)), `--danger on --${ground}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(ratio(token("danger"), PLATE), "--danger on the plate").toBeGreaterThanOrEqual(4.5);
  });

  it("--danger clears 4.5:1 on the tinted chip grounds (bg-destructive/10 … /25 over the plate)", () => {
    for (const a of [0.1, 0.15, 0.2, 0.25]) {
      expect(ratio(token("danger"), mix(token("destructive"), PLATE, a)), `chip tint /${a * 100}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("--destructive as TEXT does NOT clear 4.5:1 on the plate (why the swap exists)", () => {
    expect(ratio(token("destructive"), PLATE)).toBeLessThan(4.5);
  });

  it("--destructive stays dark enough that the button label on it clears 4.5:1 (do not lighten it)", () => {
    expect(ratio(token("destructive-foreground"), token("destructive"))).toBeGreaterThanOrEqual(4.5);
  });

  it("no src file paints TEXT with the destructive fill (text-destructive, any variant or opacity)", () => {
    // Every file the swap must never regress in. `text-destructive-foreground` is the
    // label printed ON a destructive fill and is the only legitimate neighbour. Add a
    // path here only for a destructive-coloured glyph that is not text and not a state.
    const ALLOWED: string[] = [];
    const walk = (dir: string): string[] => {
      const out: string[] = [];
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (statSync(p).isDirectory()) { if (f !== "test") out.push(...walk(p)); }
        else if (/\.tsx?$/.test(p) && !/\.test\.tsx?$/.test(p)) out.push(p);
      }
      return out;
    };
    const INK = /(?<![\w-])(?:[\w-]+:)*text-(?:destructive(?![\w-])|\[hsl\(var\(--destructive\)(?:\s*\/[^)]*)?\)\])/;
    const hits: string[] = [];
    for (const p of walk(join(process.cwd(), "src"))) {
      if (ALLOWED.some((a) => p.endsWith(a))) continue;
      readFileSync(p, "utf8").split("\n").forEach((line, i) => {
        if (INK.test(line)) hits.push(`${p.replace(process.cwd() + "/", "")}:${i + 1}`);
      });
    }
    expect(hits, "use text-danger (the ink token) — see index.css 'The one alarm'").toEqual([]);
  });

  it("the print stylesheet no longer special-cases text-destructive/<alpha>", () => {
    expect(css.includes("text-destructive/")).toBe(false);
  });
});
