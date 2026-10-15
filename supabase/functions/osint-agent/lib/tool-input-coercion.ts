// lib/tool-input-coercion.ts — a near-miss tool input is coerced INSIDE the input schema, before the AI SDK rejects it.
//
// Why. The AI SDK validates a tool call against its zod `inputSchema` BEFORE `execute` runs. A call that is right in
// substance but slightly wrong in form is rejected, the step is burnt, and the analyst sees a failed tool. Measured on
// production case 035a1a4e (an ADDRESS seed, orchestrator GLM-5.2), tool_usage_log / tool_input_failure_log showed:
//   • gemini_deep_dork `{query}`             → seed + kind invalid_type (no `seed`, no `kind`)
//   • gemini_deep_dork `{seed, kind, focus}` → kind invalid_enum_value (its enum had no "address")
//   • google_dorks `{seed, kind}`            → kind invalid_enum_value (an alias spelling, e.g. "location")
//   • jina_reader_scrape `maxChars:"15000"`  → invalid_type expected number
//   • oathnet_lookup `{type, value}`         → type invalid_enum_value (an alias spelling)
//   • and, from the previous case's audit: minimax_correlate `seed` as a number; rapidapi email with whitespace.
//
// What it does (each rule pinned by input_coercion_test.ts):
//   • kind/type ALIASES — lowercased, trimmed, `-`/space → `_`, then matched against the field's OWN enum. A spelling
//     outside the enum is looked up in INPUT_KIND_ALIASES (below) and then in the shared KIND_ALIASES table
//     (lib/kind-alias.ts); the first candidate that IS in the enum wins. If none is, the input is left as sent.
//   • `query` → `seed` for the dork tools, only when `seed` is absent;
//   • a missing `kind` is INFERRED from the selector's own shape where the tool declares it (google_dorks, and
//     serus_darkweb_scan's identifierType) — email, IP, domain, crypto, a 10+ digit phone; a bare token reads as a
//     username only for a free tool. Anything ambiguous stays missing and is rejected as before (inferSelectorKind);
//   • field aliases: serus_darkweb_scan `identifier`/`value` → `identifierValue`, `type` → `identifierType`;
//   • a missing `kind` takes a per-tool DEFAULT only where the tool declares one (gemini_deep_dork → "other", which its
//     enum already had as the catch-all);
//   • a numeric STRING ("15000") → number, only on fields the schema types as a number;
//   • a number → string, only on string selector fields (a phone sent as 6175550100);
//   • leading/trailing whitespace trimmed on selector fields (email/value/seed/url).
//
// What it will NOT do:
//   • widen anything. The coerced value is re-validated against the UNCHANGED inner schema; if it still fails, the RAW
//     input is returned, so the SDK rejects it exactly as before (same issues, same message);
//   • rewrite a value's substance — only its spelling/type/whitespace;
//   • extend lib/kind-alias.ts. That table keys DEDUP and REJECTION (`checkpointKey`, `artifactDedupKey`,
//     `normalizeArtifactKey`, `rejectedTypeAliases`); adding `location → address` there would re-key persisted rows. The
//     input-only aliases live here, and kind-alias.ts is only READ.
//
// Value-free logging: one `tool_input_coerced` console event per coerced field, carrying tool, field path and coercion
// kind — never the value. Durable trail: the records are parked for the cache wrapper (cache.ts), which matches them to
// the execute() input and stamps `input_coercion` into the tool_usage_log row's `input_json.runtime`.
//
// KILL SWITCH, read at call time: INPUT_COERCION_DISABLED=true restores today's strict behaviour (including the
// "address" enum value added to gemini_deep_dork / dork_harvest, which is refused again under the switch).
// /health proof keys: checks.input_coercion, checks.input_kind_inference (inference + field aliases).

import { KIND_ALIASES } from "./kind-alias.ts";

export function inputCoercionDisabled(): boolean {
  return (Deno.env.get("INPUT_COERCION_DISABLED") ?? "").trim().toLowerCase() === "true";
}

/**
 * Input-only spelling → candidate enum values, in preference order. The first candidate present in the TARGET field's
 * enum is used; a spelling whose candidates are all absent from that enum is not coerced (and is rejected as before).
 * Deliberately separate from KIND_ALIASES — see the header.
 */
