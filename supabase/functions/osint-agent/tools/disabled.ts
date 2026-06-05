export const firecrawl_search= tool({
  description:
    "DISABLED. Use exa_search + minimax_web_search instead. Calling this tool wastes a step and returns an immediate error.",
  inputSchema: z.object({
    query: z.string().min(2),
    limit: z.number().int().min(1).max(20).default(10),
    tbs: z.string().optional().describe("Time filter: qdr:h | qdr:d | qdr:w | qdr:m | qdr:y"),
    country: z.string().optional(),
    lang: z.string().optional(),
    sources: z.array(z.enum(["web", "news", "images"])).optional(),
    scrape: z.boolean().default(false).describe("If true, also scrape markdown for each result."),
  }),
  execute: async () => ({
    error: "firecrawl_disabled",
    skipped: true,
    hint: "Firecrawl is permanently disabled. Call exa_search and minimax_web_search in parallel instead. Do NOT retry firecrawl_search.",
  }),
}),

export const firecrawl_scrape= tool({
  description:
    "DISABLED. Use jina_reader_scrape instead. Calling this tool wastes a step and returns an immediate error.",
  inputSchema: z.object({
    url: z.string().url(),
    formats: z.array(z.enum(["markdown", "html", "links", "screenshot", "summary"])).default(["markdown"]),
    onlyMainContent: z.boolean().default(true),
    waitFor: z.number().int().min(0).max(15000).optional(),
  }),
  execute: async ({ url }) => ({
    error: "firecrawl_disabled",
    skipped: true,
    hint: `Firecrawl is permanently disabled. Call jina_reader_scrape({ url: "${url}" }) instead.`,
  }),
}),

export const firecrawl_map= tool({
  description:
    "DISABLED. Use crtsh_subdomains + dns_records instead. Calling this tool wastes a step and returns an immediate error.",
  inputSchema: z.object({
    url: z.string().url(),
    search: z.string().optional(),
    limit: z.number().int().min(1).max(5000).default(500),
    includeSubdomains: z.boolean().default(false),
  }),
  execute: async () => ({
    error: "firecrawl_disabled",
    skipped: true,
    hint: "Firecrawl is permanently disabled. Call crtsh_subdomains + dns_records for domain enumeration instead.",
  }),
}),

