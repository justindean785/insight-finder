/**
 * tools/phase1_free.ts — Phase 1 free / no-required-key OSINT tools.
 *
 * NOTE: like the other tools/*.ts files, this is the catalog-mirror copy used by
 * the catalog↔runtime contract test (src/test/tool-catalog-contract.test.ts).
 * The LIVE runtime definitions live inline in ../tool-registry.ts inside
 * buildTools(); keep the two in sync (same names, same input shapes).
 */
import { tool } from "npm:ai@6";
import { z } from "npm:zod@3";
import { fetchRetry, fetchT } from "../fetch_retry.ts";
import { isCrtshOk } from "../tool_response.ts";
import { OPENCORPORATES_API_KEY, RANSOMWARELIVE_API_KEY } from "../env.ts";
import { URLSCANNER_API_KEY } from "../env.ts";

export const ransomwarelive_lookup = tool({
  description:
    "Ransomware.live victim-exposure check — is a DOMAIN listed as a ransomware/extortion victim on a leak site? Input: { domain: string } (a registrable domain like 'acme.com', NOT a URL or email). Returns up to 25 victim entries (group, date, description). Uses api-pro.ransomware.live when RANSOMWARELIVE_API_KEY is set; without a key the tool returns { ok:false, degraded:true } because the free api.ransomware.live API has been retired. A real empty result means NOT listed → { ok:true, listed:false, victims:[] }.",
  inputSchema: z.object({ domain: z.string().min(1).describe("registrable domain, e.g. acme.com") }),
  execute: async ({ domain }) => {
    try {
      const d = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      if (!RANSOMWARELIVE_API_KEY) {
        return { ok: false, degraded: true, domain: d, error: "ransomware.live free API retired; set RANSOMWARELIVE_API_KEY (api-pro.ransomware.live) to enable" };
      }
      const r = await fetchRetry(
        `https://api-pro.ransomware.live/victims/search?q=${encodeURIComponent(d)}`,
        { headers: { "X-API-KEY": RANSOMWARELIVE_API_KEY, "Accept": "application/json" } },
        { timeoutMs: 12_000 },
      );
      if (r.status === 404) { await r.body?.cancel().catch(() => {}); return { ok: true, domain: d, listed: false, count: 0, victims: [] }; }
      if (!r.ok) return { ok: false, status: r.status, error: `ransomware.live ${r.status}`, domain: d };
      const ct = r.headers.get("content-type") ?? "";
      if (!ct.includes("json")) { await r.body?.cancel().catch(() => {}); return { ok: false, degraded: true, domain: d, error: `non-JSON response (${ct || "unknown"})` }; }
      const data = await r.json().catch(() => null);
      const rows = Array.isArray(data)
        ? data
        : (Array.isArray((data as { victims?: unknown[] } | null)?.victims) ? (data as { victims: unknown[] }).victims : []);
      const victims = rows.slice(0, 25).map((v) => {
        const x = (v ?? {}) as Record<string, unknown>;
        const desc = x.description;
        return {
          victim: (x.victim ?? x.post_title ?? null) as string | null,
          group: (x.group_name ?? x.group ?? null) as string | null,
          date: (x.discovered ?? x.published ?? x.attackdate ?? null) as string | null,
          description: typeof desc === "string" ? desc.slice(0, 300) : null,
        };
      });
      return { ok: true, domain: d, listed: victims.length > 0, count: victims.length, victims };
    } catch (e) { return { error: String(e instanceof Error ? e.message : e) }; }
  },
});

