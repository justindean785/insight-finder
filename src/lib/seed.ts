// Shared seed normalization + detection used by both the chat client
// (for the investigation cache lookup) and rendered banners.
// Mirror logic on the edge function so cache keys match.

export type SeedKind = "email" | "username" | "phone" | "ip" | "domain" | "url" | "crypto" | "other";

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
const ETH_RE = /^0x[a-f0-9]{40}$/i;
const BTC_RE = /^(?:bc1|[13])[a-z0-9]{25,62}$/i;
const USERNAME_RE = /^[a-z0-9_.\-]{2,40}$/i;

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
  if (DOMAIN_RE.test(raw)) return { kind: "domain", raw, normalized: raw.toLowerCase() };
  if (USERNAME_RE.test(raw)) return { kind: "username", raw, normalized: raw.toLowerCase() };
  return { kind: "other", raw, normalized: raw.toLowerCase() };
}