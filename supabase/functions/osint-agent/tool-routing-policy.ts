// Advisory next-best-tool ranking (edge runtime).
//
// The 1677 Iroquois Rd trace burned its budget re-running generic web searches
// while county assessor/recorder, CA SOS and business-license pivots stayed
// pending. This module ranks candidate tools by (a) pending required pivots,
// (b) query-type fit, (c) source-class novelty and official authority, biasing
// the planner toward the gaps. It is ADVISORY only — it sorts and drops dead
// providers, it never gates execution (no same-tool-count penalty; cooldown is
// applied ONLY on a real provider 429/5xx).

import type { QueryType } from "./query-type-router.ts";
import type { SourceClass } from "./source-classification.ts";
import { OFFICIAL_CLASSES } from "./source-classification.ts";

export interface ToolRouteCandidate {
  toolName: string;            // real tool slug, e.g. "minimax_web_search", "oathnet_lookup"
  toolGroup: string;           // pivot/source target, e.g. "government_property_record", "web_search"
  supportsQueryTypes: QueryType[];
  satisfiesPivotIds: string[]; // ids from pivot-checklists.ts
  sourceClasses: SourceClass[];// classes this candidate can add
  expectedValue: number;       // 0-100 baseline
  providerAvailable: boolean;
  currentConcurrency: number;
  maxConcurrency: number;
  cooldownUntil?: number;      // epoch ms; set ONLY on a real provider 429/5xx
}

export interface RouteContext {
  primaryQueryType: QueryType;
  secondaryQueryTypes?: QueryType[];
  pendingRequiredPivotIds: Set<string>;
  observedSourceClasses: Set<SourceClass>;
  highYieldTools?: Set<string>;
  failedQueryFamilies?: Set<string>;
  duplicateQueryKeys?: Set<string>;
  queryFamilyKey?: string;
  queryKey?: string;
  now?: number;                // injectable clock for tests; default 0 (do NOT call Date.now at module top-level)
}

/** True when the candidate can still take a new dispatch (provider up, no active cooldown). */
function isDispatchable(candidate: ToolRouteCandidate, now: number): boolean {
  if (!candidate.providerAvailable) return false;
  if (candidate.cooldownUntil !== undefined && candidate.cooldownUntil > now) return false;
  return true;
}

/** Advisory score for one candidate. Higher = more worth dispatching next. */
export function scoreToolCandidate(candidate: ToolRouteCandidate, ctx: RouteContext): number {
  const now = ctx.now ?? 0;
  let score = candidate.expectedValue;

  // Closes a still-pending required pivot — the strongest signal.
  if (candidate.satisfiesPivotIds.some((id) => ctx.pendingRequiredPivotIds.has(id))) {
    score += 40;
  }

  // Fits the active query type (primary or any secondary).
  const wantedTypes = new Set<QueryType>([ctx.primaryQueryType, ...(ctx.secondaryQueryTypes ?? [])]);
  if (candidate.supportsQueryTypes.some((qt) => wantedTypes.has(qt))) {
    score += 25;
  }

  // Adds a source class we have not observed yet (novelty / corroboration breadth).
  if (candidate.sourceClasses.some((sc) => !ctx.observedSourceClasses.has(sc))) {
    score += 20;
  }

  // Official / government / public-record authority bonus.
  if (
    candidate.sourceClasses.some(
      (sc) => OFFICIAL_CLASSES.has(sc) || sc.startsWith("government_") || sc === "public_record",
    )
  ) {
    score += 10;
  }

  // Operator-flagged high-yield tool.
  if (ctx.highYieldTools?.has(candidate.toolName)) {
    score += 15;
  }

  // This query family has failed before — de-prioritise, don't ban.
  if (ctx.queryFamilyKey && ctx.failedQueryFamilies?.has(ctx.queryFamilyKey)) {
    score -= 20;
  }

  // Exact query already issued — de-prioritise the duplicate.
  if (ctx.queryKey && ctx.duplicateQueryKeys?.has(ctx.queryKey)) {
    score -= 30;
  }

  // Hard drops: provider down or in a real cooldown window. Large negatives so a
  // routeNextTools caller that forgets to filter still sinks them to the bottom.
  if (!candidate.providerAvailable) score -= 1000;
  if (candidate.cooldownUntil !== undefined && candidate.cooldownUntil > now) score -= 1000;

  return score;
}

/** Built-in catalog so address/property/business/phone cases rank property +
 *  registry tools in the top 5. expectedValue ~50; concurrency headroom of 2. */
