// tools/socq.ts — LIVE runtime tool defs for SocQ (api.socq.ai), asynchronous social data.
//
// Late-attached into buildTools() in tool-registry.ts, like tools/indicia.ts. Gated on
// SOCQ_API_KEY in capabilities.ts and on the SOCQ_DISABLED kill switch.
//
// Eleven submit tools, one per SocQ endpoint (lib/socq.ts SOCQ_ENDPOINTS), plus the FREE
// socq_task_result for a task still running at the poll deadline. Every submit tool takes
// ONE selector in a field the central detector reads (`username` / `url`), so the free-first
// guard, analyst rejection and quarantine checks all see it. The two search tools take a
// free-text `query`, which has no selector: they run only with force_second_source.
//
// EVIDENCE. SocQ output is an observation of a public profile or post: a LEAD. A same-handle
// account on a different platform stays unlinked until corroborated (bio link, photo, a
// selector overlap). No tool here records artifacts; the model records what it uses through
// record_artifact / record_finding with structured sources (`socq <endpoint> task <id>`).

import { tool } from "npm:ai@6";
import { z } from "npm:zod@3";
import { SOCQ_DEFAULT_RESULTS, SOCQ_ENDPOINTS, SOCQ_MAX_RESULTS, socqDepsFromEnv, socqSubmit, socqTaskResult } from "../lib/socq.ts";

const getSignal = (opts: unknown): AbortSignal | undefined =>
  (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;

const forceFields = {
  force_second_source: z.boolean().optional().describe(
    "Set true ONLY to pay before the free-first rule is met (always needed for the search tools). Requires second_source_justification.",
  ),
  second_source_justification: z.string().optional().describe("Why this paid collection is worth it here. Logged."),
};

const resultsLimit = z.number().int().optional().describe(
  `Records to collect, 1-${SOCQ_MAX_RESULTS} (default ${SOCQ_DEFAULT_RESULTS}). Billed per record returned.`,
);

const PENDING_NOTE =
  " Collection is asynchronous and bounded at ~40s: a task still running returns pending:true with a task_id — read it with socq_task_result (free); never submit the same request again.";
const LEAD_NOTE = " Output is a LEAD: a same-handle account elsewhere is not the subject until corroborated.";

function submitTool(name: keyof typeof SOCQ_ENDPOINTS & string, description: string) {
  const ep = SOCQ_ENDPOINTS[name];
  const selectorField: z.ZodRawShape = ep.input === "usernames"
    ? { username: z.string().min(1).describe(`The ${ep.platform === "x" ? "X/Twitter" : "Instagram"} username (with or without @).`) }
    : ep.input === "urls"
    ? { url: z.string().min(8).describe(`The ${ep.platform} URL (${ep.path}).`) }
    : { query: z.string().min(2).describe("Free-text search terms (no punctuation for Instagram search).") };
  const limitField: z.ZodRawShape = ep.limited && ep.fixedLimit === undefined ? { results_limit: resultsLimit } : {};
  return tool({
    description: description + PENDING_NOTE + LEAD_NOTE,
    inputSchema: z.object({ ...selectorField, ...limitField, ...forceFields }),
    execute: (input: Record<string, unknown>, opts: unknown) => socqSubmit(name, input, socqDepsFromEnv(getSignal(opts))),
  });
}

// ---- Profiles: the walled-garden gap (bio, display name, external link, location, counts) ----
export const socq_instagram_profile = submitTool("socq_instagram_profile",
  "SocQ Instagram profile — bio, display name, external website link, verified/private flags, location and follower/following/post counts for ONE username. PAID (~0.6 credit). Use after socialfetch_lookup failed or came back empty on the same handle; otherwise refused uncharged.");
export const socq_x_profile = submitTool("socq_x_profile",
  "SocQ X/Twitter profile — bio, display name, website, location and counts for ONE username. PAID (~0.6 credit). Use after socialfetch_lookup failed or came back empty on the same handle.");
export const socq_linkedin_profile = submitTool("socq_linkedin_profile",
  "SocQ LinkedIn profile — public profile metadata for ONE linkedin.com/in/… URL. PAID (~2.5 credits). Use after jina_reader_scrape or socialfetch_web_read failed or came back empty on the same URL.");

// ---- Content and counts ----
export const socq_instagram_posts = submitTool("socq_instagram_posts",
  "SocQ Instagram posts — recent posts (caption, date, hashtags, mentions, location) for ONE username. PAID (~0.34 credit per post). Use after socialfetch_lookup failed or came back empty on the same handle.");
export const socq_instagram_post_info = submitTool("socq_instagram_post_info",
  "SocQ Instagram post info — one post or reel by URL (instagram.com/p/… or /reel/…). PAID (~0.5 credit). Use after jina_reader_scrape or socialfetch_web_read failed on the same URL.");
export const socq_instagram_followers_count = submitTool("socq_instagram_followers_count",
  "SocQ Instagram followers count — follower/following/post counts for ONE username (no follower list). PAID (~0.52 credit). Use after socialfetch_lookup failed or came back empty on the same handle.");
export const socq_x_user_posts = submitTool("socq_x_user_posts",
  "SocQ X/Twitter user posts — recent posts by ONE username. PAID (~0.5 credit per post). Use after socialfetch_lookup failed or came back empty on the same handle.");
export const socq_linkedin_company = submitTool("socq_linkedin_company",
  "SocQ LinkedIn company — company page metadata (name, website, industry, location) for ONE linkedin.com/company/… URL. PAID (~2 credits). Use after jina_reader_scrape or socialfetch_web_read failed on the same URL.");
export const socq_linkedin_posts = submitTool("socq_linkedin_posts",
  "SocQ LinkedIn profile posts — recent posts by ONE linkedin.com/in/… profile. PAID (~1 credit per post). Use after jina_reader_scrape or socialfetch_web_read failed on the same URL.");

// ---- Search: no selector, so force_second_source + justification is always required ----
export const socq_instagram_search = submitTool("socq_instagram_search",
  "SocQ Instagram account search — accounts matching free-text terms. PAID (~0.54 credit per result). Discovery only: runs ONLY with force_second_source and a second_source_justification; every hit is an unverified candidate.");
export const socq_x_search = submitTool("socq_x_search",
  "SocQ X/Twitter post search — posts matching free-text terms or X search operators. PAID (~0.7 credit per post). Discovery only: runs ONLY with force_second_source and a second_source_justification.");

// ---- Free reader for pending tasks ----
export const socq_task_result = tool({
  description:
    "SocQ task result — read a SocQ task that returned pending:true (FREE; polls up to ~40s more if still running). Pass the task_id from that result. Never resubmit the original request instead.",
  inputSchema: z.object({ task_id: z.string().min(6).describe("The task_id from a pending SocQ result.") }),
  execute: ({ task_id }, opts) => socqTaskResult({ task_id }, socqDepsFromEnv(getSignal(opts))),
});
