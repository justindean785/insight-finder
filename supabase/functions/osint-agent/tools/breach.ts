/**
 * tools/breach.ts — Auto-extracted. Add imports manually.
 */
import { tool } from "npm:ai@6";
import { z } from "npm:zod@3";
import { createClient } from "npm:@supabase/supabase-js@2";

/**
 * Loose shapes for the stolen.tax v2 endpoints (osintcat database-search,
 * snusbase, osintcat breach). Only the fields we read are typed; everything
 * else stays accessible via the index signature.
 */
interface StolenTaxParsed {
  data?: {
    results?: unknown;
    size?: number;
    breach_data?: unknown;
    results_count?: number;
    stats?: unknown;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

/** One taken-account row from the osintcat-footprint response. */
interface FootprintResult {
  domain?: string;
  taken?: boolean;
  ExtraData?: unknown;
  [k: string]: unknown;
}

/** Loose shape for the LeakCheck v2 query response (only fields we read). */
interface LeakCheckResponse {
  success?: boolean;
  found?: number;
  quota?: number;
  result?: Array<{ source?: { name?: string }; [k: string]: unknown }>;
  [k: string]: unknown;
}

export const breach_check = tool({
  description:
    "Check whether an email or username appears in public breach datasets. Primary source: stolen.tax — fans out in parallel to (a) OsintCat `database-search` (returns site+password combos), (b) Snusbase (returns identity records: name/phone/address/DOB), and (c) OsintCat plain `breach` mode. Returns combined hit count + per-source raw data. Falls back to the leakcheck public endpoint if stolen.tax is unavailable. Pass `email` for email seeds or `value` for usernames/other identifiers.",
  inputSchema: z.object({
    email: z.string().min(1).optional(),
    value: z.string().min(1).optional(),
  }).refine((v) => !!(v.email || v.value), { message: "Provide `email` or `value`" }),
  execute: async ({ email, value }) => {
    const query = (email ?? value ?? "").trim();
    if (!query) return { error: "missing query" };
    const STOLENTAX_API_KEY = Deno.env.get("STOLENTAX_API_KEY");
    // Primary: stolen.tax — fan out to the three highest-yield endpoints in parallel.
    // The previous implementation only hit OsintCat mode=breach, which on this
    // account returns results_count:0 for nearly every query. The actual breach
    // data lives in mode=database-search and in the snusbase endpoint.
    if (STOLENTAX_API_KEY) {
      const callStolen = async (path: string, body: Record<string, unknown>) => {
        try {
          const r = await fetch(
            `https://stolen.tax/api/v2/index.php?path=${encodeURIComponent(path)}`,
            {
              method: "POST",
              headers: {
                "Authorization": `Bearer ${STOLENTAX_API_KEY}`,
                "X-API-Key": STOLENTAX_API_KEY,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(body),
            },
          );
          const text = await r.text();
          let parsed: unknown;
          try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 4000) }; }
          return { ok: r.ok, status: r.status, parsed };
        } catch (e) {
          return { ok: false, status: 0, parsed: { error: String(e) } };
        }
      };
      // Snusbase auto-detects record snusbase results; record_count comes back as `size` or `results` map.
      const [dbSearch, snus, breachLegacy] = await Promise.all([
        callStolen("osintcat", { query, osintcat_mode: "database-search" }),
        callStolen("snusbase", { query }),
        callStolen("osintcat", { query, osintcat_mode: "breach" }),
      ]);

      // ---- Parse each source into a hit count ----
      const dbResults = (dbSearch.parsed as StolenTaxParsed)?.data?.results;
      const dbHits = Array.isArray(dbResults) ? dbResults.length : 0;

      const snusRoot = (snus.parsed as StolenTaxParsed)?.data ?? {};
      const snusResultsObj = snusRoot.results ?? {};
      let snusHits = 0;
      const snusSources: string[] = [];
      if (snusResultsObj && typeof snusResultsObj === "object") {
        for (const [srcName, rows] of Object.entries(snusResultsObj)) {
          if (Array.isArray(rows)) {
            snusHits += rows.length;
            snusSources.push(srcName);
          }
        }
      }
      if (snusHits === 0 && typeof snusRoot.size === "number") snusHits = snusRoot.size;

      const brRoot = (breachLegacy.parsed as StolenTaxParsed)?.data ?? {};
      const brHits =
        (Array.isArray(brRoot.breach_data) && brRoot.breach_data.length) ||
        (typeof brRoot.results_count === "number" ? brRoot.results_count : 0);

      const totalHits = dbHits + snusHits + brHits;
      const anyOk = dbSearch.ok || snus.ok || breachLegacy.ok;

      if (anyOk) {
        return {
          ok: true,
          source: "stolen.tax (osintcat database-search + snusbase + breach)",
          data: {
            success: totalHits > 0,
            found: totalHits,
            per_source: {
              osintcat_database_search: { ok: dbSearch.ok, hits: dbHits, sample: Array.isArray(dbResults) ? dbResults.slice(0, 25) : [] },
              snusbase: { ok: snus.ok, hits: snusHits, sources: snusSources, sample_keys: snusSources.slice(0, 10), data_size: snusRoot.size ?? null },
              osintcat_breach: { ok: breachLegacy.ok, hits: brHits },
            },
            // Keep raw payloads (truncated) for the agent / minimax_extract.
            raw: {
              osintcat_database_search: dbSearch.parsed,
              snusbase: snus.parsed,
            },
          },
        };
      }
      // All three failed: fall through to leakcheck public.
    }
    // Fallback: legacy leakcheck public endpoint.
    try {
      const r = await fetch(
        `https://leakcheck.io/api/public?check=${encodeURIComponent(query)}`,
      );
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, source: "leakcheck.public", data };
    } catch (e) {
      return { error: String(e) };
    }
  },
}),

