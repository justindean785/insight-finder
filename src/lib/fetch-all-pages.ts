/**
 * fetch-all-pages.ts — read a table in pages, with a hard cap and an honest "cut off" flag.
 *
 * PostgREST answers a plain `.limit(n)` with at most its configured `max-rows` rows, and a
 * single read of a busy window silently stops there. A summary built on that read describes
 * only the newest rows while labelling itself with the whole window. This helper reads page
 * by page instead, asks for ONE row past `maxRows` so it can tell "exactly maxRows" from
 * "more than maxRows", and returns an error with no rows if any page fails, so a partial read
 * is never presented as complete.
 */

export interface PageResult<T> {
  data: T[] | null;
  error: { message: string } | null;
}

export interface PagedRead<T> {
  rows: T[];
  /** more rows exist beyond `maxRows`; `rows` holds the first `maxRows` of them */
  truncated: boolean;
  error: string | null;
}

export async function fetchAllPages<T>(
  /** inclusive range, as in PostgREST `.range(from, to)` */
  fetchPage: (from: number, to: number) => PromiseLike<PageResult<T>>,
  opts: { pageSize: number; maxRows: number },
): Promise<PagedRead<T>> {
  const { pageSize, maxRows } = opts;
  const wanted = maxRows + 1; // one past the cap, to know whether anything is beyond it
  const rows: T[] = [];

  while (rows.length < wanted) {
    const from = rows.length;
    const to = Math.min(from + pageSize, wanted) - 1;
    const page = await fetchPage(from, to);
    if (page.error) return { rows: [], truncated: false, error: page.error.message };
    if (!page.data) return { rows: [], truncated: false, error: "The read returned no data." };
    rows.push(...page.data);
    if (page.data.length < to - from + 1) break; // a short page is the end of the table
  }

  if (rows.length > maxRows) return { rows: rows.slice(0, maxRows), truncated: true, error: null };
  return { rows, truncated: false, error: null };
}
