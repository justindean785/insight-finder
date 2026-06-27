/**
 * dork-translate.ts — turn a Google dork string into an Exa-friendly query.
 *
 * Exa's keyword search does NOT honor Google dork operators (filetype:, ext:,
 * intitle:, inurl:, exact-phrase quoting, "(... OR ...)" groupings), so handing
 * it a raw dork like `"seed" (filetype:pdf OR site:fec.gov ...)` returns 0
 * results. This reduces the dork to its core keywords and lifts every
 * `site:DOMAIN` into Exa's structured `includeDomains` filter, which Exa DOES
 * honor. Pure + side-effect-free so it can be unit-tested in isolation.
 */
export function dorkToExaQuery(dork: string): { query: string; includeDomains: string[] } {
  const includeDomains: string[] = [];
  let s = dork;

  // Lift `site:DOMAIN` / `site:*.DOMAIN` into includeDomains, then remove the
  // operator from the keyword stream (Exa filters domains structurally).
  s = s.replace(/\bsite:([^\s)]+)/gi, (_m, raw: string) => {
    const domain = String(raw)
      .replace(/^\*\./, "")        // site:*.example.com → example.com
      .replace(/^["']|["',)]+$/g, "") // strip stray quotes/parens/commas
      .trim();
    if (domain) includeDomains.push(domain);
    return " ";
  });

  // Drop operators Exa can't use, including any quoted value they carry
  // (e.g. intitle:"index of"). Match the operator + its whole value.
  s = s.replace(/\b(?:filetype|ext|intitle|inurl):(?:"[^"]*"|'[^']*'|[^\s)]+)/gi, " ");

  // Remove boolean OR tokens and the parenthetical groupings around them.
  s = s.replace(/\bOR\b/gi, " ").replace(/[()]/g, " ");

  // Drop surrounding quotes — keep the inner phrase as plain keywords.
  s = s.replace(/["']/g, " ");

  // Collapse whitespace.
  const query = s.replace(/\s+/g, " ").trim();

  return { query, includeDomains: [...new Set(includeDomains)] };
}
