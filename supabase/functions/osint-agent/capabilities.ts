/**
 * capabilities.ts — pure investigation-start capability discovery (Phase 6).
 *
 * Evaluates each provider BEFORE the execution loop so providers that cannot
 * run (missing key, disabled config, gated access, unsupported seed) are marked
 * unavailable and skipped — instead of becoming attempted live calls (e.g. the
 * `hibp` "API_KEY not configured" and `intelbase gated` no-op executions in the
 * trace audit).
 *
 * PURE: receives only key-PRESENCE booleans (never secret values) + the seed
 * type, so it can never log or leak a secret. The thin runtime wiring in
 * index.ts builds the presence map from Deno.env and disables unavailable tools
 * via the circuit breaker (which cache.ts already treats as a free, un-billed
 * skip).
 */

export type CapabilityReason = "ok" | "missing_key" | "disabled" | "gated" | "unsupported_seed";

export interface CapabilityStatus {
  tool: string;
  available: boolean;
  reason: CapabilityReason;
  /** log-safe detail — only env var NAMES, never values */
  detail?: string;
}

export interface ProviderRequirement {
  /** env var that must be present (truthy) for the provider to run */
  requiresKey?: string;
  /** hard-disabled regardless of env (e.g. out-of-budget) */
  disabled?: boolean;
  /** gated unless this env flag is present/enabled (e.g. feature flag) */
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
  stolentax_footprint: { requiresKey: "STOLENTAX_API_KEY" },
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
  osint_navigator_query: { requiresKey: "OSINT_NAVIGATOR_API_KEY" },
  osint_navigator_search: { requiresKey: "OSINT_NAVIGATOR_API_KEY" },
  serus_darkweb_scan: { requiresKey: "SERUS_API_KEY" },
  ipqualityscore_lookup: { requiresKey: "IPQUALITYSCORE_API_KEY" },
  urlscanner_scan: { requiresKey: "URLSCANNER_API_KEY" },
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
