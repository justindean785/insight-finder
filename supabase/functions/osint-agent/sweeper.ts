/**
 * sweeper.ts — Built-in "Username Sweep" — an edge-native, in-process HTTP
 * existence check across ~95 platforms.
 * Extracted from index.ts (lines 1501–1654).
 *
 * This is intentionally NOT Sherlock or Maigret: those are Python tools that
 * require a long-running host with subprocess + filesystem access, which
 * Supabase Edge Functions don't provide. If you ever want the real
 * Sherlock/Maigret breadth, stand up an external worker service and wire it
 * in with the env vars listed at the TODO block near `username_sweep`.
 */

interface SweepSite {
  name: string;
  url: string;
  absent?: number | string;
  /** The generic username-echo test carries NO information on this platform:
   *  measured against a guaranteed-nonexistent handle, the site answered 2xx
   *  AND echoed the requested handle into a high-signal region, so
   *  `bodyEvidencesAccount` proved a registration that cannot exist.
   *
   *  Set ONLY from that measurement, never from a guess. A site marked here can
   *  still be proven — by a `confirm` marker — but it can never again be proven
   *  by echo alone. Without a marker it reports `unverified`, which is the
   *  honest answer for a platform that cannot distinguish absence.
   *
   *  Why this and not a `confirm` marker: the comment below is right that a
   *  marker must be measured against a live profile, and measuring "this page
   *  proves a real account" needs a known-real account on each platform. The
   *  negative is what was actually measured, so the negative is what is encoded.
   */
  echoUnsafe?: true;
  /** Optional body marker that PROVES a real profile (beats the generic
   *  username-echo test below). Use when a platform renders a profile without
   *  echoing the handle, or echoes it on its not-found page.
   *
   *  DELIBERATELY UNPOPULATED. Every marker here has to be measured against the
   *  live platform — inventing plausible-looking strings would manufacture the
   *  same false confidence this file exists to remove. Until a platform is
   *  actually measured it stays on the generic echo test, and anything that
   *  test cannot prove is reported as `unverified` rather than as a hit.
   *
   *  This is also the ONLY way to prove a handle shorter than MIN_ECHO_LEN:
   *  such handles fail the echo test by construction, so a site with no
   *  `confirm` marker will always report them unverified. That is intentional
   *  — an unproven lead is the honest answer — but it means short-handle
   *  coverage is the first thing per-platform measurement should buy back. */
  confirm?: string;
}

/**
 * One vocabulary for what a probe established. Deliberately mirrors the
 * tool_usage_log outcome axis so a sweep row and an orchestrator row can be
 * read the same way:
 *
 *   found      — positive evidence: a `confirm` marker, or a whole-token echo
 *                of a handle at least MIN_ECHO_LEN long.
 *   not_found  — PROVEN absence, and only three things prove it: the site's
 *                configured `absent` status, its configured `absent` body
 *                marker, or a bare 404/410 — the statuses that mean "no such
 *                resource". Nothing else may claim absence.
 *   unverified — reached, nothing proved either way. Covers a 2xx whose body
 *                does not evidence the account AND a refusal (401/403/451):
 *                the account may exist behind the wall. A lead, never a hit.
 *   error      — the question was never answered: 5xx, 429, a timeout, a
 *                network failure, or budget exhaustion. Establishes NOTHING,
 *                which is why none of these land in `missed`.
 */
export type SweepOutcome = "found" | "not_found" | "unverified" | "error";

interface SweepSiteResult {
  site: string;
  url: string;
  /** Kept as the primary field: `found[]`/`hits` consumers read it directly. */
  found: boolean;
  outcome: SweepOutcome;
  /** 2xx/3xx, but nothing in the body evidenced the account. A LEAD, not a hit. */
  unverified?: boolean;
  status?: number;
  error?: string;
}

