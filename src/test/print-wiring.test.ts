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