export const stolentax_footprint = tool({
  description:
    "stolen.tax OsintCat-Footprint — account-discovery sweep across ~127 sites for an email or username. Returns per-site presence + extra account metadata (display name, user_id, plan, SSO providers, password-set flag, etc.). Complements deepfind_reverse_email (different site list) and is higher-fidelity per hit. Same 1000/day stolen.tax budget as breach_check.",
  inputSchema: z.object({
    value: z.string().min(1),
    type: z.enum(["auto", "email", "username"]).default("auto"),
  }),
  execute: async ({ value, type }) => {
    const STOLENTAX_API_KEY = Deno.env.get("STOLENTAX_API_KEY");
    if (!STOLENTAX_API_KEY) return { error: "STOLENTAX_API_KEY not configured" };
    const q = value.trim();
    if (!q) return { error: "missing value" };
    // Auto-detect: contains '@' -> email, else username.
    const ft = type === "auto" ? (q.includes("@") ? "email" : "username") : type;
    try {
      const r = await fetch(
        "https://stolen.tax/api/v2/index.php?path=osintcat-footprint",
        {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${STOLENTAX_API_KEY}`,
            "X-API-Key": STOLENTAX_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ query: q, footprint_type: ft }),
        },
      );
      const text = await r.text();
      let parsed: StolenTaxParsed;
      try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 4000) }; }
      const d = parsed?.data ?? {};
      const taken = Array.isArray(d?.results)
        ? (d.results as FootprintResult[]).filter((x) => x?.taken === true).map((x) => ({ domain: x.domain, extra: x.ExtraData ?? null }))
        : [];
      return {
        ok: r.ok,
        status: r.status,
        source: "stolen.tax/osintcat-footprint",
        footprint_type: ft,
        stats: d?.stats ?? null,
        taken_count: taken.length,
        taken,
        raw: parsed,
      };
    } catch (e) {
      return { error: String(e) };
    }
  },
}),

export const leakcheck_lookup = tool({
  description:
    "LeakCheck Pro v2 breach lookup (https://leakcheck.io/api/v2). SECONDARY breach source — 200 calls/day. Returns leak sources, breach dates, and (where present) passwords/usernames for an email, username, phone, hash, or domain. Use to corroborate breach_check and to surface password/source detail. Do NOT spam on low-value handles.",
  inputSchema: z.object({
    value: z.string().min(1),
    type: z.enum(["auto","email","username","phone","hash","domain","keyword"]).optional().default("auto"),
  }),
  execute: async ({ value, type }) => {
    const LEAKCHECK_API_KEY = Deno.env.get("LEAKCHECK_API_KEY");
    if (!LEAKCHECK_API_KEY) return { error: "LEAKCHECK_API_KEY not configured" };
    const q = value.trim();
    if (!q) return { error: "missing value" };
    try {
      const url = `https://leakcheck.io/api/v2/query/${encodeURIComponent(q)}?type=${encodeURIComponent(type ?? "auto")}`;
      const r = await fetch(url, { headers: { "X-API-Key": LEAKCHECK_API_KEY, "Accept": "application/json" } });
      const text = await r.text();
      let data: unknown;
      try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 4000) }; }
      const d = data as LeakCheckResponse;
      const found = (typeof d?.found === "number" ? d.found : Array.isArray(d?.result) ? d.result.length : 0);
      const quota = typeof d?.quota === "number" ? d.quota : undefined;
      const sources = Array.isArray(d?.result)
        ? Array.from(new Set(d.result.map((x) => x?.source?.name).filter(Boolean))).slice(0, 50)
        : [];
      return { ok: r.ok, status: r.status, source: "leakcheck.v2", data: { success: !!d?.success, found, quota, sources, raw: data } };
    } catch (e) {
      return { error: String(e) };
    }
  },
}),

