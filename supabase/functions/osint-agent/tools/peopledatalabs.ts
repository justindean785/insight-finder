// tools/peopledatalabs.ts
//
// People Data Labs — Person Enrichment API (v5). One-to-one match against
// PDL's ~3B person profile dataset; returns names, emails, phones, socials,
// employment, education, and location fields for a matched profile.
//
// Follows the same contract as tools/indicia.ts (approved pattern):
//   • Gated on PEOPLEDATALABS_API_KEY via capabilities.ts — readiness gate
//     drops the tool from the schema on keyless deploys.
//   • 402 / 429 → skipped (quota / rate limit), not failed.
//   • 404 (no match) → empty, not failed.
//   • HTTP error / success:false / no data → failed.
//   • Match found → { ok:true, ... }.
//
// SOURCE-CLASSIFICATION: `broker` (data-broker aggregator). Single hit is a
// LEAD, not a confirmation — same treatment as Indicia person records.

import { tool } from "npm:ai@6";
import { z } from "npm:zod@3";
import { fetchT } from "../fetch_retry.ts";

const PDL_BASE = "https://api.peopledatalabs.com/v5";
const PDL_HTTP_TIMEOUT_MS = 18_000;

interface PdlResult {
  ok?: boolean;
  empty?: boolean;
  source?: string;
  endpoint?: string;
  query?: unknown;
  likelihood?: number;
  person?: unknown;
  status?: number;
  error?: string;
}

/**
 * PDL Person Enrichment.
 * At least one strong selector is required (email / phone / profile URL /
 * name+company or name+location). PDL treats blank params as unspecified,
 * so we strip them before sending.
 */
