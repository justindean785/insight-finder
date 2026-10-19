// lib/provider-auth-prior.ts — a 401/402 seen in an EARLIER invocation of this case
// suppresses the provider for this run too.
//
// The circuit breaker is per isolate: `clearRuntime(threadId)` wipes it on every
// request and an investigation is 2–12 requests, so a provider that answered 401
// on the analyst's first turn is brand new on the third (the same shape
// lib/dead-target.ts closes for (tool, selector) pairs). `tool_usage_log` is
// durable, so this reads the case's own history once per run and re-applies the
// refusal through circuit.suppressProviderAuthPrior — the SAME mechanism the
// in-run 401/402 branch of recordResult uses, so there is one refusal shape.
//
// Rules, shared with the loaders beside it:
//   • a LATER real answer from the same provider (outcome ok/empty — any tool in
//     the family) CLEARS the refusal: "a 403 is not a dead credential" (CLAUDE.md),
//     and a rotated key must be able to recover without touching the log;
//   • only 401 and 402 carry over. A 403 is too often policy (reddit_user blocks
//     datacenter IPs) to bind a whole case on;
//   • a refusal older than AUTH_SUPPRESS_MS (24h) is forgotten. Without this bound
//     the suppression was self-sealing: it hides the provider's tools, so no later
//     ok/empty row could ever be written in that thread and a billing fix or key
//     rotation never recovered for an existing case (review finding, 2026-10-19);
//   • a cache replay (`cached`) never reached the provider: it neither counts
//     nor clears;
//   • bounded read (newest PROVIDER_AUTH_PRIOR_ROWS real rows, by the thread index)
//     and FAILS OPEN on any error — this is a cost control, not an authorization
//     boundary;
//   • kill switch PROVIDER_AUTH_PRIOR_DISABLED=true, read at call time.
// /health proof key: checks.provider_auth_prior (pure self-test).

import { AUTH_SUPPRESS_MS } from "../circuit.ts";

export const PROVIDER_AUTH_PRIOR_DISABLED_ENV = "PROVIDER_AUTH_PRIOR_DISABLED";
/** Newest real rows read per run. A long invocation logs ~100-130 calls. */
export const PROVIDER_AUTH_PRIOR_ROWS = 1000;
export const PROVIDER_AUTH_PRIOR_READ_OUTCOMES = ["failed", "ok", "empty"] as const;
/** A 401/402 older than this is not carried; mirrors the in-run suppression window. */
export const PROVIDER_AUTH_PRIOR_MAX_AGE_MS = AUTH_SUPPRESS_MS;

export function providerAuthPriorEnabled(
  env: (k: string) => string | undefined = (k) => {
    try { return Deno.env.get(k); } catch { return undefined; }
  },
): boolean {
  return (env(PROVIDER_AUTH_PRIOR_DISABLED_ENV) ?? "").trim().toLowerCase() !== "true";
}

export type AuthPriorRow = {
  tool_name?: unknown;
  status_code?: unknown;
  outcome?: unknown;
  created_at?: unknown;
  cached?: unknown;
};

export interface ProviderAuthRefusal {
  provider: string;
  /** The tool whose call was refused (the suppression is applied through it). */
  tool: string;
  status: 401 | 402;
}

