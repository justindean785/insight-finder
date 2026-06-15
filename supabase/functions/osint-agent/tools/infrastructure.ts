/**
 * tools/infrastructure.ts — Auto-extracted. Add imports manually.
 */
import { tool } from "npm:ai@6";
import { z } from "npm:zod@3";
import { createClient } from "npm:@supabase/supabase-js@2";

/** One result from the urlscan.io public search API (only fields we read). */
interface UrlscanResult {
  page?: { url?: string; domain?: string; ip?: string; asn?: string; country?: string };
  task?: { time?: string };
  screenshot?: string;
  result?: string;
  [k: string]: unknown;
}

export const whois_lookup = tool({
  description: "RDAP/WHOIS lookup for a domain.",
  inputSchema: z.object({ domain: z.string() }),
  execute: async ({ domain }) => {
    try {
      const r = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`);
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, data };
    } catch (e) {
      return { error: String(e) };
    }
  },
}),

export const crtsh_subdomains = tool({
  description: "Enumerate subdomains for a domain via crt.sh certificate transparency logs.",
  inputSchema: z.object({ domain: z.string() }),
  execute: async ({ domain }) => {
    try {
      const r = await fetch(`https://crt.sh/?q=%25.${encodeURIComponent(domain)}&output=json`);
      const data = (await r.json().catch(() => [])) as Array<{ name_value?: string }>;
      const subs = Array.from(new Set(data.flatMap((d) => (d.name_value ?? "").split("\n")).map((s) => s.trim().toLowerCase()).filter(Boolean))).slice(0, 200);
      return { domain, count: subs.length, subdomains: subs };
    } catch (e) {
      return { error: String(e) };
    }
  },
}),