export const hibp_lookup = tool({
  description:
    "Have I Been Pwned v3 breach + paste lookup (https://haveibeenpwned.com/api/v3). Authoritative breach corroboration — Troy Hunt's curated breach corpus. Returns breach metadata (name, domain, breach date, data classes). Requires HIBP_API_KEY (paid Pwned subscription). Rate: 1 req / 1.5s per key. Use to corroborate breach_check / leakcheck_lookup on confirmed emails.",
  inputSchema: z.object({
    email: z.string().email(),
    include_pastes: z.boolean().optional().default(false),
    truncate: z.boolean().optional().default(false).describe("If true, only breach names are returned (smaller payload)."),
  }),
  execute: async ({ email, include_pastes, truncate }) => {
    if (!HIBP_API_KEY) return { error: "HIBP_API_KEY not configured", skipped: true };
    const headers = {
      "hibp-api-key": HIBP_API_KEY,
      "user-agent": "lovable-osint-agent",
      "Accept": "application/json",
    };
    try {
      const bUrl = `https://haveibeenpwned.com/api/v3/breachedaccount/${encodeURIComponent(email)}?truncateResponse=${truncate ? "true" : "false"}`;
      const br = await fetchRetry(bUrl, { headers }, { retries: 1 });
      let breaches: unknown = null;
      if (br.status === 404) breaches = [];
      else if (br.ok) breaches = await br.json().catch(() => null);
      else return { error: `hibp breaches ${br.status}`, status: br.status };
      let pastes: unknown = null;
      if (include_pastes) {
        const pr = await fetchRetry(
          `https://haveibeenpwned.com/api/v3/pasteaccount/${encodeURIComponent(email)}`,
          { headers },
          { retries: 1 },
        );
        if (pr.status === 404) pastes = [];
        else if (pr.ok) pastes = await pr.json().catch(() => null);
      }
      const breachCount = Array.isArray(breaches) ? breaches.length : 0;
      const pasteCount = Array.isArray(pastes) ? (pastes as unknown[]).length : 0;
      return { ok: true, source: "hibp.v3", data: { breachCount, pasteCount, breaches, pastes } };
    } catch (e) {
      return { error: String(e) };
    }
  },
}),

// PRIMARY breach source — RapidAPI Email Breach Search (DataBreach.com, ~8000/mo).
// Email goes in the PATH: GET /rapidapi/search-email/<email>. The authoritative
// definition is inline in ../tool-registry.ts; this static export mirrors it so
// the catalog↔runtime contract test (which greps tools/*.ts) stays in sync.
export const rapidapi_breach_search = tool({
  description:
    "PRIMARY breach source — RapidAPI Email Breach Search (~8000 lookups/month). For an email, returns the breach corpus it appears in: per-breach id/name, breach date, exposed field set with `sensitive` flags, rows, hibp_id. A hit is an EXPOSURE association, not confirmed identity. Requires RAPIDAPI_KEY; self-skips when absent.",
  inputSchema: z.object({ email: z.string().email() }),
  execute: async ({ email }: { email: string }) => {
    const RAPIDAPI_KEY = Deno.env.get("RAPIDAPI_KEY");
    if (!RAPIDAPI_KEY) return { error: "RAPIDAPI_KEY not configured", skipped: true };
    const host = (Deno.env.get("RAPIDAPI_BREACH_HOST") ?? "email-breach-search.p.rapidapi.com").trim();
    const pathPrefix = (Deno.env.get("RAPIDAPI_BREACH_PATH") ?? "/rapidapi/search-email/").trim();
    const q = email.trim();
    if (!q) return { error: "missing email" };
    try {
      const url = `https://${host}${pathPrefix}${encodeURIComponent(q)}`;
      const r = await fetchT(url, {
        headers: { "X-RapidAPI-Key": RAPIDAPI_KEY, "X-RapidAPI-Host": host, "Accept": "application/json" },
      }, 20_000);
      const text = await r.text();
      let data: unknown;
      try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 4000) }; }
      interface BreachField { field?: string; label?: string; sensitive?: boolean; [k: string]: unknown }
      interface BreachEntry { id?: string; name?: string; found?: BreachField[]; breach_date?: string; rows?: number; hibp_id?: string; [k: string]: unknown }
      const entries: BreachEntry[] = Array.isArray(data) ? data as BreachEntry[] : [];
      const breaches = entries.map((e) => ({
        id: e.id ?? null,
        name: e.name ?? e.id ?? null,
        breach_date: e.breach_date ?? null,
        rows: typeof e.rows === "number" ? e.rows : null,
        hibp_id: e.hibp_id ?? null,
        exposed_fields: Array.isArray(e.found) ? Array.from(new Set(e.found.map((f) => f.label ?? f.field).filter(Boolean))) : [],
        has_sensitive: Array.isArray(e.found) ? e.found.some((f) => f.sensitive === true) : false,
      }));
      return {
        ok: r.ok, status: r.status, source: "rapidapi.breach_search",
        data: { email: q, breaches_found: breaches.length, breach_names: breaches.map((b) => b.name).filter(Boolean).slice(0, 50), has_sensitive_exposure: breaches.some((b) => b.has_sensitive), breaches, raw: data },
      };
    } catch (e) {
      return { error: String(e) };
    }
  },
}),