export const INPUT_KIND_ALIASES: Readonly<Record<string, readonly string[]>> = {
  // a postal address
  location: ["address"],
  street_address: ["address"],
  street: ["address"],
  postal_address: ["address"],
  physical_address: ["address"],
  mailing_address: ["address"],
  home_address: ["address"],
  residential_address: ["address"],
  addr: ["address"],
  // a person's name
  full_name: ["name", "person"],
  fullname: ["name", "person"],
  person_name: ["name", "person"],
  real_name: ["name", "person"],
  person: ["name", "person"],
  // phone
  phone_number: ["phone"],
  phonenumber: ["phone"],
  telephone: ["phone"],
  tel: ["phone"],
  mobile: ["phone"],
  cell: ["phone"],
  msisdn: ["phone"],
  // username / handle
  user: ["username"],
  user_name: ["username"],
  handle: ["username"],
  screen_name: ["username"],
  screenname: ["username"],
  nickname: ["username"],
  // email
  email_address: ["email"],
  e_mail: ["email"],
  mail: ["email"],
  // domain / host
  domain_name: ["domain"],
  hostname: ["domain"],
  host: ["domain"],
  fqdn: ["domain"],
  // ip (`origin` is Serus's name for an IP-or-hostname target; it is only reached on an enum that has no `ip`)
  ip: ["origin"],
  ip_address: ["ip", "origin"],
  ipv4: ["ip", "origin"],
  ipv6: ["ip", "origin"],
  ip_addr: ["ip", "origin"],
  // wallet
  wallet: ["crypto_wallet", "wallet"],
  crypto: ["crypto_wallet", "wallet"],
  wallet_address: ["crypto_wallet", "wallet"],
  crypto_address: ["crypto_wallet", "wallet"],
  // url
  link: ["url"],
  uri: ["url"],
};

export type CoercionKind =
  | "kind_normalized" // case / whitespace / separator only ("Email" → "email")
  | "kind_alias" // a different spelling of a supported kind ("location" → "address")
  | "seed_from_query" // `query` used as the missing `seed`
  | "default_kind" // a missing kind took the tool's declared default
  | "kind_inferred" // a missing kind was read off the SHAPE of the selector it describes (an email, an IP, …)
  | "field_alias" // a differently named field carried the value ("identifier" → "identifierValue")
  | "numeric_string" // "15000" → 15000
  | "number_to_string" // 6175550100 → "6175550100"
  | "trimmed"; // surrounding whitespace removed

export type CoercionRecord = { field: string; coercion: CoercionKind };

export interface InputCoercionSpec {
  /** field → the field's own enum values (the alias target must be one of these). */
  enumFields?: Readonly<Record<string, readonly string[]>>;
  /**
   * field → infer a MISSING enum field from the SHAPE of another field's value. `infer` returns an enum value or null;
   * null (an ambiguous or unrecognised shape) leaves the field missing, so the call is rejected exactly as before.
   * Applied before `defaults`. Structural only — never reads prose or intent.
   */
  infer?: Readonly<Record<string, { from: string; infer: (value: string) => string | null }>>;
  /** field → default enum value used ONLY when the field is absent. */
  defaults?: Readonly<Record<string, string>>;
  /** Fill a missing `to` field from the first present `from` field (then drop `from`). */
  renames?: ReadonlyArray<{ to: string; from: string; coercion: CoercionKind }>;
  /** Fields the schema types as a number: an exact numeric string becomes a number. */
  numberFields?: readonly string[];
  /** Fields the schema types as a string: a finite number becomes its decimal string. */
  stringFields?: readonly string[];
  /** String fields whose surrounding whitespace is trimmed. */
  trimFields?: readonly string[];
}

const NUMERIC_STRING = /^\s*-?\d+(?:\.\d+)?\s*$/;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isPlain(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

/** The enum value a kind spelling resolves to for THIS field, or null when there is none. */
export function resolveKindSpelling(raw: unknown, allowed: readonly string[]): { value: string; coercion: CoercionKind } | null {
  if (typeof raw !== "string") return null;
  if (allowed.includes(raw)) return null; // already valid — nothing to do
  const norm = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!norm || UNSAFE_KEYS.has(norm)) return null;
  if (allowed.includes(norm)) return { value: norm, coercion: "kind_normalized" };
  const candidates = [
    ...(Object.prototype.hasOwnProperty.call(INPUT_KIND_ALIASES, norm) ? INPUT_KIND_ALIASES[norm] : []),
    ...(Object.prototype.hasOwnProperty.call(KIND_ALIASES, norm) ? [KIND_ALIASES[norm]] : []),
  ];
  for (const c of candidates) if (allowed.includes(c)) return { value: c, coercion: "kind_alias" };
  return null;
}

