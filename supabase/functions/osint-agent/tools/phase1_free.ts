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
import { OPENCORPORATES_API_KEY } from "../env.ts";

export const ransomwarelive_lookup = tool({
  description:
    "Ransomware.live victim-exposure check — is a DOMAIN listed as a ransomware/extortion victim on a leak site? Input: { domain: string } (a registrable domain like 'acme.com', NOT a URL or email). Returns up to 25 victim entries (group, date, description). A 404 or empty result means NOT listed → { ok:true, listed:false, victims:[] }. No API key. Replaces the dead deepfind_ransomware_exposure.",
  inputSchema: z.object({ domain: z.string().min(1).describe("registrable domain, e.g. acme.com") }),
  execute: async ({ domain }) => {
    try {
      const d = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      let r = await fetchRetry(`https://api.ransomware.live/v2/victims/${encodeURIComponent(d)}`, {}, { timeoutMs: 12_000 });
      if (r.status === 404) {
        await r.body?.cancel().catch(() => {});
        r = await fetchRetry(`https://api.ransomware.live/v2/searchvictims/${encodeURIComponent(d)}`, {}, { timeoutMs: 12_000 });
      }
      if (r.status === 404) { await r.body?.cancel().catch(() => {}); return { ok: true, domain: d, listed: false, count: 0, victims: [] }; }
      if (!r.ok) return { ok: false, status: r.status, error: `ransomware.live ${r.status}`, domain: d };
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
    "Wayback Machine CDX archive search — corroborate that a domain/URL existed and when. Input: { url: string } (a domain like 'acme.com' or a full URL). Returns earliest + latest capture timestamps, total capture count, and up to 25 sample rows (timestamp, original, statuscode). Good for existence/first-seen corroboration. No API key.",
  inputSchema: z.object({ url: z.string().min(1).describe("domain or URL to look up in the archive") }),
  execute: async ({ url }) => {
    try {
      const r = await fetchT(`https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json&limit=50&collapse=urlkey`, {}, 15_000);
      if (!r.ok) return { ok: false, status: r.status, error: `wayback cdx ${r.status}`, url };
      const data = await r.json().catch(() => null);
      if (!Array.isArray(data) || data.length < 2) return { ok: true, url, count: 0, earliest: null, latest: null, captures: [] };
      const header = data[0] as string[];
      const ti = header.indexOf("timestamp"), oi = header.indexOf("original"), si = header.indexOf("statuscode");
      const rows = (data.slice(1) as string[][]).map((row) => ({
        timestamp: ti >= 0 ? row[ti] ?? null : null,
        original: oi >= 0 ? row[oi] ?? null : null,
        statuscode: si >= 0 ? row[si] ?? null : null,
      }));
      const ts = rows.map((x) => x.timestamp).filter((t): t is string => !!t).sort();
      return { ok: true, url, count: rows.length, earliest: ts[0] ?? null, latest: ts[ts.length - 1] ?? null, captures: rows.slice(0, 25) };
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

export const opencorporates_search = tool({
  description:
    "OpenCorporates company-registry search — find official company registrations by NAME. Input: { name: string } (company name). Returns up to 20 companies: name, jurisdiction_code, company_number, incorporation_date, current_status. The v0.4 search endpoint works key-free but is heavily rate-limited; a 401/403/429 returns { error, status } (no throw). OPENCORPORATES_API_KEY is appended automatically when configured.",
  inputSchema: z.object({ name: z.string().min(1).describe("company / organization name") }),
  execute: async ({ name }) => {
    try {
      let url = `https://api.opencorporates.com/v0.4/companies/search?q=${encodeURIComponent(name)}`;
      if (OPENCORPORATES_API_KEY) url += `&api_token=${encodeURIComponent(OPENCORPORATES_API_KEY)}`;
      const r = await fetchRetry(url, {}, { timeoutMs: 15_000 });
      if (!r.ok) {
        const gated = r.status === 401 || r.status === 403 || r.status === 429;
        return { ok: false, status: r.status, error: `opencorporates ${r.status}${gated ? " (rate-limited / token required)" : ""}`, name };
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