export const wayback_cdx_search = tool({
  description:
    "Wayback Machine CDX archive search — corroborate that a domain/URL existed and when. Input: { url: string } (a domain like 'acme.com' or a full URL). Returns ACCURATE earliest + latest capture timestamps (each queried separately so they are NOT understated by a capped page) and up to 25 sample capture rows (timestamp, original, statuscode). `sampled_count` is the number of SAMPLE rows returned (capped at 25) — it is NOT the total capture count; `capped:true` means more captures exist than were sampled. Empty archive → { ok:true, archived:false, captures:[] }. No API key.",
  inputSchema: z.object({ url: z.string().min(1).describe("domain or URL to look up in the archive") }),
  execute: async ({ url }) => {
    try {
      const base = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json`;
      const firstTs = async (limit: string): Promise<string | null> => {
        try {
          const r = await fetchT(`${base}&fl=timestamp&limit=${limit}`, {}, 15_000);
          if (!r.ok) { await r.body?.cancel().catch(() => {}); return null; }
          const data = await r.json().catch(() => null);
          if (!Array.isArray(data) || data.length < 2) return null;
          const hdr = data[0] as string[];
          const idx = hdr.indexOf("timestamp");
          const row = data[1] as string[];
          return ((idx >= 0 ? row[idx] : row[0]) ?? null) as string | null;
        } catch { return null; }
      };
      const r = await fetchT(`${base}&limit=25&collapse=urlkey`, {}, 15_000);
      if (!r.ok) return { ok: false, status: r.status, error: `wayback cdx ${r.status}`, url };
      const data = await r.json().catch(() => null);
      if (!Array.isArray(data) || data.length < 2) {
        return { ok: true, url, archived: false, sampled_count: 0, capped: false, earliest: null, latest: null, captures: [] };
      }
      const header = data[0] as string[];
      const ti = header.indexOf("timestamp"), oi = header.indexOf("original"), si = header.indexOf("statuscode");
      const rows = (data.slice(1) as string[][]).map((row) => ({
        timestamp: ti >= 0 ? row[ti] ?? null : null,
        original: oi >= 0 ? row[oi] ?? null : null,
        statuscode: si >= 0 ? row[si] ?? null : null,
      }));
      const [earliest, latest] = await Promise.all([firstTs("1"), firstTs("-1")]);
      const sampleTs = rows.map((x) => x.timestamp).filter((t): t is string => !!t).sort();
      return {
        ok: true, url, archived: true,
        earliest: earliest ?? sampleTs[0] ?? null,
        latest: latest ?? sampleTs[sampleTs.length - 1] ?? null,
        sampled_count: rows.length,
        capped: rows.length >= 25,
        captures: rows.slice(0, 25),
      };
    } catch (e) { return { error: String(e instanceof Error ? e.message : e) }; }
  },
});

export const crtsh_lookup = tool({
  description:
    "crt.sh certificate-transparency lookup — issued certs for a DOMAIN. Input: { domain: string }. Returns UNIQUE subdomains (parsed from name_value) and unique issuer names, each capped at 50, plus the total cert count. crt.sh is slow and can return a non-JSON error/overload page → that returns { error }. No API key. (crtsh_subdomains returns only the subdomain list; this also surfaces issuers + cert count.)",
  inputSchema: z.object({ domain: z.string().min(1).describe("registrable domain, e.g. acme.com") }),
  execute: async ({ domain }) => {
    try {
      const d = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      const r = await fetchT(`https://crt.sh/?q=${encodeURIComponent(d)}&output=json`, {}, 15_000);
      const data = (await r.json().catch(() => null)) as Array<{ name_value?: string; issuer_name?: string }> | null;
      if (!isCrtshOk(r.ok, data)) {
        return { ok: false, status: r.status, error: r.ok ? "crt.sh returned non-JSON (likely an error/overload page)" : `crt.sh ${r.status}`, domain: d };
      }
      const arr = data as Array<{ name_value?: string; issuer_name?: string }>;
      const subdomains = Array.from(new Set(arr.flatMap((c) => (c.name_value ?? "").split("\n")).map((s) => s.trim().toLowerCase()).filter(Boolean))).slice(0, 50);
      const issuers = Array.from(new Set(arr.map((c) => (c.issuer_name ?? "").trim()).filter(Boolean))).slice(0, 50);
      return { ok: true, domain: d, cert_count: arr.length, subdomain_count: subdomains.length, subdomains, issuers };
    } catch (e) { return { error: String(e instanceof Error ? e.message : e) }; }
  },
});

