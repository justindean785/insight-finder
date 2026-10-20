/**
 * credential-health.ts — which providers are REFUSING us, and whether they recovered.
 *
 * PURE (no I/O). The caller supplies the rows; this module only classifies them.
 *
 * WHY THIS EXISTS. `/health`'s tools line reads
 *   `${enabledOptional}/${total} optional tool APIs configured`
 * and every entry behind it is `has(env.SOME_API_KEY)` — a PRESENCE test. A dead
 * key and a working key are byte-identical to that check, so the probe reported
 * "17/20 configured" throughout the period in which github_code_search was
 * answering 401 on every call and rapidapi_breach_search was answering 403. It
 * also cannot confirm a fix: rotating a secret's value changes no name, so the
 * count does not move and the operator has no signal either way.
 *
 * This closes that. It reports, from what providers ACTUALLY answered:
 *   • which tools returned an authorization failure inside the window,
 *   • when each last did,
 *   • whether each has succeeded SINCE — i.e. whether a rotation took.
 *
 * ⚠️ NAMED "authorization failure", NOT "dead credential", on purpose. A 403 is
 * not always a bad key: `reddit_user` 403s because Reddit blocks unauthenticated
 * datacenter IPs, and FOFA answers 200 with `{"error":true}` when the account's
 * PLAN lacks a queried field. Calling every 403 a dead credential is how the
 * 2026-09-12 datasheet condemned rapidapi_breach_search while it was serving 391
 * successful lookups. Report the observation; let a human name the cause.
 */

/** One `tool_usage_log` row, as loosely typed as it arrives from PostgREST. */
export interface CredentialRow {
  tool_name?: unknown;
  status_code?: unknown;
  outcome?: unknown;
  created_at?: unknown;
}

export interface CredentialStatus {
  tool: string;
  /** ISO timestamp of the most recent 401/403 inside the window. */
  last_auth_failure_at: string;
  /** Most recent non-failed call, or null if the tool has never succeeded here. */
  last_success_at: string | null;
  /** A success strictly AFTER the last refusal — the signal a rotation took. */
  recovered: boolean;
  auth_failures: number;
}

export interface CredentialHealth {
  rows_read: number;
  /** Tools still refusing: an auth failure with no success after it. */
  failing: CredentialStatus[];
  /** Tools that were refusing and have since succeeded. */
  recovered: CredentialStatus[];
}

/** HTTP codes that mean "the provider declined to serve us", whatever the cause. */
export const AUTH_FAILURE_CODES: ReadonlySet<number> = new Set([401, 403]);

const EMPTY: CredentialHealth = { rows_read: 0, failing: [], recovered: [] };

function asString(v: unknown): string {
  return typeof v === "string" && v.length > 0 ? v : "";
}

/** Later of two ISO timestamps; "" counts as "never". Lexicographic compare is
 *  correct for ISO-8601 UTC and avoids constructing a Date per row. */
function later(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

/**
 * Classify recent calls into per-tool authorization health.
 *
 * A "success" is any call that is not a hard failure and not a governance skip.
 * Measured on `outcome`, never on the `ok` boolean: `ok` was relaxed to
 * `outcome !== "failed"`, and an EMPTY negative ("this target has no record") is
 * a real, successful call that proves the credential works — excluding it would
 * mark a healthy, low-hit provider as permanently unrecovered.
 */
export function summarizeCredentialHealth(
  rows: readonly CredentialRow[] | null | undefined,
): CredentialHealth {
  if (!Array.isArray(rows) || rows.length === 0) return { ...EMPTY, failing: [], recovered: [] };
  const byTool = new Map<string, { fails: number; lastFail: string; lastOk: string }>();
  for (const row of rows) {
    const tool = asString(row?.tool_name);
    if (!tool) continue;
    const at = asString(row?.created_at);
    const entry = byTool.get(tool) ?? { fails: 0, lastFail: "", lastOk: "" };
    const code = typeof row?.status_code === "number" ? row.status_code : Number(row?.status_code);
    if (Number.isFinite(code) && AUTH_FAILURE_CODES.has(code)) {
      entry.fails += 1;
      entry.lastFail = later(entry.lastFail, at);
    } else if (row?.outcome !== "failed" && row?.outcome !== "skipped") {
      entry.lastOk = later(entry.lastOk, at);
    }
    byTool.set(tool, entry);
  }
  const failing: CredentialStatus[] = [];
  const recovered: CredentialStatus[] = [];
  for (const [tool, e] of byTool) {
    if (!e.fails || !e.lastFail) continue;
    const status: CredentialStatus = {
      tool,
      last_auth_failure_at: e.lastFail,
      last_success_at: e.lastOk || null,
      recovered: Boolean(e.lastOk) && e.lastOk > e.lastFail,
      auth_failures: e.fails,
    };
    (status.recovered ? recovered : failing).push(status);
  }
  // Most-refused first, so the operator reads the worst offender at the top.
  failing.sort((a, b) => b.auth_failures - a.auth_failures || a.tool.localeCompare(b.tool));
  recovered.sort((a, b) => a.tool.localeCompare(b.tool));
  return { rows_read: rows.length, failing, recovered };
}

/**
 * One-line `detail` for the /health payload. Kept short and specific: a probe
 * line nobody can act on is the same as no probe line.
 */
export function describeCredentialHealth(h: CredentialHealth, truncated = false): string {
  const parts: string[] = [];
  parts.push(
    h.failing.length === 0
      ? "no provider authorization failures"
      : `refusing: ${h.failing.map((f) => `${f.tool} (${f.auth_failures}x)`).join(", ")}`,
  );
  if (h.recovered.length > 0) parts.push(`recovered: ${h.recovered.map((r) => r.tool).join(", ")}`);
  if (truncated) parts.push("window truncated by row cap — counts are a floor");
  return parts.join(" · ");
}

// ---- /health maintenance gate (2026-10-19) --------------------------------------
// The newest rows read for checks.credentials, by created_at, inside the window.
// 300 is a few full runs' worth (a long invocation logs ~100-130 calls): enough to
// name a provider that is refusing every call right now, small enough that the read
// is an index range scan rather than the 5,000-row exact-count scan it replaced.
export const CREDENTIAL_HEALTH_SAMPLE_ROWS = 300;
export const CREDENTIAL_HEALTH_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const MAINTENANCE_SKIPPED_DETAIL =
  "skipped on a liveness probe — pass ?maintenance=1 (or the authenticated ?probe=1) to run " +
  "recovery, the rejected-cluster sweep, credential health, synthesis and the cache sweep";

/** True when the probe asks for the maintenance sweeps, or HEALTH_MAINTENANCE_ALWAYS=true restores the old default. */
export function maintenanceRequested(
  u: URL,
  env: (k: string) => string | undefined = (k) => {
    try { return Deno.env.get(k); } catch { return undefined; }
  },
): boolean {
  if (u.searchParams.get("maintenance") === "1") return true;
  return (env("HEALTH_MAINTENANCE_ALWAYS") ?? "").trim().toLowerCase() === "true";
}