/** Pure: compute the coerced input and what was done. Never throws; returns the input unchanged when nothing applies. */
export function coerceToolInput(raw: unknown, spec: InputCoercionSpec): { value: unknown; records: CoercionRecord[] } {
  if (!isPlain(raw)) return { value: raw, records: [] };
  const out: Record<string, unknown> = { ...raw };
  const records: CoercionRecord[] = [];

  for (const r of spec.renames ?? []) {
    if (out[r.to] !== undefined) continue;
    const v = out[r.from];
    if (typeof v !== "string" && typeof v !== "number") continue;
    out[r.to] = v;
    delete out[r.from];
    records.push({ field: r.to, coercion: r.coercion });
  }
  for (const f of spec.stringFields ?? []) {
    const v = out[f];
    if (typeof v === "number" && Number.isFinite(v)) {
      out[f] = String(v);
      records.push({ field: f, coercion: "number_to_string" });
    }
  }
  for (const f of spec.trimFields ?? []) {
    const v = out[f];
    if (typeof v === "string" && v !== v.trim() && v.trim()) {
      out[f] = v.trim();
      records.push({ field: f, coercion: "trimmed" });
    }
  }
  for (const f of spec.numberFields ?? []) {
    const v = out[f];
    if (typeof v === "string" && NUMERIC_STRING.test(v)) {
      const n = Number(v.trim());
      if (Number.isFinite(n)) {
        out[f] = n;
        records.push({ field: f, coercion: "numeric_string" });
      }
    }
  }
  for (const [f, allowed] of Object.entries(spec.enumFields ?? {})) {
    const inf = spec.infer && Object.prototype.hasOwnProperty.call(spec.infer, f) ? spec.infer[f] : null;
    if (out[f] === undefined && inf && typeof out[inf.from] === "string") {
      let k: string | null = null;
      try { k = inf.infer(out[inf.from] as string); } catch { k = null; }
      if (k && allowed.includes(k)) {
        out[f] = k;
        records.push({ field: f, coercion: "kind_inferred" });
        continue;
      }
    }
    if (out[f] === undefined && spec.defaults && Object.prototype.hasOwnProperty.call(spec.defaults, f)) {
      out[f] = spec.defaults[f];
      records.push({ field: f, coercion: "default_kind" });
      continue;
    }
    const hit = resolveKindSpelling(out[f], allowed);
    if (hit) {
      out[f] = hit.value;
      records.push({ field: f, coercion: hit.coercion });
    }
  }
  return records.length ? { value: out, records } : { value: raw, records: [] };
}

// ── durable trail: parked records the cache wrapper claims at execute() ────────────────────────────────────────────

type Parked = { tool: string; at: number; fields: Array<CoercionRecord & { result: unknown }> };
const PARKED: Parked[] = [];
const PARK_TTL_MS = 120_000;
const PARK_MAX = 200;

function prune(now: number): void {
  while (PARKED.length && (now - PARKED[0].at > PARK_TTL_MS || PARKED.length > PARK_MAX)) PARKED.shift();
}

/**
 * Claim the coercion records for a call that is about to execute. A parked entry matches when it is for the same tool
 * and every coerced field's resulting value is strictly equal to the executing input's field — so a record is never
 * attributed to a call that did not carry the coerced value. Oldest first; consumed once. Never throws.
 */
export function takeInputCoercions(tool: string, input: unknown): CoercionRecord[] | null {
  try {
    const now = Date.now();
    prune(now);
    if (!isPlain(input)) return null;
    const i = PARKED.findIndex((p) => p.tool === tool && p.fields.every((f) => input[f.field] === f.result));
    if (i < 0) return null;
    const [hit] = PARKED.splice(i, 1);
    return hit.fields.map(({ field, coercion }) => ({ field, coercion }));
  } catch {
    return null;
  }
}

/** Test-only: drop every parked record. */
export function _resetParkedCoercions(): void {
  PARKED.length = 0;
}

/**
 * The z.preprocess body. `validates` runs the UNCHANGED inner schema on the coerced value; only a coercion that turns
 * the call valid is applied, logged and parked — otherwise the raw input goes through and is rejected as before.
 */
export function applyInputCoercion(
  tool: string,
  raw: unknown,
  spec: InputCoercionSpec,
  validates: (v: unknown) => boolean,
): unknown {
  try {
    if (inputCoercionDisabled()) return raw;
    const { value, records } = coerceToolInput(raw, spec);
    if (!records.length) return raw;
    if (!validates(value)) return raw;
    for (const r of records) {
      console.log(JSON.stringify({ event: "tool_input_coerced", tool, field: r.field, coercion: r.coercion }));
    }
    const now = Date.now();
    prune(now);
    const v = value as Record<string, unknown>;
    PARKED.push({ tool, at: now, fields: records.map((r) => ({ ...r, result: v[r.field] })) });
    return value;
  } catch {
    return raw; // a coercion fault must never break the step; the SDK validates the raw input as before
  }
}

