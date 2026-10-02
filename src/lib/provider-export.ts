/**
 * provider-export.ts — read the subject out of a pasted provider export.
 *
 * Analysts paste lookup results straight into the composer as the case seed:
 *
 *     === OATHNET INTELLIGENCE ===
 *     Found via oathnet.org
 *     Database: <breached site>
 *     phone number: <digits>
 *     full name: <name>
 *     === END - oathnet.org ===
 *
 * The free-text scan in `extractDisplaySeed` took the first selector-shaped
 * token it met, and in such a block that is the PROVIDER's own domain. So the
 * composer offered `oathnet.org (domain)` as the target, the report printed
 * `Selector: oathnet.org · Type: domain`, and the case was framed as an
 * investigation of the lookup service instead of the subject it returned
 * (production, 2026-10-01).
 *
 * Two rules, both applied ONLY to text that is already shaped like an export
 * (a block of `key: value` lines, or explicit provider attribution), so a plain
 * selector or ordinary prose classifies exactly as before:
 *
 * 1. A labelled selector field wins, in priority email > phone > username >
 *    full name (a name only when nothing stronger is present).
 * 2. Provider attribution is never the target: a "Found via <domain>" line,
 *    "=== … ===" header/footer lines, `dbname:` / `database:` / `source:`
 *    fields, and the known provider domains in OSINT_PROVIDER_DOMAINS.
 *
 * PURE, no imports. The edge function has no equivalent: `detectSeedServer`
 * (supabase/functions/osint-agent/validation.ts) classifies a whole export as
 * `other`, which is why its thread title is the raw header.
 */

/**
 * Lookup services whose OWN domain is printed in their exports. Inside an
 * export these are attribution, never the subject. Typed alone, a provider
 * domain is still an ordinary domain seed — this list is never consulted for a
 * bare selector. Values are the display name used in the case title tag.
 */
export const OSINT_PROVIDER_DOMAINS: Readonly<Record<string, string>> = {
  "oathnet.org": "OathNet",
  "intelx.io": "IntelX",
  "dehashed.com": "DeHashed",
  "leakcheck.io": "LeakCheck",
  "leakcheck.net": "LeakCheck",
  "snusbase.com": "Snusbase",
  "hudsonrock.com": "Hudson Rock",
  "haveibeenpwned.com": "HIBP",
  "intelbase.is": "Intelbase",
  "breachdirectory.org": "BreachDirectory",
  "leak-lookup.com": "Leak-Lookup",
  "osint.industries": "OSINT Industries",
  "epieos.com": "Epieos",
};

export type ExportPick = { value: string; kind: "email" | "phone" | "username" | "name" };

export type ProviderExport = {
  /** The subject selector read from a labelled field, or null when the export names none. */
  pick: ExportPick | null;
  /** Display name of the provider, when the export says who produced it. */
  provider: string | null;
  /** The text with every attribution position removed — all a free-text scan may read. */
  scrubbed: string;
};

