/**
 * Per-tool reliability for the Intelligence › Sources tab.
 *
 * Same definition as the `tool_health` view (migration 20260701): reliability is
 * measured on the `outcome` column over REAL ATTEMPTS only — `ok` and `failed`.
 * Governance skips and valid empty (no-record) results are excluded from BOTH
 * the numerator and the denominator, so they can neither flatter a tool nor
 * defame it. Live calls only (`cached = false`), last 30 days.
 *
 * The tab used to read the legacy `ok` boolean, which is stored as
 * `outcome !== "failed"`: skips and empties were counted as successes, so a tool
 * with nothing but skips read 100%. It also read an unordered, unwindowed 5000
 * rows, so on a table past that size the figure came from an arbitrary slice.
 *
 * Rows with a NULL outcome (pre-outcome-column history) are dropped, never
 * guessed from `ok` — the same rule the view applies.
 */

export const SOURCE_RELIABILITY_WINDOW_DAYS = 30;
/** Recent half of the window, compared with the rest of it for the trend. */
export const SOURCE_RELIABILITY_RECENT_DAYS = 14;
export const SOURCE_RELIABILITY_ROW_LIMIT = 5000;

export type SourceLogRow = {
  tool_name: string;
  outcome: string | null;
  cached: boolean | null;
  created_at: string;
};

export type SourceReliability = {
  tool: string;
  /** 0-100 over real attempts, or null when the tool has none in the window. */
  reliability: number | null;
  /** Percentage-point change, recent vs earlier part of the window; 0 when either side has no attempts. */
  delta: number;
  /** Real attempts: outcome ok or failed. */
  attempts: number;
  ok: number;
  failed: number;
  /** Excluded from the figure, shown so the exclusion is visible. */
  skipped: number;
  empty: number;
};

export function windowStartIso(now: number): string {
  return new Date(now - SOURCE_RELIABILITY_WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
}

export function summarizeSourceReliability(
  rows: readonly SourceLogRow[],
  tools: readonly string[],
  now: number = Date.now(),
): SourceReliability[] {
  const windowStart = windowStartIso(now);
  const recentStart = new Date(now - SOURCE_RELIABILITY_RECENT_DAYS * 24 * 3600 * 1000).toISOString();
  type Acc = { ok: number; failed: number; skipped: number; empty: number; okR: number; nR: number; okP: number; nP: number };
  const by = new Map<string, Acc>();
  for (const t of tools) by.set(t, { ok: 0, failed: 0, skipped: 0, empty: 0, okR: 0, nR: 0, okP: 0, nP: 0 });

  for (const row of rows) {
    const a = by.get(row.tool_name);
    if (!a) continue;
    if (row.cached !== false) continue; // live calls only, as the view
    if (row.created_at < windowStart) continue;
    if (row.outcome === "skipped") { a.skipped++; continue; }
    if (row.outcome === "empty") { a.empty++; continue; }
    if (row.outcome !== "ok" && row.outcome !== "failed") continue; // NULL / unknown: dropped, never guessed
    const good = row.outcome === "ok";
    if (good) a.ok++; else a.failed++;
    if (row.created_at >= recentStart) { a.nR++; if (good) a.okR++; } else { a.nP++; if (good) a.okP++; }
  }

  return tools
    .map((tool): SourceReliability => {
      const a = by.get(tool)!;
      const attempts = a.ok + a.failed;
      const rPct = a.nR ? (a.okR / a.nR) * 100 : NaN;
      const pPct = a.nP ? (a.okP / a.nP) * 100 : NaN;
      return {
        tool,
        reliability: attempts ? Math.round((a.ok / attempts) * 100) : null,
        delta: Number.isFinite(rPct) && Number.isFinite(pPct) ? Math.round(rPct - pPct) : 0,
        attempts,
        ok: a.ok,
        failed: a.failed,
        skipped: a.skipped,
        empty: a.empty,
      };
    })
    // Only tools this user has actually run (any outcome); a new account must not see 13 empty rows.
    .filter((r) => r.attempts + r.skipped + r.empty > 0)
    .sort((x, y) => y.attempts - x.attempts || y.skipped + y.empty - (x.skipped + x.empty) || x.tool.localeCompare(y.tool));
}

/** Plain-words breakdown for the row tooltip, so the exclusion is stated, not implied. */
export function describeSourceReliability(r: SourceReliability): string {
  const parts = [`${r.ok} succeeded`, `${r.failed} failed`];
  if (r.skipped) parts.push(`${r.skipped} skipped (not counted)`);
  if (r.empty) parts.push(`${r.empty} no-record (not counted)`);
  return parts.join(" · ");
}