export const pdl_person_enrich = tool({
  description:
    "People Data Labs Person Enrichment (~3B profiles) — PROFESSIONAL enrichment. Strongest on LinkedIn URLs, work emails, and (name+company). Returns names, work/personal emails, phones, LinkedIn/Twitter/GitHub profiles, employment + education history, geo. " +
    "NARROW USE: only call when the subject has a plausible professional footprint AND you have (a) a LinkedIn URL, (b) a confirmed work email, (c) name+company, (d) name+school, or (e) name+specific city/region. DO NOT call for bare gaming/anon handles, minors, name-only queries without an employer/location disambiguator, or subjects the case has already framed as consumer/social-only (TikTok/Discord/gaming) — the dataset is professional-biased and will burn a credit for no match. " +
    "Best as a pivot after a LinkedIn/company hit or when a breach surfaces a work email. Broker/aggregate data: LEAD until corroborated. 1 credit per successful match; 404 no-match is free.",
  inputSchema: z.object({
    email: z.string().optional().describe("Email address to match on."),
    phone: z.string().optional().describe("Phone number (E.164 preferred)."),
    profile: z.string().optional().describe("A social profile URL (linkedin.com/in/..., twitter.com/..., github.com/..., facebook.com/...)."),
    name: z.string().optional().describe("Full name. Pair with company or location for a strong match."),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    company: z.string().optional().describe("Current or past employer, to disambiguate a name match."),
    school: z.string().optional().describe("School name, to disambiguate a name match."),
    location: z.string().optional().describe("City, region, or country to disambiguate a name match."),
    min_likelihood: z.number().int().min(1).max(10).optional().default(6).describe("PDL likelihood floor (1-10). Default 6 = confident match."),
  }),
  execute: async (input, opts) => {
    const apiKey = Deno.env.get("PEOPLEDATALABS_API_KEY");
    if (!apiKey) {
      return { error: "PEOPLEDATALABS_API_KEY not configured", source: "peopledatalabs", endpoint: "person_enrich" } satisfies PdlResult;
    }

    // Drop blank/undefined so PDL doesn't treat "" as a specified filter.
    const params = new URLSearchParams();
    const passthrough: Array<keyof typeof input> = [
      "email", "phone", "profile", "name", "first_name", "last_name",
      "company", "school", "location",
    ];
    for (const k of passthrough) {
      const v = input[k];
      if (typeof v === "string" && v.trim().length > 0) params.set(k, v.trim());
    }
    if (input.min_likelihood != null) params.set("min_likelihood", String(input.min_likelihood));

    // Strict selector gate — enforce the "professional-context" contract from the
    // tool description at execution time. `location` alone with a name is NOT
    // enough (per user policy: name+context, not name+country). We require an
    // employer/school OR a specific locality-level location string (comma-
    // separated, e.g. "Austin, TX") — a bare country/region gets rejected.
    const looksSpecificLocation = (v: string | null): boolean => {
      if (!v) return false;
      const s = v.trim();
      // "City, Region" or "City, Country" style — at least one comma + 3+ chars each side.
      return /,\s*\S{2,}/.test(s) && s.length >= 6;
    };
    const hasStrongDirect = ["email","phone","profile"].some((k) => params.has(k));
    const hasNameAndEmployer = (params.has("name") || (params.has("first_name") && params.has("last_name")))
      && (params.has("company") || params.has("school"));
    const hasNameAndSpecificLocation = (params.has("name") || (params.has("first_name") && params.has("last_name")))
      && looksSpecificLocation(params.get("location"));
    if (!(hasStrongDirect || hasNameAndEmployer || hasNameAndSpecificLocation)) {
      return {
        ok: false,
        skipped: true,
        source: "peopledatalabs",
        endpoint: "person_enrich",
        error: "peopledatalabs: gated — needs a professional selector: (email/phone/profile URL) OR (name+company|school) OR (name + specific 'City, Region'). Name-only or name+country is not enough.",
      } as PdlResult;
    }

    const signal = (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
    let resp: Response;
    try {
      resp = await fetchT(
        `${PDL_BASE}/person/enrich?${params.toString()}`,
        {
          method: "GET",
          headers: { "X-Api-Key": apiKey, Accept: "application/json" },
          signal,
        },
        PDL_HTTP_TIMEOUT_MS,
      );
    } catch (err) {
      const isAbort = err instanceof DOMException && err.name === "AbortError";
      return {
        source: "peopledatalabs",
        endpoint: "person_enrich",
        error: isAbort
          ? "peopledatalabs person_enrich timed out"
          : `peopledatalabs network error: ${err instanceof Error ? err.message : String(err)}`,
      } satisfies PdlResult;
    }

    // Quota / rate-limit → SKIPPED (not a provider fault; balance is neutral).
    if (resp.status === 402 || resp.status === 429) {
      await resp.body?.cancel().catch(() => {});
      return {
        ok: false,
        status: resp.status,
        source: "peopledatalabs",
        endpoint: "person_enrich",
        error: `peopledatalabs quota/credit exhausted (HTTP ${resp.status}) — provider suppressed for investigation`,
      } satisfies PdlResult;
    }

    // PDL returns 404 with { status:404, error:{...} } when no profile matches
    // — a valid negative, not a failure.
    if (resp.status === 404) {
      await resp.body?.cancel().catch(() => {});
      return {
        ok: false,
        empty: true,
        status: 404,
        source: "peopledatalabs",
        endpoint: "person_enrich",
        query: Object.fromEntries(params.entries()),
        error: "peopledatalabs person_enrich: no matching profile found",
      } satisfies PdlResult;
    }

    let json: unknown;
    try {
      json = await resp.json();
    } catch (err) {
      return {
        ok: false,
        status: resp.status,
        source: "peopledatalabs",
        endpoint: "person_enrich",
        error: `peopledatalabs invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      } satisfies PdlResult;
    }

    if (!resp.ok) {
      const msg = (json as { error?: { message?: unknown } } | null)?.error?.message;
      return {
        ok: false,
        status: resp.status,
        source: "peopledatalabs",
        endpoint: "person_enrich",
        error: `peopledatalabs HTTP ${resp.status}${typeof msg === "string" ? `: ${msg}` : ""}`,
      } satisfies PdlResult;
    }

    const env = json as { status?: number; likelihood?: number; data?: unknown; error?: { message?: string } };
    if (env.status && env.status >= 400) {
      return {
        ok: false,
        status: env.status,
        source: "peopledatalabs",
        endpoint: "person_enrich",
        error: `peopledatalabs error ${env.status}${env.error?.message ? `: ${env.error.message}` : ""}`,
      } satisfies PdlResult;
    }
    if (!env.data) {
      return {
        ok: false,
        empty: true,
        source: "peopledatalabs",
        endpoint: "person_enrich",
        query: Object.fromEntries(params.entries()),
        error: "peopledatalabs person_enrich: no usable result — no matching profile data",
      } satisfies PdlResult;
    }

    // Trim the profile: PDL responses are large (~50 KB) and blow the context
    // window. Keep the identity-critical fields only; drop the raw
    // experience/education arrays' internal metadata to just human-readable
    // summaries.
    const d = env.data as Record<string, unknown>;
    const trimmed = {
      full_name: d.full_name,
      first_name: d.first_name,
      middle_name: d.middle_name,
      last_name: d.last_name,
      gender: d.gender,
      birth_year: d.birth_year,
      location_name: d.location_name,
      location_country: d.location_country,
      location_locality: d.location_locality,
      location_region: d.location_region,
      job_title: d.job_title,
      job_company_name: d.job_company_name,
      job_company_website: d.job_company_website,
      job_company_industry: d.job_company_industry,
      linkedin_url: d.linkedin_url,
      linkedin_username: d.linkedin_username,
      twitter_url: d.twitter_url,
      twitter_username: d.twitter_username,
      github_url: d.github_url,
      github_username: d.github_username,
      facebook_url: d.facebook_url,
      facebook_username: d.facebook_username,
      work_email: d.work_email,
      personal_emails: d.personal_emails,
      mobile_phone: d.mobile_phone,
      phone_numbers: d.phone_numbers,
      profiles: Array.isArray(d.profiles)
        ? (d.profiles as Array<Record<string, unknown>>).slice(0, 20).map((p) => ({
            network: p.network, url: p.url, username: p.username,
          }))
        : undefined,
      experience: Array.isArray(d.experience)
        ? (d.experience as Array<Record<string, unknown>>).slice(0, 10).map((e) => ({
            title: (e.title as Record<string, unknown> | undefined)?.name,
            company: (e.company as Record<string, unknown> | undefined)?.name,
            start_date: e.start_date, end_date: e.end_date,
          }))
        : undefined,
      education: Array.isArray(d.education)
        ? (d.education as Array<Record<string, unknown>>).slice(0, 5).map((e) => ({
            school: (e.school as Record<string, unknown> | undefined)?.name,
            degrees: e.degrees, start_date: e.start_date, end_date: e.end_date,
          }))
        : undefined,
    };

    return {
      ok: true,
      source: "peopledatalabs",
      endpoint: "person_enrich",
      query: Object.fromEntries(params.entries()),
      likelihood: env.likelihood,
      person: trimmed,
    } satisfies PdlResult;
  },
});