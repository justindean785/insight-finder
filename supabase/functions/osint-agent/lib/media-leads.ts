/**
 * media-leads — surface the direct image URLs a scrape or profile result already
 * contains, so the GeoSeer chain (gemini_vision -> geoseer_geolocate) starts from a
 * list instead of from the model happening to notice a URL.
 *
 * ## The gap this closes (measured 2026-10-18, tool_usage_log, SELECT-only)
 *
 * 314 cases since 2026-06-08. 276 used a social or scrape tool, 48 ran
 * `gemini_vision`, and `geoseer_geolocate` fired ONCE (2026-10-07). The tool, its
 * geolocatability gate, its key check and its prompt guidance are all built and
 * deployed. What was missing is the first hop: nothing hands the model the image
 * URL, so it has to spot one inside markdown or a provider payload, then choose
 * vision, then choose GeoSeer. Three discretionary steps, one of which (the spot)
 * is easy to miss.
 *
 * ## What this does
 *
 * After a SOURCE tool returns an object, add two top-level keys to the copy the
 * model reads: `media_leads` (at most MAX_MEDIA_LEADS direct image URLs, content
 * images ranked before avatars) and `media_leads_note` (what to do with them).
 * Nothing else in the result is touched, removed or reordered.
 *
 * ## What this deliberately does NOT do
 *
 * - It never calls a tool and never spends a credit. Vision and GeoSeer stay the
 *   model's choice (option A). An auto-chain would be a separate, capped, default-OFF
 *   switch and a separate PR.
 * - It creates no evidence. The leads are a heuristic list of URLs that were already
 *   in the result; the wrapper sits OUTSIDE wrapToolsWithCache, so the cache, the
 *   tool_usage_log row and the chain-of-custody record all see the original result.
 *   `extractFindings` reads named fields per tool and never reads `media_leads`
 *   (pinned by media_leads_test.ts).
 * - It cannot fail a call. Any internal error returns the original result unchanged.
 * - It never suppresses, blocks or reorders a tool. It only adds.
 * - It holds no state, so there is no per-thread counter to drift across isolates.
 *
 * Kill switch: MEDIA_LEADS_DISABLED=true, read at CALL time. Proof key:
 * `checks.media_leads` (health-handler.ts).
 *
 * Zero imports on purpose: pure, and testable without the request graph.
 */

export const MEDIA_LEADS_DISABLED_ENV = "MEDIA_LEADS_DISABLED";

/** Operator switch, read at CALL TIME. Default ON (it only adds a list). */
export function mediaLeadsDisabled(
  env: (k: string) => string | undefined = (k) => Deno.env.get(k),
): boolean {
  return (env(MEDIA_LEADS_DISABLED_ENV) ?? "").trim().toLowerCase() === "true";
}

/** Tools whose results can carry the image URLs of a page or a profile. */
export const MEDIA_LEAD_SOURCE_TOOLS: ReadonlySet<string> = new Set([
  "jina_reader_scrape",
  "markdown_extract",
  "socialfetch_web_read",
  "socialfetch_lookup",
  "github_user",
  "reddit_user",
  "steam_profile",
  "gravatar_profile",
]);

export const MAX_MEDIA_LEADS = 6;
const MAX_WALK_NODES = 4000;
const MAX_WALK_DEPTH = 8;
const MAX_STRING_SCAN = 300_000;
const MAX_URL_LENGTH = 2048;

/** What the SAME object (a social post) says about where and when it was made. */
export interface MediaLeadPost {
  /** The platform itself reported a place for this post (name and/or coordinates). */
  has_location_tag: boolean;
  /** The platform's place name, when it gave one. Platform-asserted, not verified. */
  place?: string;
  /** Post date (YYYY-MM-DD), when the object carries a usable timestamp. */
  taken_at?: string;
}

export interface MediaLead {
  url: string;
  /** "content" = a picture a person posted or a page shows; "avatar" = a profile picture. */
  kind: "content" | "avatar";
  source_tool: string;
  /** Only content images are worth a GeoSeer call; the geolocatability gate skips portraits. */
  geolocation_candidate: boolean;
  /** Present only when the image sits in an object that also carries a place tag or a timestamp. */
  post?: MediaLeadPost;
}

export const MEDIA_LEADS_NOTE =
  "Heuristic list of direct image URLs found in this result: leads, not evidence. " +
  "Content image: gemini_vision (mode='image') first; only a scene with outdoor, street, landmark or signage signal goes on to geoseer_geolocate (url + scene). " +
  "post.has_location_tag=true means the platform already reported a place (post.place): read that before paying for GeoSeer. " +
  "Avatars: reverse-image only.";

