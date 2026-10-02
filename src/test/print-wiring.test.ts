/**
 * print-wiring — source-level pins for the Report tab's print path.
 *
 * A browser-printed report (Ctrl+P / File → Print) came out as one page of
 * KPIs and one blank page: the print stylesheet keyed on `body.printing-report`,
 * which only the Download-PDF button set for ~50 ms around its own
 * `window.print()`, and the workspace shell's fixed-height, absolutely-positioned
 * stack clipped everything else to a single viewport. Two things now hold:
 * the class is set on `beforeprint` (every print path), and the stylesheet
 * unclamps the report's real ancestors.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

describe("print wiring", () => {
  it("ReportTab sets the print class on beforeprint and clears it on afterprint", () => {
    const src = read("src/components/panel/ReportTab.tsx");
    expect(src).toMatch(/addEventListener\("beforeprint"/);
    expect(src).toMatch(/addEventListener\("afterprint"/);
    expect(src).toMatch(/classList\.add\("printing-report"\)/);
    expect(src).toMatch(/classList\.remove\("printing-report"\)/);
    // no timer-scoped toggle — that is the path Ctrl+P never saw
    expect(src).not.toMatch(/setTimeout\(\(\) => \{\s*window\.print\(\)/);
  });

  it("the workspace arms the report's print handling only while Report is the tab on screen", () => {
    // Visited panels stay mounted (hidden). Behaviour is driven in
    // case-snapshot-provider.test.tsx; this pins the one call site that must pass it.
    const src = read("src/pages/ChatPage.tsx");
    expect(src).toMatch(/<ReportTab\b[^>]*\bprintActive=\{tab === "report"\}/);
  });

  it("the print stylesheet unclamps the workspace ancestors that clip the report", () => {
    const css = read("src/index.css");
    const start = css.indexOf("@media print");
    expect(start).toBeGreaterThan(-1);
    const block = css.slice(start);
    for (const sel of ["#workspace-tabpanel-report", ".chat-column", "body.printing-report main"]) {
      expect(block, sel).toContain(sel);
    }
    const ancestorRule = block.slice(block.indexOf("#workspace-tabpanel-report"));
    expect(ancestorRule).toMatch(/position:\s*static\s*!important/);
    expect(ancestorRule).toMatch(/height:\s*auto\s*!important/);
    expect(ancestorRule).toMatch(/overflow:\s*visible\s*!important/);
    // the report root itself is no longer absolutely positioned inside a clipped shell
    const root = block.slice(block.indexOf("body.printing-report #case-report-print-root {"));
    expect(root.slice(0, 400)).toMatch(/position:\s*static\s*!important/);
  });
});

/* ── The paper register ──────────────────────────────────────────────────
 * "PDF (print) · as displayed" printed an unusable PDF: the dark theme's ink
 * tokens survived into print while the page turned white (near-white text on
 * white), the graphite shell printed as black side bars, source chips clipped
 * to one line, and the evidence tables ran off the right edge. These pins hold
 * the fix: a print-only light token set whose inks clear WCAG AA on paper, and
 * the chip/table/hint rules — all of it inside @media print.
 */

/** Every top-level `@media print { … }` body in the stylesheet. */
function printBlocks(css: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf("@media print", from);
    if (at < 0) return out;
    const open = css.indexOf("{", at);
    let depth = 0;
    let i = open;
    for (; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}" && --depth === 0) break;
    }
    out.push(css.slice(open + 1, i));
    from = i + 1;
  }
}

/** Strip every @media print body, leaving what the SCREEN can see. */
function withoutPrintBlocks(css: string): string {
  let s = css;
  for (const b of printBlocks(css)) s = s.replace(b, "");
  return s;
}

function rootTokens(block: string): Map<string, [number, number, number]> {
  const root = block.match(/:root\s*\{([^}]*)\}/);
  const tokens = new Map<string, [number, number, number]>();
  if (!root) return tokens;
  for (const m of root[1].matchAll(/--([\w-]+):\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%/g)) {
    tokens.set(m[1], [Number(m[2]), Number(m[3]), Number(m[4])]);
  }
  return tokens;
}

