/**
 * tools/osint_navigator.ts — OSINT Navigator (query + search), OathNet, Synapsint.
 * Extracted from index.ts (lines 2188–2350).
 */

import { tool } from "npm:ai@6";
import { z } from "npm:zod@3";
import {
  OSINT_NAVIGATOR_API_KEY,
  OATHNET_API_KEY,
  SYNAPSINT_API_KEY,
  fetchRetry,
  isDegraded,
  markToolDegraded,
} from "../env.ts";
import { gateStage2, routingGuard } from "../guard.ts";

export const osint_navigator_query = tool({
  description:
    "OSINT Navigator natural-language tool recommendation (POST https://navigator.indicator.media/api/query). Ask 'which OSINT tools should I use for X?' in plain English and get back a curated list of verified tools with names + URLs. Use when you (the planner) are unsure which third-party tool fits a pivot, or when the user asks for tool recommendations. Returns {answer, tools:[{name,url,...}]}. Rate-limited by tier. Do NOT invent tools — only cite what's returned.",
  inputSchema: z.object({
    query: z.string().describe("Natural-language question, e.g. 'tools to find who registered a domain' or 'image verification tools'"),
    skip_cache: z.boolean().optional().default(false),
  }),
  execute: async ({ query, skip_cache }) => {
    if (!OSINT_NAVIGATOR_API_KEY) return { error: "OSINT_NAVIGATOR_API_KEY not configured" };
    try {
      const r = await fetchRetry("https://navigator.indicator.media/api/query", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OSINT_NAVIGATOR_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ query, skip_cache }),
      }, { retries: 1 });
      const text = await r.text();
      let data: any;
      try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 4000) }; }
      if (!r.ok) {
        console.warn(`[osint_navigator_query] HTTP ${r.status} snippet=${text.slice(0, 300)}`);
        return { error: `osint_navigator ${r.status}`, status: r.status, snippet: text.slice(0, 300) };
      }
      const tools = Array.isArray(data?.tools)
        ? data.tools.slice(0, 12).map((t: any) => ({
            id: t?.tool_id ?? t?.id,
            name: t?.tool_name ?? t?.name ?? t?.title,
            url: t?.tool_url ?? t?.url ?? t?.homepage ?? t?.link,
            category: t?.category ?? t?.categories,
            tags: t?.tags,
            summary: t?.short_description ?? (typeof t?.description === "string" ? t.description.slice(0, 400) : (t?.summary ?? null)),
          }))
        : data?.tools;
      return { ok: true, answer: data?.answer ?? null, tools, cache: data?.cache ?? data?.cached };
    } catch (e) { return { error: String(e) }; }
  },
});

export const oathnet_lookup = tool({
  description:
   "Query OathNet. v2 breach search for email/username/phone/domain; geo+ASN for ip. 100 calls/day. Fire ONCE per high-value email/username/phone/domain in parallel with breach_check, leakcheck_lookup, and intelbase_email_lookup (do NOT wait for them to fail). Always fire on every ip seed for geo+ASN. Skip only after ~50 calls this session or an explicit 429.",
  inputSchema: z.object({
    type: z.enum(["email", "username", "phone", "ip", "domain"]),
    value: z.string(),
  }),
  execute: async ({ type, value }) => {
    const gated = gateStage2("oathnet_lookup");
    if (gated) return gated;
    // High-cost: one call per seed unless new corroborating evidence has appeared.
    {
      const last = routingGuard.highCostLastArtifactCount.get("oathnet_lookup");
      if (last !== undefined && routingGuard.artifactsTotal - last < 5) {
        const note = `oathnet_lookup skipped — high-cost tool already used this seed (${routingGuard.artifactsTotal - last} new artifacts since, need ≥5).`;
        console.log(`[high-cost-gate] ${note}`);
        return { ok: false, skipped: true, gated: true, reason: note };
      }
      routingGuard.highCostLastArtifactCount.set("oathnet_lookup", routingGuard.artifactsTotal);
    }
    if (!OATHNET_API_KEY) return { error: "OATHNET_API_KEY not configured" };
    try {
      let url: string;
      if (type === "ip") {
        url = `https://oathnet.org/api/service/ip-info?ip=${encodeURIComponent(value)}`;
      } else {
        const params = new URLSearchParams();
        if (type === "domain") params.set("email_domain", value);
        else params.set("q", value);
        params.set("limit", "50");
        url = `https://oathnet.org/api/service/v2/breach/search?${params.toString()}`;
      }
      const r = await fetch(url, {
        headers: { "x-api-key": OATHNET_API_KEY },
      });
      const text = await r.text();
      let data: unknown;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text.slice(0, 4000) };
      }
      return { ok: r.ok, status: r.status, data };
    } catch (e) {
      return { error: String(e) };
    }
  },
}),

