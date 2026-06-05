/**
 * tools/email.ts — Auto-extracted. Add imports manually.
 */
import { tool } from "npm:ai@6";
import { z } from "npm:zod@3";
import { createClient } from "npm:@supabase/supabase-js@2";

/**
 * Loose shapes for the Hunter.io v2 endpoints. Only the fields we read are
 * typed; everything else stays reachable via the index signatures. The
 * top-level `{ data, errors }` envelope wraps each endpoint's payload.
 */
interface HunterEnvelope<T> {
  data?: T;
  errors?: unknown;
  [k: string]: unknown;
}

/** One email record in the Hunter domain-search response. */
interface HunterDomainEmail {
  value?: string;
  first_name?: string;
  last_name?: string;
  position?: string;
  department?: string;
  seniority?: string;
  linkedin?: string;
  twitter?: string;
  phone_number?: string;
  confidence?: number;
  sources?: Array<{ uri?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}

interface HunterDomainData {
  organization?: string;
  country?: string;
  pattern?: string;
  webmail?: boolean;
  disposable?: boolean;
  meta?: { results?: number; [k: string]: unknown };
  emails?: HunterDomainEmail[];
  [k: string]: unknown;
}

/** Generic record used for the shallow Hunter finder/verifier payloads. */
type HunterRecord = Record<string, unknown>;

type HunterHandle = { handle?: string };

/** Deeply-nested person payload from Hunter combined / people-find. */
interface HunterPerson {
  name?: { fullName?: string; givenName?: string; familyName?: string };
  geo?: { city?: string; country?: string };
  bio?: string;
  site?: string;
  avatar?: string;
  employment?: unknown;
  github?: HunterHandle;
  twitter?: HunterHandle;
  linkedin?: HunterHandle;
  aboutme?: HunterHandle;
  [k: string]: unknown;
}

/** Deeply-nested company payload from Hunter combined / companies-find. */
interface HunterCompany {
  name?: string;
  legalName?: string;
  domain?: string;
  description?: string;
  category?: { industry?: string; subIndustry?: string };
  metrics?: { employees?: number; employeesRange?: string; annualRevenue?: number };
  foundedYear?: number;
  tech?: unknown[];
  geo?: { city?: string; country?: string };
  linkedin?: HunterHandle;
  twitter?: HunterHandle;
  facebook?: HunterHandle;
  [k: string]: unknown;
}

/** The combined endpoint nests person + company under `data`. */
interface HunterCombinedData {
  person?: HunterPerson;
  company?: HunterCompany;
  [k: string]: unknown;
}

export const emailrep = tool({
  description:
    "Free EmailRep.io reputation lookup. Returns reputation (high/medium/low/none), suspicious flag, deliverability, breach count, domain age, and which sites the email is registered on. Great corroboration for any email seed.",
  inputSchema: z.object({ email: z.string().email() }),
  execute: async ({ email }) => {
    try {
      const r = await fetch(`https://emailrep.io/${encodeURIComponent(email)}`, {
        headers: { "User-Agent": "Proximity-OSINT", Accept: "application/json" },
      });
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, data };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const gravatar_profile = tool({
  description:
    "Look up a Gravatar profile by email. Returns display name, bio, linked social accounts, avatar URL — and confirms the email is real. Always run on any email seed.",
  inputSchema: z.object({ email: z.string().email() }),
  execute: async ({ email }) => {
    try {
      const enc = new TextEncoder().encode(email.trim().toLowerCase());
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", enc)))
        .map((b) => b.toString(16).padStart(2, "0")).join("");
      const r = await fetch(`https://api.gravatar.com/v3/profiles/${hash}`, {
        headers: { Accept: "application/json", "User-Agent": "Proximity-OSINT" },
      });
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, hash, avatar_url: `https://gravatar.com/avatar/${hash}`, data };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const hunter_domain_search = tool({
  description:
    "Hunter.io domain-search. Returns emails associated with a domain, plus organization, pattern, department/seniority breakdown, and per-email sources. Premium signal — use on any non-consumer domain.",
  inputSchema: z.object({
    domain: z.string(),
    limit: z.number().int().min(1).max(100).optional(),
    department: z.string().optional().describe("executive, it, finance, management, sales, legal, support, hr, marketing, communication, education, design, health, operations"),
    seniority: z.string().optional().describe("junior, senior, executive"),
    type: z.enum(["personal", "generic"]).optional(),
  }),
  execute: async ({ domain, limit, department, seniority, type }) => {
    if (!HUNTER_API_KEY) return { error: "HUNTER_API_KEY not configured" };
    try {
      const params = new URLSearchParams({ domain, api_key: HUNTER_API_KEY });
      if (limit) params.set("limit", String(limit));
      if (department) params.set("department", department);
      if (seniority) params.set("seniority", seniority);
      if (type) params.set("type", type);
      const r = await fetch(`https://api.hunter.io/v2/domain-search?${params}`);
      const data = await r.json().catch(() => ({})) as HunterEnvelope<HunterDomainData>;
      const d: HunterDomainData = data?.data ?? {};
      return {
        ok: r.ok,
        status: r.status,
        organization: d.organization,
        country: d.country,
        pattern: d.pattern,
        webmail: d.webmail,
        disposable: d.disposable,
        total: d.meta?.results ?? (d.emails?.length ?? 0),
        emails: (d.emails ?? []).map((e) => ({
          value: e.value,
          first_name: e.first_name,
          last_name: e.last_name,
          position: e.position,
          department: e.department,
          seniority: e.seniority,
          linkedin: e.linkedin,
          twitter: e.twitter,
          phone: e.phone_number,
          confidence: e.confidence,
          sources_count: (e.sources ?? []).length,
          sample_source: e.sources?.[0]?.uri,
        })),
        errors: data?.errors,
      };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const hunter_email_finder = tool({
  description:
    "Hunter.io email-finder. Guess and verify a person's email at a given domain using their name. Returns email + score + verification status.",
  inputSchema: z.object({
    domain: z.string(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    full_name: z.string().optional(),
  }),
  execute: async ({ domain, first_name, last_name, full_name }) => {
    if (!HUNTER_API_KEY) return { error: "HUNTER_API_KEY not configured" };
    if (!first_name && !last_name && !full_name) return { error: "Provide first_name+last_name or full_name" };
    try {
      const params = new URLSearchParams({ domain, api_key: HUNTER_API_KEY });
      if (first_name) params.set("first_name", first_name);
      if (last_name) params.set("last_name", last_name);
      if (full_name) params.set("full_name", full_name);
      const r = await fetch(`https://api.hunter.io/v2/email-finder?${params}`);
      const data = await r.json().catch(() => ({})) as HunterEnvelope<HunterRecord>;
      const d: HunterRecord = data?.data ?? {};
      return {
        ok: r.ok && !!d.email,
        status: r.status,
        email: d.email,
        score: d.score,
        first_name: d.first_name,
        last_name: d.last_name,
        position: d.position,
        linkedin: d.linkedin_url,
        verification: d.verification,
        sources_count: ((d.sources as unknown[]) ?? []).length,
        errors: data?.errors,
      };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const hunter_email_verifier = tool({
  description:
    "Hunter.io email-verifier. Returns deliverability status (deliverable/undeliverable/risky/unknown), MX/SMTP checks, disposable/webmail/gibberish flags, and a 0-100 score.",
  inputSchema: z.object({ email: z.string().email() }),
  execute: async ({ email }) => {
    if (!HUNTER_API_KEY) return { error: "HUNTER_API_KEY not configured" };
    try {
      const r = await fetch(`https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${HUNTER_API_KEY}`);
      const data = await r.json().catch(() => ({})) as HunterEnvelope<HunterRecord>;
      const d: HunterRecord = data?.data ?? {};
      return {
        ok: r.ok,
        status: r.status,
        email: d.email,
        result: d.result,
        status_detail: d.status,
        score: d.score,
        regexp: d.regexp,
        gibberish: d.gibberish,
        disposable: d.disposable,
        webmail: d.webmail,
        mx_records: d.mx_records,
        smtp_server: d.smtp_server,
        smtp_check: d.smtp_check,
        accept_all: d.accept_all,
        block: d.block,
        sources_count: ((d.sources as unknown[]) ?? []).length,
        errors: data?.errors,
      };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const hunter_combined = tool({
  description:
    "Hunter.io combined enrichment (person + company) for an email. Returns name, role, seniority, social profiles, plus the company's industry, size, tech stack, HQ, founded date, social presence.",
  inputSchema: z.object({ email: z.string().email() }),
  execute: async ({ email }) => {
    if (!HUNTER_API_KEY) return { error: "HUNTER_API_KEY not configured" };
    try {
      const r = await fetch(`https://api.hunter.io/v2/combined/find?email=${encodeURIComponent(email)}&api_key=${HUNTER_API_KEY}`);
      const data = await r.json().catch(() => ({})) as HunterEnvelope<HunterCombinedData>;
      // Hunter's Combined endpoint requires a paid plan; on 400/403 the
      // free plan falls through. Try person + company enrichment in
      // parallel as a graceful fallback so the email still gets enriched.
      if (!r.ok && (r.status === 400 || r.status === 403)) {
        const domain = email.split("@")[1] ?? "";
        const [pr, cr] = await Promise.all([
          fetch(`https://api.hunter.io/v2/people/find?email=${encodeURIComponent(email)}&api_key=${HUNTER_API_KEY}`).then(x => x.json()).catch(() => ({})),
          domain ? fetch(`https://api.hunter.io/v2/companies/find?domain=${encodeURIComponent(domain)}&api_key=${HUNTER_API_KEY}`).then(x => x.json()).catch(() => ({})) : Promise.resolve({}),
        ]);
        const pp: HunterPerson = (pr as HunterEnvelope<HunterPerson>)?.data ?? {};
        const cc: HunterCompany = (cr as HunterEnvelope<HunterCompany>)?.data ?? {};
        const hasAny = Object.keys(pp).length > 0 || Object.keys(cc).length > 0;
        if (hasAny) {
          return {
            ok: true,
            status: 200,
            fallback: "people+companies",
            person: {
              name: pp.name?.fullName,
              location: pp.geo?.city ? `${pp.geo.city}, ${pp.geo.country}` : undefined,
              employment: pp.employment,
              github: pp.github?.handle,
              twitter: pp.twitter?.handle,
              linkedin: pp.linkedin?.handle,
            },
            company: {
              name: cc.name,
              domain: cc.domain,
              industry: cc.category?.industry,
              employees: cc.metrics?.employees,
              tech: (cc.tech ?? []).slice(0, 25),
            },
          };
        }
        return { ok: false, status: r.status, error: `hunter_combined ${r.status} (plan-gated; people/companies also empty)` };
      }
      const d: HunterCombinedData = data?.data ?? {};
      const p: HunterPerson = d.person ?? {};
      const c: HunterCompany = d.company ?? {};
      return {
        ok: r.ok,
        status: r.status,
        person: {
          name: p.name?.fullName,
          given_name: p.name?.givenName,
          family_name: p.name?.familyName,
          location: p.geo?.city ? `${p.geo.city}, ${p.geo.country}` : undefined,
          bio: p.bio,
          site: p.site,
          avatar: p.avatar,
          employment: p.employment,
          github: p.github?.handle,
          twitter: p.twitter?.handle,
          linkedin: p.linkedin?.handle,
          aboutme: p.aboutme?.handle,
        },
        company: {
          name: c.name,
          legal_name: c.legalName,
          domain: c.domain,
          description: c.description,
          industry: c.category?.industry,
          sub_industry: c.category?.subIndustry,
          employees: c.metrics?.employees,
          employees_range: c.metrics?.employeesRange,
          annual_revenue: c.metrics?.annualRevenue,
          founded: c.foundedYear,
          tech: (c.tech ?? []).slice(0, 25),
          location: c.geo?.city ? `${c.geo.city}, ${c.geo.country}` : undefined,
          linkedin: c.linkedin?.handle,
          twitter: c.twitter?.handle,
          facebook: c.facebook?.handle,
        },
        errors: data?.errors,
      };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const bosint_email_lookup = tool({
  description:
    "OSINTNova (Bosint) email exposure check. Surface-level breach + exposure indicators for an email address. Shared 1000 calls/day quota across Bosint endpoints, 120/min. Fire ONCE per email seed and once per newly-confirmed email mid-run, in parallel with the other breach sources. Returns {success, data, api_metadata}.",
  inputSchema: z.object({ email: z.string().describe("Email address to check") }),
  execute: async ({ email }) => {
    if (!OSINTNOVA_API_KEY) return { error: "OSINTNOVA_API_KEY not configured" };
    try {
      const url = `https://app.osintnova.com/bosintapi/${OSINTNOVA_API_KEY}/email/${encodeURIComponent(email)}`;
      const r = await fetchRetry(url, { headers: { "accept": "application/json" } }, { retries: 1 });
      const text = await r.text();
      let data: unknown;
      try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 4000) }; }
      return { ok: r.ok, status: r.status, data };
    } catch (e) {
      return { error: String(e) };
    }
  },
}),

export const bosint_phone_lookup = tool({
  description:
    "OSINTNova (Bosint) phone intelligence. Carrier, location, line type, timezone, and associated names when available. Pass full E.164 number with country code (e.g. '+12025551234'). Shared 1000 calls/day quota across Bosint endpoints, 120/min. Fire ONCE per phone seed in parallel with leakcheck_lookup + oathnet_lookup. SLOW upstream — capped at 25s + 1 retry; will return a timeout marker if it hangs.",
  inputSchema: z.object({ phone: z.string().describe("Phone number in E.164 format, e.g. +12025551234") }),
  execute: async ({ phone }) => {
    if (!OSINTNOVA_API_KEY) return { error: "OSINTNOVA_API_KEY not configured" };
    const cleaned = phone.trim();
    const url = `https://app.osintnova.com/bosintapi/${OSINTNOVA_API_KEY}/phone/${encodeURIComponent(cleaned)}`;
    // Strict 25s per attempt, max 2 attempts with a 10s backoff, hard
    // ceiling at 60s so a hung upstream can never stall the stream.
    const attemptOnce = async (signal: AbortSignal) => {
      const r = await fetch(url, { headers: { accept: "application/json" }, signal });
      const text = await r.text();
      let data: unknown;
      try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 4000) }; }
      return { ok: r.ok, status: r.status, data };
    };
    const runWithTimeout = async (ms: number) => {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), ms);
      try { return await attemptOnce(ctrl.signal); }
      finally { clearTimeout(tid); }
    };
    const started = Date.now();
    try {
      return await runWithTimeout(25_000);
    } catch (e1) {
      const elapsed = Date.now() - started;
      if (elapsed > 30_000) {
        console.warn("bosint_phone_lookup timed out — using fallback sources only");
        return { error: "bosint_phone_timeout", skipped: true, hint: "leakcheck_lookup + oathnet_lookup cover this phone." };
      }
      // brief backoff then a single retry
      await new Promise((r) => setTimeout(r, 10_000));
      try { return await runWithTimeout(25_000); }
      catch (e2) {
        console.warn("bosint_phone_lookup timed out — using fallback sources only");
        return { error: "bosint_phone_timeout", skipped: true, hint: "leakcheck_lookup + oathnet_lookup cover this phone." };
      }
    }
  },
}),

export const deepfind_reverse_email = tool({
  description:
    "DeepFind.Me reverse-email account discovery (https://deepfind.me) — checks ~120 services for accounts registered to an email address. Returns service hits plus partial email/phone recovery hints. Shared DeepFind budget: 1000 calls/day.",
  inputSchema: z.object({ email: z.string().email() }),
  execute: async ({ email }) => {
    const KEY = Deno.env.get("DEEPFIND_API_KEY");
    if (!KEY) return { error: "DEEPFIND_API_KEY not configured" };
    try {
      const r = await fetch(`https://deepfind.me/api/tools/reverse-email-check?email=${encodeURIComponent(email)}`, {
        headers: { "X-DFME-API-KEY": KEY, "Accept": "application/json" },
      });
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, source: "deepfind.reverse_email", data };
    } catch (e) { return { error: String(e) }; }
  },
}),

export const deepfind_disposable_email = tool({
  description:
    "DeepFind.Me disposable/burner email detector. Flags temp-mail providers via known-list + MX heuristics. Use to grade email credibility before pivoting.",
  inputSchema: z.object({ email: z.string().email() }),
  execute: async ({ email }) => {
    const KEY = Deno.env.get("DEEPFIND_API_KEY");
    if (!KEY) return { error: "DEEPFIND_API_KEY not configured" };
    try {
      const r = await fetch(`https://deepfind.me/api/disposable-email/check/${encodeURIComponent(email)}`, {
        headers: { "X-DFME-API-KEY": KEY, "Accept": "application/json" },
      });
      const data = await r.json().catch(() => ({}));
      return { ok: r.ok, status: r.status, source: "deepfind.disposable", data };
    } catch (e) { return { error: String(e) }; }
  },
}),