// ── extraction ───────────────────────────────────────────────────────────────

const MD_IMAGE_RE = /!\[[^\]]*\]\(\s*<?(https?:\/\/[^\s)>]+)>?[^)]*\)/gi;
const BARE_IMAGE_URL_RE = /https?:\/\/[^\s"'<>()[\]{}\\]+?\.(?:jpe?g|png|webp|heic|heif)(?:\?[^\s"'<>()[\]{}\\]*)?/gi;
const IMAGE_PATH_RE = /\.(?:jpe?g|png|webp|heic|heif)$/i;

// A key that names an image, after camelCase -> snake_case. Size/format suffixes may stack
// (avatar_url_hd, thumbnail_url_small), so the suffix group repeats.
const KEY_SUFFIX = "(?:_?(?:url|src|hd|large|full|small|medium|big|original|https))*";
const IMAGE_KEY_RE = new RegExp(
  `(?:^|_)(?:avatar|profile_?(?:pic|image|picture|photo)|picture|photo|image|img|thumbnail|thumb|display_?url|media_?url|banner|cover|og_?image)${KEY_SUFFIX}$`,
);
const AVATAR_KEY_RE = /avatar|profile|picture/;
// Any key that is plainly a profile picture, whatever its suffix (profile_image_url_https, avatar2, userpic).
const AVATAR_ANY_KEY_RE = /avatar|userpic|pfp|profile_?(?:pic|image|img|photo|picture)/;
// A low-resolution copy of a picture that normally sits beside its full-size URL.
const HQ_KEY_RE = /(?:^|_)(?:hd|large|full|big|original)(?:_|$)/;
const THUMB_KEY_RE = new RegExp(`(?:^|_)(?:thumbnail|thumb)${KEY_SUFFIX}$`);

// Things that are never a geolocatable photo: icons, sprites, trackers, vector art, animations.
const JUNK_URL_RE =
  /(?:favicon|sprite|emoji|emoticon|badge|shields\.io|pixel|spacer|tracking|beacon|1x1|apple-touch|doubleclick|googletagmanager|google-analytics|facebook\.com\/tr\b|gstatic\.com|placeholder|blank\.|default[_-]?(?:avatar|profile)|\/logos?[/_.-]|[_.-]logo[_.\-/]|\/icons?\/|[_.-]icon[_.\-/]|\.svg(?:$|[?#])|\.gif(?:$|[?#]))/i;

const snake = (k: string) => k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

/** Public http(s) host only. Downstream tools still run assertSafeUrl; this just keeps junk out of the list. */
function isPublicHttpUrl(u: URL): boolean {
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return false;
  if (h.startsWith("[") || h.includes(":")) return false;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
  }
  return true;
}

const trimUrl = (s: string) => s.trim().replace(/[.,;:!?'")\]]+$/, "");

interface Candidate {
  url: string;
  avatar: boolean;
  thumb?: boolean;
  /** The key says this is the large/HD variant. */
  hq?: boolean;
  post?: MediaLeadPost;
}

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const cleanText = (v: unknown, max: number): string | undefined => {
  if (typeof v !== "string") return undefined;
  // Control characters become spaces. Done by char code, not a regex: both Deno's and the
  // repo's ESLint `no-control-regex` rule reject a control-character class.
  let spaced = "";
  for (const ch of v) {
    const c = ch.charCodeAt(0);
    spaced += c < 32 || c === 127 ? " " : ch;
  }
  const t = spaced.replace(/\s+/g, " ").trim().slice(0, max);
  return t || undefined;
};
const finiteNum = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** YYYY-MM-DD from an epoch (seconds or milliseconds) or an ISO-ish string. Out-of-range values are dropped. */
function toDay(v: unknown): string | undefined {
  let ms: number | undefined;
  if (typeof v === "number" && Number.isFinite(v)) ms = v < 1e11 ? v * 1000 : v;
  else if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v.trim())) ms = Date.parse(v.trim());
  if (ms === undefined || Number.isNaN(ms)) return undefined;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  if (y < 1995 || y > 2100) return undefined;
  return d.toISOString().slice(0, 10);
}

/**
 * What a post-like object says about place and time. A bare coordinate pair or a place
 * name counts as a tag. Returns undefined when the object says neither, so plain pages
 * and profiles never grow an empty `post`.
 */
function postContext(o: Record<string, unknown>): MediaLeadPost | undefined {
  const loc = o.location ?? o.place ?? o.geo;
  let place: string | undefined;
  let coords = false;
  if (typeof loc === "string") {
    place = cleanText(loc, 80);
  } else if (isRec(loc)) {
    place = cleanText(loc.name ?? loc.title ?? loc.address ?? loc.city, 80);
    coords = (finiteNum(loc.lat) !== undefined && finiteNum(loc.lng ?? loc.lon) !== undefined) ||
      (finiteNum(loc.latitude) !== undefined && finiteNum(loc.longitude) !== undefined);
  }
  place = place ?? cleanText(o.location_name ?? o.locationName ?? o.place_name ?? o.placeName, 80);
  if (!coords) {
    coords = finiteNum(o.latitude) !== undefined && finiteNum(o.longitude) !== undefined;
  }
  const taken_at = toDay(o.takenAt ?? o.taken_at ?? o.createdAt ?? o.created_at ?? o.timestamp);
  if (!place && !coords && !taken_at) return undefined;
  return {
    has_location_tag: Boolean(place) || coords,
    ...(place ? { place } : {}),
    ...(taken_at ? { taken_at } : {}),
  };
}

function walk(root: unknown, out: Candidate[]): void {
  let nodes = 0;
  const seen = new WeakSet<object>();
  const scanString = (s: string) => {
    const text = s.length > MAX_STRING_SCAN ? s.slice(0, MAX_STRING_SCAN) : s;
    for (const m of text.matchAll(MD_IMAGE_RE)) out.push({ url: trimUrl(m[1]), avatar: false });
    for (const m of text.matchAll(BARE_IMAGE_URL_RE)) out.push({ url: trimUrl(m[0]), avatar: false });
  };
  const visit = (node: unknown, depth: number) => {
    if (++nodes > MAX_WALK_NODES || depth > MAX_WALK_DEPTH) return;
    if (typeof node === "string") {
      scanString(node);
      return;
    }
    if (!node || typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) {
      for (const v of node) visit(v, depth + 1);
      return;
    }
    const rec = node as Record<string, unknown>;
    // Keyed pictures first. A value taken from an image-named key is NOT scanned again as
    // free text: that scan would re-file an avatar URL ending in .jpg as a content image.
    const keyed: Candidate[] = [];
    const keyedKeys = new Set<string>();
    for (const [key, value] of Object.entries(rec)) {
      if (typeof value !== "string") continue;
      const sk = snake(key);
      const v = value.trim();
      if ((IMAGE_KEY_RE.test(sk) || AVATAR_ANY_KEY_RE.test(sk)) && /^https?:\/\//i.test(v)) {
        keyed.push({
          url: trimUrl(v),
          avatar: AVATAR_KEY_RE.test(sk),
          thumb: THUMB_KEY_RE.test(sk),
          hq: HQ_KEY_RE.test(sk),
        });
        keyedKeys.add(key);
      }
    }
    if (keyed.length > 0) {
      // A post usually lists its full-size picture and a thumbnail of it: keep the full-size one.
      const hasFull = keyed.some((c) => !c.avatar && !c.thumb);
      // Several avatar sizes in one object are one picture: keep the large one (else the first).
      const avatars = keyed.filter((c) => c.avatar);
      const keepAvatar = avatars.find((c) => c.hq) ?? avatars[0];
      const post = postContext(rec);
      for (const c of keyed) {
        if (c.thumb && hasFull) continue;
        if (c.avatar && c !== keepAvatar) continue;
        out.push(post && !c.avatar ? { ...c, post } : c);
      }
    }
    for (const [key, value] of Object.entries(rec)) {
      if (keyedKeys.has(key)) continue;
      visit(value, depth + 1);
    }
  };
  visit(root, 0);
}

/** Dedupe key: host + path. The query is kept only when the path has no image extension (CDN-style links). */
function dedupeKey(u: URL): string {
  return `${u.hostname.toLowerCase()}${u.pathname}${IMAGE_PATH_RE.test(u.pathname) ? "" : u.search}`;
}

/** Pure. Returns at most MAX_MEDIA_LEADS leads, content images first, then avatars, discovery order within each. */
export function extractMediaLeads(toolName: string, result: unknown): MediaLead[] {
  const cands: Candidate[] = [];
  walk(result, cands);
  const seen = new Map<string, MediaLead>();
  for (const c of cands) {
    if (!c.url || c.url.length > MAX_URL_LENGTH) continue;
    let u: URL;
    try {
      u = new URL(c.url);
    } catch {
      continue;
    }
    if (!isPublicHttpUrl(u)) continue;
    if (JUNK_URL_RE.test(u.href)) continue;
    const key = dedupeKey(u);
    const existing = seen.get(key);
    if (existing) {
      // The same picture seen as a post image AND as an avatar is a content image.
      if (existing.kind === "avatar" && !c.avatar) {
        existing.kind = "content";
        existing.geolocation_candidate = true;
      }
      if (!existing.post && c.post && existing.kind === "content") existing.post = c.post;
      continue;
    }
    seen.set(key, {
      url: u.href,
      kind: c.avatar ? "avatar" : "content",
      source_tool: toolName,
      geolocation_candidate: !c.avatar,
      ...(c.post && !c.avatar ? { post: c.post } : {}),
    });
  }
  const all = [...seen.values()];
  const content = all.filter((l) => l.kind === "content");
  // Untagged pictures first: those are the ones a paid geolocation could add something to.
  // A post the platform already placed keeps its slot, behind them, as a cross-check.
  const untagged = content.filter((l) => l.post?.has_location_tag !== true);
  const tagged = content.filter((l) => l.post?.has_location_tag === true);
  return [...untagged, ...tagged, ...all.filter((l) => l.kind === "avatar")].slice(0, MAX_MEDIA_LEADS);
}

/**
 * Add `media_leads` + `media_leads_note` to an object result, leaving every existing
 * key exactly as it was. Returns the ORIGINAL value for anything else, and on any error.
 */
export function attachMediaLeads(toolName: string, result: unknown): unknown {
  try {
    if (!MEDIA_LEAD_SOURCE_TOOLS.has(toolName)) return result;
    if (!result || typeof result !== "object" || Array.isArray(result)) return result;
    if (Symbol.asyncIterator in (result as object)) return result;
    const r = result as Record<string, unknown>;
    if ("media_leads" in r) return result;
    // A skipped call or a clean negative ("found: false") has no content to mine.
    if (r.skipped === true || r.found === false) return result;
    const leads = extractMediaLeads(toolName, r);
    if (leads.length === 0) return result;
    return { ...r, media_leads: leads, media_leads_note: MEDIA_LEADS_NOTE };
  } catch {
    return result;
  }
}

/**
 * Wrap the SOURCE tools in `tools` so their results carry media leads. Apply this
 * OUTSIDE wrapToolsWithCache. Tools that are not sources, or have no `execute`, are
 * returned as the very same objects. The switch is read on every call.
 */
export function wrapToolsWithMediaLeads<T extends Record<string, unknown>>(
  tools: T,
  env: (k: string) => string | undefined = (k) => Deno.env.get(k),
): T {
  const out: Record<string, unknown> = { ...tools };
  for (const name of MEDIA_LEAD_SOURCE_TOOLS) {
    const t = out[name] as { execute?: unknown } | undefined;
    if (!t || typeof t.execute !== "function") continue;
    const orig = (t.execute as (input: unknown, opts: unknown) => unknown).bind(t);
    out[name] = {
      ...t,
      execute: async (input: unknown, opts: unknown) => {
        const res = await orig(input, opts);
        if (mediaLeadsDisabled(env)) return res;
        return attachMediaLeads(name, res);
      },
    };
  }
  return out as T;
}

/** /health proof: runs the live extractor on a fixed synthetic result. Pure and silent. */
export function mediaLeadsSelfTest(
  env: (k: string) => string | undefined = (k) => Deno.env.get(k),
): { ok: boolean; enabled: boolean; sources: number; detail: string } {
  const probe = {
    content: "![a](https://cdn.example.com/p/1.jpg) ![i](https://cdn.example.com/favicon.ico)",
    avatar_url: "https://cdn.example.com/av/42",
  };
  const leads = extractMediaLeads("jina_reader_scrape", probe);
  const ok = leads.length === 2 &&
    leads[0].kind === "content" && leads[0].geolocation_candidate === true &&
    leads[1].kind === "avatar" && leads[1].geolocation_candidate === false;
  return {
    ok,
    enabled: !mediaLeadsDisabled(env),
    sources: MEDIA_LEAD_SOURCE_TOOLS.size,
    detail: ok
      ? "content images rank before avatars; icons are dropped"
      : "SELF-TEST FAILED: media-lead extraction no longer ranks content before avatars or no longer drops icons",
  };
}