export const synapsint_lookup = tool({
  description:
    "Synapsint multi-endpoint OSINT aggregator (synapsint.pythonanywhere.com). One tool, many endpoints — pick the right `endpoint` for the seed type. " +
    "Domain endpoints: links, subdomains, dns, waf, tenant (Microsoft), leaks (emails leaked from this domain), whoisd, dmarc, sh (security headers), tls, ranking, pastes (pastebin mentions), dnssec. " +
    "IP endpoints: check (IP info + open ports), rip (reverse-IP shared-hosting neighbors), whoiss. " +
    "ASN endpoint: asn. Email endpoint: email (leaked credentials). CVE endpoint: cve. " +
    "Use as a fast secondary corroboration source for domain/IP/email/CVE/ASN seeds — especially valuable for `rip` (shared hosting), `tenant` (M365 enumeration), `pastes`, and `leaks` which other tools don't cover. Free tier API key; treat quota as generous but not unlimited.",
  inputSchema: z.object({
    endpoint: z.enum([
      "links","asn","check","waf","subdomains","dns","tenant","rip",
      "email","leaks","whoisd","whoiss","cve","dmarc","sh","tls",
      "ranking","pastes","dnssec",
    ]).describe("Which Synapsint endpoint to call."),
    value: z.string().describe("Parameter for the endpoint — domain, ip, asn, email, or CVE id as appropriate."),
  }),
  execute: async ({ endpoint, value }) => {
    if (!SYNAPSINT_API_KEY) return { error: "SYNAPSINT_API_KEY not configured" };
    const deg = isDegraded("synapsint_lookup"); if (deg) return deg;
    try {
      const url = `https://synapsint.pythonanywhere.com/${endpoint}/${encodeURIComponent(value)}`;
      const r = await fetchRetry(url, {
        headers: { "X-API-KEY": SYNAPSINT_API_KEY, "accept": "application/json" },
      }, { retries: 1 });
      const text = await r.text();
      let data: unknown;
      try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 4000) }; }
      if (r.status >= 500) markToolDegraded("synapsint_lookup", `HTTP ${r.status}`);
      return { ok: r.ok, status: r.status, endpoint, value, data };
    } catch (e) {
      markToolDegraded("synapsint_lookup", `network error`);
      return { error: String(e) };
    }
  },
}),

export const osint_navigator_search = tool({
  description:
    "OSINT Navigator direct tool-database search (POST https://navigator.indicator.media/api/tools/search). Keyword / category lookup, NOT Q&A. Optional category slugs: domains_websites, social_media, image_video_analysis, geolocation_mapping, transport, companies. Use for browsing alternatives or when you already know the category. Returns a list of verified tools — do NOT invent.",
  inputSchema: z.object({
    query: z.string().describe("Keyword(s), e.g. 'whois', 'archive', 'vessel tracking'"),
    category: z.string().optional().describe("Optional category slug; omit to broaden"),
    limit: z.number().int().min(1).max(25).optional().default(10),
  }),
  execute: async ({ query, category, limit }) => {
    if (!OSINT_NAVIGATOR_API_KEY) return { error: "OSINT_NAVIGATOR_API_KEY not configured" };
    try {
      const body: Record<string, unknown> = { query, limit };
      if (category) body.category = category;
      const r = await fetchRetry("https://navigator.indicator.media/api/tools/search", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${OSINT_NAVIGATOR_API_KEY}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      }, { retries: 1 });
      const text = await r.text();
      let data: any;
      try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 4000) }; }
      if (!r.ok) {
        console.warn(`[osint_navigator_search] HTTP ${r.status} snippet=${text.slice(0, 300)}`);
        return { error: `osint_navigator ${r.status}`, status: r.status, snippet: text.slice(0, 300) };
      }
      const list = Array.isArray(data) ? data : (data?.tools ?? data?.results ?? []);
      const tools = (Array.isArray(list) ? list : []).slice(0, limit ?? 10).map((t: any) => ({
        id: t?.tool_id ?? t?.id,
        name: t?.tool_name ?? t?.name ?? t?.title,
        url: t?.tool_url ?? t?.url ?? t?.homepage ?? t?.link,
        category: t?.category ?? t?.categories,
        tags: t?.tags,
        summary: t?.short_description ?? (typeof t?.description === "string" ? t.description.slice(0, 400) : (t?.summary ?? null)),
      }));
      return { ok: true, query, category: category ?? null, count: tools.length, tools };
    } catch (e) { return { error: String(e) }; }
  },
}),