export const dns_records = tool({
  description: "Resolve DNS records (A, AAAA, MX, NS, TXT, CNAME) for a hostname via Cloudflare DoH.",
  inputSchema: z.object({ host: z.string(), types: z.array(z.enum(["A","AAAA","MX","NS","TXT","CNAME","SOA"])).default(["A","MX","NS","TXT"]) }),
  execute: async ({ host, types }) => {
    try {
      const out: Record<string, unknown> = {};
      await Promise.all(types.map(async (t) => {
        const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=${t}`, { headers: { Accept: "application/dns-json" } });
        const j = await r.json().catch(() => ({}));
        out[t] = (j as { Answer?: Array<{ data: string }> }).Answer?.map((a) => a.data) ?? [];
      }));
      return { host, records: out };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const shodan_internetdb = tool({
  description:
    "Free, no-auth Shodan InternetDB lookup for an IP. Returns open ports, hostnames, CPEs, tags, and known CVEs. Use on every IP after ip_intel.",
  inputSchema: z.object({ ip: z.string() }),
  execute: async ({ ip }) => {
    try {
      const r = await fetch(`https://internetdb.shodan.io/${encodeURIComponent(ip)}`);
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, data };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const ip_intel = tool({
  description: "Geolocate an IP and return ISP, ASN, city, country.",
  inputSchema: z.object({ ip: z.string() }),
  execute: async ({ ip }) => {
    try {
      const r = await fetch(
        `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,regionName,city,zip,lat,lon,timezone,isp,org,as,mobile,proxy,hosting,query`,
      );
      const data = await r.json();
      // Reframe results when the IP belongs to a major CDN/edge network —
      // geolocation reflects the edge POP, NOT the actual origin host.
      const blob = `${data?.isp ?? ""} ${data?.org ?? ""} ${data?.as ?? ""}`.toLowerCase();
      const cdnHit = /cloudflare|akamai|fastly|amazon|aws|google\b|googleusercontent|microsoft|azure|incapsula|sucuri|stackpath|cdn77|bunny/.exec(blob);
      if (cdnHit) {
        return {
          ...data,
          cdn: true,
          cdn_provider: cdnHit[0],
          location_kind: "cdn_edge",
          note: `IP belongs to ${cdnHit[0]} edge network — geo reflects CDN POP, not the actual origin server. Origin remains hidden.`,
        };
      }
      return { ...data, location_kind: "origin" };
    } catch (e) {
      return { error: String(e) };
    }
  },
}),

export const ipgeolocation_lookup = tool({
  description:
    "IPGeolocation.io enrichment for an IP (https://api.ipgeolocation.io). Returns geo, ISP, organization, ASN, connection type (residential/mobile/dch/etc), currency, timezone, calling code. Use as a SECONDARY corroborating source after ip_intel — they agree → high confidence; they disagree → flag VPN/proxy. Free tier: 1000/day.",
  inputSchema: z.object({ ip: z.string().min(3) }),
  execute: async ({ ip }) => {
    const KEY = Deno.env.get("IPGEOLOCATION_API_KEY");
    if (!KEY) return { error: "IPGEOLOCATION_API_KEY not configured" };
    try {
      const r = await fetch(`https://api.ipgeolocation.io/ipgeo?apiKey=${encodeURIComponent(KEY)}&ip=${encodeURIComponent(ip)}`, {
        headers: { "Accept": "application/json" },
      });
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, source: "ipgeolocation.io", data };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const ipqualityscore_lookup = tool({
  description:
    "IPQualityScore validity + fraud scoring (https://ipqualityscore.com). One tool, three identifier types: 'phone' | 'email' | 'ip'. Returns a `valid` flag, a 0-100 `fraud_score`, and type-specific signals. USE THIS EARLY as a VALIDATION GATE before spending on deep lookups: if `valid:false` or fraud_score is high (>=85) for a phone/email seed, the identifier is reserved/fake/disposable — treat any attributions to it as low-confidence and STOP burning paid breach/people-search calls on it. Free tier ~5000/mo.",
  inputSchema: z.object({
    kind: z.enum(["phone", "email", "ip"]),
    value: z.string().min(3),
    country: z.string().length(2).optional(),
    strictness: z.number().int().min(0).max(3).optional(),
  }),
  execute: async ({ kind, value, country, strictness }) => {
    const KEY = Deno.env.get("IPQUALITYSCORE_API_KEY");
    if (!KEY) return { error: "IPQUALITYSCORE_API_KEY not configured", code: "ipqs_key_missing" };
    try {
      const base = `https://www.ipqualityscore.com/api/json/${kind}/${encodeURIComponent(KEY)}/${encodeURIComponent(value)}`;
      const params = new URLSearchParams();
      if (kind === "phone" && country) params.set("country[]", country);
      if (kind === "email") params.set("timeout", "12");
      if (strictness !== undefined && kind !== "ip") params.set("strictness", String(strictness));
      const qs = params.toString() ? `?${params.toString()}` : "";
      const r = await fetch(`${base}${qs}`, { headers: { Accept: "application/json" } });
      const data = await r.json().catch(() => ({})) as Record<string, unknown>;
      if (!r.ok || data.success === false) {
        return { ok: false, status: r.status, error: (data.message as string) ?? "IPQualityScore lookup failed", kind, value };
      }
      return { ok: true, source: "ipqualityscore.com", kind, value, ...data };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const http_fingerprint = tool({
  description: "Fetch a URL and return status, server/tech headers, title, and a short text excerpt. Use to investigate a website without leaving the agent.",
  inputSchema: z.object({ url: z.string().url() }),
  execute: async ({ url }) => {
    try {
      // SSRF guard — reject loopback, link-local (cloud metadata!), RFC1918.
      try { assertSafeUrl(url); }
      catch (e) { return { error: String(e instanceof Error ? e.message : e) }; }
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10000);
      const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Proximity-OSINT)" }, redirect: "follow", signal: ctrl.signal });
      clearTimeout(t);
      // Block followed redirects that land on an internal host.
      try { assertSafeUrl(r.url); }
      catch (e) { return { error: `redirect blocked: ${String(e instanceof Error ? e.message : e)}` }; }
      const headers: Record<string, string> = {};
      r.headers.forEach((v, k) => { headers[k] = v; });
      const body = await r.text().catch(() => "");
      const title = body.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim();
      const text = body.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 1200);
      return { status: r.status, finalUrl: r.url, title, headers, excerpt: text };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const virustotal_lookup = tool({
  description:
    "VirusTotal v3 lookup (https://www.virustotal.com/api/v3). Returns reputation, detections, categories, WHOIS, resolutions, and community votes for a file hash (md5/sha1/sha256), URL, domain, or IP. Public-API quota: 4 req/min, 500/day — use sparingly on high-value artifacts only. Returns the `attributes.last_analysis_stats` (harmless/malicious/suspicious/undetected) plus category and reputation.",
  inputSchema: z.object({
    kind: z.enum(["file", "url", "domain", "ip"]),
    value: z.string().min(3),
  }),
  execute: async ({ kind, value }) => {
    const KEY = Deno.env.get("VIRUSTOTAL_API_KEY");
    if (!KEY) return { error: "VIRUSTOTAL_API_KEY not configured" };
    const v = value.trim();
    let path: string;
    if (kind === "file") {
      path = `files/${encodeURIComponent(v)}`;
    } else if (kind === "url") {
      // VT requires base64url-encoded URL ID (no padding).
      const b64 = btoa(v).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      path = `urls/${b64}`;
    } else if (kind === "domain") {
      path = `domains/${encodeURIComponent(v)}`;
    } else {
      path = `ip_addresses/${encodeURIComponent(v)}`;
    }
    try {
      const r = await fetch(`https://www.virustotal.com/api/v3/${path}`, {
        headers: { "x-apikey": KEY, "Accept": "application/json" },
      });
      const data = await r.json().catch(() => ({}));
      const attrs = (data as { data?: { attributes?: Record<string, unknown> } })?.data?.attributes ?? {};
      return {
        ok: r.ok,
        status: r.status,
        source: "virustotal.v3",
        data: {
          stats: attrs.last_analysis_stats,
          reputation: attrs.reputation,
          total_votes: attrs.total_votes,
          categories: attrs.categories,
          last_analysis_date: attrs.last_analysis_date,
          whois: attrs.whois ? String(attrs.whois).slice(0, 2000) : undefined,
          tags: attrs.tags,
          meaningful_name: attrs.meaningful_name,
          magic: attrs.magic,
          type_description: attrs.type_description,
          raw: data,
        },
      };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const hackertarget = tool({
  description:
    "Free HackerTarget recon (50 queries/day per source IP, no key). Modes: reverseiplookup (domains hosted on an IP), hostsearch (subdomains+IPs of a domain), dnslookup (all DNS records), aslookup (ASN of an IP), geoip, reverse-dns.",
  inputSchema: z.object({
    mode: z.enum(["reverseiplookup", "hostsearch", "dnslookup", "aslookup", "geoip", "reversedns"]),
    query: z.string(),
  }),
  execute: async ({ mode, query }) => {
    const slug = mode === "reversedns" ? "reversedns" : mode;
    try {
      const r = await fetch(`https://api.hackertarget.com/${slug}/?q=${encodeURIComponent(query)}`);
      const text = await r.text();
      const lines = text.trim().split("\n").filter(Boolean).slice(0, 500);
      return { ok: r.ok, status: r.status, mode, query, lines };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const urlscan_search = tool({
  description:
    "Search urlscan.io's public scan database (no auth). Use to find historical URLs/screenshots referencing a domain, IP, hash, or string. Returns up to 20 scan results with page URL, screenshot, IP, ASN.",
  inputSchema: z.object({ query: z.string().describe('Lucene query, e.g. domain:example.com or ip:1.2.3.4 or page.url:"keyword"') }),
  execute: async ({ query }) => {
    try {
      const r = await fetch(`https://urlscan.io/api/v1/search/?q=${encodeURIComponent(query)}&size=20`);
      const data = await r.json().catch(() => ({}));
      const results = (data as { results?: UrlscanResult[] }).results ?? [];
      return {
        ok: r.ok, total: (data as { total?: number }).total,
        results: results.map((x) => ({
          url: x?.page?.url, domain: x?.page?.domain, ip: x?.page?.ip,
          asn: x?.page?.asn, country: x?.page?.country,
          screenshot: x?.screenshot, scanned: x?.task?.time, result: x?.result,
        })),
      };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const wayback_snapshots = tool({
  description: "Look up archive.org Wayback Machine snapshots for a URL. Returns the closest snapshot + total count.",
  inputSchema: z.object({ url: z.string() }),
  execute: async ({ url }) => {
    try {
      const [closest, cdx] = await Promise.all([
        fetch(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`).then((r) => r.json()).catch(() => ({})),
        fetch(`https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&limit=10&from=20000101`).then((r) => r.json()).catch(() => []),
      ]);
      return { closest, recent: cdx };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const archive_url = tool({
  description:
    "Submit a URL to the Wayback Machine to create a permanent archived snapshot. Returns the archived URL. Use on any volatile evidence (social posts, leak listings) so a [CONFIRMED] finding remains defensible.",
  inputSchema: z.object({ url: z.string().url() }),
  execute: async ({ url }) => {
    try {
      const r = await fetch(`https://web.archive.org/save/${url}`, {
        method: "GET",
        headers: { "User-Agent": "Proximity-OSINT/1.0" },
        redirect: "manual",
      });
      const location = r.headers.get("content-location") || r.headers.get("location");
      const archived = location ? `https://web.archive.org${location.startsWith("/") ? location : "/" + location}` : undefined;
      return {
        ok: r.ok || !!archived,
        status: r.status,
        original_url: url,
        archived_url: archived,
        note: archived ? "Snapshot created" : "Submission accepted — snapshot may take ~30s to be retrievable",
      };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const deepfind_ssl_inspect = tool({
  description:
    "DeepFind.Me SSL/TLS certificate inspector. Returns issuer, validity window, SANs, key size, protocol, cipher, and misconfig warnings for a domain.",
  inputSchema: z.object({ domain: z.string().min(3) }),
  execute: async ({ domain }) => {
    const KEY = Deno.env.get("DEEPFIND_API_KEY");
    if (!KEY) return { error: "DEEPFIND_API_KEY not configured" };
    try {
      const r = await fetch(`https://deepfind.me/api/ssl-certificate`, {
        method: "POST",
        headers: { "X-DFME-API-KEY": KEY, "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ domain }),
      });
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, source: "deepfind.ssl", data };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const deepfind_tech_stack = tool({
  description:
    "DeepFind.Me tech-stack detector. Identifies CMS, frameworks, analytics, CDN, server tech for a URL. Useful for domain/url seeds.",
  inputSchema: z.object({ url: z.string().min(3) }),
  execute: async ({ url }) => {
    const KEY = Deno.env.get("DEEPFIND_API_KEY");
    if (!KEY) return { error: "DEEPFIND_API_KEY not configured" };
    const deg = isDegraded("deepfind_tech_stack"); if (deg) return deg;
    try {
      const r = await fetch(`https://deepfind.me/api/tech-stack/detect`, {
        method: "POST",
        headers: { "X-DFME-API-KEY": KEY, "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await r.json().catch(() => ({}));
      if (r.status >= 500) markToolDegraded("deepfind_tech_stack", `HTTP ${r.status}`);
      return { ok: r.ok, status: r.status, source: "deepfind.tech_stack", data };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const deepfind_url_unshorten = tool({
  description:
    "DeepFind.Me URL unshortener. Follows full redirect chain for short URLs (bit.ly, t.co, etc) and returns final destination + safety signal.",
  inputSchema: z.object({ url: z.string().min(3) }),
  execute: async ({ url }) => {
    const KEY = Deno.env.get("DEEPFIND_API_KEY");
    if (!KEY) return { error: "DEEPFIND_API_KEY not configured" };
    try {
      const r = await fetch(`https://deepfind.me/api/url-unshortener/expand`, {
        method: "POST",
        headers: { "X-DFME-API-KEY": KEY, "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, source: "deepfind.unshorten", data };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const deepfind_mac_lookup = tool({
  description:
    "DeepFind.Me MAC address → manufacturer / OUI / address type lookup.",
  inputSchema: z.object({ macAddress: z.string().min(6) }),
  execute: async ({ macAddress }) => {
    const KEY = Deno.env.get("DEEPFIND_API_KEY");
    if (!KEY) return { error: "DEEPFIND_API_KEY not configured" };
    try {
      const r = await fetch(`https://deepfind.me/api/mac-lookup`, {
        method: "POST",
        headers: { "X-DFME-API-KEY": KEY, "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ macAddress }),
      });
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, source: "deepfind.mac", data };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const deepfind_dark_web_link = tool({
  description:
    "DeepFind.Me .onion validator — verifies V2/V3 format and checks DeepFind's 18k+ known-service database.",
  inputSchema: z.object({ url: z.string().min(6) }),
  execute: async ({ url }) => {
    const KEY = Deno.env.get("DEEPFIND_API_KEY");
    if (!KEY) return { error: "DEEPFIND_API_KEY not configured" };
    try {
      const r = await fetch(`https://deepfind.me/api/dark-web-link`, {
        method: "POST",
        headers: { "X-DFME-API-KEY": KEY, "Content-Type": "application/json", "Accept": "application/json" },
        body: JSON.stringify({ url }),
      });
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, source: "deepfind.darkweb", data };
    } catch (e) { return { error: String(e) }; }
  },
}),

