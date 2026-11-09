// tools/contextdev.ts — LIVE runtime tool defs for Context.dev (api.context.dev/v1).
//
// Late-attached into buildTools() in tool-registry.ts, like tools/indicia.ts. Gated on
// CONTEXT_DEV_API_KEY in capabilities.ts (dropped from the schema on a keyless deploy)
// and on the CONTEXT_DEV_DISABLED kill switch.
//
// Both tools are FREE-FIRST gated by cache.ts (lib/paid-guard-policies.ts): a paid call
// is admitted only after the cheaper tool tried the same selector in this case and came
// back failed or empty, or with force_second_source + second_source_justification.
//
// EVIDENCE. contextdev_scrape is a fetcher: its content is the public page, classed like
// jina_reader_scrape. contextdev_people_search returns CANDIDATE profiles from a
// people index, classed data_broker (lead tier): a same-name match is never the subject
// until a selector overlaps. Neither tool records artifacts itself; the model records
// what it uses through record_artifact / record_finding with structured sources.

import { tool } from "npm:ai@6";
import { z } from "npm:zod@3";
import { contextDevDepsFromEnv, contextDevPeopleSearch, contextDevScrape } from "../lib/contextdev.ts";

const getSignal = (opts: unknown): AbortSignal | undefined =>
  (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;

const forceFields = {
  force_second_source: z.boolean().optional().describe(
    "Set true ONLY to pay for a deliberate second source before the free-first rule is met. Requires second_source_justification.",
  ),
  second_source_justification: z.string().optional().describe(
    "Why a paid second source is worth it here (e.g. 'corroborating an unverified lead from a single breach row'). Logged.",
  ),
};

export const contextdev_scrape = tool({
  description:
    "Context.dev anti-bot page scrape — renders one public URL (JS, Cloudflare/Datadome-protected pages) and returns up to 8,000 chars of main-content Markdown. PAID (~1 credit). " +
    "Use ONLY after jina_reader_scrape or socialfetch_web_read failed or came back empty on the SAME URL; otherwise it is refused uncharged. " +
    "The page is an observation of a public page, not identity proof.",
  inputSchema: z.object({
    url: z.string().min(4).describe("The http(s) URL that the free readers could not read."),
    fresh: z.boolean().optional().describe("true = bypass Context.dev's 3-day page cache (only when the page must be current)."),
    ...forceFields,
  }),
  execute: ({ url, fresh }, opts) => contextDevScrape({ url, fresh }, contextDevDepsFromEnv(getSignal(opts))),
});

export const contextdev_people_search = tool({
  description:
    "Context.dev people search — ONE page (≤10) of candidate professional profiles for a named person anchored by company, city or title. PAID (~10 credits). " +
    "Needs a full name plus at least one anchor. Use only after indicia_person came back empty on the same name (US), or with force_second_source + justification (non-US). " +
    "Results are CANDIDATES: a same-name profile is not the subject until a selector (email, handle, employer+city) overlaps.",
  inputSchema: z.object({
    name: z.string().min(3).describe("The person's full name (first and last)."),
    company: z.string().optional().describe("Current or past employer — an anchor."),
    city: z.string().optional().describe("City the person lives or works in — an anchor."),
    title: z.string().optional().describe("Job title or role — an anchor."),
    country: z.string().optional().describe("Two-letter country code filter, e.g. US or GB."),
    ...forceFields,
  }),
  execute: ({ name, company, city, title, country }, opts) =>
    contextDevPeopleSearch({ name, company, city, title, country }, contextDevDepsFromEnv(getSignal(opts))),
});