/** One `key: value` line. The key is a short label; the value is the rest of the line. A bare URL is not one. */
const KV_LINE = /^\s*([A-Za-z][A-Za-z0-9 _./()-]{0,40}?)\s*:(?!\/\/)\s*(\S.*?)\s*$/;
/** "=== OATHNET INTELLIGENCE ===", "=== END - oathnet.org ===". Three or more "=", as exports print them. */
const HEADER_SEGMENT = /={3,}[^=\n]*[A-Za-z][^=\n]*={3,}/g;
/** "Found via oathnet.org" — only when what follows is domain-shaped. Scrubbed anywhere inside an export… */
const FOUND_VIA = /\bfound\s+via\s+((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?)/gi;
/** …but it MAKES text an export only as its own line, so prose ("… found via example.com") is untouched. */
const FOUND_VIA_LINE = /^[ \t]*found\s+via\s+(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}/im;
/** Fields that name where a record came from, never who it is about. */
const ATTRIBUTION_KEYS = new Set(["dbname", "db name", "database", "database name", "db", "source", "data source"]);
/** The same fields inside an export flattened onto one line: drop the key and its first token. */
const INLINE_ATTRIBUTION = /\b(?:dbname|db name|database|source)\s*:\s*\S+/gi;
/** Export timestamps ("Date: 2026-10-01T19:30:55.511Z") — digit-and-dash runs a phone scan misreads. */
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** A provider host, with optional scheme, subdomain and path. */
const PROVIDER_HOST = new RegExp(
  `(?:https?:\\/\\/)?(?:[a-z0-9-]+\\.)*(${Object.keys(OSINT_PROVIDER_DOMAINS).map(escapeRe).join("|")})(?![\\w-]|\\.[a-z0-9])(?:\\/\\S*)?`,
  "gi",
);
/** A match glued onto a longer token ("notoathnet.org", "user@oathnet.org") is not the provider. */
const gluedLeft = (s: string, offset: number) => offset > 0 && /[\w.@-]/.test(s[offset - 1]);

const EMAIL_VALUE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_VALUE = /^\+?[\d\s().-]{7,}$/;
const HANDLE_VALUE = /^@?[a-z0-9_.-]{2,40}$/i;
const NAME_VALUE = /^\p{L}[\p{L}\p{M}' .-]{0,78}[\p{L}.]$/u;
/** Masked, empty or placeholder values are not selectors ("j***@…", "null", "N/A"). */
const PLACEHOLDER = /^(?:null|none|nil|n\/?a|unknown|undefined|redacted|hidden|-+|\?+)$/i;

const EMAIL_KEY = /\b(?:e ?mail|mail)\b/;
const PHONE_KEY = /\b(?:phone|mobile|cell|cellphone|telephone|tel|msisdn)\b/;
const HANDLE_KEY = /^(?:user ?name|user|handle|login|nick ?name|nick|screen ?name|alias)$/;
const FULL_NAME_KEY = /^(?:full ?name|name)$/;
const FIRST_NAME_KEY = /^first ?name$/;
const LAST_NAME_KEY = /^(?:last ?name|surname)$/;

const normKey = (k: string) => k.toLowerCase().replace(/[_.\-()/]+/g, " ").replace(/\s+/g, " ").trim();
const cleanValue = (v: string) => v.trim().replace(/^["'<[(]+/, "").replace(/["'>\]),;]+$/, "").trim();
const digitCount = (s: string) => s.replace(/\D/g, "").length;
const usable = (v: string) => Boolean(v) && !PLACEHOLDER.test(v) && !/[*•…]/.test(v);

function pickSelector(fields: Array<{ key: string; value: string }>): ExportPick | null {
  let email: string | null = null;
  let phone: string | null = null;
  let username: string | null = null;
  let fullName: string | null = null;
  let first: string | null = null;
  let last: string | null = null;
  for (const { key, value } of fields) {
    if (!usable(value)) continue;
    if (EMAIL_VALUE.test(value)) {
      // An email in an email field — or in a login/username field, which some
      // providers use for the account's email — is the email selector.
      if (!email && (EMAIL_KEY.test(key) || HANDLE_KEY.test(key))) email = value;
      continue;
    }
    if (PHONE_KEY.test(key)) {
      // Labelled as a phone, so 7 digits is enough; E.164 caps it at 15.
      const n = digitCount(value);
      if (PHONE_VALUE.test(value) && n >= 7 && n <= 15) {
        // Prefer the fullest form: an international "+…" value over a national one.
        if (!phone || (!phone.startsWith("+") && value.startsWith("+"))) phone = value;
      }
      continue;
    }
    if (HANDLE_KEY.test(key)) {
      // An all-digit "user" is an account ID, not a handle.
      if (!username && HANDLE_VALUE.test(value) && !/^@?\d+$/.test(value)) username = value;
      continue;
    }
    if (NAME_VALUE.test(value)) {
      if (!fullName && FULL_NAME_KEY.test(key)) fullName = value;
      else if (!first && FIRST_NAME_KEY.test(key)) first = value;
      else if (!last && LAST_NAME_KEY.test(key)) last = value;
    }
  }
  if (email) return { value: email, kind: "email" };
  if (phone) return { value: phone, kind: "phone" };
  if (username) return { value: username, kind: "username" };
  const name = fullName ?? (first && last ? `${first} ${last}` : null);
  return name ? { value: name, kind: "name" } : null;
}

/** The first known provider domain standing on its own in `text`, as its display name. */
function knownProviderIn(text: string): string | null {
  for (const m of text.matchAll(PROVIDER_HOST)) {
    if (!gluedLeft(text, m.index ?? 0)) return OSINT_PROVIDER_DOMAINS[m[1].toLowerCase()] ?? null;
  }
  return null;
}

function providerOf(text: string): string | null {
  const known = knownProviderIn(text);
  if (known) return known;
  const via = new RegExp(FOUND_VIA.source, "i").exec(text)?.[1];
  return via ? via.replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase() : null;
}

function scrubAttribution(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => {
      const m = KV_LINE.exec(line);
      return !(m && ATTRIBUTION_KEYS.has(normKey(m[1])));
    })
    .join("\n")
    .replace(HEADER_SEGMENT, " ")
    .replace(FOUND_VIA, " ")
    .replace(INLINE_ATTRIBUTION, " ")
    .replace(ISO_DATE, " ")
    .replace(PROVIDER_HOST, (m: string, _host: string, offset: number, s: string) => (gluedLeft(s, offset) ? m : " "))
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Read `text` as a provider export. Returns null when it is not export-shaped —
 * fewer than two `key: value` lines and no provider attribution — so callers
 * fall through to their ordinary handling unchanged.
 */
export function readProviderExport(text: string | null | undefined): ProviderExport | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  const fields: Array<{ key: string; value: string }> = [];
  let kvLines = 0;
  let attributed = new RegExp(HEADER_SEGMENT.source).test(raw) || FOUND_VIA_LINE.test(raw);
  for (const line of raw.split(/\r?\n/)) {
    const m = KV_LINE.exec(line);
    if (!m) continue;
    kvLines++;
    const key = normKey(m[1]);
    if (ATTRIBUTION_KEYS.has(key)) attributed = true;
    else fields.push({ key, value: cleanValue(m[2]) });
  }
  // Inside a key: value block, a known provider's domain is attribution too.
  if (!attributed && kvLines >= 2) attributed = knownProviderIn(raw) !== null;
  if (!attributed && kvLines < 2) return null;
  return {
    pick: pickSelector(fields),
    provider: attributed ? providerOf(raw) : null,
    scrubbed: attributed ? scrubAttribution(raw) : raw,
  };
}