export const census_geocode = tool({
  description:
    "US Census one-line address geocoder — does a US street ADDRESS exist, and where? Input: { address: string } (a one-line US street address). Returns the standardized matched address + coordinates (lon/lat) and matched:boolean. US addresses only. No API key.",
  inputSchema: z.object({ address: z.string().min(1).describe("one-line US street address") }),
  execute: async ({ address }) => {
    try {
      const r = await fetchT(`https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=${encodeURIComponent(address)}&benchmark=Public_AR_Current&format=json`, {}, 15_000);
      if (!r.ok) return { ok: false, status: r.status, error: `census ${r.status}`, address };
      const data = (await r.json().catch(() => null)) as { result?: { addressMatches?: Array<Record<string, unknown>> } } | null;
      const matches = data?.result?.addressMatches;
      if (!Array.isArray(matches) || matches.length === 0) return { ok: true, address, matched: false, count: 0, matches: [] };
      const out = matches.slice(0, 5).map((m) => {
        const coords = (m.coordinates ?? {}) as { x?: number; y?: number };
        return { matchedAddress: (m.matchedAddress ?? null) as string | null, lon: coords.x ?? null, lat: coords.y ?? null };
      });
      return { ok: true, address, matched: true, count: out.length, matches: out };
    } catch (e) { return { error: String(e instanceof Error ? e.message : e) }; }
  },
});

