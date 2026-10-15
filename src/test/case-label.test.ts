import { describe, it, expect } from "vitest";
import { caseDisplayLabel } from "@/lib/case-label";

describe("caseDisplayLabel", () => {
  it("collapses an attached-files title to the file names, no storage URL", () => {
    const t = "Attached files: - [export_Disehoudini10.json](https://skzqwbyvmwqarfgfvyky.supabase.co/storage/v1/object/sign/x/y.json?token=abc)";
    expect(caseDisplayLabel(t)).toBe("Attached: export_Disehoudini10.json");
  });
  it("several attachments are listed comma-separated", () => {
    expect(caseDisplayLabel("Attached files: - [a.png](https://x/y) - [b.pdf](https://x/z)")).toBe("Attached: a.png, b.pdf");
  });
  it("a pasted banner heading becomes a short lead", () => {
    expect(caseDisplayLabel("=== OATHNET INTELLIGENCE === Found via oathnet Date: 2026-10-14")).toBe("OATHNET INTELLIGENCE — Found via oathnet Date: 2026-10-14");
  });
  it("bare URLs shrink to their host; ordinary titles are untouched", () => {
    expect(caseDisplayLabel("check https://juba-osint.com/page?x=1 please")).toBe("check juba-osint.com please");
    expect(caseDisplayLabel("Username: dizosint")).toBe("Username: dizosint");
  });
  it("falls back to the seed, then a placeholder", () => {
    expect(caseDisplayLabel("  ", "dizosint")).toBe("dizosint");
    expect(caseDisplayLabel(null)).toBe("Untitled case");
  });
});
