/**
 * capabilities.ts — pure investigation-start capability discovery (Phase 6).
 *
 * Evaluates each provider BEFORE the execution loop so providers that cannot
 * run (missing key, unsupported seed) are marked unavailable and skipped —
 * instead of becoming attempted live calls (e.g. the `hibp`
 * "API_KEY not configured" no-op executions in the trace audit).
 *
 * PURE: receives only key-PRESENCE booleans (never secret values) + the seed
 * type, so it can never log or leak a secret. The thin runtime wiring in
 * index.ts builds the presence map from Deno.env and disables unavailable tools
 * via the circuit breaker (which cache.ts already treats as a free, un-billed
 * skip).
 */

export type CapabilityReason = "ok" | "missing_key" | "gated" | "disabled" | "unsupported_seed";

export interface CapabilityStatus {
  tool: string;
  available: boolean;
  reason: CapabilityReason;
  /** log-safe detail — only env var NAMES, never values */
  detail?: string;
}

export interface ProviderRequirement {
  /** provider is intentionally unavailable in this build */
  disabled?: boolean;
  /** env var that must be present (truthy) for the provider to run */
  requiresKey?: string;
  /** feature flag/env var that must be true for the provider to run */
  gatedUnless?: string;
  /** seed types this provider supports; if set and the seed isn't included,
   *  the provider is unsupported for this run */
  seedTypes?: string[];
}

/** Provider → what it needs to run. Tools absent here are assumed always
 *  available (free / unauth: dns, http_fingerprint, jina, github, shodan, …).
 *  Gating only ever fires when a required key is genuinely absent, so listing a
 *  provider whose key IS set in prod is a no-op. */
export const PROVIDER_REQUIREMENTS: Record<string, ProviderRequirement> = {
  hibp_lookup: { requiresKey: "HIBP_API_KEY" },
  exa_search: { requiresKey: "EXA_API_KEY" },
  exa_find_similar: { requiresKey: "EXA_API_KEY" },
  exa_get_contents: { requiresKey: "EXA_API_KEY" },
  hunter_domain_search: { requiresKey: "HUNTER_API_KEY" },
  hunter_email_finder: { requiresKey: "HUNTER_API_KEY" },
  hunter_email_verifier: { requiresKey: "HUNTER_API_KEY" },
  hunter_combined: { requiresKey: "HUNTER_API_KEY" },
  oathnet_lookup: { requiresKey: "OATHNET_API_KEY" },
  socialfetch_lookup: { requiresKey: "SOCIALFETCH_API_KEY" },
  cordcat_discord_lookup: { requiresKey: "CORDCAT_API_KEY" },
  bosint_email_lookup: { requiresKey: "OSINTNOVA_API_KEY" },
  leakcheck_lookup: { requiresKey: "LEAKCHECK_API_KEY" },
  // CUT 2026-07-05 (tool-hardening audit). Gated OFF the schedulable set — the
  // readiness gate in index.ts deletes it from the tool schema so the model never
  // sees or wastes a step on it. Code is intentionally LEFT in the registry (not
  // deleted) so re-enabling is a one-line flip if the provider recovers.
  //   • ipqualityscore_lookup — dead key: 0/28 success, all HTTP 200 "Invalid or
  //     unauthorized key" for 30 days straight (verified prod 2026-07-05). An
  //     invalid key is NOT a balance-exhaustion skip — it emits no real reliability
  //     signal, so it's cut. Re-enable (delete this line) once IPQUALITYSCORE_API_KEY
  //     is replaced with a valid key.
  // (The permanently-dead stolentax_footprint / synapsint_lookup / emailrep tools
  // were fully removed from the codebase in the dead-tool cull — not just disabled.)
  ipqualityscore_lookup: { disabled: true },
  // DeepFind re-verified 2026-06-13 against the live API with a valid key: the
  // ONLY problem was the expired key (403). Our code already uses the correct
  // HTTP methods (POST+body / path-param). These 12 endpoints return 200/201.
  // Requires DEEPFIND_API_KEY set to the current key in Supabase function secrets.
  deepfind_reverse_email: { requiresKey: "DEEPFIND_API_KEY" },
  deepfind_disposable_email: { requiresKey: "DEEPFIND_API_KEY" },
  deepfind_ssl_inspect: { requiresKey: "DEEPFIND_API_KEY" },
  deepfind_tech_stack: { requiresKey: "DEEPFIND_API_KEY" },
  deepfind_url_unshorten: { requiresKey: "DEEPFIND_API_KEY" },
  deepfind_telegram_channel: { requiresKey: "DEEPFIND_API_KEY" },
  deepfind_telegram_search: { requiresKey: "DEEPFIND_API_KEY" },
  deepfind_vin_lookup: { requiresKey: "DEEPFIND_API_KEY" },
  deepfind_aircraft_lookup: { requiresKey: "DEEPFIND_API_KEY" },
  deepfind_vessel_lookup: { requiresKey: "DEEPFIND_API_KEY" },
  deepfind_mac_lookup: { requiresKey: "DEEPFIND_API_KEY" },
  deepfind_dark_web_link: { requiresKey: "DEEPFIND_API_KEY" },
  deepfind_email_breach: { requiresKey: "DEEPFIND_API_KEY" },
  deepfind_transaction_viewer: { requiresKey: "DEEPFIND_API_KEY" },
  virustotal_lookup: { requiresKey: "VIRUSTOTAL_API_KEY" },
  ipgeolocation_lookup: { requiresKey: "IPGEOLOCATION_API_KEY" },
  gemini_deep_dork: { requiresKey: "GEMINI_API_KEY" },
  gemini_vision: { requiresKey: "GEMINI_API_KEY" },
  osint_navigator_query: { requiresKey: "OSINT_NAVIGATOR_API_KEY" },
  osint_navigator_search: { requiresKey: "OSINT_NAVIGATOR_API_KEY" },
  serus_darkweb_scan: { requiresKey: "SERUS_API_KEY" },
  // ipqualityscore_lookup — see the CUT block below (dead key, disabled 2026-07-05).
  urlscanner_scan: { requiresKey: "URLSCANNER_API_KEY" },
  intelbase_email_lookup: { requiresKey: "INTELBASE_API_KEY", gatedUnless: "INTELBASE_ENABLED" },
  firecrawl_search: { disabled: true },
  firecrawl_scrape: { disabled: true },
  firecrawl_map: { disabled: true },
  // RapidAPI breach tools are keyed but were historically only self-skipping
  // (missing from this map), so a keyless deploy still advertised them to the
  // model and burned a step on a guaranteed-empty call. The readiness gate now
  // drops them from the schema when RAPIDAPI_KEY is absent. NOTE: breach_check is
  // deliberately NOT listed here — despite using STOLENTAX_API_KEY when present,
  // it falls back to the keyless leakcheck.io/api/public endpoint (tool-registry.ts),
  // so it returns real breach data on a keyless deploy and must NOT be gated.
  rapidapi_breach_search: { requiresKey: "RAPIDAPI_KEY" },
  rapidapi_all_breaches: { requiresKey: "RAPIDAPI_KEY" },
  // Indicia (api.indicia.app) — US person/phone/email/address + web-DB breach
  // aggregator, added 2026-07-05 to replace the cut footprint tools. All six
  // endpoints gate on a single key; a keyless deploy drops them from the schema
  // (readiness gate) instead of burning a step. Face/geo/gmail/username endpoints
  // are intentionally NOT wired (hard policy — see tools/indicia.ts).
  indicia_email: { requiresKey: "INDICIA_API_KEY" },
  indicia_phone: { requiresKey: "INDICIA_API_KEY" },
  indicia_person: { requiresKey: "INDICIA_API_KEY" },
  indicia_address: { requiresKey: "INDICIA_API_KEY" },
  indicia_web_dbs: { requiresKey: "INDICIA_API_KEY" },
  indicia_hudsonrock: { requiresKey: "INDICIA_API_KEY" },
};