export const nominatim_geocode = tool({
  description:
    "OpenStreetMap Nominatim geocoder — resolve any worldwide ADDRESS or place to coordinates. Input: { address: string }. Returns the top match: display_name, lat/lon, category/type, and a residential-vs-commercial hint when derivable. Rate-limited to 1 req/sec by OSM policy (sends a descriptive User-Agent). No API key.",
  inputSchema: z.object({ address: z.string().min(1).describe("free-form address or place name") }),
  execute: async ({ address }) => {
    try {
      const r = await fetchT(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=jsonv2&addressdetails=1&limit=3`,
        { headers: { "User-Agent": "insight-finder-osint/1.0 (justindean785@gmail.com)" } },
        15_000,
      );
      if (!r.ok) return { ok: false, status: r.status, error: `nominatim ${r.status}`, address };
      const data = (await r.json().catch(() => null)) as Array<Record<string, unknown>> | null;
      if (!Array.isArray(data) || data.length === 0) return { ok: true, address, matched: false };
      const top = data[0];
      const cat = String(top.category ?? top.class ?? "").toLowerCase();
      const typ = String(top.type ?? top.addresstype ?? "").toLowerCase();
      const blob = `${cat} ${typ}`;
      const residential = /residential|house|apartment|dwelling|detached|terrace/.test(blob);
      const commercial = /commercial|office|retail|\bshop\b|industrial|company|business/.test(blob);
      const place_type = residential ? "residential" : (commercial ? "commercial" : null);
      return {
        ok: true, address, matched: true,
        display_name: (top.display_name ?? null) as string | null,
        lat: (top.lat ?? null) as string | null,
        lon: (top.lon ?? null) as string | null,
        category: (top.category ?? top.class ?? null) as string | null,
        type: (top.type ?? null) as string | null,
        place_type,
      };
    } catch (e) { return { error: String(e instanceof Error ? e.message : e) }; }
  },
});

export const hibp_pwned_passwords_kanon = tool({
  description:
    "Have I Been Pwned k-anonymity password-exposure check (NO API key). Input: { password: string } OR { sha1: string } (a 40-hex SHA-1 of the password). PRIVACY GUARANTEE: only the first 5 chars of the SHA-1 hash ever leave this function — the password and the full hash are NEVER sent. Returns { ok, pwned:boolean, count:number } = how many breach corpora contain that password.",
  inputSchema: z.object({
    password: z.string().min(1).optional().describe("plaintext password (hashed locally with SHA-1; never transmitted)"),
    sha1: z.string().regex(/^[0-9a-fA-F]{40}$/).optional().describe("precomputed 40-hex SHA-1 of the password"),
  }),
  execute: async ({ password, sha1 }) => {
    try {
      let hashHex: string;
      if (sha1) {
        hashHex = sha1.toUpperCase();
      } else if (password) {
        const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(password));
        hashHex = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("").toUpperCase();
      } else {
        return { error: "provide either password or sha1" };
      }
      const prefix = hashHex.slice(0, 5);
      const suffix = hashHex.slice(5);
      const r = await fetchRetry(`https://api.pwnedpasswords.com/range/${prefix}`, { headers: { "Add-Padding": "true" } }, { timeoutMs: 12_000 });
      if (!r.ok) return { ok: false, status: r.status, error: `pwnedpasswords ${r.status}` };
      const text = await r.text();
      let count = 0;
      for (const line of text.split("\n")) {
        const [suf, cnt] = line.trim().split(":");
        if (suf && suf.toUpperCase() === suffix) { count = parseInt(cnt, 10) || 0; break; }
      }
      return { ok: true, pwned: count > 0, count };
    } catch (e) { return { error: String(e instanceof Error ? e.message : e) }; }
  },
});

export const gleif_lei_search = tool({
  description:
    "GLEIF Legal Entity Identifier registry search by NAME (NO API key). Input: { name: string } (org/company legal name). Returns up to 10 entities: lei, legalName, status, jurisdiction, legalAddress {city, country}, registrationStatus. COVERAGE CAVEAT: only entities that hold an LEI (financial-market participants — public companies, funds, many regulated/private orgs); small private companies may be ABSENT, so an EMPTY result does NOT mean the company doesn't exist. Falls back to fuzzy name suggestions when the exact filter returns nothing.",
  inputSchema: z.object({ name: z.string().min(1).describe("org / company legal name") }),
  execute: async ({ name }) => {
    try {
      const q = encodeURIComponent(name.trim());
      const accept = { headers: { Accept: "application/vnd.api+json" } };
      const r = await fetchRetry(
        `https://api.gleif.org/api/v1/lei-records?filter%5Bentity.legalName%5D=${q}&page%5Bsize%5D=10`,
        accept,
        { timeoutMs: 12_000 },
      );
      if (!r.ok) return { ok: false, status: r.status, error: `gleif ${r.status}`, name };
      const data = (await r.json().catch(() => null)) as { data?: Array<Record<string, unknown>> } | null;
      const rows = Array.isArray(data?.data) ? data!.data : [];
      const records = rows.slice(0, 10).map((rec) => {
        const a = (rec.attributes ?? {}) as Record<string, unknown>;
        const entity = (a.entity ?? {}) as Record<string, unknown>;
        const legalName = (entity.legalName ?? {}) as { name?: string };
        const legalAddr = (entity.legalAddress ?? {}) as { city?: string; country?: string };
        const reg = (a.registration ?? {}) as { status?: string };
        return {
          lei: (a.lei ?? rec.id ?? null) as string | null,
          legalName: (legalName.name ?? null) as string | null,
          status: (entity.status ?? null) as string | null,
          jurisdiction: (entity.jurisdiction ?? null) as string | null,
          legalAddress: { city: legalAddr.city ?? null, country: legalAddr.country ?? null },
          registrationStatus: (reg.status ?? null) as string | null,
        };
      });
      if (records.length > 0) return { ok: true, name, count: records.length, records };
      const fr = await fetchRetry(
        `https://api.gleif.org/api/v1/fuzzycompletions?field=entity.legalName&q=${q}`,
        accept,
        { timeoutMs: 12_000 },
      );
      if (fr.ok) {
        const fdata = (await fr.json().catch(() => null)) as { data?: Array<Record<string, unknown>> } | null;
        const suggestions = (Array.isArray(fdata?.data) ? fdata!.data : []).slice(0, 10).map((s) => {
          const attrs = (s.attributes ?? {}) as { value?: string };
          const rel = (s.relationships ?? {}) as { "lei-records"?: { data?: { id?: string } } };
          return { legalName: (attrs.value ?? null) as string | null, lei: (rel["lei-records"]?.data?.id ?? null) as string | null };
        }).filter((x) => x.legalName);
        if (suggestions.length > 0) {
          return { ok: true, name, count: 0, fuzzy: true, suggestions, note: "no exact legalName match — fuzzy name suggestions returned (entity may still exist without an LEI)" };
        }
      } else { await fr.body?.cancel().catch(() => {}); }
      return { ok: true, name, count: 0, records: [], note: "no LEI record matched — the entity may simply not hold an LEI (small private cos often don't)" };
    } catch (e) { return { error: String(e instanceof Error ? e.message : e) }; }
  },
});

export const opencorporates_search = tool({
  description:
    "OpenCorporates company-registry search — find official company registrations by NAME. Input: { name: string } (company name). Returns up to 20 companies: name, jurisdiction_code, company_number, incorporation_date, current_status. REQUIRES OPENCORPORATES_API_KEY — the v0.4 endpoint now returns 401 'Invalid Api Token' for all keyless requests, so the tool self-skips when the key is unset. For keyless company-registry corroboration, use gleif_lei_search instead.",
  inputSchema: z.object({ name: z.string().min(1).describe("company / organization name") }),
  execute: async ({ name }) => {
    if (!OPENCORPORATES_API_KEY) return { error: "OPENCORPORATES_API_KEY not configured", skipped: true };
    try {
      const url = `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(name)}&api_token=${encodeURIComponent(OPENCORPORATES_API_KEY)}`;
      const r = await fetchRetry(url, {}, { timeoutMs: 15_000 });
      if (!r.ok) {
        const gated = r.status === 401 || r.status === 403 || r.status === 429;
        return { ok: false, status: r.status, error: `opencorporates ${r.status}${gated ? " (rate-limited / invalid token)" : ""}`, name };
      }
      const data = (await r.json().catch(() => null)) as { results?: { companies?: Array<{ company?: Record<string, unknown> }> } } | null;
      const companies = data?.results?.companies;
      if (!Array.isArray(companies)) return { ok: true, name, count: 0, companies: [] };
      const out = companies.slice(0, 20).map((c) => {
        const co = (c.company ?? {}) as Record<string, unknown>;
        return {
          name: (co.name ?? null) as string | null,
          jurisdiction_code: (co.jurisdiction_code ?? null) as string | null,
          company_number: (co.company_number ?? null) as string | null,
          incorporation_date: (co.incorporation_date ?? null) as string | null,
          current_status: (co.current_status ?? null) as string | null,
        };
      });
      return { ok: true, name, count: out.length, companies: out };
    } catch (e) { return { error: String(e instanceof Error ? e.message : e) }; }
  },
});

export const urlscanner_scan = tool({
  description:
    "URLScanner.online PRIVATE URL/domain/IP security scanner (sync endpoint). One call returns score (0-100), verdict (clean|low|medium|high|critical), DNS records, SSL cert chain, HTTP security-header analysis, WHOIS (incl. domainAge / registrar / expiry), threat-blocklist hits (URLhaus, Spamhaus, SURBL), and an AI risk summary (knownDomain, domainReputation, riskLevel, briefSummary, recommendations). Input: { url: string } (URL, domain, or IP). Requires URLSCANNER_API_KEY (free 10/day, solo 100/day). Scans are PRIVATE (never published). Typical latency 15-20s; modules that time out return null for that field — the response is always returned. Reserve for high-value suspicious artifacts.",
  inputSchema: z.object({
    url: z.string().min(1).describe("URL, registrable domain, or IP to scan"),
    rescan: z.boolean().optional().describe("Force a fresh scan, bypassing the 7-day cache"),
  }),
  execute: async ({ url, rescan }) => {
    if (!URLSCANNER_API_KEY) return { error: "URLSCANNER_API_KEY not configured", degraded: true };
    try {
      const r = await fetchRetry(
        "https://urlscanner.online/api/scan/sync",
        {
          method: "POST",
          headers: {
            "X-API-Key": URLSCANNER_API_KEY,
            "Content-Type": "application/json",
            "Accept": "application/json",
          },
          body: JSON.stringify(rescan ? { url, rescan: true } : { url }),
        },
        { timeoutMs: 45_000 },
      );
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        return { ok: false, status: r.status, error: `urlscanner ${r.status}: ${body.slice(0, 300)}`, url };
      }
      const data = await r.json().catch(() => null) as Record<string, unknown> | null;
      if (!data) return { ok: false, error: "urlscanner returned non-JSON body", url };
      return { ok: true, url: (data.url ?? url) as string, score: data.score ?? null, verdict: data.verdict ?? null, raw: data };
    } catch (e) { return { error: String(e instanceof Error ? e.message : e), url }; }
  },
});
