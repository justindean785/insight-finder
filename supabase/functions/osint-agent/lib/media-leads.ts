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

export interface MediaLead {
  url: string;
  /** "content" = a picture a person posted or a page shows; "avatar" = a profile picture. */
  kind: "content" | "avatar";
  source_tool: string;
  /** Only content images are worth a GeoSeer call; the geolocatability gate skips portraits. */
  geolocation_candidate: boolean;
}

export const MEDIA_LEADS_NOTE =
  "Heuristic list of direct image URLs found in this result: unverified leads, not evidence. " +
  "For a content image, run gemini_vision (mode='image') on the url; only if its scene shows outdoor, street, landmark or signage signal, pass url + scene to geoseer_geolocate. " +
  "Avatars are reverse-image candidates only.";

// ── extraction ───────────────────────────────────────────────────────────────

const MD_IMAGE_RE = /!\[[^\]]*\]\(\s*<?(https?:\/\/[^\s)>]+)>?[^)]*\)/gi;
const BARE_IMAGE_URL_RE = /https?:\/\/[^\s"'<>()[\]{}\\]+?\.(?:jpe?g|png|webp|heic|heif)(?:\?[^\s"'<>()[\]{}\\]*)?/gi;
const IMAGE_PATH_RE = /\.(?:jpe?g|png|webp|heic|heif)$/i;

// A key that names an image, after camelCase -> snake_case.
const IMAGE_KEY_RE =
  /(?:^|_)(?:avatar|profile_?(?:pic|image|picture|photo)|picture|photo|image|img|thumbnail|thumb|display_?url|media_?url|banner|cover|og_?image)(?:_?(?:url|src|hd|large|full))?$/;
const AVATAR_KEY_RE = /avatar|profile|picture/;

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
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (typeof value === "string") {
        const sk = snake(key);
        const v = value.trim();
        if (IMAGE_KEY_RE.test(sk) && /^https?:\/\//i.test(v)) {
          out.push({ url: trimUrl(v), avatar: AVATAR_KEY_RE.test(sk) });
        }
      }
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
      continue;
    }
    seen.set(key, {
      url: u.href,
      kind: c.avatar ? "avatar" : "content",
      source_tool: toolName,
      geolocation_candidate: !c.avatar,
    });
  }
  const all = [...seen.values()];
  return [...all.filter((l) => l.kind === "content"), ...all.filter((l) => l.kind === "avatar")].slice(0, MAX_MEDIA_LEADS);
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