/** Every env var name the requirements depend on — what the wiring must probe. */
export function capabilityEnvKeys(
  requirements: Record<string, ProviderRequirement> = PROVIDER_REQUIREMENTS,
): string[] {
  const keys = new Set<string>();
  for (const req of Object.values(requirements)) {
    if (req.requiresKey) keys.add(req.requiresKey);
    if (req.gatedUnless) keys.add(req.gatedUnless);
  }
  return [...keys];
}

/** Evaluate every configured provider against the env-presence map + seed type.
 *  Pure and deterministic. */
export function discoverCapabilities(
  env: Record<string, boolean>,
  seedType: string | null,
  requirements: Record<string, ProviderRequirement> = PROVIDER_REQUIREMENTS,
): CapabilityStatus[] {
  const out: CapabilityStatus[] = [];
  for (const [tool, req] of Object.entries(requirements)) {
    if (req.disabled) {
      out.push({ tool, available: false, reason: "disabled", detail: "provider disabled in config" });
    } else if (req.requiresKey && !env[req.requiresKey]) {
      out.push({ tool, available: false, reason: "missing_key", detail: `${req.requiresKey} not set` });
    } else if (req.gatedUnless && !env[req.gatedUnless]) {
      out.push({ tool, available: false, reason: "gated", detail: `${req.gatedUnless} not enabled` });
    } else if (req.seedTypes && seedType && !req.seedTypes.includes(seedType)) {
      out.push({ tool, available: false, reason: "unsupported_seed", detail: `not supported for seed '${seedType}'` });
    } else {
      out.push({ tool, available: true, reason: "ok" });
    }
  }
  return out;
}

/** Just the providers that should be gated before the run. */
export function unavailableProviders(caps: CapabilityStatus[]): CapabilityStatus[] {
  return caps.filter((c) => !c.available);
}

/** Tool names to REMOVE from the model's schedulable set AND the tool schema it
 *  sees (missing key / disabled / gated / unsupported seed). Pure — the readiness
 *  gate in index.ts deletes exactly these from the `tools` object before streamText,
 *  so a keyless tool is never advertised and never wastes a step returning
 *  "not configured". */
export function gatedToolNames(caps: CapabilityStatus[]): string[] {
  return caps.filter((c) => !c.available).map((c) => c.tool);
}

/** The subset of `allNames` that survives the readiness gate (available tools).
 *  Pure helper so the "keyless tool is absent from the schedulable set + schema"
 *  invariant is unit-testable without booting the orchestrator. */
export function schedulableTools(allNames: string[], caps: CapabilityStatus[]): string[] {
  const gated = new Set(gatedToolNames(caps));
  return allNames.filter((n) => !gated.has(n));
}
