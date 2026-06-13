// Markdown normalization helpers for the chat/report renderer.
//
// The OSINT agent frequently emits its findings table as ONE continuous line —
// header, the `|---|---|` separator, and every data row concatenated with no
// newlines between them. remark-gfm only recognizes a table when its rows are
// on their own lines, so a collapsed table renders as a literal-pipe wall of
// run-together text. `reflowCollapsedTables` detects that shape and rebuilds it
// into a proper multi-line GFM table before it reaches the renderer.

const SEP_CELL = /^:?-{2,}:?$/;
// A table separator run somewhere on the line, e.g. `|---|---|` or `| :-- | --: |`.
const HAS_SEPARATOR = /\|\s*:?-{2,}:?\s*\|/;

/** Reflow any single-line ("collapsed") GFM tables in `md` into multi-line
 * tables so remark-gfm can parse them. Properly-formatted tables and ordinary
 * prose pass through unchanged. */
export function reflowCollapsedTables(md: string): string {
  if (!md || !md.includes("|") || !HAS_SEPARATOR.test(md)) return md;
  return md.split("\n").map(reflowLine).join("\n");
}

function reflowLine(line: string): string {
  // Only a collapsed table puts the `|---|` separator on the SAME line as data.
  // A well-formed separator line (`|---|---|`) has no content cells, so it falls
  // through the `header.length < n` / empty-body guards below untouched.
  if (!HAS_SEPARATOR.test(line)) return line;

  const tokens = line.split("|").map((c) => c.trim());
  const sepIdx = tokens.map((c, i) => (SEP_CELL.test(c) ? i : -1)).filter((i) => i >= 0);
  if (sepIdx.length < 2) return line; // need at least a 2-column separator

  const n = sepIdx.length;
  const firstSep = sepIdx[0];
  const lastSep = sepIdx[sepIdx.length - 1];

  // Header = the n non-empty cells immediately before the separator run.
  // Anything further left is leading prose (e.g. a glued "Findings" heading)
  // that we keep on its own line so it isn't swallowed into the first column.
  const before = tokens.slice(0, firstSep).filter((c) => c !== "");
  if (before.length < n) return line;
  const header = before.slice(before.length - n);
  const leading = before.slice(0, before.length - n);

  // Body = every non-empty, non-separator cell after the separator run.
  const body = tokens.slice(lastSep + 1).filter((c) => c !== "" && !SEP_CELL.test(c));
  if (body.length === 0) return line; // already a clean standalone separator line

  const out: string[] = [];
  if (leading.length) out.push(leading.join(" "));
  out.push(`| ${header.join(" | ")} |`);
  out.push(`| ${header.map(() => "---").join(" | ")} |`);
  for (let i = 0; i < body.length; i += n) {
    const row = body.slice(i, i + n);
    while (row.length < n) row.push("");
    out.push(`| ${row.join(" | ")} |`);
  }
  // Blank lines so remark-gfm treats the table as its own block.
  return `\n${out.join("\n")}\n`;
}
