/**
 * dispatch-selector.ts — selector candidates for the two DISPATCH checks only
 * (analyst rejection and quarantine taint), for tools whose selector lives in a
 * field the central detector does not read.
 *
 * `detectSelectorType` / `detectSelectorValue` (cache.ts) recognise `value`,
 * `email`, `username`, … — not Serus's `identifierValue` / `identifierType`, the
 * Indicia tools' `query`, or CordCat's `discord_id`. For those calls the selector
 * came out EMPTY, and both dispatch checks fail open on an empty selector: an
 * analyst-rejected email still reached a paid Serus or Indicia call, and a
 * quarantined selector went out without the `unproven_linkage` taint.
 *
 * WHY A SEPARATE EXTRACTOR, NOT NEW KEYS IN THE CENTRAL DETECTOR. The central
 * detector also feeds the circuit key, the cache's `selector_type` /
 * `selector_normalized` and, through `SELECTOR_INPUT_KEYS`, the `params_hash`.
 * Teaching it these fields would re-key every cached Serus / Indicia / CordCat
 * row. These candidates are consulted only when the central selector is EMPTY
 * and only by the rejection and quarantine checks, so no cache or circuit
 * identity moves.
 *
 * EXACT SELECTORS ONLY. A free-text `query` ("x@y.z" leak OR breach) is not a
 * selector and yields nothing; only a query that IS an email / phone / domain /
 * IP is matched. A Serus `password` search is never a selector: a password is
 * not an identity to match against reviews, and must not reach a log line.
 *
 * Kill switch DISPATCH_SELECTOR_ALIASES_DISABLED=true (read at call time)
 * restores the previous behaviour with no deploy.
 */

export interface DispatchSelectorCandidate {
  /** Selector type in the dispatch keyspace (`email`, `phone`, `username`, …). */
  type: string;
  /** The raw value; the caller normalizes it per type. */
  value: string;
}

const SWITCH = "DISPATCH_SELECTOR_ALIASES_DISABLED";

function readEnv(k: string): string | undefined {
  try {
    const env = (globalThis as { Deno?: { env?: { get?(key: string): string | undefined } } }).Deno?.env;
    return env?.get ? env.get(k) : undefined;
  } catch {
    return undefined;
  }
}

export function dispatchSelectorAliasesDisabled(env: (k: string) => string | undefined = readEnv): boolean {
  return (env(SWITCH) ?? "").trim().toLowerCase() === "true";
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;
const IPV4_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const DOMAIN_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;
const PHONE_CHARS_RE = /^\+?[\d\s().-]+$/;

/** The selector types a bare value can be, by shape alone. Empty when it is not one exact selector. */
function shapeTypes(value: string): string[] {
  const v = value.trim();
  if (!v) return [];
  if (EMAIL_RE.test(v)) return ["email"];
  if (IPV4_RE.test(v)) return ["ip"];
  if (DOMAIN_RE.test(v)) return ["domain"];
  if (PHONE_CHARS_RE.test(v) && (v.match(/\d/g) ?? []).length >= 7) return ["phone"];
  return [];
}

/** Serus `identifierType` → dispatch types. `password` maps to nothing, deliberately. */
function serusTypes(identifierType: unknown, value: string): string[] {
  const t = typeof identifierType === "string" ? identifierType.trim().toLowerCase() : "";
  if (t === "email" || t === "phone" || t === "username" || t === "domain") return [t];
  if (t === "password") return [];
  // A keyword search names a person or a handle; `origin` is a host or address.
  if (t === "keyword") return ["name", "username", ...shapeTypes(value)];
  if (t === "origin") return shapeTypes(value).length ? shapeTypes(value) : ["url"];
  return shapeTypes(value);
}

/**
 * Extra (type, value) candidates for the dispatch checks. Returns `[]` unless one
 * of the recognised alternate selector fields is present, or when the kill switch
 * is on. Callers must use these ONLY when the central selector is empty.
 */
export function dispatchSelectorCandidates(
  input: unknown,
  env: (k: string) => string | undefined = readEnv,
): DispatchSelectorCandidate[] {
  if (dispatchSelectorAliasesDisabled(env)) return [];
  const inp = (input ?? {}) as Record<string, unknown>;
  const out: DispatchSelectorCandidate[] = [];
  const add = (types: string[], value: string) => {
    for (const type of types) {
      if (!out.some((c) => c.type === type && c.value === value)) out.push({ type, value });
    }
  };
  if (typeof inp.identifierValue === "string" && inp.identifierValue.trim()) {
    add(serusTypes(inp.identifierType, inp.identifierValue), inp.identifierValue);
  }
  for (const key of ["query", "q"] as const) {
    const v = inp[key];
    if (typeof v === "string" && v.trim()) add(shapeTypes(v), v);
  }
  if (typeof inp.discord_id === "string" && /^\d{17,20}$/.test(inp.discord_id.trim())) {
    add(["account_id"], inp.discord_id.trim());
  }
  return out;
}

/** /health probe: pure, no I/O. PRESENCE proves the deployed bundle. */
export function dispatchSelectorAliasesSelfTest(
  env: (k: string) => string | undefined = readEnv,
): { ok: boolean; switch: string; detail: string } {
  if (dispatchSelectorAliasesDisabled(env)) {
    return { ok: true, switch: `${SWITCH}=true`, detail: `LEGACY via ${SWITCH}: Serus/Indicia/CordCat selectors are invisible to the dispatch checks` };
  }
  const wrong: string[] = [];
  const types = (input: unknown) => dispatchSelectorCandidates(input, env).map((c) => c.type).join(",");
  if (types({ identifierValue: "a@b.co", identifierType: "email" }) !== "email") wrong.push("serus email");
  if (types({ identifierValue: "secret", identifierType: "password" }) !== "") wrong.push("serus password became a selector");
  if (types({ query: "+1 (555) 010-0000" }) !== "phone") wrong.push("query phone");
  if (types({ query: "\"a@b.co\" leak OR breach" }) !== "") wrong.push("free-text query became a selector");
  if (types({ discord_id: "123456789012345678" }) !== "account_id") wrong.push("discord_id");
  return wrong.length
    ? { ok: false, switch: `${SWITCH}=false`, detail: wrong.join("; ") }
    : {
      ok: true,
      switch: `${SWITCH}=false`,
      detail: "rejection and quarantine checks read Serus identifierValue/identifierType, exact-selector query/q and discord_id when the cache selector is empty; cache and circuit keys unchanged",
    };
}
