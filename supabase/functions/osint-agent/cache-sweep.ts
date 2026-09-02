/**
 * cache-sweep.ts — bounded, application-level removal of expired `tool_call_cache` rows.
 *
 * ## Why this exists instead of the pg_cron migration
 *
 * Measured in production 2026-08-29: **11,105 rows, 11,009 of them expired**,
 * oldest expiry 2026-06-25. The #510 migration that was supposed to clean this
 * up never ran, and could not have:
 *
 *   - `pg_cron` is NOT installed (`installed_version: null`). The `cron` schema
 *     does not exist, so `cron.job` and `cron.schedule` are unresolvable.
 *   - The migration is absent from `supabase_migrations.schema_migrations`;
 *     the newest row there is `20260825024640`. Every migration this database
 *     has is Lovable-authored (UUID-named) — **`supabase/migrations/` in this
 *     repo is not the mechanism that changes this database.**
 *   - The migration would have failed anyway: its second `DO` block references
 *     `cron.job` unconditionally, which throws `relation "cron.job" does not
 *     exist` when the extension is absent. Reproduced.
 *
 * Installing `pg_cron` needs owner privileges on a Lovable-owned project. So the
 * scheduler is the wrong dependency: this project already has a maintenance path
 * that runs outside every investigation, and it needs no extension, no
 * migration and no elevated grant.
 *
 * ## The invariants this module holds
 *
 * - **Bounded.** At most `CACHE_SWEEP_BATCH` rows per invocation, selected by id
 *   first. Never an unqualified `DELETE`, never a predicate-only delete that
 *   could take a long lock over 11k rows.
 * - **Idempotent.** Deleting by an explicit id set: a row a concurrent sweep
 *   already removed simply is not there, which is not an error.
 * - **Non-failing.** Every fault is counted and returned. This function does not
 *   throw, because its only caller is a health probe and an operator losing
 *   `/health` over cache housekeeping would be a far worse outcome than stale
 *   rows.
 * - **Off the request path.** Invoked from the health sweep — a separate request
 *   from any investigation — exactly like `recoverStaleActiveThreads` and the
 *   synthesis sweep beside it.
 * - **No PII in logs.** `tool_call_cache` rows carry `input_json`, `output_json`
 *   and `selector_normalized` — i.e. the selectors under investigation. This
 *   module reads and reports **counts only**; no row value is ever logged or
 *   returned.
 * - **Preserves live rows.** The filter is `expires_at < now()`. A NULL
 *   `expires_at` is a row with no expiry and is never eligible: SQL
 *   three-valued logic already excludes it from `<`, so this is a property of
 *   the comparison and not of a guard someone could remove.
 *
 * ## Ships dark
 *
 * `CACHE_SWEEP_ENABLED` defaults **OFF**, and `CACHE_SWEEP_DRY_RUN` lets the
 * distribution be measured before a single row is removed. This deletes
 * production data; it does not get to start doing that because a deploy landed.
 */

/** Rows removed per invocation. Small enough to be a short statement, large
 *  enough that a ~11k backlog clears in a couple of days of ordinary probes. */
export const CACHE_SWEEP_BATCH = 5_000;

export interface CacheSweepResult {
  /** Expired rows found by this invocation (capped at the batch bound). */
  attempted: number;
  /** Rows actually removed. Equals `attempted` on a clean run; 0 on a dry run. */
  deleted: number;
  /** Faults encountered. Non-zero means the caller should report degraded, never throw. */
  errors: number;
  /** True when the batch bound was reached, so more remain for the next probe. */
  more: boolean;
  dryRun: boolean;
}

/** The narrow slice of PostgREST this module uses. Structural, so tests pass a fake. */
interface CacheQuery {
  select: (cols: string) => CacheQuery;
  delete: () => CacheQuery;
  lt: (col: string, value: string) => CacheQuery;
  in: (col: string, values: string[]) => CacheQuery;
  limit: (n: number) => CacheQuery;
  then: (
    res: (v: { data?: unknown; error?: unknown }) => unknown,
    rej?: (e: unknown) => unknown,
  ) => Promise<unknown>;
}
interface CacheDb { from: (table: string) => CacheQuery }

function flag(name: string, dflt = false): boolean {
  try {
    const v = Deno.env.get(name);
    if (v == null || v === "") return dflt;
    return /^(1|true|yes|on)$/i.test(v.trim());
  } catch {
    return dflt;
  }
}

/** Off unless explicitly enabled. This removes production rows. */
export function cacheSweepEnabled(): boolean {
  return flag("CACHE_SWEEP_ENABLED", false);
}

/** Compute and report without deleting, so the backlog can be measured first. */
export function cacheSweepDryRun(): boolean {
  return flag("CACHE_SWEEP_DRY_RUN", false);
}

/**
 * Remove one bounded batch of expired cache rows.
 *
 * Returns counts. Never throws — see the invariants above.
 */
export async function sweepExpiredCache(
  dbLike: unknown,
  opts?: { batch?: number; dryRun?: boolean; now?: Date },
): Promise<CacheSweepResult> {
  const batch = Math.max(1, opts?.batch ?? CACHE_SWEEP_BATCH);
  const dryRun = opts?.dryRun ?? cacheSweepDryRun();
  const out: CacheSweepResult = { attempted: 0, deleted: 0, errors: 0, more: false, dryRun };
  const db = dbLike as CacheDb | null;
  if (!db || typeof db.from !== "function") {
    out.errors++;
    return out;
  }

  const cutoff = (opts?.now ?? new Date()).toISOString();

  // 1) Identify. `id` ONLY — never the payload columns, which carry selectors.
  let ids: string[];
  try {
    const res = await db.from("tool_call_cache")
      .select("id")
      .lt("expires_at", cutoff)
      .limit(batch) as { data?: unknown; error?: unknown };
    if (res?.error) {
      out.errors++;
      return out;
    }
    const rows = Array.isArray(res?.data) ? res.data : [];
    ids = rows
      .map((r) => (r as { id?: unknown })?.id)
      .filter((v): v is string => typeof v === "string" && v.length > 0);
  } catch {
    out.errors++;
    return out;
  }

  out.attempted = ids.length;
  out.more = ids.length >= batch;
  if (ids.length === 0 || dryRun) return out;

  // 2) Remove by explicit id set. Idempotent and concurrency-safe: a row another
  //    invocation already took is simply absent from the delete's effect.
  try {
    const res = await db.from("tool_call_cache")
      .delete()
      .in("id", ids) as { error?: unknown };
    if (res?.error) {
      out.errors++;
      return out;
    }
    out.deleted = ids.length;
  } catch {
    out.errors++;
  }
  return out;
}

/** One-line, PII-free summary for a health check's `detail`. */
export function describeCacheSweep(r: CacheSweepResult): string {
  if (r.dryRun) return `DRY RUN — ${r.attempted} expired row(s) eligible, nothing deleted${r.more ? " (more remain)" : ""}`;
  return `${r.deleted} expired row(s) removed of ${r.attempted} found${r.more ? " (more remain)" : ""}`;
}
