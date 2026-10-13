// lib/user-supplied-status.ts — E2 (option c): pasted is not checked.
//
// A row whose ONLY source is analyst-supplied material ("user_supplied (unicourt.com
// docket)", "user-provided pivot") can still reach confidence 90 and status `verified`:
// the host inside the parenthetical classifies it as `court_record` and the cap engine
// finds no open confirmation gap. Production 2026-10-09, thread 7a2968e1: two docket rows
// at `verified` / 90. Nobody checked them; the analyst only PASTED them.
//
// Rule: such a row keeps its confidence (the analyst's document is high quality) but its
// status can never be `verified` or `confirmed` — those stay analyst-review outcomes.
// It degrades to `observed` with an honest reason_not_confirmed and
// metadata.user_supplied_unreviewed. Write path only; lowers status, never raises
// anything; existing rows untouched. A row that ALSO cites a non-user source is left
// to the normal derivation. Kill switch, read at call time: USER_SUPPLIED_STATUS_CEILING_DISABLED=true.

import type { RecordingStatusResult } from "../recording-source-policy.ts";

const USER_SUPPLIED_TOKEN_RE = /^user[_\s-]?(?:supplied|provided)(?:\s*\(|$|\s)/i;
export const USER_SUPPLIED_REASON = "supplied by the analyst; not independently checked";

function readEnvSafe(k: string): string | undefined {
  try {
    return (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(k);
  } catch {
    return undefined;
  }
}

export function userSuppliedStatusCeilingDisabled(env: (k: string) => string | undefined = readEnvSafe): boolean {
  return (env("USER_SUPPLIED_STATUS_CEILING_DISABLED") ?? "").trim().toLowerCase() === "true";
}

function splitTopLevel(label: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of label) {
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === "+" || ch === "|" || ch === ";" || ch === ",")) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

export function isUserSuppliedToken(token: string): boolean {
  return USER_SUPPLIED_TOKEN_RE.test(token.trim());
}

/** True when EVERY source named (surface label + metadata.sources) is analyst-supplied. */
export function isUserSuppliedOnly(
  source: string | null | undefined,
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  const tokens: string[] = [];
  if (typeof source === "string" && source) tokens.push(...splitTopLevel(source));
  const extra = metadata?.sources;
  if (Array.isArray(extra)) for (const s of extra) if (typeof s === "string" && s) tokens.push(...splitTopLevel(s));
  return tokens.length > 0 && tokens.every(isUserSuppliedToken);
}

export interface UserSuppliedGuarded extends RecordingStatusResult {
  userSuppliedUnreviewed: boolean;
}

export function guardUserSuppliedStatus(
  res: RecordingStatusResult,
  source: string | null | undefined,
  metadata: Record<string, unknown> | null | undefined,
): UserSuppliedGuarded {
  const untouched: UserSuppliedGuarded = { ...res, userSuppliedUnreviewed: false };
  if (userSuppliedStatusCeilingDisabled()) return untouched;
  if (!isUserSuppliedOnly(source, metadata)) return untouched;
  if (res.status !== "verified" && res.status !== "confirmed") return { ...untouched, userSuppliedUnreviewed: true };
  return {
    status: "observed",
    reasonNotConfirmed: res.reasonNotConfirmed ?? USER_SUPPLIED_REASON,
    userSuppliedUnreviewed: true,
  };
}

/** /health self-test; PRESENCE of the key proves the build. */
export function userSuppliedStatusSelfTest(): { ok: boolean; detail: string } {
  if (userSuppliedStatusCeilingDisabled()) return { ok: true, detail: "LEGACY via USER_SUPPLIED_STATUS_CEILING_DISABLED" };
  const v: RecordingStatusResult = { status: "verified", reasonNotConfirmed: null };
  const pasted = guardUserSuppliedStatus(v, "user_supplied (unicourt.com docket)", null);
  const mixed = guardUserSuppliedStatus(v, "user_supplied (unicourt.com docket) + exa_search (nytimes.com/x)", null);
  const plain = guardUserSuppliedStatus(v, "exa_search (nytimes.com/x)", null);
  const ok = pasted.status === "observed" && pasted.userSuppliedUnreviewed && mixed.status === "verified" && plain.status === "verified";
  return ok
    ? { ok: true, detail: "user-supplied-only rows cannot be verified/confirmed (status -> observed, confidence kept)" }
    : { ok: false, detail: "user-supplied status ceiling misbehaving" };
}
