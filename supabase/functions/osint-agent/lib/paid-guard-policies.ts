// lib/paid-guard-policies.ts — the free-first policies for every guarded paid tool.
//
// ONE static list, imported once by cache.ts, so which tools are guarded never
// depends on which module happened to be loaded first. Each provider PR adds its
// entries here. The guard itself is lib/paid-provider-guard.ts.
//
// A rule names the free (or cheaper) tools that clear the paid call, and the outcomes
// that count. `failed`/`empty` means "the cheaper tool tried this exact selector and
// could not answer", which is the only reason to pay.

import { registerPaidGuardPolicy } from "./paid-provider-guard.ts";

// ---- Context.dev ----------------------------------------------------------------
// Anti-bot scrape: pay only for a page the free readers could not read.
registerPaidGuardPolicy("contextdev_scrape", {
  provider: "context.dev",
  rules: [{
    tools: ["jina_reader_scrape", "socialfetch_web_read"],
    outcomes: ["failed", "empty"],
    label: "free_reader_blocked",
  }],
  tryFirst: ["jina_reader_scrape", "socialfetch_web_read"],
});
// People search (10 credits): pay only after the cheaper person search came back
// empty on the same name. Non-US subjects (Indicia is US-only) need
// force_second_source with a written justification. google_dorks does NOT clear it:
// it only writes query strings, so it is not an attempt.
registerPaidGuardPolicy("contextdev_people_search", {
  provider: "context.dev",
  rules: [{
    tools: ["indicia_person"],
    outcomes: ["failed", "empty"],
    label: "cheaper_person_search_empty",
  }],
  tryFirst: ["indicia_person"],
});

// ---- SocQ ---------------------------------------------------------------------------
// Handle-based endpoints: pay only after socialfetch_lookup (the cheaper profile reader for
// instagram/twitter) failed or came back empty on the same handle. The guard key does not
// carry the platform, so a SocialFetch failure on the handle clears either platform.
const SOCQ_BY_HANDLE = ["socq_instagram_profile", "socq_x_profile", "socq_instagram_posts", "socq_instagram_followers_count", "socq_x_user_posts"];
for (const tool of SOCQ_BY_HANDLE) {
  registerPaidGuardPolicy(tool, {
    provider: "socq",
    rules: [{ tools: ["socialfetch_lookup"], outcomes: ["failed", "empty"], label: "free_profile_reader_blocked" }],
    tryFirst: ["socialfetch_lookup"],
  });
}
// URL-based endpoints (LinkedIn profile/company/posts, one Instagram post): pay only for a
// page the free readers could not read.
const SOCQ_BY_URL = ["socq_linkedin_profile", "socq_linkedin_company", "socq_linkedin_posts", "socq_instagram_post_info"];
for (const tool of SOCQ_BY_URL) {
  registerPaidGuardPolicy(tool, {
    provider: "socq",
    rules: [{ tools: ["jina_reader_scrape", "socialfetch_web_read"], outcomes: ["failed", "empty"], label: "free_reader_blocked" }],
    tryFirst: ["jina_reader_scrape", "socialfetch_web_read"],
  });
}
// Free-text search: no selector, so nothing can have been tried first. Registered with no
// rules: the guard refuses `no_selector` unless force_second_source + justification.
const SOCQ_SEARCH = ["socq_instagram_search", "socq_x_search"];
for (const tool of SOCQ_SEARCH) {
  registerPaidGuardPolicy(tool, { provider: "socq", rules: [], tryFirst: [] });
}
// socq_task_result is free (reading a task) and is never guarded.

/** The tools this module guards, for /health and tests. */
export const GUARDED_PAID_TOOLS: readonly string[] = [
  "contextdev_scrape", "contextdev_people_search", ...SOCQ_BY_HANDLE, ...SOCQ_BY_URL, ...SOCQ_SEARCH,
];
