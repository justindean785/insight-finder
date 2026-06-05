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
}

interface SweepResult {
  username: string;
  total: number;
  hits: number;
  found: Array<Record<string, unknown>>;
  missed: string[];
  skipped_due_to_budget: number;
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

  const results: Array<Record<string, unknown>> = [];
  const queue = [...sites];

  const runOne = async (s: SweepSite) => {
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
      let found = r.ok;
      if (typeof s.absent === "number") {
        found = r.status !== s.absent && r.status < 400;
      } else if (typeof s.absent === "string" && r.ok) {
        const body = await r.text().catch(() => "");
        found = !body.includes(s.absent);
      }
      return { site: s.name, url: s.url, status: r.status, found };
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
  const skipped = results.filter((r) => (r as any).error === "budget exhausted").length;

  return {
    username,
    total: results.length,
    hits: hits.length,
    found: hits,
    missed: results.filter((r) => !r.found).map((r) => (r as any).site),
    skipped_due_to_budget: skipped,
  };
}