function timeOf(v: unknown): number {
  if (typeof v !== "string") return 0;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Providers whose MOST RECENT real answer in this case was a 401 or 402, with no
 * later ok/empty from any tool of the same provider. Pure.
 */
export function buildProviderAuthPrior(
  rows: readonly AuthPriorRow[],
  providerForTool: (tool: string) => string,
  opts: { now?: number; maxAgeMs?: number } = {},
): ProviderAuthRefusal[] {
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.maxAgeMs ?? PROVIDER_AUTH_PRIOR_MAX_AGE_MS;
  const ordered = rows
    .map((row, index) => ({ row, index, at: timeOf(row.created_at) }))
    .sort((a, b) => (a.at === b.at ? a.index - b.index : a.at - b.at));
  const latest = new Map<string, ProviderAuthRefusal | null>();
  for (const { row: r } of ordered) {
    if (r.cached === true) continue;
    const tool = typeof r.tool_name === "string" ? r.tool_name.trim() : "";
    if (!tool) continue;
    const outcome = typeof r.outcome === "string" ? r.outcome : "";
    const provider = providerForTool(tool);
    if (outcome === "ok" || outcome === "empty") {
      latest.set(provider, null); // a real answer clears any earlier refusal
      continue;
    }
    if (outcome !== "failed") continue;
    const status = typeof r.status_code === "number" ? r.status_code : Number(r.status_code);
    if (status !== 401 && status !== 402) continue; // any other failure neither counts nor clears
    const age = now - timeOf(r.created_at);
    if (!Number.isFinite(age) || age > maxAgeMs) continue; // stale or undated: forgotten, never carried
    latest.set(provider, { provider, tool, status });
  }
  return [...latest.values()].filter((v): v is ProviderAuthRefusal => v !== null);
}

// deno-lint-ignore no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AuthPriorDb = { from: (table: string) => any };

/** One bounded read of the case's real attempts, newest first. Fails OPEN (empty) on any error. */
export async function loadProviderAuthPrior(
  db: AuthPriorDb,
  threadId: string,
  providerForTool: (tool: string) => string,
): Promise<{ refusals: ProviderAuthRefusal[]; rowsRead: number; error?: string }> {
  try {
    const { data, error } = await db
      .from("tool_usage_log")
      .select("tool_name,status_code,outcome,created_at,cached")
      .eq("thread_id", threadId)
      .in("outcome", PROVIDER_AUTH_PRIOR_READ_OUTCOMES)
      .order("created_at", { ascending: false })
      .limit(PROVIDER_AUTH_PRIOR_ROWS);
    if (error) return { refusals: [], rowsRead: 0, error: String(error.message ?? error).slice(0, 160) };
    const rows = (data ?? []) as AuthPriorRow[];
    return { refusals: buildProviderAuthPrior(rows, providerForTool), rowsRead: rows.length };
  } catch (e) {
    return { refusals: [], rowsRead: 0, error: String(e).slice(0, 160) };
  }
}

/** /health → checks.provider_auth_prior. Pure; presence proves this build. */
export function providerAuthPriorSelfTest(): { ok: boolean; switch: string; detail: string } {
  const sw = PROVIDER_AUTH_PRIOR_DISABLED_ENV;
  if (!providerAuthPriorEnabled()) return { ok: true, switch: `${sw}=true`, detail: `LEGACY via ${sw} (401/402 forgotten between invocations)` };
  const prov = (t: string) => (t.startsWith("oathnet_") ? "oathnet" : t);
  const wrong: string[] = [];
  const now = Date.parse("2026-01-01T00:10:00Z");
  const a = buildProviderAuthPrior([
    { tool_name: "oathnet_lookup", status_code: 401, outcome: "failed", created_at: "2026-01-01T00:00:01Z" },
    { tool_name: "hunter_combined", status_code: 500, outcome: "failed", created_at: "2026-01-01T00:00:02Z" },
  ], prov, { now });
  if (a.length !== 1 || a[0].provider !== "oathnet" || a[0].status !== 401) wrong.push("401 not carried");
  const b = buildProviderAuthPrior([
    { tool_name: "oathnet_lookup", status_code: 402, outcome: "failed", created_at: "2026-01-01T00:00:01Z" },
    { tool_name: "oathnet_stealer_search", status_code: 200, outcome: "ok", created_at: "2026-01-01T00:00:02Z" },
  ], prov, { now });
  if (b.length !== 0) wrong.push("a later real answer did not clear the refusal");
  const c = buildProviderAuthPrior([
    { tool_name: "reddit_user", status_code: 403, outcome: "failed", created_at: "2026-01-01T00:00:01Z" },
    { tool_name: "oathnet_lookup", status_code: 401, outcome: "failed", created_at: "2026-01-01T00:00:01Z", cached: true },
  ], prov, { now });
  if (c.length !== 0) wrong.push("a 403 or a cached row was carried");
  const d = buildProviderAuthPrior([
    { tool_name: "oathnet_lookup", status_code: 401, outcome: "failed", created_at: "2026-01-01T00:00:01Z" },
  ], prov, { now: now + PROVIDER_AUTH_PRIOR_MAX_AGE_MS });
  if (d.length !== 0) wrong.push("a refusal older than the suppression window was carried");
  return wrong.length
    ? { ok: false, switch: `${sw}=false`, detail: wrong.join("; ") }
    : {
      ok: true,
      switch: `${sw}=false`,
      detail: "a 401/402 from an earlier run of the case suppresses the provider for this run (cleared by any later " +
        "real answer from that provider, forgotten after 24h; 403 and cache replays never carry)",
    };
}