/**
 * Structural kind inference for a selector value, used by `spec.infer`. Returns only shapes that cannot be mistaken
 * for anything else; a phone needs at least 10 digits so a date ("2026-10-15") is never read as one. A single bare
 * token reads as a username only when `allowUsername` is set (free tools only — a paid scan never runs on a guess).
 */
export function inferSelectorKind(
  value: string,
  detect: (v: string) => { kind: string } | null,
  opts: { allowUsername?: boolean } = {},
): "email" | "phone" | "ip" | "domain" | "username" | "crypto" | null {
  const v = (value ?? "").trim();
  if (!v || v.length > 256) return null;
  const d = detect(v);
  if (!d) return null;
  switch (d.kind) {
    case "email": case "ip": case "domain": case "crypto": return d.kind;
    case "phone": return v.replace(/\D/g, "").length >= 10 ? "phone" : null;
    case "username": return opts.allowUsername ? "username" : null;
    default: return null;
  }
}

/** /health → checks.input_kind_inference. Pure; presence proves this build. */
export function inputKindInferenceSelfTest(detect: (v: string) => { kind: string } | null): { ok: boolean; switch: string; detail: string } {
  const sw = "INPUT_COERCION_DISABLED";
  if (inputCoercionDisabled()) return { ok: true, switch: `${sw}=true`, detail: "LEGACY via INPUT_COERCION_DISABLED (strict schemas)" };
  const wrong: string[] = [];
  const spec: InputCoercionSpec = {
    enumFields: { identifierType: ["email", "phone", "domain", "origin"] },
    renames: [{ to: "identifierValue", from: "identifier", coercion: "field_alias" }],
    infer: { identifierType: { from: "identifierValue", infer: (v) => {
      const k = inferSelectorKind(v, detect);
      return k === "ip" ? "origin" : k;
    } } },
  };
  const a = coerceToolInput({ identifier: "a@example.com" }, spec).value as Record<string, unknown>;
  if (a.identifierValue !== "a@example.com" || a.identifierType !== "email") wrong.push("field alias + inference not applied");
  const b = coerceToolInput({ identifierValue: "2026-10-15" }, spec).value as Record<string, unknown>;
  if (b.identifierType !== undefined) wrong.push("a date was inferred as a phone");
  const c = coerceToolInput({ identifierValue: "someone" }, spec).value as Record<string, unknown>;
  if (c.identifierType !== undefined) wrong.push("a bare token was guessed for a paid scan");
  const ip = coerceToolInput({ identifierValue: "198.51.100.7", identifierType: "ip" }, spec).value as Record<string, unknown>;
  if (ip.identifierType !== "origin") wrong.push("ip did not map to origin");
  return wrong.length
    ? { ok: false, switch: `${sw}=false`, detail: wrong.join("; ") }
    : {
      ok: true,
      switch: `${sw}=false`,
      detail: "a missing kind is inferred only from an unambiguous selector shape (email, IP, domain, 10+ digit phone; " +
        "bare-token username only for free tools); serus_darkweb_scan accepts identifier/value as identifierValue",
    };
}

/** /health → checks.input_coercion. Presence proves this build; ok:false means a rule failed its own probe. */
export function inputCoercionSelfTest(): { ok: boolean; switch: string; detail: string } {
  const sw = "INPUT_COERCION_DISABLED";
  if (inputCoercionDisabled()) return { ok: true, switch: `${sw}=true`, detail: "LEGACY via INPUT_COERCION_DISABLED (strict schemas)" };
  const wrong: string[] = [];
  const kinds = ["email", "name", "address", "other"] as const;
  const a = coerceToolInput({ query: "x", kind: "Location" }, {
    enumFields: { kind: kinds },
    renames: [{ to: "seed", from: "query", coercion: "seed_from_query" }],
  });
  if ((a.value as Record<string, unknown>).seed !== "x" || (a.value as Record<string, unknown>).kind !== "address") wrong.push("alias/rename not applied");
  const b = coerceToolInput({ kind: "planet" }, { enumFields: { kind: kinds } });
  if (b.records.length) wrong.push("an unknown kind was coerced");
  const c = coerceToolInput({ maxChars: "15000", n: "15k" }, { numberFields: ["maxChars", "n"] });
  if ((c.value as Record<string, unknown>).maxChars !== 15000 || (c.value as Record<string, unknown>).n !== "15k") wrong.push("numeric-string rule wrong");
  return wrong.length
    ? { ok: false, switch: `${sw}=false`, detail: wrong.join("; ") }
    : {
      ok: true,
      switch: `${sw}=false`,
      detail: "near-miss tool inputs (kind aliases, query→seed, numeric strings, number→string, whitespace) are coerced " +
        "only when the result validates; anything else is rejected as before",
    };
}