// REFERENCE catalog — GET /rapidapi/all-breaches. Whole-corpus metadata, no PII.
export const rapidapi_all_breaches = tool({
  description:
    "RapidAPI Email Breach Search — All Breaches catalog. Reference list of the entire DataBreach.com corpus (name, id, row count, exposed field types, dates, summary, hibp_id). No PII / not email-specific. Use only to contextualize a breach id. Requires RAPIDAPI_KEY; self-skips when absent.",
  inputSchema: z.object({ filter: z.string().optional(), limit: z.number().int().min(1).max(500).optional().default(100) }),
  execute: async ({ filter, limit }: { filter?: string; limit?: number }) => {
    const RAPIDAPI_KEY = Deno.env.get("RAPIDAPI_KEY");
    if (!RAPIDAPI_KEY) return { error: "RAPIDAPI_KEY not configured", skipped: true };
    const host = (Deno.env.get("RAPIDAPI_BREACH_HOST") ?? "email-breach-search.p.rapidapi.com").trim();
    const path = (Deno.env.get("RAPIDAPI_ALL_BREACHES_PATH") ?? "/rapidapi/all-breaches").trim();
    try {
      const r = await fetchT(`https://${host}${path}`, {
        headers: { "X-RapidAPI-Key": RAPIDAPI_KEY, "X-RapidAPI-Host": host, "Accept": "application/json" },
      }, 20_000);
      const text = await r.text();
      let data: unknown;
      try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 4000) }; }
      interface CatalogField { field?: string; label?: string; sensitive?: boolean; [k: string]: unknown }
      interface CatalogEntry { name?: string; id?: string; rows?: number; breach_date?: string; hibp_id?: string; fields?: CatalogField[]; field_counts?: Record<string, number>; [k: string]: unknown }
      const all: CatalogEntry[] = Array.isArray((data as { breaches?: unknown })?.breaches)
        ? (data as { breaches: CatalogEntry[] }).breaches
        : Array.isArray(data) ? data as CatalogEntry[] : [];
      const f = (filter ?? "").trim().toLowerCase();
      const matched = f ? all.filter((b) => `${b.name ?? ""} ${b.id ?? ""}`.toLowerCase().includes(f)) : all;
      const slice = matched.slice(0, limit ?? 100).map((b) => ({
        name: b.name ?? b.id ?? null, id: b.id ?? null,
        rows: typeof b.rows === "number" ? b.rows : null, breach_date: b.breach_date ?? null, hibp_id: b.hibp_id ?? null,
        fields: Array.isArray(b.fields) ? Array.from(new Set(b.fields.map((x) => x.label ?? x.field).filter(Boolean))) : (b.field_counts ? Object.keys(b.field_counts) : []),
        has_sensitive: Array.isArray(b.fields) ? b.fields.some((x) => x.sensitive === true) : false,
      }));
      return { ok: r.ok, status: r.status, source: "rapidapi.all_breaches", data: { total_in_corpus: all.length, matched: matched.length, returned: slice.length, filter: f || null, breaches: slice } };
    } catch (e) {
      return { error: String(e) };
    }
  },
}),
