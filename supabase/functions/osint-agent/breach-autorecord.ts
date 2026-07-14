/**
 * breach-autorecord.ts — server-side extraction of concrete unmasked breach values
 * from breach tool outputs, so `artifacts.metadata.exposed_values` is populated even
 * when the orchestrator LLM never calls `record_artifacts` (the observed DeepSeek
 * gap). Called from index.ts:onStepFinish.
 *
 * PURE — no network, no supabase, no fetch. Given (toolName, output, seedSelector)
 * returns a flat list of concrete values. The caller groups them per (selector,
 * breach), builds `breach_exposure` rows via buildAutoRecordedRow, scrubs, and
 * inserts. Kept pure so unit tests exercise every shape without a runtime.
 *
 * Scope for this session: rapidapi_breach_search, serus_darkweb_scan,
 * leakcheck_lookup, oathnet_stealer_search. oathnet_lookup's concrete_hits
 * flattening (mirror commit 87031da) was intentionally not cherry-picked into the
 * deployed reveal fix, so its raw shape is not yet flattened here.
 */

export interface BreachValueRecord {
  /** Account / subject the value is tied to (email, username, phone, ...). */
  selector: string | null;
  /** Breach source name ("MySpace", "Evite", "stealer:google.com", ...). */
  breach: string | null;
  /** Normalized field kind ("password", "full_name", "dob", "ip", ...). */
  field: string;
  /** The concrete captured value. */
  value: string;
  /** Passwords/tokens/DOB/SSN — surfaces sensitive + caps confidence harder. */
  sensitive: boolean;
}

export interface BreachExposureGroup {
  selector: string | null;
  breach: string | null;
  sensitive: boolean;
  exposed_values: Array<{ field: string; value: string; sensitive: boolean }>;
}

// Fields whose values are secret material — a password/token/DOB row must be
// flagged so evidence caps + UI treat it as sensitive.
const SENSITIVE_FIELDS = new Set([
  "password", "pass", "pwd", "passwd", "hash", "token", "cookie", "cookies",
  "secret", "auth", "authorization", "session", "otp", "totp", "cvv", "cc",
  "credit_card", "dob", "date_of_birth", "birthday", "ssn", "sin", "gov_id",
  "national_id", "private_key", "seed_phrase", "mnemonic",
]);

// Canonical field name → alias table. Providers spell the same field a dozen
// ways (`full_name`/`fullname`/`name`, `dob`/`date_of_birth`/`birthday`,
// `ip`/`ip_address`, `zip`/`postcode`); collapse to one canonical name so
// dedup + UI grouping work.
const REVEAL_FIELD_ALIASES: Record<string, string> = {
  full_name: "full_name",
  fullname: "full_name",
  first_name: "first_name",
  firstname: "first_name",
  last_name: "last_name",
  lastname: "last_name",
  name: "name",
  dob: "dob",
  date_of_birth: "dob",
  birthday: "dob",
  password: "password",
  passwd: "password",
  pwd: "password",
  hash: "hash",
  ip: "ip",
  ip_address: "ip",
  phone: "phone",
  phone_number: "phone",
  address: "address",
  street: "address",
  city: "city",
  state: "state",
  region: "state",
  country: "country",
  zip: "zip",
  postcode: "zip",
  username: "username",
  handle: "username",
  email: "email",
  cookie: "cookie",
  cookies: "cookie",
  token: "token",
};

function normField(k: string): string | null {
  const lk = String(k ?? "").trim().toLowerCase();
  return REVEAL_FIELD_ALIASES[lk] ?? null;
}

function isSensitive(field: string): boolean {
  return SENSITIVE_FIELDS.has(field);
}

// A serus/oathnet row often carries a value like `••••••` when a specific
// breach is still masked even under reveal. Never persist those — they add
// no evidence but would pollute the exposure list.
const MASKED_RE = /^[•*x·⋅_]{3,}$/;

