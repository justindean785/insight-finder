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
const USERNAME_RE = /^[a-z0-9_.-]{2,40}$/i;

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

export type DisplaySeed = { selector: string; kind: SeedKind; title: string };

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
      return { selector: direct.raw, kind: direct.kind, title: direct.raw };
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
  const domain = raw.match(DOMAIN_ANYWHERE)?.[0];
  if (domain) return { selector: domain.toLowerCase(), kind: "domain", title: domain.toLowerCase() };

  // Fallback: first clean fragment, truncated.
  const frag = raw.split(/\n|·|—|={2,}/).map((s) => s.trim()).find(Boolean) ?? raw;
  const short = frag.slice(0, 60);
  return { selector: short, kind: (seedType as SeedKind) || "other", title: short };
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
  if (DOMAIN_RE.test(raw)) return { kind: "domain", raw, normalized: raw.toLowerCase() };
  if (USERNAME_RE.test(raw)) return { kind: "username", raw, normalized: raw.toLowerCase() };
  return { kind: "other", raw, normalized: raw.toLowerCase() };
}