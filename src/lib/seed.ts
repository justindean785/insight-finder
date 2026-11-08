// Shared seed normalization + detection used by both the chat client
// (for the investigation cache lookup) and rendered banners.
// Mirror logic on the edge function so cache keys match.

import { readProviderExport } from "@/lib/provider-export";
import { attachmentLabel, attachmentOnlyNames } from "@/lib/attachments";

export type SeedKind = "email" | "username" | "phone" | "ip" | "domain" | "url" | "crypto" | "address" | "other";

export type DetectedSeed = {
  kind: SeedKind;
  raw: string;
  /** Normalized cache key. Lowercased, trimmed. For emails: "+tag" stripped. */
  normalized: string;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IP_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const URL_RE = /^https?:\/\/\S+$/i;
const DOMAIN_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
const PHONE_RE = /^\+?[\d\s\-().]{7,}$/;
/** E.164 caps a phone number at 15 digits. A longer bare digit run is a platform
 *  account ID (a 17–20 digit Discord/Twitter snowflake, a Steam64 ID), not a phone.
 *  MUST match E164_MAX_DIGITS in supabase/functions/osint-agent/validation.ts. */
const E164_MAX_DIGITS = 15;
const digitCount = (s: string) => s.replace(/\D/g, "").length;
const ETH_RE = /^0x[a-f0-9]{40}$/i;
const BTC_RE = /^(?:bc1|[13])[a-z0-9]{25,62}$/i;
const USERNAME_RE = /^[a-z0-9_.-]{2,40}$/i;

// --- US postal address ----------------------------------------------------
// MUST match looksLikePostalAddress / normalizeAddressValue in
// supabase/functions/osint-agent/address.ts — the client computes the cache
// key the edge function looks the investigation up by, and there is no shared
// module between src/ and supabase/functions/.
//
// Runs against the WHITESPACE-FLATTENED value, so a pasted two-line address
// ("79 WAVERLY AVE\nCINCINNATI OH, 45215") is the same input as its one-line
// form, and `[\s,]+` accepts the comma placements people actually type
// ("OH, 45215" / "Cincinnati, OH 45215" / "Cincinnati OH 45215").
//
// The state position requires a real USPS two-letter code, not `[A-Za-z]{2}` —
// an unconstrained class let a plain "<house> <street> <suffix> <zip>" with no
// state at all false-positive ("123 Main St 90210": the street suffix "St" was
// consumed as the "state"), and let a degenerate two-token value false-positive
// too ("5 AB CD 12345": neither "AB" nor "CD" is a real state).
const US_STATE_CODES = new Set([
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA", "HI", "ID", "IL", "IN",
  "IA", "KS", "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV",
  "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN",
  "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC", "AS", "GU", "MP", "PR", "VI",
  "AA", "AE", "AP",
]);
const US_STATE_CODE_RE = "(?:" + [...US_STATE_CODES].join("|") + ")";
const US_POSTAL_RE = new RegExp(
  `^\\d{1,6}(?:-\\d{1,6})?[A-Za-z]?\\s+\\S.*?[\\s,]+(${US_STATE_CODE_RE})[\\s,]+\\d{5}(?:-\\d{4})?$`,
  "i",
);

/** Collapse newlines/tabs/runs of spaces. Casing and punctuation untouched. */
export function flattenAddress(raw: string | null | undefined): string {
  return (raw ?? "").replace(/\s+/g, " ").trim();
}

/** House number + 2-letter state + ZIP, in any common punctuation/line layout. */
export function looksLikePostalAddress(raw: string | null | undefined): boolean {
  const flat = flattenAddress(raw);
  if (!flat || flat.length > 200) return false;
  const m = US_POSTAL_RE.exec(flat);
  if (!m) return false;
  // The state token must be written in the conventional uppercase form. Real
  // addresses always capitalize the state abbreviation; two of the 57 codes
  // (IN, OR) are also ordinary lowercase English words ("called him back in
  // 12345", "apples or 90210"), so a case-insensitive-only match false-
  // positived on plain sentences that happen to end in a 5-digit number.
  return m[1] === m[1].toUpperCase();
}

/**
 * Cache key for an address seed: lowercased, "," and "." dropped, whitespace
 * collapsed — so every formatting of one address maps to one key while `raw`
 * keeps the analyst's original text for display.
 */
export function normalizeAddressValue(raw: string | null | undefined): string {
  return (raw ?? "")
    .toLowerCase()
    .replace(/[,.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// --- Display-seed extraction --------------------------------------------
// A thread's seed_value can be a clean selector ("casey.rivera@example.com") OR a
// pasted blob (e.g. raw OATHNET output). detectSeed() only classifies a clean
// single token; this pulls the strongest real selector out of a messy blob so
// the report title / exec summary / filename never show the whole dump.
const EMAIL_ANYWHERE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const URL_ANYWHERE = /https?:\/\/\S+/i;
const PHONE_ANYWHERE = /\+?\d[\d\s().-]{8,}\d/;
// Require an alphabetic TLD so ISO timestamps ("…:39.653Z") aren't read as domains.
const DOMAIN_ANYWHERE = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/i;
// A file name ("scan-report.pdf") has the shape of a domain. These extensions are not TLDs, so in the
// FREE-TEXT scan below a match ending in one is a document name, not a selector. Deliberately NOT
// listed: `.zip`, `.mov`, `.py`, `.sh`, `.md`, `.ps` — real TLDs that must keep working as domains.
// Applies only to that scan: a clean single token still goes through detectSeed, unchanged.
const DOCUMENT_EXTENSIONS = new Set([
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "csv", "rtf", "odt", "ods",
  "png", "jpg", "jpeg", "gif", "svg", "webp", "json", "xml", "html", "htm", "log",
]);
function firstDomainInText(text: string): string | undefined {
  for (const m of text.matchAll(new RegExp(DOMAIN_ANYWHERE.source, "gi"))) {
    const tld = m[0].slice(m[0].lastIndexOf(".") + 1).toLowerCase();
    if (!DOCUMENT_EXTENSIONS.has(tld)) return m[0];
  }
  return undefined;
}

/**
 * What a case's seed READS as. `attachment` is display-only: it is never a cache
 * key kind (SeedKind stays mirrored with the edge's detectSeedServer) and is
 * never written to `threads.seed_type`.
 */
export type DisplaySeedKind = SeedKind | "attachment";

export type DisplaySeed = { selector: string; kind: DisplaySeedKind; title: string };

export function extractDisplaySeed(
  seedValue: string | null | undefined,
  seedType?: string | null,
): DisplaySeed {
  const raw = (seedValue ?? "").trim();
  if (!raw) return { selector: "—", kind: "other", title: "Investigation" };

  // An upload with no typed text. Without this the blob scan below picked the
  // signed storage URL out of the markdown and framed the case as a `url` seed,
  // token and all. The file is what the analyst gave us; name the case by it.
  const files = attachmentOnlyNames(raw);
  if (files) return { selector: files[0], kind: "attachment", title: attachmentLabel(files) };

  // Already a clean single token → trust detectSeed. EXCEPT "address": unlike
  // email/url/phone/domain/username, detectSeed's address pattern tolerates
  // arbitrary characters between the house number and the state/ZIP
  // (`\S.*?`), so a short one-line string can satisfy it end-to-end while
  // ALSO containing a stronger, more precise selector inside it — e.g.
  // "123 Main St, contact John Doe at john@example.com, Columbus OH 43215".
  // Falling through to the blob-extraction chain below re-checks for that
  // stronger selector first, and still lands on the same address result when
  // there genuinely isn't one.
  if (raw.length <= 120 && !/\n|={2,}|\s{2,}/.test(raw)) {
    const direct = detectSeed(raw);
    if (direct && direct.kind !== "other" && direct.kind !== "address") {
      return { selector: direct.raw, kind: direct.kind, title: direct.raw };
    }
  }

  // A pasted provider export (OathNet, IntelX, DeHashed …). Its attribution —
  // "Found via oathnet.org", the "=== … ===" header, `dbname:` — is the first
  // domain the scan below would meet, and the case was framed as the
  // provider's domain. Read the labelled subject field instead; failing that,
  // scan only what is left once attribution is removed. A name has no SeedKind
  // of its own, so it travels as "other" with the name as its selector.
  const exported = readProviderExport(raw);
  if (exported) {
    const tag = exported.provider ? ` · ${exported.provider} export` : "";
    if (exported.pick) {
      const kind: SeedKind = exported.pick.kind === "name" ? "other" : exported.pick.kind;
      return { selector: exported.pick.value, kind, title: `${exported.pick.value}${tag}` };
    }
    if (exported.scrubbed !== raw) {
      const inner = extractDisplaySeed(exported.scrubbed, seedType);
      if (inner.selector === "—") return { ...inner, title: exported.provider ? `${exported.provider} export` : inner.title };
      return { ...inner, title: `${inner.title}${tag}` };
    }
  }

  // Messy blob — extract the strongest selector by priority. Checked BEFORE the
  // postal-address shortcut below: a blob can be address-shaped end-to-end
  // (house number ... real state ... ZIP) while also carrying a stronger,
  // more precise selector inside it (e.g. "123 Main St, contact John Doe at
  // john@example.com, Columbus OH 43215") — that selector must still win, the
  // same priority order this function already used before address existed.
  const email = raw.match(EMAIL_ANYWHERE)?.[0];
  if (email) return { selector: email, kind: "email", title: email };
  const url = raw.match(URL_ANYWHERE)?.[0];
  if (url) return { selector: url.replace(/[).,]+$/, ""), kind: "url", title: url };
  const phone = raw.match(PHONE_ANYWHERE)?.[0]?.trim();
  if (phone && digitCount(phone) >= 10 && digitCount(phone) <= E164_MAX_DIGITS) {
    return { selector: phone, kind: "phone", title: phone };
  }
  const domain = firstDomainInText(raw);
  if (domain) return { selector: domain.toLowerCase(), kind: "domain", title: domain.toLowerCase() };

  // A pasted postal address is a real selector even though it spans two lines
  // and trips the "messy blob" test above. Without this the fallback below cut
  // "79 WAVERLY AVE\nCINCINNATI OH, 45215" down to its first line.
  if (looksLikePostalAddress(raw)) {
    const flat = flattenAddress(raw);
    return { selector: flat, kind: "address", title: flat };
  }

  // Fallback: first clean fragment, truncated.
  const frag = raw.split(/\n|·|—|={2,}/).map((s) => s.trim()).find(Boolean) ?? raw;
  const short = frag.slice(0, 60);
  return { selector: short, kind: (seedType as SeedKind) || "other", title: short };
}

// --- Thread title formatting ---------------------------------------------
// Human-readable thread titles: "[Entity Type]: [Seed]" instead of the raw
// seed blob (issue #73). Unknown/unclassified seeds keep the legacy
// slice(0, 80) behavior so nothing regresses. MUST mirror formatThreadTitle
// in supabase/functions/osint-agent/validation.ts (no shared module exists
// between src/ and supabase/functions/).
//
// A pasted multi-line provider export is NOT classified here (detectSeed reads
// one clean token), so its stored title is still the raw first 80 chars — on the
// edge too, and a test pins the two equal. The UI derives the shown title from
// the seed at display time instead: see exportSubjectTitle / threadDisplayTitle
// in src/lib/case-name.ts. Fix the stored title on the edge and here together.
export const THREAD_TITLE_MAX = 80;

const SEED_KIND_LABELS: Record<string, string> = {
  email: "Email",
  username: "Username",
  phone: "Phone",
  ip: "IP",
  domain: "Domain",
  url: "URL",
  crypto: "Crypto Wallet",
  person: "Person",
  address: "Address",
};

export function formatThreadTitle(text: string): string {
  const raw = (text ?? "").trim();
  const detected = detectSeed(raw);
  const label = detected ? SEED_KIND_LABELS[detected.kind] : undefined;
  if (!label) return raw.slice(0, THREAD_TITLE_MAX);
  return `${label}: ${detected!.raw}`.slice(0, THREAD_TITLE_MAX);
}

export function detectSeed(input: string): DetectedSeed | null {
  const raw = input.trim();
  if (!raw) return null;

  if (EMAIL_RE.test(raw)) {
    const lower = raw.toLowerCase();
    const [localRaw, domain] = lower.split("@");
    const local = localRaw.split("+")[0]; // strip "+tag" for cache key only
    return { kind: "email", raw, normalized: `${local}@${domain}` };
  }
  if (URL_RE.test(raw)) {
    try {
      const u = new URL(raw);
      const norm = `${u.protocol}//${u.hostname.toLowerCase()}${u.pathname.replace(/\/$/, "")}${u.search}`;
      return { kind: "url", raw, normalized: norm };
    } catch { /* fall through */ }
  }
  if (IP_RE.test(raw)) return { kind: "ip", raw, normalized: raw };
  if (ETH_RE.test(raw) || BTC_RE.test(raw)) return { kind: "crypto", raw, normalized: raw.toLowerCase() };
  // A bare digit run past E.164's 15 digits is an account ID. Classify it before
  // PHONE_RE (which it matches) and USERNAME_RE (which it also matches — a username
  // sweep on a snowflake is as wrong as a phone playbook).
  if (/^\d+$/.test(raw) && raw.length > E164_MAX_DIGITS) return { kind: "other", raw, normalized: raw };
  if (PHONE_RE.test(raw) && digitCount(raw) <= E164_MAX_DIGITS) {
    const digits = raw.replace(/[^\d+]/g, "");
    return { kind: "phone", raw, normalized: digits };
  }
  if (DOMAIN_RE.test(raw)) return { kind: "domain", raw, normalized: raw.toLowerCase() };
  if (USERNAME_RE.test(raw)) return { kind: "username", raw, normalized: raw.toLowerCase() };
  // "@handle" is a username seed — the way every platform displays one. It
  // classified as `other`, so `@hoodken28` lost the username playbook and its
  // thread read "Type: other". Normalized without the `@`, matching artifact
  // values and the server (validation.ts detectSeedServer).
  if (raw.startsWith("@") && USERNAME_RE.test(raw.slice(1))) {
    return { kind: "username", raw, normalized: raw.slice(1).toLowerCase() };
  }
  // MUST match detectSeedServer in supabase/functions/osint-agent/validation.ts.
  if (looksLikePostalAddress(raw)) {
    return { kind: "address", raw, normalized: normalizeAddressValue(raw) };
  }
  return { kind: "other", raw, normalized: raw.toLowerCase() };
}