function pushValue(
  out: BreachValueRecord[],
  selector: string | null,
  breach: string | null,
  field: string | null,
  raw: unknown,
): void {
  if (!field) return;
  if (raw == null) return;
  const s = String(raw).trim();
  if (!s) return;
  if (MASKED_RE.test(s)) return;
  out.push({ selector, breach, field, value: s, sensitive: isSensitive(field) });
}

// Walk a breach-row object for every known reveal field and push each as a
// concrete value. Non-known keys are ignored (kept the walk narrow so
// arbitrary junk from a provider never turns into a fake artifact).
function walkKnownFields(
  obj: Record<string, unknown>,
  selector: string | null,
  breach: string | null,
  out: BreachValueRecord[],
): void {
  for (const [k, v] of Object.entries(obj)) {
    const field = normField(k);
    if (!field) continue;
    if (Array.isArray(v)) {
      for (const item of v.slice(0, 20)) pushValue(out, selector, breach, field, item);
    } else if (typeof v === "string" || typeof v === "number") {
      pushValue(out, selector, breach, field, v);
    }
  }
}

/**
 * Extract every concrete unmasked breach value present in one tool result.
 * `seedSelector` is the seed the tool was called with (email/username/phone);
 * providers rarely echo it (serus does not), so callers pass it in from the
 * paired tool-call input.
 */
export function extractBreachConcreteValues(
  toolName: string,
  output: unknown,
  seedSelector: string | null = null,
): BreachValueRecord[] {
  const out: BreachValueRecord[] = [];
  if (!output || typeof output !== "object") return out;
  const o = output as Record<string, unknown>;

  switch (toolName) {
    case "rapidapi_breach_search": {
      // rapidapi_breach_search already flattens `concrete_values` at the top
      // of `data`. Trust it verbatim — this is the shape the tool guarantees.
      const data = (o.data ?? {}) as Record<string, unknown>;
      const selector = (typeof data.email === "string" ? data.email : null) ?? seedSelector;
      const cv = Array.isArray(data.concrete_values) ? data.concrete_values : [];
      for (const v of cv) {
        const r = v as { breach?: unknown; field?: unknown; value?: unknown; sensitive?: unknown };
        const rawField = String(r.field ?? "").trim();
        const field = normField(rawField) ?? rawField.toLowerCase();
        if (!field) continue;
        if (r.value == null) continue;
        const s = String(r.value).trim();
        if (!s || MASKED_RE.test(s)) continue;
        out.push({
          selector,
          breach: typeof r.breach === "string" ? r.breach : null,
          field,
          value: s,
          sensitive: r.sensitive === true || isSensitive(field),
        });
      }
      return out;
    }

    case "serus_darkweb_scan": {
      // Serus terminal poll response spreads through shapeTerminalResult, so
      // `output.breaches[]` is at the top level. Each row carries the reveal
      // fields (password / full_name / dob / ...) inline when reveal=true and
      // the key has darkweb:reveal scope. `output.extractedData` carries an
      // already-flattened set (emails/usernames/phones/names/cryptoAddresses)
      // — walk both.
      const selector = seedSelector;
      const breaches = Array.isArray(o.breaches) ? o.breaches : [];
      for (const b of breaches) {
        const br = (b ?? {}) as Record<string, unknown>;
        // A row that's still masked under reveal contributes no concrete value.
        if (br.isMasked === true) continue;
        const auth = (br.breachAuthority ?? {}) as { name?: unknown };
        const breachName = typeof auth.name === "string" ? auth.name : null;
        walkKnownFields(br, selector, breachName, out);
      }
      const ed = (o.extractedData ?? {}) as Record<string, unknown>;
      const flatten = (field: string, arr: unknown) => {
        if (!Array.isArray(arr)) return;
        for (const v of arr.slice(0, 30)) pushValue(out, selector, null, field, v);
      };
      flatten("email", ed.emails);
      flatten("username", ed.usernames);
      flatten("phone", ed.phones);
      flatten("name", ed.names);
      flatten("crypto_wallet", ed.cryptoAddresses);
      return out;
    }

    case "leakcheck_lookup": {
      // LeakCheck v2 tool output flattens the response to sources + a full copy
      // of `raw`. The per-row values (password, full_name, dob, ...) only exist
      // on `raw.result[]` — the tool's top-level shape kept just the source
      // names, so the extractor has to reach into `raw.result[]` to recover the
      // real values.
      const data = (o.data ?? {}) as Record<string, unknown>;
      const raw = (data.raw ?? {}) as Record<string, unknown>;
      const rows = Array.isArray(raw.result) ? raw.result : [];
      const selector = seedSelector;
      for (const row of rows) {
        const r = (row ?? {}) as Record<string, unknown>;
        const src = (r.source ?? {}) as { name?: unknown };
        const breachName = typeof src.name === "string" ? src.name : null;
        walkKnownFields(r, selector, breachName, out);
      }
      return out;
    }

    case "oathnet_stealer_search": {
      // trimStealerItems keeps raw secret-keyed fields (password/cookies/tokens)
      // on each item when REVEAL_BREACH_DATA is on. Pivot the row into a
      // synthetic breach name derived from the captured host domain (or the
      // log_id when the domain array is empty).
      const selector = seedSelector;
      const items = Array.isArray(o.items) ? o.items : [];
      for (const it of items) {
        const item = (it ?? {}) as Record<string, unknown>;
        const domainFirst = Array.isArray(item.domain) && item.domain.length
          ? String(item.domain[0] ?? "")
          : (typeof item.domain === "string" ? item.domain : "");
        const logId = item.log_id != null ? String(item.log_id) : null;
        const breachName = domainFirst
          ? `stealer:${domainFirst}`
          : (logId ? `stealer:${logId}` : "stealer");
        walkKnownFields(item, selector, breachName, out);
      }
      return out;
    }

    default:
      return out;
  }
}

