// lib/socialfetch-input.ts — strict near-miss repair for socialfetch_lookup inputs.
//
// Production tool_usage_log showed repeated schema rejections of socialfetch_lookup: calls that sent `username`,
// `identifier` or `url` instead of `handle`, or a profile URL with no `platform`. The call is a PAID, low-quota API, so
// this repair is deliberately stricter than the generic coercion rules (lib/tool-input-coercion.ts):
//   • only UNAMBIGUOUS aliases fill `handle`: username / identifier / url; `value` only when it is the sole candidate;
//   • two candidates that disagree (including with an explicit `handle`) are a conflict and the call is REJECTED;
//   • `platform` is inferred only from an EXACT supported host (instagram.com, tiktok.com, x.com, twitter.com,
//     facebook.com, subdomains allowed) — never from a bare handle, never from prose;
//   • a supplied `platform` that disagrees with the URL's host is REJECTED, not silently overridden;
//   • facebook keeps the full URL (the route takes `?url=`); other platforms get the handle read off the URL path, and
//     if no plausible handle can be read the input is left untouched (and rejected by the schema as before);
//   • tiktok kind='video' keeps the full URL (the route takes a video URL/id).
// The coerced value is still re-validated against the UNCHANGED schema by applyInputCoercion.
//
// Logs carry the reason only — never a handle, URL or platform value.
// KILL SWITCH (read at call time): SOCIALFETCH_COERCION_DISABLED=true restores today's strict schema for this tool.
// /health proof key: checks.socialfetch_coercion.

import type { CoercionRecord, CustomInputRepair } from "./tool-input-coercion.ts";

export function socialfetchCoercionDisabled(): boolean {
  return (Deno.env.get("SOCIALFETCH_COERCION_DISABLED") ?? "").trim().toLowerCase() === "true";
}

type Platform = "instagram" | "tiktok" | "twitter" | "facebook";

const HOSTS: ReadonlyArray<readonly [string, Platform]> = [
  ["instagram.com", "instagram"],
  ["tiktok.com", "tiktok"],
  ["x.com", "twitter"],
  ["twitter.com", "twitter"],
  ["facebook.com", "facebook"],
];

// Spellings of the SAME four platforms (mirrors normalizeSocialPlatform in tool-registry.ts; kept local so this lib
// has no import cycle). Anything else maps to itself and so conflicts with a supported host.
const PLATFORM_SPELLINGS: Readonly<Record<string, Platform>> = {
  instagram: "instagram", ig: "instagram", "instagram.com": "instagram",
  tiktok: "tiktok", tt: "tiktok", "tiktok.com": "tiktok",
  twitter: "twitter", x: "twitter", tweet: "twitter", "x.com": "twitter", "twitter.com": "twitter",
  facebook: "facebook", fb: "facebook", "facebook.com": "facebook", "fb.com": "facebook",
};

function canonicalPlatform(raw: string): string {
  const s = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
  return Object.prototype.hasOwnProperty.call(PLATFORM_SPELLINGS, s) ? PLATFORM_SPELLINGS[s] : s;
}