export const DEFAULT_TOOL_CATALOG: ToolRouteCandidate[] = [
  // ── Government property records (assessor / recorder / deed)
  {
    toolName: "oathnet_lookup",
    toolGroup: "government_property_record",
    supportsQueryTypes: ["address", "property"],
    satisfiesPivotIds: ["county_assessor_parcel", "county_recorder_deed"],
    sourceClasses: ["government_property_record", "public_record"],
    expectedValue: 50,
    providerAvailable: true,
    currentConcurrency: 0,
    maxConcurrency: 2,
  },
  {
    toolName: "minimax_web_search",
    toolGroup: "government_property_record",
    supportsQueryTypes: ["address", "property"],
    satisfiesPivotIds: ["county_assessor_parcel", "county_recorder_deed"],
    sourceClasses: ["government_property_record"],
    expectedValue: 50,
    providerAvailable: true,
    currentConcurrency: 0,
    maxConcurrency: 2,
  },
  // ── Government business registry (Secretary of State)
  {
    toolName: "minimax_web_search",
    toolGroup: "government_business_registry",
    supportsQueryTypes: ["business"],
    satisfiesPivotIds: ["sos_entity_registry"],
    sourceClasses: ["government_business_registry"],
    expectedValue: 50,
    providerAvailable: true,
    currentConcurrency: 0,
    maxConcurrency: 2,
  },
  // ── Government business license (city / county)
  {
    toolName: "minimax_web_search",
    toolGroup: "government_business_license",
    supportsQueryTypes: ["business"],
    satisfiesPivotIds: ["business_license"],
    sourceClasses: ["government_business_license"],
    expectedValue: 50,
    providerAvailable: true,
    currentConcurrency: 0,
    maxConcurrency: 2,
  },
  // ── Reverse phone (public-record aggregator)
  {
    toolName: "oathnet_lookup",
    toolGroup: "reverse_phone",
    supportsQueryTypes: ["phone", "address"],
    satisfiesPivotIds: ["address_phone_crosscheck", "phone_reverse"],
    sourceClasses: ["public_record"],
    expectedValue: 50,
    providerAvailable: true,
    currentConcurrency: 0,
    maxConcurrency: 2,
  },
  // ── Business directory listing (D&B / Manta / OpenCorporates)
  {
    toolName: "minimax_web_search",
    toolGroup: "business_directory",
    supportsQueryTypes: ["business", "phone", "address"],
    satisfiesPivotIds: ["business_directory_listing"],
    sourceClasses: ["business_directory"],
    expectedValue: 48,
    providerAvailable: true,
    currentConcurrency: 0,
    maxConcurrency: 2,
  },
  // ── Generic web search (discovery) across the common entity types
  {
    toolName: "exa_search",
    toolGroup: "web_search",
    supportsQueryTypes: ["address", "property", "business", "person"],
    satisfiesPivotIds: ["exact_address_search"],
    sourceClasses: ["web_search"],
    expectedValue: 45,
    providerAvailable: true,
    currentConcurrency: 0,
    maxConcurrency: 2,
  },
  {
    toolName: "minimax_web_search",
    toolGroup: "web_search",
    supportsQueryTypes: ["person", "business", "address", "property"],
    satisfiesPivotIds: ["person_exact_name_location"],
    sourceClasses: ["web_search"],
    expectedValue: 42,
    providerAvailable: true,
    currentConcurrency: 0,
    maxConcurrency: 2,
  },
  // ── Domain / infra so non-address query types also route
  {
    toolName: "whois_lookup",
    toolGroup: "domain_whois",
    supportsQueryTypes: ["domain", "url"],
    satisfiesPivotIds: ["domain_whois"],
    sourceClasses: ["infra"],
    expectedValue: 45,
    providerAvailable: true,
    currentConcurrency: 0,
    maxConcurrency: 2,
  },
  {
    toolName: "dns_records",
    toolGroup: "domain_dns",
    supportsQueryTypes: ["domain", "url"],
    satisfiesPivotIds: ["domain_dns"],
    sourceClasses: ["infra"],
    expectedValue: 45,
    providerAvailable: true,
    currentConcurrency: 0,
    maxConcurrency: 2,
  },
  {
    toolName: "crtsh_subdomains",
    toolGroup: "certificate_transparency",
    supportsQueryTypes: ["domain", "url"],
    satisfiesPivotIds: ["domain_ssl_certs"],
    sourceClasses: ["infra"],
    expectedValue: 43,
    providerAvailable: true,
    currentConcurrency: 0,
    maxConcurrency: 2,
  },
];

/** Rank candidates for the next dispatch. Drops dead providers + active
 *  cooldowns, then sorts by advisory score DESC (stable). Advisory, not a gate. */
export function routeNextTools(
  ctx: RouteContext,
  catalog: ToolRouteCandidate[] = DEFAULT_TOOL_CATALOG,
): ToolRouteCandidate[] {
  const now = ctx.now ?? 0;
  const scored = catalog
    .filter((candidate) => isDispatchable(candidate, now))
    .map((candidate, index) => ({ candidate, index, score: scoreToolCandidate(candidate, ctx) }));

  // Stable sort: ties keep original catalog order.
  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));

  return scored.map((entry) => entry.candidate);
}