interface SweepResult {
  username: string;
  total: number;
  /** CONFIRMED registrations only — never includes `unverified`. */
  hits: number;
  found: SweepSiteResult[];
  /** Reachable but unevidenced. Surfaced so they can be chased, NOT counted. */
  unverified: SweepSiteResult[];
  /** PROVEN absence only — never includes `unverified` or `errored`. */
  missed: string[];
  /** Unreachable. Establishes nothing either way. */
  errored: string[];
  skipped_due_to_budget: number;
}

/**
 * Read at most `maxBytes` of a response body, then cancel the stream.
 *
 * The existence check now needs the BODY for every site (not just the six with
 * string markers), so this bounds the added cost: a profile page names its owner
 * in the <title>/og: tags long before 64KB, and we never buffer a whole page.
 */
async function readCapped(r: Response, maxBytes = 65536): Promise<string> {
  if (!r.body) return "";
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
      }
    }
  } catch {
    // A truncated body is still usable evidence.
  } finally {
    try {
      await reader.cancel();
    } catch { /* already closed */ }
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

/**
 * Does the page actually evidence THIS account?
 *
 * A soft-404 (HTTP 200 carrying a signup form or an SPA shell) is the failure
 * this guards: measured 2026-08-06, `pypi.org/user/<anything>/` returns 200 with
 * a body that never names the user, and the status-only check counted it as a
 * registration. The same shape produced the Bandcamp "domain is available /
 * unclaimed", HackTheBox "Not Found" and Bluesky empty-profile hits that the
 * analyst had already marked FALSE on an earlier case.
 *
 * Deliberately conservative: it can under-report a JS-rendered profile that
 * never prints the handle server-side. Those do not vanish — they are reported
 * as `unverified` leads, which is the honest label for "reachable, unproven".
 *
 * TWO GUARDS make the echo test evidence rather than coincidence:
 *
 *  1. WHOLE-TOKEN. A bare `includes()` matched the handle inside any longer
 *     run of characters — "ben" hits "benchmark", a CSS class, a minified
 *     identifier, a base64 blob. That is the same defect this PR exists to
 *     remove, only inverted: unproven presence dressed up as a hit. The handle
 *     must sit on a token boundary.
 *  2. LENGTH FLOOR. Below MIN_ECHO_LEN even a whole-token match is coincidence
 *     — short strings occur as standalone tokens all over ordinary HTML, in
 *     attribute values, minified identifiers and stop-words. Such a handle can
 *     only be proven by an explicit `confirm` marker, so absent one it comes
 *     back `unverified`, never as a hit.
 */
const MIN_ECHO_LEN = 5;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does `hay` contain `needle` as a whole token? Both must be lowercased.
 *
 * The token alphabet includes `-` as well as `_`, which matters more than it
 * looks: hyphens are legal in handles on most of these platforms, so `mercury`
 * and `mercury-banner` are genuinely DIFFERENT handles, not one inside the
 * other. Leaving `-` as a delimiter let every hyphenated CSS class, utility
 * class and BEM modifier in a stylesheet read as an echo of the account —
 * `class="mercury-banner"` scored a registration for `mercury`. Caught by the
 * CSS-class case in sweeper_evidence_test.ts.
 */
function echoesHandle(hay: string, needle: string): boolean {
  return new RegExp(`(^|[^a-z0-9_-])${escapeRe(needle)}([^a-z0-9_-]|$)`).test(hay);
}

/**
 * GUARD 3 — WHERE the echo appears decides whether it is evidence.
 *
 * The residual this closes: a platform that repeats the REQUESTED handle on its
 * own not-found page — "No account named mercury", a canonical URL echoing the
 * path, a hydration blob carrying the query — passed the whole-body echo test
 * and scored a registration. Guards 1 and 2 cannot see it, because the echo is
 * a genuine whole-token occurrence of a long-enough handle. Only its LOCATION
 * distinguishes "this page is that account's profile" from "this page is
 * repeating what you asked for".
 *
 * A real profile names its owner in the document's identity surface: the
 * <title>, the Open Graph tags a link preview would use, or the canonical URL.
 * An error page names the request in its body text. So the echo is now sought
 * ONLY in those regions.
 *
 * ONE-WAY RATCHET. Restricting where evidence may be found can only ever
 * REMOVE proof, never manufacture it: every region is a substring of the body,
 * so a region match implies a body match. Therefore the only transition this
 * guard can cause is `found -> unverified`. It cannot turn `unverified` into
 * `found`, and it cannot touch `not_found`, which is decided by the definitive
 * absent signals BEFORE any body is read. `regionEchoImpliesBodyEcho` is
 * exported so that invariant is asserted rather than asserted-about.
 *
 * The cost is real and accepted: a profile that names its owner only in
 * JS-rendered body content degrades to `unverified` — a visible lead, which is
 * the honest label for "reachable, unproven", and the direction this file
 * already errs in.
 */
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/gi;
const OG_META_RE = /<meta\b[^>]*\b(?:property|name)\s*=\s*["']og:[^"']*["'][^>]*>/gi;
const CANONICAL_LINK_RE = /<link\b[^>]*\brel\s*=\s*["'](?:canonical|alternate)["'][^>]*>/gi;
const ATTR_RE = /\b(?:content|href)\s*=\s*["']([^"']*)["']/i;

/**
 * Regions whose CONTENT is not markup, even when it looks like markup.
 *
 * Stripped BEFORE anything is extracted, and in this order, because that is
 * how HTML actually tokenizes: inside a raw-text element `<!--` is not a
 * comment opener, so removing raw text first and comments second is faithful
 * where the reverse would mangle a script containing `-->`.
 *
 * Why this exists: matching `<title>…</title>` across the whole document meant
 * a literal `"<title>mercury</title>"` inside a script string, an HTML comment,
 * or a <template> was extracted as the page's title and scored as proof. All
 * three were reproduced. The region rule was sound; reading regions with a
 * document-wide regex was not.
 */
const RAW_TEXT_RE = /<(script|style|textarea|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
const HEAD_RE = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/i;

/**
 * The document's identity surface: <title> text, og:* content values, and
 * canonical/alternate hrefs. Nothing else — deliberately not the body, not
 * twitter: cards, not JSON-LD. Widening this set widens the false-positive
 * surface it exists to close.
 *
 * Two narrowings beyond "run the regexes":
 *  1. Raw-text elements and comments are removed first, so markup-shaped TEXT
 *     can never be read as markup.
 *  2. <title> is taken from <head> when the document has one. A <title> in the
 *     body is not the document's title; browsers only honour the one in head.
 *     Documents that omit <head> entirely fall back to the stripped document,
 *     which is still safe because step 1 already ran.
 */
export function highSignalRegions(body: string): string {
  if (!body) return "";
  const clean = body.replace(RAW_TEXT_RE, " ").replace(COMMENT_RE, " ");
  const head = HEAD_RE.exec(clean)?.[1];
  const titleScope = head ?? clean;
  const parts: string[] = [];
  for (const m of titleScope.matchAll(TITLE_RE)) parts.push(m[1] ?? "");
  for (const re of [OG_META_RE, CANONICAL_LINK_RE]) {
    for (const m of clean.matchAll(re)) {
      const attr = ATTR_RE.exec(m[0]);
      if (attr) parts.push(attr[1]);
    }
  }
  return parts.join("\n");
}

/** The pre-2.11 test, kept ONLY so the ratchet invariant can be asserted. */
export function echoAnywhereInBody(body: string, username: string): boolean {
  const u = String(username ?? "").trim().toLowerCase();
  if (!body || u.length < MIN_ECHO_LEN) return false;
  return echoesHandle(body.toLowerCase(), u);
}

/**
 * The ratchet, as a checkable property: a region echo ALWAYS implies a body
 * echo. If this ever returns false the restriction has stopped being a
 * narrowing and has started inventing evidence.
 */
export function regionEchoImpliesBodyEcho(body: string, username: string): boolean {
  return !bodyEvidencesAccount(body, username) || echoAnywhereInBody(body, username);
}

function bodyEvidencesAccount(body: string, username: string): boolean {
  if (!body || !username) return false;
  const u = username.trim().toLowerCase();
  // Short handles are unprovable by echo alone — see guard 2 above.
  if (u.length < MIN_ECHO_LEN) return false;
  return echoesHandle(highSignalRegions(body).toLowerCase(), u);
}

/**
 * Positive-evidence decision for one fetched page. Exported so the precedence
 * rule can be tested directly: no site in the table configures `confirm` yet,
 * so it is unreachable through `sweepUsername`.
 *
 * A configured `confirm` marker REPLACES the generic echo test rather than
 * racing it. Under the earlier `(confirm && …) || echo` form, a site whose
 * not-found page repeats the requested handle still passed on the echo even
 * after a marker was configured for it — so the one mechanism capable of
 * fixing that platform could never take effect. If a marker is configured, it
 * is the whole test.
 */
export function accountIsProven(
  site: Pick<SweepSite, "confirm" | "echoUnsafe">,
  body: string,
  username: string,
): boolean {
  if (site.confirm) return body.includes(site.confirm);
  // Measured-unsafe echo: proving by handle-echo here is proving nothing, so
  // the honest result is "unverified", never a counted hit. Checked AFTER
  // `confirm` so a measured marker still promotes the site back to provable.
  if (site.echoUnsafe) return false;
  return bodyEvidencesAccount(body, username);
}

/**
 * Check ~95 platforms for the presence of a given username.
 * Uses concurrency=16, per-request timeout=6s, total budget=25s.
 */
export async function sweepUsername(username: string): Promise<SweepResult> {
  const u = encodeURIComponent(username);
  const sites: SweepSite[] = [
    { name: "GitHub", url: `https://github.com/${u}`, absent: 404 },
    { name: "GitLab", url: `https://gitlab.com/${u}`, absent: 404 },
    { name: "Twitter/X", url: `https://x.com/${u}`, absent: 404 },
    { name: "Instagram", url: `https://www.instagram.com/${u}/`, absent: 404 },
    { name: "TikTok", url: `https://www.tiktok.com/@${u}`, absent: "Couldn't find this account" },
    { name: "Reddit", url: `https://www.reddit.com/user/${u}/about.json` },
    { name: "Medium", url: `https://medium.com/@${u}`, absent: 404 },
    { name: "Pinterest", url: `https://www.pinterest.com/${u}/`, absent: 404 },
    { name: "Vimeo", url: `https://vimeo.com/${u}`, absent: 404 },
    { name: "Twitch", url: `https://www.twitch.tv/${u}`, absent: 404 },
    { name: "YouTube", url: `https://www.youtube.com/@${u}`, absent: 404 },
    { name: "DEV.to", url: `https://dev.to/${u}`, absent: 404 },
    { name: "HackerNews", url: `https://news.ycombinator.com/user?id=${u}`, absent: "No such user" },
    { name: "Keybase", url: `https://keybase.io/${u}`, absent: 404 },
    { name: "ProductHunt", url: `https://www.producthunt.com/@${u}`, absent: 404 },
    { name: "Behance", url: `https://www.behance.net/${u}`, absent: 404 },
    { name: "Dribbble", url: `https://dribbble.com/${u}`, absent: 404 },
    { name: "Flickr", url: `https://www.flickr.com/people/${u}`, absent: 404 },
    { name: "Spotify", url: `https://open.spotify.com/user/${u}`, absent: 404, echoUnsafe: true },
    { name: "SoundCloud", url: `https://soundcloud.com/${u}`, absent: 404 },
    { name: "Bandcamp", url: `https://${u}.bandcamp.com`, absent: 404 },
    { name: "Patreon", url: `https://www.patreon.com/${u}`, absent: 404 },
    { name: "Steam", url: `https://steamcommunity.com/id/${u}`, absent: "The specified profile could not be found" },
    { name: "Roblox", url: `https://www.roblox.com/user.aspx?username=${u}`, absent: "Page cannot be found" },
    { name: "Wikipedia", url: `https://en.wikipedia.org/wiki/User:${u}`, absent: "Wikipedia does not have a" },
    { name: "Telegram", url: `https://t.me/${u}`, absent: "tgme_page_title", echoUnsafe: true },
    { name: "About.me", url: `https://about.me/${u}`, absent: 404 },
    { name: "Gravatar", url: `https://en.gravatar.com/${u}`, absent: 404 },
    { name: "Replit", url: `https://replit.com/@${u}`, absent: 404 },
    { name: "Linktree", url: `https://linktr.ee/${u}`, absent: 404 },
    // --- Sherlock/Maigret-style extended sweep ---
    { name: "Bluesky", url: `https://bsky.app/profile/${u}.bsky.social`, absent: 400 },
    { name: "Threads", url: `https://www.threads.net/@${u}`, absent: 404 },
    { name: "Tumblr", url: `https://${u}.tumblr.com`, absent: 404 },
    { name: "DeviantArt", url: `https://www.deviantart.com/${u}`, absent: 404 },
    { name: "Snapchat", url: `https://www.snapchat.com/add/${u}`, absent: 404 },
    { name: "Last.fm", url: `https://www.last.fm/user/${u}`, absent: 404 },
    { name: "Mixcloud", url: `https://www.mixcloud.com/${u}/`, absent: 404, echoUnsafe: true },
    { name: "Discogs", url: `https://www.discogs.com/user/${u}`, absent: 404 },
    { name: "Genius", url: `https://genius.com/${u}`, absent: 404 },
    { name: "RateYourMusic", url: `https://rateyourmusic.com/~${u}`, absent: 404 },
    { name: "Goodreads", url: `https://www.goodreads.com/${u}`, absent: 404 },
    { name: "Letterboxd", url: `https://letterboxd.com/${u}/`, absent: 404 },
    { name: "MyAnimeList", url: `https://myanimelist.net/profile/${u}`, absent: 404 },
    { name: "AniList", url: `https://anilist.co/user/${u}`, absent: 404 },
    { name: "Trakt", url: `https://trakt.tv/users/${u}`, absent: 404, echoUnsafe: true },
    { name: "IMDb", url: `https://www.imdb.com/user/${u}/`, absent: 404 },
    { name: "Quora", url: `https://www.quora.com/profile/${u}`, absent: 404 },
    { name: "Disqus", url: `https://disqus.com/by/${u}/`, absent: 404 },
    { name: "Slideshare", url: `https://www.slideshare.net/${u}`, absent: 404 },
    { name: "Wattpad", url: `https://www.wattpad.com/user/${u}`, absent: 404 },
    { name: "FanFiction", url: `https://www.fanfiction.net/u/${u}`, absent: 404 },
    { name: "ArchiveOfOurOwn", url: `https://archiveofourown.org/users/${u}`, absent: 404 },
    { name: "BuyMeACoffee", url: `https://www.buymeacoffee.com/${u}`, absent: 404 },
    { name: "Ko-fi", url: `https://ko-fi.com/${u}`, absent: 404 },
    { name: "Gumroad", url: `https://${u}.gumroad.com`, absent: 404 },
    { name: "Fiverr", url: `https://www.fiverr.com/${u}`, absent: 404 },
    { name: "Upwork", url: `https://www.upwork.com/freelancers/${u}`, absent: 404 },
    { name: "Etsy", url: `https://www.etsy.com/shop/${u}`, absent: 404 },
    { name: "itch.io", url: `https://${u}.itch.io`, absent: 404 },
    { name: "GameJolt", url: `https://gamejolt.com/@${u}`, absent: 404 },
    { name: "Newgrounds", url: `https://${u}.newgrounds.com`, absent: 404 },
    { name: "Strava", url: `https://www.strava.com/athletes/${u}`, absent: 404 },
    { name: "Untappd", url: `https://untappd.com/user/${u}`, absent: 404 },
    { name: "Chess.com", url: `https://www.chess.com/member/${u}`, absent: 404 },
    { name: "Lichess", url: `https://lichess.org/@/${u}`, absent: 404 },
    { name: "Codeforces", url: `https://codeforces.com/profile/${u}`, absent: 404 },
    { name: "LeetCode", url: `https://leetcode.com/${u}/`, absent: 404 },
    { name: "HackerRank", url: `https://www.hackerrank.com/${u}`, absent: 404, echoUnsafe: true },
    { name: "HackTheBox", url: `https://app.hackthebox.com/profile/${u}`, absent: 404 },
    { name: "TryHackMe", url: `https://tryhackme.com/p/${u}`, absent: 404 },
    { name: "Kaggle", url: `https://www.kaggle.com/${u}`, absent: 404 },
    { name: "Bitbucket", url: `https://bitbucket.org/${u}/`, absent: 404 },
    { name: "Codepen", url: `https://codepen.io/${u}`, absent: 404 },
    { name: "JsFiddle", url: `https://jsfiddle.net/user/${u}/`, absent: 404 },
    { name: "npm", url: `https://www.npmjs.com/~${u}`, absent: 404 },
    { name: "PyPI", url: `https://pypi.org/user/${u}/`, absent: 404 },
    { name: "RubyGems", url: `https://rubygems.org/profiles/${u}`, absent: 404 },
    { name: "DockerHub", url: `https://hub.docker.com/u/${u}`, absent: 404 },
    { name: "StackOverflow", url: `https://stackoverflow.com/users/${u}`, absent: 404 },
    { name: "AngelList/Wellfound", url: `https://wellfound.com/u/${u}`, absent: 404 },
    { name: "OpenStreetMap", url: `https://www.openstreetmap.org/user/${u}`, absent: 404 },
    { name: "Pastebin", url: `https://pastebin.com/u/${u}`, absent: 404 },
    { name: "Giphy", url: `https://giphy.com/${u}`, absent: 404 },
    { name: "VSCO", url: `https://vsco.co/${u}/gallery`, absent: 404 },
    { name: "Ello", url: `https://ello.co/${u}`, absent: 404 },
    { name: "500px", url: `https://500px.com/p/${u}`, absent: 404 },
    { name: "Foursquare", url: `https://foursquare.com/${u}`, absent: 404 },
    { name: "Hashnode", url: `https://hashnode.com/@${u}`, absent: 404 },
    { name: "Polywork", url: `https://www.polywork.com/${u}`, absent: 404 },
    { name: "Read.cv", url: `https://read.cv/${u}`, absent: 404 },
    { name: "Substack", url: `https://${u}.substack.com`, absent: 404 },
    { name: "Mastodon.social", url: `https://mastodon.social/@${u}`, absent: 404 },
    { name: "Minecraft (NameMC)", url: `https://namemc.com/profile/${u}`, absent: 404, echoUnsafe: true },
    { name: "Xbox Gamertag", url: `https://account.xbox.com/profile?gamertag=${u}`, absent: 404 },
    { name: "OK.ru", url: `https://ok.ru/${u}`, absent: 404 },
    { name: "VK", url: `https://vk.com/${u}`, absent: 404 },
    { name: "Weibo", url: `https://weibo.com/${u}`, absent: 404 },
    { name: "Douban", url: `https://www.douban.com/people/${u}/`, absent: 404 },
    { name: "NameMC Skin", url: `https://namemc.com/search?q=${u}`, absent: 404 },
  ];

  const ua = "Mozilla/5.0 (compatible; Proximity-OSINT/1.0)";
  // Concurrency-capped sweep. Firing 95 parallel fetches with 8s timeouts
  // can pin the edge function on a single seed; cap to 16 in-flight at a
  // time and total-budget the whole sweep.
  const CONCURRENCY = 16;
  const PER_REQ_TIMEOUT_MS = 6000;
  const TOTAL_BUDGET_MS = 25000;
  const sweepDeadline = Date.now() + TOTAL_BUDGET_MS;

  const results: SweepSiteResult[] = [];
  const queue = [...sites];

  const runOne = async (s: SweepSite): Promise<SweepSiteResult> => {
    if (Date.now() > sweepDeadline) {
      return { site: s.name, url: s.url, error: "budget exhausted", found: false, outcome: "error" };
    }
    const ctrl = new AbortController();
    const remaining = Math.max(500, sweepDeadline - Date.now());
    const timeoutMs = Math.min(PER_REQ_TIMEOUT_MS, remaining);
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(s.url, {
        headers: { "User-Agent": ua },
        redirect: "follow",
        signal: ctrl.signal,
      });

      // 1. ABSENCE MUST BE PROVEN, and only two things prove it: the site's
      //    configured `absent` status, or a bare 404/410 on a profile URL —
      //    the one status whose meaning IS "no such resource".
      //
      //    Everything else that happens to be >= 400 proves NOTHING about the
      //    account. A 403 is an interposing proxy or a bot wall; 429 is a rate
      //    limit; 451 is a legal block; 5xx is the platform failing. Treating
      //    those as absence is the same category error as treating a 200 as
      //    presence, and it is not hypothetical: probing this sweep's estate
      //    from the build environment returned 403 for 92 of 99 sites, every
      //    one of which the old `r.status >= 400` rule scored as a proven
      //    absence.
      if (typeof s.absent === "number" && r.status === s.absent) {
        return { site: s.name, url: s.url, status: r.status, found: false, outcome: "not_found" };
      }
      if (r.status === 404 || r.status === 410) {
        return { site: s.name, url: s.url, status: r.status, found: false, outcome: "not_found" };
      }
      if (r.status >= 500 || r.status === 429) {
        // The platform never answered the question. Not a lead either.
        return {
          site: s.name, url: s.url, status: r.status, found: false,
          outcome: "error", error: `upstream ${r.status}`,
        };
      }
      if (r.status >= 400) {
        // Reached something, was refused (401/403/451/…). Inconclusive: the
        // account may well exist behind the wall, so it stays a lead.
        return {
          site: s.name, url: s.url, status: r.status, found: false,
          outcome: "unverified", unverified: true, error: `blocked ${r.status}`,
        };
      }

      const body = await readCapped(r);
      if (typeof s.absent === "string" && body.includes(s.absent)) {
        return { site: s.name, url: s.url, status: r.status, found: false, outcome: "not_found" };
      }

      // 2. A 2xx is NOT proof of registration — require positive evidence.
      //    Absent that, this is an unverified lead, never a counted hit.
      //
      //    A configured `confirm` marker REPLACES the generic echo test rather
      //    than racing it. Under `(confirm && …) || echo` a site whose 404 page
      //    repeats the requested handle still passed on the echo even after a
      //    marker was configured for it — so the one mechanism able to fix that
      //    platform could never actually take effect. If a marker is configured,
      //    it is the whole test.
      const proven = accountIsProven(s, body, username);
      return {
        site: s.name,
        url: s.url,
        status: r.status,
        found: Boolean(proven),
        outcome: proven ? "found" : "unverified",
        ...(proven ? {} : { unverified: true }),
      };
    } catch (e) {
      return { site: s.name, url: s.url, error: String(e), found: false, outcome: "error" };
    } finally {
      clearTimeout(t);
    }
  };

  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const s = queue.shift();
      if (!s) break;
      results.push(await runOne(s));
    }
  });
  await Promise.all(workers);

  const hits = results.filter((r) => r.found);
  const unverified = results.filter((r) => r.unverified);
  const skipped = results.filter((r) => r.error === "budget exhausted").length;

  return {
    username,
    total: results.length,
    hits: hits.length,
    found: hits,
    unverified,
    // `missed` stays "everything not confirmed" for existing callers, but the
    // unverified sites are listed separately above so a caller can tell a
    // proven absence from an unproven presence.
    // PROVEN absence only. A site we never reached establishes nothing, so it
    // is reported under `errored` instead of being counted as "not there" —
    // the same honesty rule the unverified split applies to soft-404s.
    missed: results.filter((r) => r.outcome === "not_found").map((r) => r.site),
    errored: results.filter((r) => r.outcome === "error").map((r) => r.site),
    skipped_due_to_budget: skipped,
  };
}