/** The supported platform an http(s) URL's host belongs to (exact host or subdomain), else null. */
export function platformFromUrl(value: string): { platform: Platform; url: URL } | null {
  const t = value.trim();
  if (!/^https?:\/\//i.test(t)) return null;
  let url: URL;
  try { url = new URL(t); } catch { return null; }
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  for (const [domain, platform] of HOSTS) {
    if (host === domain || host.endsWith(`.${domain}`)) return { platform, url };
  }
  return null;
}

const RESERVED_FIRST_SEGMENT = new Set([
  "p", "reel", "reels", "tv", "stories", "explore", "accounts", "direct", "i", "intent", "home", "search", "share",
  "hashtag", "login", "signup", "settings", "notifications", "messages", "tag", "video", "discover", "foryou", "live",
]);
const HANDLE_SHAPE: Readonly<Record<Exclude<Platform, "facebook">, RegExp>> = {
  instagram: /^[A-Za-z0-9._]{1,30}$/,
  tiktok: /^[A-Za-z0-9._]{2,24}$/,
  twitter: /^[A-Za-z0-9_]{1,15}$/,
};

/** The profile handle in a profile-URL path (first segment, `@` stripped), or null when none is plainly present. */
function handleFromPath(platform: Exclude<Platform, "facebook">, url: URL): string | null {
  const seg = url.pathname.split("/").filter(Boolean)[0];
  if (!seg) return null;
  let h: string;
  try { h = decodeURIComponent(seg); } catch { return null; }
  if (platform === "tiktok") {
    if (!h.startsWith("@")) return null; // tiktok profile URLs are /@name; anything else is a video/discover path
    h = h.slice(1);
  } else if (h.startsWith("@")) {
    h = h.slice(1);
  }
  if (RESERVED_FIRST_SEGMENT.has(h.toLowerCase())) return null;
  return HANDLE_SHAPE[platform].test(h) ? h : null;
}

const HANDLE_ALIASES = ["username", "identifier", "url"] as const;

export type SocialfetchRepair = CustomInputRepair;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/**
 * Pure. Reads the (already generically trimmed) input object and returns a repair, a rejection, or nothing.
 * A rejection carries a `value` that the schema will refuse (the conflicting fields removed) — applyInputCoercion
 * hands that to the SDK instead of the raw input, which might otherwise validate on its explicit `handle`.
 */
export function repairSocialfetchInput(input: Record<string, unknown>): SocialfetchRepair {
  const out: Record<string, unknown> = { ...input };
  const records: CoercionRecord[] = [];
  const stripAll = () => {
    const v = { ...input };
    for (const k of ["handle", ...HANDLE_ALIASES, "value"]) delete v[k];
    return v;
  };

  // 1. handle candidates -------------------------------------------------------------------------------------------
  const explicit = str(input.handle);
  const aliasVals: string[] = [];
  for (const k of HANDLE_ALIASES) { const s = str(input[k]); if (s) aliasVals.push(s); }
  const valueField = str(input.value);
  const candidates = [...(explicit ? [explicit] : []), ...aliasVals, ...(valueField ? [valueField] : [])];
  if (new Set(candidates).size > 1) return { kind: "reject", reason: "conflicting_handle_aliases", value: stripAll() };

  let handle = explicit;
  if (!handle) {
    // `value` is accepted only when it is the sole candidate (a lone alias is also sole by the check above).
    handle = aliasVals[0] ?? valueField;
    if (handle) records.push({ field: "handle", coercion: "field_alias" });
  }
  const hadAliases = HANDLE_ALIASES.some((k) => k in out) || "value" in out;
  for (const k of [...HANDLE_ALIASES, "value"]) delete out[k];
  if (handle) out.handle = handle;
  if (!handle) return { kind: "none" };

  // 2. platform vs URL host ----------------------------------------------------------------------------------------
  const suppliedRaw = str(input.platform);
  const hit = platformFromUrl(handle);
  if (hit) {
    if (suppliedRaw && canonicalPlatform(suppliedRaw) !== hit.platform) {
      return { kind: "reject", reason: "platform_url_conflict", value: stripAll() };
    }
    if (!suppliedRaw) {
      out.platform = hit.platform;
      records.push({ field: "platform", coercion: "platform_from_url" });
    }
    // 3. the handle itself: facebook keeps the URL; tiktok video keeps the URL; the rest read the path.
    const kind = typeof input.kind === "string" ? input.kind : "profile";
    if (hit.platform !== "facebook" && !(hit.platform === "tiktok" && kind === "video")) {
      const h = handleFromPath(hit.platform, hit.url);
      if (!h) return records.length || hadAliases ? { kind: "reject", reason: "no_profile_in_url", value: stripAll() } : { kind: "none" };
      out.handle = h;
      records.push({ field: "handle", coercion: "handle_from_url" });
    }
  }

  return records.length ? { kind: "repair", value: out, records } : { kind: "none" };
}

/** InputCoercionSpec.custom adapter. */
export function socialfetchCustomCoercion(input: Record<string, unknown>): SocialfetchRepair {
  if (socialfetchCoercionDisabled()) return { kind: "none" };
  return repairSocialfetchInput(input);
}

/** /health → checks.socialfetch_coercion. Pure; presence proves this build; ok:false = a rule failed its own probe. */
export function socialfetchCoercionSelfTest(): { ok: boolean; switch: string; detail: string } {
  const sw = "SOCIALFETCH_COERCION_DISABLED";
  if (socialfetchCoercionDisabled()) return { ok: true, switch: `${sw}=true`, detail: "LEGACY via SOCIALFETCH_COERCION_DISABLED (strict schema)" };
  const wrong: string[] = [];
  const a = repairSocialfetchInput({ platform: "instagram", username: "example_user" });
  if (a.kind !== "repair" || a.value.handle !== "example_user") wrong.push("username alias not applied");
  const b = repairSocialfetchInput({ platform: "instagram", handle: "one", username: "two" });
  if (b.kind !== "reject") wrong.push("conflicting aliases not rejected");
  const c = repairSocialfetchInput({ url: "https://www.facebook.com/example.profile" });
  if (c.kind !== "repair" || c.value.platform !== "facebook" || c.value.handle !== "https://www.facebook.com/example.profile") wrong.push("facebook URL not kept whole");
  const d = repairSocialfetchInput({ platform: "tiktok", url: "https://www.instagram.com/example_user/" });
  if (d.kind !== "reject") wrong.push("platform/host conflict not rejected");
  const e = repairSocialfetchInput({ handle: "example_user" });
  if (e.kind !== "none") wrong.push("platform inferred from a bare handle");
  const f = repairSocialfetchInput({ url: "https://evil-instagram.com/example_user" });
  if (f.kind === "repair" && f.value.platform !== undefined) wrong.push("a look-alike host was accepted");
  return wrong.length
    ? { ok: false, switch: `${sw}=false`, detail: wrong.join("; ") }
    : {
      ok: true,
      switch: `${sw}=false`,
      detail: "socialfetch_lookup accepts username/identifier/url (and a lone value) as handle and infers platform only from an " +
        "exact supported host; conflicting aliases or a platform that disagrees with the URL host are rejected",
    };
}
