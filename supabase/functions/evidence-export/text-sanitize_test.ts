// Regression gate for the evidence-export 500: every string drawn into the PDF
// must be WinAnsi-safe so pdf-lib never throws on real OSINT data (emoji, CJK,
// ✓/✗, smart punctuation), and malformed timestamps must not throw.
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { sanitizeWinAnsi, safeIso } from "./text-sanitize.ts";

Deno.test("sanitizeWinAnsi drops non-WinAnsi glyphs but preserves Latin-1", () => {
  const out = sanitizeWinAnsi("\u{1F91D} café ✓ ✗ 日本語 — “q” …");
  assert(!/[\u{1F91D}✓✗日]/u.test(out), `raw emoji/glyphs leaked: ${out}`);
  assert(out.includes("café"), `Latin-1 'é' must survive: ${out}`);
  assert(out.includes("[OK]") && out.includes("[X]"), `check/cross not mapped: ${out}`);
  assert(out.includes('"q"') && out.includes("-") && out.includes("..."), `punctuation not normalized: ${out}`);
});

Deno.test("sanitizeWinAnsi: only WinAnsi-encodable code points remain", () => {
  // After sanitizing, every code point must be in the WinAnsi-safe ranges
  // (tab/newline, printable ASCII, or Latin-1 0xA0-0xFF) — nothing pdf-lib chokes on.
  const out = sanitizeWinAnsi("mix🤝of☃weird✓chars日x");
  for (const ch of out) {
    const cp = ch.codePointAt(0)!;
    assert(
      cp === 0x09 || cp === 0x0A || cp === 0x0D || (cp >= 0x20 && cp <= 0x7E) || (cp >= 0xA0 && cp <= 0xFF),
      `unsafe code point U+${cp.toString(16)} survived in: ${out}`,
    );
  }
});

Deno.test("sanitizeWinAnsi handles null/undefined/empty", () => {
  assertEquals(sanitizeWinAnsi(null), "");
  assertEquals(sanitizeWinAnsi(undefined), "");
  assertEquals(sanitizeWinAnsi(""), "");
});

Deno.test("safeIso formats valid dates and never throws on garbage", () => {
  assertEquals(safeIso("2026-06-16T00:00:00.000Z"), "2026-06-16T00:00:00.000Z");
  assertEquals(safeIso(null), "-");
  // garbage must NOT throw (new Date(x).toISOString() would) — returns sanitized text
  assertEquals(safeIso("not-a-date"), "not-a-date");
  assert(!safeIso("garbage 🤝").includes("\u{1F91D}"), "garbage date must be sanitized");
});
