// Shared seed normalization + detection used by both the chat client
// (for the investigation cache lookup) and rendered banners.
// Mirror logic on the edge function so cache keys match.

export type SeedKind = "email" | "username" | "phone" | "ip" | "domain" | "url" | "crypto" | "other";

export type DetectedSeed = {
  kind: SeedKind;
  raw: string;
  /** Normalized cache key. Lowercased, trimmed. For emails: "+tag" stripped. */
  normalized: string;
  /**
   * The token has hostname grammar but an unrecognised suffix, so `kind` is the
   * least-assertive reading rather than a confident one. Surfaced in the report
   * so an unresolved selector never reads as a settled fact.
   */
  ambiguous?: boolean;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const IP_RE = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const URL_RE = /^https?:\/\/\S+$/i;
const DOMAIN_RE = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i;
const PHONE_RE = /^\+?[\d\s\-().]{7,}$/;
const ETH_RE = /^0x[a-f0-9]{40}$/i;
const BTC_RE = /^(?:bc1|[13])[a-z0-9]{25,62}$/i;
const USERNAME_RE = /^[a-z0-9_.-]{2,40}$/i;

/**
 * Suffixes we are willing to treat as PROOF of a hostname.
 *
 * This is a positive fast-path, NOT the classifier. There are well over a
 * thousand gTLDs and the set changes, so an allowlist can only ever answer
 * "yes, confidently" — never "no, confidently". Treating a miss as proof of a
 * username would just invert the original bug: `example.quest` is a real
 * domain, and calling it a handle is as wrong as calling `Ronny.doe` a domain.
 * Misses are therefore reported as AMBIGUOUS (see `classifyDottedToken`).
 *
 * Two-letter suffixes are accepted by LENGTH rather than enumeration, because
 * every two-letter TLD is a ccTLD.
 *
 * Word-like gTLDs that collide with ordinary handles (`.bar`, `.dog`, `.one`,
 * `.pub`, `.run`, `.ltd`) are deliberately ABSENT: for those the ambiguous
 * answer is the honest one.
 */
const KNOWN_GTLDS = new Set([
  "com", "net", "org", "edu", "gov", "mil", "int", "info", "biz", "name", "pro",
  "aero", "coop", "museum", "asia", "jobs", "mobi", "tel", "travel",
  "app", "dev", "cloud", "site", "online", "website", "store", "shop", "tech",
  "xyz", "blog", "wiki", "page", "email", "digital", "agency", "solutions",
  "services", "systems", "network", "software", "host", "hosting", "domains",
  "media", "studio", "design", "academy", "institute", "university",
]);

/** Confidently a TLD. A `false` here means "unknown", NOT "definitely not". */
export function isLikelyTld(label: string): boolean {
  const l = label.trim().toLowerCase();
  if (!/^[a-z]{2,24}$/.test(l)) return false;
  return l.length === 2 || KNOWN_GTLDS.has(l);
}

/** Hostname grammar AND a recognised TLD — not merely "contains a dot". */
export function isLikelyDomain(value: string): boolean {
  const v = value.trim();
  if (!DOMAIN_RE.test(v)) return false;
  return isLikelyTld(v.split(".").pop() ?? "");
}

/**
 * How to treat a single dotted token.
 *
 * Three outcomes, and the middle one is the point:
 *   "domain"    — hostname grammar with a recognised suffix.
 *   "ambiguous" — hostname grammar with an UNRECOGNISED suffix. Could be a
 *                 newer gTLD or a `first.last` handle; nothing in the token
 *                 itself distinguishes them. We take the least-assertive
 *                 reading (username, so the seed is still searchable as a
 *                 handle) and mark it so the report can say it is unresolved.
 *   "username"  — no dot at all; nothing ambiguous about it.
 */
export function classifyDottedToken(value: string): "domain" | "ambiguous" | "username" {
  const v = value.trim();
  if (isLikelyDomain(v)) return "domain";
  if (DOMAIN_RE.test(v)) return "ambiguous";
  return "username";
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

export type DisplaySeed = {
  selector: string;
  kind: SeedKind;
  title: string;
  /** See DetectedSeed.ambiguous — the report must not present a guess as settled. */
  ambiguous?: boolean;
};

export function extractDisplaySeed(
  seedValue: string | null | undefined,
  seedType?: string | null,
): DisplaySeed {
  const raw = (seedValue ?? "").trim();
  if (!raw) return { selector: "—", kind: "other", title: "Investigation" };

  // Already a clean single token → trust detectSeed.
  if (raw.length <= 120 && !/\n|={2,}|\s{2,}/.test(raw)) {
    const direct = detectSeed(raw);
    if (direct && direct.kind !== "other") {
      return {
        selector: direct.raw,
        kind: direct.kind,
        title: direct.raw,
        ...(direct.ambiguous ? { ambiguous: true } : {}),
      };
    }
  }

  // Messy blob — extract the strongest selector by priority.
  const email = raw.match(EMAIL_ANYWHERE)?.[0];
  if (email) return { selector: email, kind: "email", title: email };
  const url = raw.match(URL_ANYWHERE)?.[0];
  if (url) return { selector: url.replace(/[).,]+$/, ""), kind: "url", title: url };
  const phone = raw.match(PHONE_ANYWHERE)?.[0]?.trim();
  if (phone && phone.replace(/\D/g, "").length >= 10) {
    return { selector: phone, kind: "phone", title: phone };
  }
  // Same TLD rule as detectSeed — otherwise the blob path re-invents the very
  // domain certainty the token grammar refuses to assert.
  const domain = raw.match(DOMAIN_ANYWHERE)?.[0];
  if (domain && isLikelyDomain(domain)) {
    return { selector: domain.toLowerCase(), kind: "domain", title: domain.toLowerCase() };
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
  if (PHONE_RE.test(raw)) {
    const digits = raw.replace(/[^\d+]/g, "");
    return { kind: "phone", raw, normalized: digits };
  }
  // A dotted token is only a domain when its last label is a recognised TLD.
  // An unrecognised suffix is genuinely undecidable from the token alone, so it
  // takes the least-assertive reading and carries `ambiguous`.
  const dotted = classifyDottedToken(raw);
  if (dotted === "domain") return { kind: "domain", raw, normalized: raw.toLowerCase() };
  if (USERNAME_RE.test(raw)) {
    return {
      kind: "username",
      raw,
      normalized: raw.toLowerCase(),
      ...(dotted === "ambiguous" ? { ambiguous: true } : {}),
    };
  }
  return { kind: "other", raw, normalized: raw.toLowerCase() };
}