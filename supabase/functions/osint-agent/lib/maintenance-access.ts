/**
 * maintenance-access — WHO may trigger the /health maintenance sweeps, and over
 * whose threads. (Security lockdown, 2026-11-14.)
 *
 * Before this module, `?health=1&maintenance=1` ran stale-run recovery, the
 * rejected-cluster sweep, a tool_usage_log credential read, finding synthesis and
 * the cache sweep with the SERVICE ROLE, across EVERY user, for any caller on the
 * internet: the health path returns before any auth code runs (index.ts), and the
 * only credential check in the handler guarded `?probe=1`.
 *
 * Access, decided here and nowhere else:
 *   operator  — a valid `x-probe-secret` (constant-time compare). All-users
 *               maintenance exactly as before: recovery, rejected-cluster sweep,
 *               credential health, synthesis, cache sweep.
 *   user      — `Authorization: Bearer <jwt>` that Supabase Auth accepts
 *               (`auth.getUser()`, server-side; the same call auth.ts makes for a
 *               run). Recovery and the rejected-cluster sweep ONLY, filtered to the
 *               verified user's id. Never synthesis, never the cache sweep, never
 *               the credential read. The user id comes ONLY from getUser(); no
 *               query-string or body field is read.
 *   anonymous — anything else (no token, a rejected token, or throttled). Treated
 *               as a plain liveness probe: no service-role client is created, no
 *               maintenance read or write happens, no maintenance detail returns.
 *   forbidden — `?probe=1` with a wrong or missing secret: 403, as before.
 *
 * This decides only WHO triggers maintenance. What recovery does to a thread
 * (recovery.ts, the I-1 run-marker gate, the I-2 completion contract) is unchanged.
 *
 * KILL SWITCH (read at call time): MAINTENANCE_LOCKDOWN_DISABLED=true restores the
 * pre-lockdown behaviour — any `maintenance=1` caller runs all-users maintenance.
 * It RE-OPENS the hole; it exists only to restore open-case stale-run recovery
 * without a deploy if the token-bearing sweep fails in production.
 */
import { createClient } from "npm:@supabase/supabase-js@2";

export type MaintenanceAccess =
  | { kind: "none" }
  | { kind: "operator"; via: "secret" | "lockdown_disabled" }
  | { kind: "user"; userId: string }
  | { kind: "anonymous"; reason: "no_credentials" | "invalid_session" | "throttled" }
  | { kind: "forbidden" };

export type MaintenanceAccessInput = {
  /** `?probe=1` — the secret-gated paid provider probe (also runs maintenance). */
  wantProbe: boolean;
  /** `?maintenance=1`, or HEALTH_MAINTENANCE_ALWAYS=true. */
  maintenanceAsked: boolean;
  suppliedSecret: string | null;
  configuredSecret: string;
  authHeader: string | null;
  lockdownDisabled: boolean;
};

export type MaintenanceAccessDeps = {
  /** Verify the bearer token server-side; return the user id, or null. */
  verifyUser: (authHeader: string) => Promise<string | null>;
  /** Per-user throttle on the user path. */
  rateLimit: (key: string) => Promise<{ ok: boolean }>;
};

export const MAINTENANCE_REFUSED_DETAIL =
  "maintenance refused: no operator secret and no verified user session — answered as a liveness probe";

export function maintenanceLockdownDisabled(
  env: (k: string) => string | undefined = (k) => {
    try { return Deno.env.get(k); } catch { return undefined; }
  },
): boolean {
  return (env("MAINTENANCE_LOCKDOWN_DISABLED") ?? "").trim().toLowerCase() === "true";
}

/**
 * Constant-time string equality. Both sides are hashed to fixed-length SHA-256
 * digests first, so neither the length nor the first differing byte of the
 * configured secret leaks through timing; the XOR loop never exits early.
 */
export async function constantTimeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [da, db] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const x = new Uint8Array(da);
  const y = new Uint8Array(db);
  let diff = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** `Bearer <token>` with a non-blank token, else null. */
export function bearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(authHeader.trim());
  return m ? m[1] : null;
}