/**
 * Group extracted records per (selector, breach) — the shape the UI's
 * Evidence tab expects: ONE `breach_exposure` artifact per hit, with every
 * concrete value hanging off `metadata.exposed_values`.
 */
export function groupBreachRecordsForArtifacts(
  records: BreachValueRecord[],
): BreachExposureGroup[] {
  const map = new Map<string, BreachExposureGroup & { seen: Set<string> }>();
  for (const r of records) {
    const key = `${(r.selector ?? "").toLowerCase()} ${(r.breach ?? "").toLowerCase()}`;
    const dedup = `${r.field} ${r.value.toLowerCase()}`;
    let g = map.get(key);
    if (!g) {
      g = {
        selector: r.selector,
        breach: r.breach,
        sensitive: false,
        exposed_values: [],
        seen: new Set<string>(),
      };
      map.set(key, g);
    }
    if (g.seen.has(dedup)) continue;
    g.seen.add(dedup);
    g.exposed_values.push({ field: r.field, value: r.value, sensitive: r.sensitive });
    if (r.sensitive) g.sensitive = true;
  }
  return [...map.values()].map(({ seen: _seen, ...rest }) => rest);
}

/** A stable per-group hash used to dedupe artifacts across steps of a run. */
export function groupContentKey(g: BreachExposureGroup): string {
  const values = g.exposed_values
    .map((v) => `${v.field}=${v.value.toLowerCase()}`)
    .sort()
    .join("|");
  return `${(g.selector ?? "").toLowerCase()} ${(g.breach ?? "").toLowerCase()} ${values}`;
}

/**
 * Infer the seed selector from a tool call's input arguments. Only handles
 * the breach tools the extractor supports — everything else returns null so
 * the extractor uses whatever seedSelector the caller passes in.
 */
export function inferSeedSelector(toolName: string, input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  switch (toolName) {
    case "rapidapi_breach_search":
      return typeof i.email === "string" ? i.email : null;
    case "serus_darkweb_scan":
      return typeof i.identifierValue === "string" ? i.identifierValue : null;
    case "leakcheck_lookup":
    case "oathnet_stealer_search":
    case "oathnet_lookup":
      return typeof i.value === "string" ? i.value : null;
    default:
      return null;
  }
}
