/**
 * tools/social.ts — Auto-extracted. Add imports manually.
 */
import { tool } from "npm:ai@6";
import { z } from "npm:zod@3";
import { createClient } from "npm:@supabase/supabase-js@2";
import type { GitHubCodeSearchResponse, GitHubCodeMatch } from "../api_types.ts";

/** One child node in a Reddit listing (about.json / user.json). */
interface RedditChild {
  kind?: string;
  data?: {
    subreddit?: string;
    title?: string;
    body?: string;
    permalink?: string;
    created_utc?: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/** Loose shape for the Reddit user.json / about.json responses. */
interface RedditResponse {
  data?: { children?: RedditChild[]; [k: string]: unknown };
  [k: string]: unknown;
}

/** One site entry in the DeepFind.Me profile-analyzer response. */
interface DeepFindSite {
  status?: string;
  site?: string;
  name?: string;
  url?: string;
  profile_url?: string;
  username?: string;
  [k: string]: unknown;
}

/** Loose shape for the DeepFind.Me analyzer response (only fields we read). */
interface DeepFindAnalyzerResponse {
  sites?: DeepFindSite[];
  summary?: unknown;
  [k: string]: unknown;
}

export const socialfetch_lookup = tool({
  description:
    "Query SocialFetch for normalized public social profiles. SUPPORTED platforms ONLY: 'tiktok' | 'instagram' | 'twitter' | 'facebook'. For ANY OTHER platform (youtube, twitch, soundcloud, bandcamp, roblox, github, reddit, linkedin, mastodon, etc.) DO NOT call this tool — prefer `jina_reader_scrape` on the profile URL (cleanest fallback), then `http_fingerprint`, `wayback_snapshots`, or `minimax_web_search`. SocialFetch quota is LOW — if it errors or returns nothing, retry the same profile URL via `jina_reader_scrape` instead of burning more SocialFetch calls. Unsupported platforms return an informative no-op instead of crashing. Use platform='facebook' with a full profile URL; otherwise pass a bare handle. kind='profile' for profile metadata, kind='videos' (TikTok only) for paginated videos.",
  inputSchema: z.object({
    platform: z.string(),
    handle: z.string().describe("Username/handle, or full URL for facebook"),
    kind: z.enum(["profile", "videos"]).default("profile"),
  }),
  execute: async ({ platform, handle, kind }) => {
    const p = String(platform || "").trim().toLowerCase();
    const SUPPORTED = new Set(["tiktok", "instagram", "twitter", "facebook"]);
    if (!SUPPORTED.has(p)) {
      return {
        ok: false,
        skipped: true,
        reason: `socialfetch_lookup does not support platform='${platform}'. Use http_fingerprint on the profile URL, wayback_snapshots, or minimax_web_search instead.`,
        supported: Array.from(SUPPORTED),
      };
    }
    if (!SOCIALFETCH_API_KEY) return { error: "SOCIALFETCH_API_KEY not configured" };
    try {
      let url: string;
      if (p === "facebook") {
        url = `https://api.socialfetch.dev/v1/facebook/profiles?url=${encodeURIComponent(handle)}`;
      } else if (p === "tiktok" && kind === "videos") {
        url = `https://api.socialfetch.dev/v1/tiktok/profiles/${encodeURIComponent(handle)}/videos`;
      } else {
        url = `https://api.socialfetch.dev/v1/${p}/profiles/${encodeURIComponent(handle)}`;
      }
      const r = await fetch(url, { headers: { "x-api-key": SOCIALFETCH_API_KEY } });
      const text = await r.text();
      let data: unknown;
      try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 4000) }; }
      return { ok: r.ok, status: r.status, data };
    } catch (e) {
      return { error: String(e) };
    }
  },
}),

export const cordcat_discord_lookup = tool({
  description:
    "CordCat Discord OSINT lookup. Given a 17-20 digit Discord snowflake user ID, returns the full Discord profile (username, global_name, avatar, banner, public_flags), DSA sanction statements, breach hits, and FiveM records in one call. ONLY accepts a numeric snowflake — NOT a Discord username/tag. If you only have a username, extract the snowflake first (jina_reader_scrape on a profile page, message link, or invite, or via discord.id-style lookups). Free plan budget: 60 req/hour — do not spam.",
  inputSchema: z.object({
    discord_id: z.string().regex(/^\d{17,20}$/, "Must be a 17-20 digit Discord snowflake ID"),
  }),
  execute: async ({ discord_id }) => {
    if (!CORDCAT_API_KEY) return { error: "CORDCAT_API_KEY not configured" };
    try {
      const r = await fetchRetry(
        `https://api.cord.cat/api/v2/query/${encodeURIComponent(discord_id)}`,
        { headers: { "X-API-Key": CORDCAT_API_KEY, "Accept": "application/json" } },
      );
      const text = await r.text();
      let data: unknown;
      try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 4000) }; }
      return {
        ok: r.ok,
        status: r.status,
        rate_remaining: r.headers.get("X-RateLimit-Remaining") ?? undefined,
        rate_reset: r.headers.get("X-RateLimit-Reset") ?? undefined,
        data,
      };
    } catch (e) {
      return { error: String(e) };
    }
  },
}),