function hslToRgb([h, s, l]: [number, number, number]): [number, number, number] {
  const S = s / 100, L = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => L - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const lum = (rgb: [number, number, number]) => {
    const [r, g, bl] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe("print legibility — the paper register", () => {
  const css = read("src/index.css");
  const blocks = printBlocks(css);
  const paper = blocks.find((b) => /:root\s*\{/.test(b)) ?? "";
  const tokens = rootTokens(paper);

  it("a print-only :root flips the ground to white and the film to black", () => {
    expect(paper, "no @media print block redefines :root").not.toBe("");
    expect(tokens.get("background")?.[2]).toBe(100);
    expect(tokens.get("card")?.[2]).toBe(100);
    expect(tokens.get("surface-0")?.[2]).toBe(100);
    // Tailwind's `white` is remapped onto --film; on paper every wash/hairline must be dark.
    expect(tokens.get("film")?.[2]).toBe(0);
    for (const s of ["surface-1", "surface-2", "surface-3", "surface-4", "sidebar-background"]) {
      expect(tokens.get(s)?.[2], s).toBeGreaterThanOrEqual(85);
    }
  });

  it("every ink token clears 4.5:1 on white and on the print surface it sits on", () => {
    const white: [number, number, number] = [255, 255, 255];
    const surface2 = hslToRgb(tokens.get("surface-2")!);
    const inks = [
      "foreground", "card-foreground", "popover-foreground", "secondary-foreground", "accent-foreground",
      "muted-foreground", "subtle-foreground", "faint-foreground", "primary", "destructive",
      "info", "success", "warning", "danger", "evidence",
      "confidence-high", "confidence-mid", "confidence-low",
      "conf-confirmed", "conf-likely", "conf-possible", "conf-weak", "conf-unverified",
      "authority-verified", "authority-infrastructure", "authority-probable", "authority-review",
      "authority-weak", "authority-conflict", "authority-quarantine", "authority-failed",
      "speaker-analyst", "speaker-agent", "speaker-tool",
    ];
    for (const ink of inks) {
      const v = tokens.get(ink);
      expect(v, `--${ink} is not redefined for print`).toBeDefined();
      const rgb = hslToRgb(v!);
      expect(contrast(rgb, white), `--${ink} on white`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(rgb, surface2), `--${ink} on --surface-2`).toBeGreaterThanOrEqual(4.5);
    }
    // muted ink may be grey, but never lighter than ~#6b6b6b
    for (const ink of ["muted-foreground", "subtle-foreground", "faint-foreground"]) {
      expect(tokens.get(ink)![2], ink).toBeLessThanOrEqual(42);
    }
  });

  it("the confidence ramp stays ordinal on paper — a stronger tier is darker ink", () => {
    const l = (t: string) => tokens.get(t)![2];
    expect(l("conf-confirmed")).toBeLessThan(l("conf-likely"));
    expect(l("conf-likely")).toBeLessThan(l("conf-possible"));
    expect(l("conf-possible")).toBeLessThan(l("conf-weak"));
    expect(l("conf-weak")).toBeLessThan(l("conf-unverified"));
    expect(l("confidence-high")).toBeLessThan(l("confidence-mid"));
    expect(l("confidence-mid")).toBeLessThan(l("confidence-low"));
  });

  it("html/body print white, and alpha ink and opacity dimming are dropped inside the report", () => {
    expect(paper).toMatch(/html,\s*body\s*\{[^}]*background:\s*#fff\s*!important/);
    expect(paper).toMatch(/\[class\*=" text-muted-foreground\/"\][^{]*\{\s*color:\s*hsl\(var\(--muted-foreground\)\)\s*!important/);
    expect(paper).toMatch(/\[class\*=" text-foreground\/"\][^{]*\{\s*color:\s*hsl\(var\(--foreground\)\)\s*!important/);
    expect(paper).toMatch(/#case-report-print-root \[class\*="opacity-"\]\s*\{\s*opacity:\s*1\s*!important/);
  });

  it("source chips grow to fit a wrapped label instead of clipping it", () => {
    const rule = paper.match(/\.source-chip\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/height:\s*auto\s*!important/);
    expect(rule).toMatch(/white-space:\s*normal\s*!important/);
    expect(rule).toMatch(/overflow:\s*visible\s*!important/);
    const badge = read("src/components/SourceBadge.tsx");
    expect(badge).toMatch(/"source-chip /);
  });

  it("tables fit the page width and never split a row; the scroll hint does not print", () => {
    const table = paper.match(/#case-report-print-root table\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(table).toMatch(/width:\s*100%\s*!important/);
    expect(table).toMatch(/min-width:\s*0\s*!important/);
    expect(paper).toMatch(/#case-report-print-root tr\s*\{\s*break-inside:\s*avoid/);
    const report = read("src/components/panel/CaseReport.tsx");
    expect(report).toMatch(/<p className="no-print[^"]*">Scroll horizontally to see all columns/);
    expect(report).toMatch(/<table className="report-evidence-table /);
    expect(blocks.some((b) => /\.no-print\s*\{\s*display:\s*none\s*!important/.test(b))).toBe(true);
  });

  it("the print hooks carry no screen style — every rule naming them is inside @media print", () => {
    const screen = withoutPrintBlocks(css);
    for (const hook of [".source-chip", ".report-evidence-table", ".report-section-head", ".no-print"]) {
      expect(screen.includes(hook), `${hook} is styled outside @media print`).toBe(false);
    }
    // and the light tokens never leak onto the screen register
    expect(screen).not.toMatch(/--film:\s*0 0% 0%/);
  });
});
