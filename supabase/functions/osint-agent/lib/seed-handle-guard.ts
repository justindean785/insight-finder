/**
 * seed-handle-guard — a shortened form of the seed handle is a different account.
 *
 * MEASURED 2026-11-10. The case seed was a dotted handle (written here as `sample.handle`). The model dropped the
 * suffix and ran `username_sweep` and a username breach lookup on `sample` — a common handle owned by other people.
 * The run recorded 17 registrations and 33 breach records for strangers; nothing linked to the seed, because nothing
 * was ever looked up on it.
 *
 * Nothing here REFUSES a call. Looking at the shortened handle is allowed (it can be the same person). What it may
 * not do is carry subject authority: `sample` is not `sample.handle`, so a lookup on it gets the same
 * `unproven_linkage` taint a quarantined selector gets (lib/unproven-linkage.ts), and the result carries a hint
 * naming the exact handle so the model looks that up too. Operator sign-off: JD, 2026-11-10 (ruling 2A).
 *
 * SCOPE, on purpose: only a seed that is a username containing a dot, and only a query that is a proper prefix of
 * it ending at a dot (`sample` of `sample.handle`, `first.last` of `first.last.priv`). The separator-stripped
 * spelling (`samplehandle`) is NOT a shortened form: the cluster engine already treats it as the same handle.
 *
 * Kill switch: SEED_HANDLE_GUARD_DISABLED=true, read at call time.
 * Zero imports: this sits under the dispatch wrapper and must not pull anything into a cycle.
 */

export function seedHandleGuardEnabled(): boolean {
  const env = (globalThis as { Deno?: { env?: { get(k: string): string | undefined } } }).Deno?.env;
  return (env?.get("SEED_HANDLE_GUARD_DISABLED") ?? "").trim().toLowerCase() !== "true";
}

const clean = (v: unknown) => String(v ?? "").trim().replace(/^@+/, "").toLowerCase();

/** Is `queried` a proper prefix of the dotted `seedHandle`, cut at a dot? */
export function isShortenedSeedHandle(seedHandle: string, queried: string): boolean {
  const seed = clean(seedHandle);
  const q = clean(queried);
  if (!seed.includes(".") || !q || q === seed) return false;
  return seed.startsWith(`${q}.`);
}

/** Selector types under which a handle is looked up. `value` and `auto` are the untyped breach slots
 *  (`breach_check {value}`, `leakcheck_lookup {type:"auto"}`): a bare value equal to the shortened handle is that handle. */
const HANDLE_LOOKUP_TYPES = new Set(["username", "handle", "social", "value", "auto"]);

export interface ShortenedSeedLookup {
  /** The shortened handle the call was made on, cleaned. */
  queried: string;
  /** Why its linkage is unproven. Becomes `parent_reason` on the unproven-linkage marker. */
  reason: string;
  /** Shown to the model on the tool result. */
  hint: string;
}

/**
 * Decide whether a dispatch is a handle lookup on a shortened form of the seed. `seedHandle` is the run's seed when
 * (and only when) it was typed `username`; pass null/"" for any other seed and this is inert.
 */
export function shortenedSeedLookup(
  seedHandle: string | null | undefined,
  candidateTypes: readonly string[],
  queriedRaw: string,
): ShortenedSeedLookup | null {
  if (!seedHandle || !seedHandleGuardEnabled()) return null;
  if (!candidateTypes.some((t) => HANDLE_LOOKUP_TYPES.has(String(t).toLowerCase()))) return null;
  if (!isShortenedSeedHandle(seedHandle, queriedRaw)) return null;
  const seed = clean(seedHandle);
  const queried = clean(queriedRaw);
  return {
    queried,
    reason:
      `"${queried}" is a shortened form of the case seed handle "${seed}". A different handle is a different ` +
      `account, so accounts and records found under it are not shown to be the subject's`,
    hint:
      `The case seed is the handle "${seed}", dots included. "${queried}" is a shortened form and a different ` +
      `account: what this call returned carries no subject authority. Look up the exact handle "${seed}" as well, ` +
      `and record anything found under "${queried}" as a lead, not as the subject's.`,
  };
}

/**
 * /health self-test. Pure. PRESENCE proves the deployed bundle carries the guard; `switch` reports
 * SEED_HANDLE_GUARD_DISABLED; ok:false means the predicate failed its own probe.
 */
export function seedHandleGuardSelfTest(): { ok: boolean; enabled: boolean; switch: string; detail: string } {
  const sw = "SEED_HANDLE_GUARD_DISABLED";
  if (!seedHandleGuardEnabled()) {
    return { ok: true, enabled: false, switch: `${sw}=true`, detail: "LEGACY: a lookup on a shortened seed handle is not tainted" };
  }
  const wrong: string[] = [];
  const hit = (seed: string | null, types: string[], q: string) => shortenedSeedLookup(seed, types, q) !== null;
  if (!hit("sample.handle", ["username"], "sample")) wrong.push("prefix not caught");
  if (!hit("first.last.priv", ["value"], "First.Last")) wrong.push("two-label prefix not caught");
  if (!hit("sample.handle", ["value", "auto"], "@sample")) wrong.push("untyped breach slot not caught");
  if (hit("sample.handle", ["username"], "sample.handle")) wrong.push("the exact seed was tainted");
  if (hit("sample.handle", ["username"], "samplehandle")) wrong.push("the separator-stripped spelling was tainted");
  if (hit("sample.handle", ["username"], "sam")) wrong.push("a prefix not cut at a dot was tainted");
  if (hit("sample.handle", ["username"], "handle")) wrong.push("a suffix label was tainted");
  if (hit("sample.handle", ["email", "domain"], "sample")) wrong.push("a non-handle lookup was tainted");
  if (hit("samplehandle", ["username"], "sample")) wrong.push("an undotted seed engaged the guard");
  if (hit(null, ["username"], "sample")) wrong.push("a run with no username seed engaged the guard");
  return wrong.length
    ? { ok: false, enabled: true, switch: `${sw}=false`, detail: wrong.join("; ") }
    : {
      ok: true,
      enabled: true,
      switch: `${sw}=false`,
      detail: "a handle lookup on a dot-cut prefix of a dotted seed handle runs, tainted unproven_linkage, with a hint naming the exact handle",
    };
}