export const username_sweep = tool({
  // Until then this is the edge-native built-in sweep.
  description:
    "Built-in Username Sweep: parallel HTTP existence check across ~95 platforms for a handle. Returns the list of sites where the handle resolves. Only call this on a handle with NO spaces. Do NOT call it on a full name or name+location seed — derive candidate handles first.",
  inputSchema: z.object({ username: z.string().min(1) }),
  execute: async ({ username }) => {
    if (/\s/.test(username.trim())) {
      return {
        ok: false,
        skipped: true,
        reason: "username_sweep requires a handle with no spaces; derive candidate handles first (firstlast, first.last, flast, etc.)",
        username,
      };
    }
    return await sweepUsername(username);
  },
}),

export const username_search = tool({
  description: "Alias of username_sweep: same edge-native ~95-site existence check. Same no-spaces rule applies.",
  inputSchema: z.object({ username: z.string().min(1) }),
  execute: async ({ username }) => {
    if (/\s/.test(username.trim())) {
      return {
        ok: false,
        skipped: true,
        reason: "username_search requires a handle with no spaces; derive candidate handles first",
        username,
      };
    }
    return await sweepUsername(username);
  },
}),

export const github_user = tool({
  description: "Fetch a GitHub user's public profile + recent public repos.",
  inputSchema: z.object({ username: z.string() }),
  execute: async ({ username }) => {
    try {
      const h = { "User-Agent": "Proximity-OSINT", Accept: "application/vnd.github+json" };
      const [uRes, rRes] = await Promise.all([
        fetch(`https://api.github.com/users/${encodeURIComponent(username)}`, { headers: h }),
        fetch(`https://api.github.com/users/${encodeURIComponent(username)}/repos?sort=updated&per_page=10`, { headers: h }),
      ]);
      const user = await uRes.json().catch(() => ({}));
      const repos = (await rRes.json().catch(() => [])) as Array<{ name: string; html_url: string; description: string; stargazers_count: number; language: string; updated_at: string }>;
      return {
        ok: uRes.ok,
        user,
        repos: Array.isArray(repos) ? repos.map((r) => ({ name: r.name, url: r.html_url, stars: r.stargazers_count, lang: r.language, updated: r.updated_at, desc: r.description })) : repos,
      };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const github_code_search = tool({
  description:
    "Search GitHub's public code index for a string (email, username, key fragment, internal hostname). Returns up to 20 file matches with repo and snippet. Authenticated via GITHUB_API_TOKEN (5,000 req/hr) when configured, else falls back to unauthenticated (60 req/hr).",
  inputSchema: z.object({ query: z.string() }),
  execute: async ({ query }) => {
    try {
      const headers: Record<string, string> = {
        "User-Agent": "Proximity-OSINT",
        Accept: "application/vnd.github.v3.text-match+json",
      };
      if (GITHUB_API_TOKEN) headers.Authorization = `Bearer ${GITHUB_API_TOKEN}`;
      const r = await fetch(`https://api.github.com/search/code?q=${encodeURIComponent(query)}&per_page=20`, { headers });
      const text = await r.text();
      let data: GitHubCodeSearchResponse = {};
      try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
      if (!r.ok) {
        const remaining = r.headers.get("x-ratelimit-remaining");
        const reset = r.headers.get("x-ratelimit-reset");
        console.warn(`[github_code_search] HTTP ${r.status} authed=${!!GITHUB_API_TOKEN} remaining=${remaining} reset=${reset} msg=${(data?.message ?? "").slice(0, 200)}`);
        return { error: `github ${r.status}`, status: r.status, authenticated: !!GITHUB_API_TOKEN, rate_remaining: remaining, message: data?.message, snippet: text.slice(0, 300) };
      }
      const items = (data?.items ?? []).map((i: GitHubCodeMatch) => ({
        repo: i.repository?.full_name, path: i.path, url: i.html_url,
        matches: ((i.text_matches as Array<{ fragment?: string }> | undefined) ?? []).map((m) => m.fragment).slice(0, 3),
      }));
      return { ok: true, authenticated: !!GITHUB_API_TOKEN, total: data?.total_count, items };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const reddit_user = tool({
  description: "Fetch a Reddit user's public profile and recent posts/comments.",
  inputSchema: z.object({ username: z.string() }),
  execute: async ({ username }) => {
    try {
      const h = { "User-Agent": "Proximity-OSINT/1.0" };
      const u = encodeURIComponent(username);
      const [about, posts] = await Promise.all([
        fetch(`https://www.reddit.com/user/${u}/about.json`, { headers: h }).then((r) => r.json()).catch(() => ({})),
        fetch(`https://www.reddit.com/user/${u}.json?limit=15`, { headers: h }).then((r) => r.json()).catch(() => ({})),
      ]);
      const items = ((posts as RedditResponse)?.data?.children ?? []).map((c: RedditChild) => ({
        kind: c.kind, subreddit: c.data?.subreddit, title: c.data?.title,
        body: c.data?.body?.slice?.(0, 300), url: c.data?.permalink ? `https://reddit.com${c.data.permalink}` : undefined,
        created: c.data?.created_utc,
      }));
      return { about: (about as RedditResponse)?.data, recent: items };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const hackernews_user = tool({
  description: "Fetch a Hacker News user profile (karma, about, account age, submitted item IDs).",
  inputSchema: z.object({ username: z.string() }),
  execute: async ({ username }) => {
    try {
      const r = await fetch(`https://hacker-news.firebaseio.com/v0/user/${encodeURIComponent(username)}.json`);
      const data = await r.json().catch(() => null);
      return { ok: r.ok && data != null, data };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const deepfind_profile_analyzer = tool({
  description:
    "DeepFind.Me deep profile analyzer — scans ~350 sites for a username (much wider than the local username_sweep's ~95). Use when the local sweep returns weak coverage or for high-value handles. Slow; one call burns ~1 minute on DeepFind's side.",
  inputSchema: z.object({ username: z.string().min(1) }),
  execute: async ({ username }) => {
    const KEY = Deno.env.get("DEEPFIND_API_KEY");
    if (!KEY) return { error: "DEEPFIND_API_KEY not configured" };
    try {
      const r = await fetch(`https://deepfind.me/api/analyzer/${encodeURIComponent(username)}`, {
        headers: { "X-DFME-API-KEY": KEY, "Accept": "application/json" },
      });
      const data = await r.json().catch(() => ({}));
      const d = data as DeepFindAnalyzerResponse;
      // Drop the long tail of "not found" sites (most of the ~350) — they
      // burn tokens without adding signal. Keep only confirmed hits.
      const allSites: DeepFindSite[] = Array.isArray(d?.sites) ? d.sites : [];
      const foundSites = allSites
        .filter((s) => s?.status === "found")
        .slice(0, 120)
        .map((s) => ({
          site: s?.site ?? s?.name,
          url: s?.url ?? s?.profile_url,
          username: s?.username,
        }));
      return {
        ok: r.ok,
        status: r.status,
        source: "deepfind.analyzer",
        data: {
          hits: allSites.filter((s) => s?.status === "found").length,
          scanned: allSites.length,
          summary: d?.summary,
          sites: foundSites,
          truncated_not_found: true,
        },
      };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const deepfind_telegram_channel = tool({
  description:
    "DeepFind.Me Telegram channel lookup. Returns channel metadata + recent visible messages for a public Telegram handle.",
  inputSchema: z.object({ handle: z.string().min(1) }),
  execute: async ({ handle }) => {
    const KEY = Deno.env.get("DEEPFIND_API_KEY");
    if (!KEY) return { error: "DEEPFIND_API_KEY not configured" };
    const clean = handle.replace(/^@/, "").replace(/^https?:\/\/t\.me\//i, "").replace(/^s\//, "");
    try {
      const r = await fetch(`https://deepfind.me/api/telegram-osint/channel`, {
        method: "POST",
        headers: { "X-DFME-API-KEY": KEY, "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ handle: clean }),
      });
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, source: "deepfind.telegram_channel", data };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const deepfind_telegram_search = tool({
  description:
    "DeepFind.Me Telegram channel keyword search — discover public channels matching a topic.",
  inputSchema: z.object({ query: z.string().min(2) }),
  execute: async ({ query }) => {
    const KEY = Deno.env.get("DEEPFIND_API_KEY");
    if (!KEY) return { error: "DEEPFIND_API_KEY not configured" };
    try {
      const r = await fetch(`https://deepfind.me/api/telegram-osint/search`, {
        method: "POST",
        headers: { "X-DFME-API-KEY": KEY, "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ query }),
      });
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, source: "deepfind.telegram_search", data };
    } catch (e) { return { error: String(e) }; }
  },
}),

