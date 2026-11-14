/**
 * seed-selectors.ts — the selectors an analyst typed into ONE seed.
 *
 * `detectSeed` classifies the whole typed string as a single kind, so a seed
 * that holds several selectors ("a@example.test, b@example.test", or an email
 * and a phone) is kind `other` and matched no recorded row. The assessment then
 * found no seed row, linked nothing, and the report listed the very contacts the
 * analyst typed as "ownership unresolved" (audit 2026-11-13, stage 2).
 *
 * This extracts STRONG selectors only, structurally:
 *  - emails, URLs, IPs, wallets and domains, token by token through `detectSeed`;
 *  - phone numbers, scanned in the text because they contain spaces;
 *  - handles only when written with an explicit `@`.
 * It never extracts a name (a name alone is never linkage; `seedNameMatcher`
 * handles the name the seed names) and never a bare word: any word looks like a
 * username, so prose would become handles.
 *
 * A seed that is already ONE selector returns nothing: the assessment's
 * whole-seed comparison handles it, exactly as before.
 *
 * JD's rulings (2026-11-14): every selector typed in the seed is the subject's;
 * a bare handle is not recognised inside a composite seed; a selector that
 * touches the stored seed's 200-character cut is dropped, since it may be
 * truncated.
 */
import { attachmentOnlyNames, seedWithoutAttachments } from "@/lib/attachments";
import { detectSeed } from "@/lib/seed";

/** `threads.seed_value` holds the first 200 characters of the first message. */
export const STORED_SEED_MAX = 200;

export type SeedSelectorKind = "email" | "phone" | "username" | "url" | "domain" | "ip" | "crypto";
export type SeedSelector = { kind: SeedSelectorKind; value: string };

/** Artifact kind spellings that hold each selector kind. A NAME row is in none of them. */
const ARTIFACT_KINDS: Record<SeedSelectorKind, ReadonlySet<string>> = {
  email: new Set(["email"]),
  phone: new Set(["phone"]),
  username: new Set(["username", "handle", "social"]),
  url: new Set(["url", "profile", "social_profile", "website"]),
  domain: new Set(["domain", "subdomain", "website"]),
  ip: new Set(["ip", "ip_address"]),
  crypto: new Set(["crypto_wallet", "wallet", "crypto"]),
};

const digits = (s: string) => s.replace(/\D/g, "");
const PHONE_SCAN = /\+?\d[\d\s().-]{6,}\d/g;
const TOKEN_KINDS: ReadonlySet<string> = new Set(["email", "url", "ip", "crypto", "domain"]);

/** Canonical text of a selector value, for comparison only. */
function canon(kind: SeedSelectorKind, raw: string): string {
  const v = raw.trim().toLowerCase();
  if (kind === "phone") return digits(v);
  if (kind === "username") return v.replace(/^@+/, "");
  if (kind === "url") return v.replace(/\/+$/, "");
  return v;
}

export function seedSelectors(seedValue: string | null | undefined): SeedSelector[] {
  const stored = (seedValue ?? "").trim();
  if (!stored || attachmentOnlyNames(stored) !== null) return [];
  let typed = (seedWithoutAttachments(stored) ?? "").trim();
  if (!typed) return [];
  // One selector: the whole-seed path already handles it.
  const whole = detectSeed(typed);
  if (whole && whole.kind !== "other" && whole.kind !== "address") return [];
  // The stored seed may be cut mid-selector: drop what touches the cut.
  if (stored.length >= STORED_SEED_MAX && typed === stored) typed = typed.replace(/\S+$/, "");

  const out: SeedSelector[] = [];
  const seen = new Set<string>();
  const add = (kind: SeedSelectorKind, raw: string) => {
    const value = canon(kind, raw);
    const key = `${kind}|${value}`;
    if (!value || seen.has(key)) return;
    seen.add(key);
    out.push({ kind, value });
  };

  let rest = typed;
  for (const raw of typed.split(/[\s,;]+/)) {
    const token = raw.replace(/^[("'<[]+|[)"'>\].!?]+$/g, "");
    if (!token) continue;
    if (token.startsWith("@")) {
      const handle = detectSeed(token);
      if (handle?.kind === "username") { add("username", token); rest = rest.replace(raw, " "); }
      continue;
    }
    const d = detectSeed(token);
    if (d && TOKEN_KINDS.has(d.kind)) { add(d.kind as SeedSelectorKind, token); rest = rest.replace(raw, " "); }
  }
  // Phones, in what is left: ten or more digits, or an explicit + with eight.
  for (const m of rest.match(PHONE_SCAN) ?? []) {
    const n = digits(m).length;
    if (n > 15) continue;
    if (n >= 10 || (m.trim().startsWith("+") && n >= 8)) add("phone", m);
  }
  return out;
}

/** Is this recorded row one of the selectors typed in the seed? Kind and value must both match. */
export function matchesSeedSelector(row: { kind: string; value: string }, selectors: readonly SeedSelector[]): boolean {
  if (selectors.length === 0) return false;
  const rowKind = String(row.kind ?? "").toLowerCase();
  for (const s of selectors) {
    if (!ARTIFACT_KINDS[s.kind].has(rowKind)) continue;
    const v = canon(s.kind, String(row.value ?? ""));
    if (!v) continue;
    if (v === s.value) return true;
    // The same number with and without its country code.
    if (s.kind === "phone" && v.length >= 10 && s.value.length >= 10 && v.slice(-10) === s.value.slice(-10)) return true;
  }
  return false;
}
