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

interface SweepSiteResult {
  site: string;
  url: string;
  found: boolean;
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
  missed: string[];
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
 *     — three characters occur as a standalone token all over ordinary HTML.
 *     Such a handle can only be proven by an explicit `confirm` marker, so
 *     absent one it comes back `unverified`, never as a hit.
 */
const MIN_ECHO_LEN = 4;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Does `hay` contain `needle` as a whole token? Both must be lowercased. */
function echoesHandle(hay: string, needle: string): boolean {
  return new RegExp(`(^|[^a-z0-9_])${escapeRe(needle)}([^a-z0-9_]|$)`).test(hay);
}

function bodyEvidencesAccount(body: string, username: string): boolean {
  if (!body || !username) return false;
  const u = username.trim().toLowerCase();
  // Short handles are unprovable by echo alone — see guard 2 above.
  if (u.length < MIN_ECHO_LEN) return false;
  return echoesHandle(body.toLowerCase(), u);
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
    { name: "Spotify", url: `https://open.spotify.com/user/${u}`, absent: 404 },
    { name: "SoundCloud", url: `https://soundcloud.com/${u}`, absent: 404 },
    { name: "Bandcamp", url: `https://${u}.bandcamp.com`, absent: 404 },
    { name: "Patreon", url: `https://www.patreon.com/${u}`, absent: 404 },
    { name: "Steam", url: `https://steamcommunity.com/id/${u}`, absent: "The specified profile could not be found" },
    { name: "Roblox", url: `https://www.roblox.com/user.aspx?username=${u}`, absent: "Page cannot be found" },
    { name: "Wikipedia", url: `https://en.wikipedia.org/wiki/User:${u}`, absent: "Wikipedia does not have a" },
    { name: "Telegram", url: `https://t.me/${u}`, absent: "tgme_page_title" },
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
    { name: "Mixcloud", url: `https://www.mixcloud.com/${u}/`, absent: 404 },
    { name: "Discogs", url: `https://www.discogs.com/user/${u}`, absent: 404 },
    { name: "Genius", url: `https://genius.com/${u}`, absent: 404 },
    { name: "RateYourMusic", url: `https://rateyourmusic.com/~${u}`, absent: 404 },
    { name: "Goodreads", url: `https://www.goodreads.com/${u}`, absent: 404 },
    { name: "Letterboxd", url: `https://letterboxd.com/${u}/`, absent: 404 },
    { name: "MyAnimeList", url: `https://myanimelist.net/profile/${u}`, absent: 404 },
    { name: "AniList", url: `https://anilist.co/user/${u}`, absent: 404 },
    { name: "Trakt", url: `https://trakt.tv/users/${u}`, absent: 404 },
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
    { name: "HackerRank", url: `https://www.hackerrank.com/${u}`, absent: 404 },
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
    { name: "Minecraft (NameMC)", url: `https://namemc.com/profile/${u}`, absent: 404 },
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
      return { site: s.name, url: s.url, error: "budget exhausted", found: false };
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

      // 1. Definitive ABSENT signals. A trusted negative ends it here.
      if (typeof s.absent === "number" && r.status === s.absent) {
        return { site: s.name, url: s.url, status: r.status, found: false };
      }
      if (r.status >= 400) {
        return { site: s.name, url: s.url, status: r.status, found: false };
      }

      const body = await readCapped(r);
      if (typeof s.absent === "string" && body.includes(s.absent)) {
        return { site: s.name, url: s.url, status: r.status, found: false };
      }

      // 2. A 2xx is NOT proof of registration — require positive evidence.
      //    Absent that, this is an unverified lead, never a counted hit.
      const proven = (s.confirm && body.includes(s.confirm)) ||
        bodyEvidencesAccount(body, username);
      return {
        site: s.name,
        url: s.url,
        status: r.status,
        found: Boolean(proven),
        ...(proven ? {} : { unverified: true }),
      };
    } catch (e) {
      return { site: s.name, url: s.url, error: String(e), found: false };
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
    missed: results.filter((r) => !r.found).map((r) => r.site),
    skipped_due_to_budget: skipped,
  };
}