export async function resolveMaintenanceAccess(
  input: MaintenanceAccessInput,
  deps: MaintenanceAccessDeps,
): Promise<MaintenanceAccess> {
  if (!input.wantProbe && !input.maintenanceAsked) return { kind: "none" };

  // Operator: fail closed when no secret is configured.
  if (input.configuredSecret && input.suppliedSecret &&
      await constantTimeEqual(input.suppliedSecret, input.configuredSecret)) {
    return { kind: "operator", via: "secret" };
  }
  // `?probe=1` sends paid provider pings; it has always required the secret.
  if (input.wantProbe) return { kind: "forbidden" };

  if (input.lockdownDisabled) return { kind: "operator", via: "lockdown_disabled" };

  if (!bearerToken(input.authHeader)) return { kind: "anonymous", reason: "no_credentials" };
  let userId: string | null = null;
  try {
    userId = await deps.verifyUser(input.authHeader as string);
  } catch {
    userId = null;
  }
  // A blank id must never reach a sweep: an unscoped sweep is an all-users sweep.
  if (typeof userId !== "string" || userId.trim() === "") {
    return { kind: "anonymous", reason: "invalid_session" };
  }
  let allowed = true;
  try {
    allowed = (await deps.rateLimit(`maint:${userId}`)).ok;
  } catch {
    allowed = true; // the limiter itself fails open, as checkRateLimit does
  }
  if (!allowed) return { kind: "anonymous", reason: "throttled" };
  return { kind: "user", userId };
}

/**
 * Default verifier: the same server-side check auth.ts uses for a run — an
 * anon-key client carrying the caller's Authorization header, then
 * `auth.getUser()`, which asks Supabase Auth to validate the token.
 */
export function makeVerifyUser(supabaseUrl: string | undefined, anonKey: string | undefined) {
  return async (authHeader: string): Promise<string | null> => {
    if (!supabaseUrl || !anonKey) return null;
    const client = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client.auth.getUser();
    if (error || !data?.user?.id) return null;
    return data.user.id;
  };
}

/**
 * `/health` proof key `checks.maintenance_auth`. Runs the resolver over synthetic
 * requests. PRESENCE proves the deployed bundle; "LEGACY" means the kill switch
 * is on; ok:false means the resolver failed its own probe.
 */
export async function maintenanceAuthSelfTest(
  lockdownDisabled: boolean = maintenanceLockdownDisabled(),
): Promise<{ ok: boolean; detail: string }> {
  if (lockdownDisabled) {
    return { ok: true, detail: "LEGACY via MAINTENANCE_LOCKDOWN_DISABLED — anonymous maintenance runs for all users" };
  }
  const secret = "synthetic-operator-secret";
  const deps: MaintenanceAccessDeps = {
    verifyUser: async (h) => (h === "Bearer synthetic-good-token" ? "00000000-0000-4000-8000-0000000000aa" : null),
    rateLimit: async () => ({ ok: true }),
  };
  const base = { wantProbe: false, maintenanceAsked: true, configuredSecret: secret, lockdownDisabled: false };
  const anon = await resolveMaintenanceAccess({ ...base, suppliedSecret: null, authHeader: null }, deps);
  const bad = await resolveMaintenanceAccess({ ...base, suppliedSecret: null, authHeader: "Bearer synthetic-bad-token" }, deps);
  const user = await resolveMaintenanceAccess({ ...base, suppliedSecret: null, authHeader: "Bearer synthetic-good-token" }, deps);
  const wrong = await resolveMaintenanceAccess({ ...base, suppliedSecret: "synthetic-operator-secreT", authHeader: null }, deps);
  const op = await resolveMaintenanceAccess({ ...base, suppliedSecret: secret, authHeader: null }, deps);
  const ok = anon.kind === "anonymous" && bad.kind === "anonymous" && user.kind === "user" &&
    wrong.kind === "anonymous" && op.kind === "operator";
  return ok
    ? { ok: true, detail: "anon→liveness, jwt→own threads (recovery + rejected-cluster sweep), secret→all users" }
    : { ok: false, detail: `resolver failed self-test: ${[anon, bad, user, wrong, op].map((a) => a.kind).join(",")}` };
}
