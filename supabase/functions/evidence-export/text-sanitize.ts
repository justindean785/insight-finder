// PDF text sanitization for the evidence export.
//
// pdf-lib StandardFonts use WinAnsi (CP1252) encoding and THROW on any glyph
// they can't encode — emoji, CJK, ✓/✗, smart punctuation. OSINT evidence values
// routinely contain these, which previously threw and 500'd the entire export.
// These helpers map every string drawn into the PDF to a WinAnsi-safe form. The
// JSON manifest (the integrity artifact) keeps the RAW values — only the
// human-readable PDF rendering is sanitized, so chain-of-custody is unchanged.

export function sanitizeWinAnsi(input: string | null | undefined): string {
  if (!input) return "";
  return String(input)
    .replace(/[–—]/g, "-")                 // en / em dash
    .replace(/…/g, "...")                       // ellipsis
    .replace(/[‘’‚′]/g, "'")     // smart single quotes
    .replace(/[“”„″]/g, '"')     // smart double quotes
    .replace(/•/g, "*")                         // bullet
    .replace(/[✓✅✔]/g, "[OK]")        // check marks
    .replace(/[✗✘❌✖]/g, "[X]")   // crosses
    .replace(/[^\u0020-\u007E\u00A0-\u00FF]/g, (char) =>
      char === "\t" || char === "\n" || char === "\r" ? char : "?",
    ); // drop emoji/CJK/etc. while preserving ASCII whitespace.
}

// new Date(bad).toISOString() throws "Invalid time value" — guard it so one
// malformed timestamp in the log can't 500 the export.
export function safeIso(value: string | null | undefined): string {
  if (!value) return "-";
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? sanitizeWinAnsi(String(value)) : d.toISOString();
}
