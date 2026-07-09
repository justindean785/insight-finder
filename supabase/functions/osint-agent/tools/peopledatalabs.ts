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
// SOURCE-CLASSIFICATION: `breach`-peer broker (data-broker aggregator). Single
// hit is a LEAD, not a confirmation — same treatment as Indicia person records.
//
// This file is the CANONICAL copy (insight-finder). It was authored in the
// Lovable mirror; backported here 2026-07-09 with the audit's four fixes:
//   #1 gated refusal returns skipped:true + "gated" (not a hard failure).
//   #2 pdl_person_enrich added to circuit.ts PREMIUM_TOOLS (once-per-entity).
//   #3 "peopledatalabs"/"pdl" free-text → breach class in source-classification.
//   #4 min_likelihood sent UNCONDITIONALLY (credit-safety — see buildPdlParams).

import { tool } from "npm:ai@6";
import { z } from "npm:zod@3";
import { fetchT } from "../fetch_retry.ts";

const PDL_BASE = "https://api.peopledatalabs.com/v5";
const PDL_HTTP_TIMEOUT_MS = 18_000;
const PDL_DEFAULT_MIN_LIKELIHOOD = 6;

interface PdlResult {
  ok?: boolean;
  empty?: boolean;
  skipped?: boolean;
  source?: string;
  endpoint?: string;
  query?: unknown;
  likelihood?: number;
  person?: unknown;
  status?: number;
  error?: string;
}

export interface PdlInput {
  email?: string;
  phone?: string;
  profile?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  company?: string;
  school?: string;
  location?: string;
  min_likelihood?: number;
}

/**
 * "City, Region" / "City, Country" style — at least one comma with 2+ chars
 * on the right and a 6+ char string overall. A bare country/region is NOT
 * specific enough (per policy: name+context, not name+country).
 */
export function looksSpecificLocation(v: string | null | undefined): boolean {
  if (!v) return false;
  const s = v.trim();
  return /,\s*\S{2,}/.test(s) && s.length >= 6;
}

/**
 * Build the PDL query params from tool input. Drops blank/undefined so PDL
 * doesn't treat "" as a specified filter, and — FIX #4 (credit safety) — sends
 * min_likelihood UNCONDITIONALLY. The zod .default(6) only fills in when args
 * are parsed through the AI SDK; a direct execute() call leaves it undefined,
 * so without this PDL would match + BILL a sub-floor likelihood the tool then
 * discards client-side. Always sending the floor makes PDL do the free-404
 * filtering server-side regardless of invocation path.
 */
export function buildPdlParams(input: PdlInput): URLSearchParams {
  const params = new URLSearchParams();
  const passthrough: Array<keyof PdlInput> = [
    "email", "phone", "profile", "name", "first_name", "last_name",
    "company", "school", "location",
  ];
  for (const k of passthrough) {
    const v = input[k];
    if (typeof v === "string" && v.trim().length > 0) params.set(k, v.trim());
  }
  params.set("min_likelihood", String(input.min_likelihood ?? PDL_DEFAULT_MIN_LIKELIHOOD));
  return params;
}

/**
 * Strict selector gate — enforces the "professional-context" contract at
 * execution time. Requires a strong direct selector (email/phone/profile URL),
 * OR name + employer/school, OR name + a specific "City, Region" location.
 * Name-only or name+country is refused BEFORE the call so it never bills.
 */
export function pdlGateAllows(params: URLSearchParams): boolean {
  const hasName = params.has("name") || (params.has("first_name") && params.has("last_name"));
  const hasStrongDirect = ["email", "phone", "profile"].some((k) => params.has(k));
  const hasNameAndEmployer = hasName && (params.has("company") || params.has("school"));
  const hasNameAndSpecificLocation = hasName && looksSpecificLocation(params.get("location"));
  return hasStrongDirect || hasNameAndEmployer || hasNameAndSpecificLocation;
}

/**
 * PDL Person Enrichment.
 * At least one strong selector is required (email / phone / profile URL /
 * name+company or name+location).
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
    min_likelihood: z.number().int().min(1).max(10).optional().default(PDL_DEFAULT_MIN_LIKELIHOOD).describe("PDL likelihood floor (1-10). Default 6 = confident match."),
  }),
  execute: async (input, opts) => {
    const apiKey = Deno.env.get("PEOPLEDATALABS_API_KEY");
    if (!apiKey) {
      return { error: "PEOPLEDATALABS_API_KEY not configured", source: "peopledatalabs", endpoint: "person_enrich" } satisfies PdlResult;
    }

    const params = buildPdlParams(input);

    if (!pdlGateAllows(params)) {
      // FIX #1: skipped:true + "gated" so classifyToolOutcome treats this as a
      // skip, NOT a hard failure — otherwise every name-only refusal drags down
      // tool_health.ok_pct and counts toward the circuit breaker's 3-strike
      // disable, self-disabling the tool for the rest of the run.
      return {
        ok: false,
        skipped: true,
        source: "peopledatalabs",
        endpoint: "person_enrich",
        error: "peopledatalabs: gated — needs a professional selector: (email/phone/profile URL) OR (name+company|school) OR (name + specific 'City, Region'). Name-only or name+country is not enough.",
      } satisfies PdlResult;
    }

    const floor = input.min_likelihood ?? PDL_DEFAULT_MIN_LIKELIHOOD;
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
        skipped: true,
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

    // Belt-and-suspenders (fix #4 companion): if the floor somehow didn't reach
    // PDL and it returned a sub-floor match, treat it as empty rather than
    // surfacing a weak match as a hit. (The credit is already spent at the 200 —
    // this doesn't refund it, but buildPdlParams above makes it not happen.)
    if (typeof env.likelihood === "number" && env.likelihood < floor) {
      return {
        ok: false,
        empty: true,
        status: 200,
        source: "peopledatalabs",
        endpoint: "person_enrich",
        query: Object.fromEntries(params.entries()),
        likelihood: env.likelihood,
        error: `peopledatalabs person_enrich: match below min_likelihood floor (${env.likelihood} < ${floor}) — treated as no match`,
      } satisfies PdlResult;
    }

    // Trim the profile: PDL responses are large (~50 KB) and blow the context
    // window. Keep the identity-critical fields only.
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
