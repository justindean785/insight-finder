/**
 * api_types.ts — Loose TypeScript interfaces for the third-party APIs the
 * orchestrator calls. Goal: replace `let data: any = JSON.parse(text)`
 * with `let data: SomeApiResponse = ...` so the downstream `.map((t: any)
 * => ...)` cascades get type-checked.
 *
 * Scope discipline:
 *   - Only the fields we actually read are typed. Unknown fields stay
 *     accessible via index signature (`[k: string]: unknown`).
 *   - We use `unknown` (not `any`) for genuinely unknown shapes and
 *     narrow at the use site.
 *   - When an API is documented to return shapes we don't yet model,
 *     we add a TODO so the next pass can extend.
 *
 * Why not just declare module '...'?: the upstream APIs don't ship
 * TypeScript definitions, and generating them from OpenAPI specs is
 * out of scope for beta-readiness. These hand-written interfaces are
 * the pragmatic middle ground.
 */

// ---- OSINT Navigator (https://navigator.indicator.media) ---------------------

/** One tool record in the OSINT Navigator response. */
export interface NavigatorTool {
  tool_id?: string;
  id?: string;
  tool_name?: string;
  name?: string;
  title?: string;
  tool_url?: string;
  url?: string;
  homepage?: string;
  link?: string;
  category?: string;
  categories?: string | string[];
  tags?: string[];
  short_description?: string;
  description?: string;
  summary?: string;
  [k: string]: unknown;
}

/** Response shape for /api/query. */
export interface NavigatorQueryResponse {
  answer?: string | null;
  tools?: NavigatorTool[] | null;
  cache?: boolean;
  cached?: boolean;
  [k: string]: unknown;
}

/** Response shape for /api/tools/search — either an array or { tools, results }. */
export interface NavigatorSearchResponse {
  tools?: NavigatorTool[];
  results?: NavigatorTool[];
  [k: string]: unknown;
}

// ---- StolenTax (https://stolen.tax/api/v2) ---------------------------------

/** One record in the stolen.tax osintcat mode=database-search response. */
export interface StolenTaxRecord {
  domain?: string;
  ExtraData?: unknown;
  taken?: boolean;
  [k: string]: unknown;
}

/** Stats block from the stolen.tax footprint response. */
export interface StolenTaxStats {
  [k: string]: unknown;
}

/** Response shape for stolen.tax footprint and osintcat endpoints. */
export interface StolenTaxResponse {
  data?: {
    results?: StolenTaxRecord[];
    stats?: StolenTaxStats;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

// ---- GitHub Code Search (https://api.github.com/search/code) ----------------

/** One match in the github_code_search response. */
export interface GitHubCodeMatch {
  name?: string;
  path?: string;
  html_url?: string;
  repository?: { full_name?: string; html_url?: string };
  [k: string]: unknown;
}

/** Response shape for the GitHub code search endpoint. */
export interface GitHubCodeSearchResponse {
  total_count?: number;
  incomplete_results?: boolean;
  items?: GitHubCodeMatch[];
  message?: string;          // present on rate-limit / auth failure
  documentation_url?: string;
  [k: string]: unknown;
}
