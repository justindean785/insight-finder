/**
 * rdap.ts — RDAP domain lookup with IANA bootstrap fallback and honest outcomes.
 *
 * WHAT THIS REPLACES
 * `whois_lookup` was a 13-line wrapper over rdap.org that returned `{ ok, data }`
 * and nothing else. Two problems came out of that shape:
 *
 *  1. rdap.org is an aggregating redirector, not a registry. It does not serve
 *     every TLD — many ccTLDs are absent from its routing — so a perfectly
 *     registered domain could come back 404 purely because the aggregator had
 *     no route for that zone. The bootstrap fallback below asks IANA which
 *     registry actually owns the TLD and goes there directly.
 *
 *  2. Every non-2xx looked alike. A registry saying "no such domain" and a
 *     registry that was down or timed out both surfaced as `ok:false`, so a
 *     measured, meaningful NEGATIVE was indistinguishable from a failure to
 *     measure at all. This is the same category error the username sweep had —
 *     see sweeper.ts's outcome vocabulary — and it is fixed the same way.
 *
 * NOTE ON THE ORIGINAL SPEC: an earlier draft called for a CLI `whois`
 * fallback. That cannot exist here. Supabase edge functions have no subprocess
 * capability — there is no `Deno.run` / `Deno.Command` / `child_process`
 * anywhere under supabase/functions — so `whois`, `dig` and friends are
 * analyst-manual tools, never agent fallbacks. Where rdap.org has no route the
 * remedy is the registry's own RDAP endpoint, not a shell.
 */

/** Same vocabulary as the sweep, so one reader serves both. */
export type RdapOutcome = "found" | "measured_empty" | "failed";

export interface RdapResult {
  ok: boolean;
  outcome: RdapOutcome;
  domain: string;
  /** Which endpoint answered — aggregator or the registry we bootstrapped to. */
  source?: string;
  status?: number;
  registrar?: string | null;
  statuses?: string[];
  events?: Array<{ action?: string; date?: string }>;
  nameservers?: string[];
  /** True when the registry served the record but withheld contact detail
   *  (GDPR / registry policy). The lookup SUCCEEDED — the data is redacted, not
   *  missing — so this must never read as an error. */
  redacted?: boolean;
  /** No registry could be consulted (IANA unreachable, or none listed for this
   *  TLD), so the aggregator's answer was never corroborated. */
  unconfirmed?: boolean;
  error?: string;
  data?: unknown;
}

const IANA_BOOTSTRAP_URL = "https://data.iana.org/rdap/dns.json";
const BOOTSTRAP_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A FAILED bootstrap fetch must not be cached like a successful one.
 *
 * The first cut stored the empty map with the full 24h TTL, so a single IANA
 * blip on the first lookup of an isolate disabled the registry fallback for a
 * day — and every ccTLD rdap.org cannot route would have silently degraded to
 * the aggregator's unconfirmed answer that whole time. A cached failure is not
 * knowledge; it is only a reason not to hammer IANA.
 */
const BOOTSTRAP_NEGATIVE_TTL_MS = 60_000;

interface BootstrapCache {
  /** tld (no leading dot) -> list of RDAP base URLs */
  map: Map<string, string[]>;
  /** When the MAP was fetched. Never advanced by a failed refresh — the data
   *  really is that old and its age must not be laundered. */
  fetchedAt: number;
  /** false = this entry records a FAILURE, not a fetched table. */
  ok: boolean;
  /** When a REFRESH of an already-good map last failed. A separate clock from
   *  `fetchedAt`, and the reason it exists: serving stale data without also
   *  recording the failure left the map permanently expired, so every single
   *  lookup re-attempted IANA for as long as it stayed down. Age and backoff
   *  are different facts and need different fields. Cleared by a success. */
  refreshFailedAt?: number;
}
let bootstrapCache: BootstrapCache | null = null;

/** Exposed for tests; also lets a caller force a refresh after a bad fetch. */
export function _resetBootstrapCache(): void {
  bootstrapCache = null;
}

/** Test seam: age the MAP past its TTL without waiting or faking a clock. */
export function _expireBootstrapCache(): void {
  if (bootstrapCache) bootstrapCache.fetchedAt = 0;
}

/** Test seam: elapse the refresh-failure barrier, leaving the map's age alone. */
export function _expireBootstrapBarrier(): void {
  if (bootstrapCache) bootstrapCache.refreshFailedAt = 0;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * IANA publishes the authoritative TLD -> RDAP base URL table. Cached for 24h:
 * it changes on the order of days, and an edge isolate is short-lived enough
 * that re-fetching per request would dominate the tool's latency.
 *
 * A bootstrap fetch that fails is NOT fatal — it only means we cannot fall back,
 * so the aggregator's answer stands on its own.
 */
export async function loadBootstrap(fetchImpl: FetchLike): Promise<Map<string, string[]>> {
  const now = Date.now();
  if (bootstrapCache) {
    const ttl = bootstrapCache.ok ? BOOTSTRAP_TTL_MS : BOOTSTRAP_NEGATIVE_TTL_MS;
    if (now - bootstrapCache.fetchedAt < ttl) return bootstrapCache.map;
    // Stale, but a recent refresh attempt already failed. Serve the stale map
    // and do NOT re-attempt until the barrier elapses.
    if (
      bootstrapCache.refreshFailedAt !== undefined &&
      now - bootstrapCache.refreshFailedAt < BOOTSTRAP_NEGATIVE_TTL_MS
    ) {
      return bootstrapCache.map;
    }
  }
  const map = new Map<string, string[]>();
  try {
    const r = await fetchImpl(IANA_BOOTSTRAP_URL);
    if (!r.ok) throw new Error(`iana bootstrap ${r.status}`);
    const doc = await r.json() as { services?: Array<[string[], string[]]> };
    for (const [tlds, urls] of doc.services ?? []) {
      const bases = (urls ?? []).filter((u) => typeof u === "string");
      for (const t of tlds ?? []) map.set(String(t).toLowerCase().replace(/^\./, ""), bases);
    }
    // A success replaces the entry outright, which also clears any barrier.
    bootstrapCache = { map, fetchedAt: now, ok: true };
    return map;
  } catch {
    // STALE SUCCESSFUL DATA OUTRANKS A FRESH FAILURE. The TLD -> RDAP table
    // changes on the order of days, so yesterday's table beats no table.
    // Record the failure on its OWN clock: the map keeps its real age (so it
    // still expires honestly) while the barrier stops every subsequent lookup
    // from re-attempting a provider we just watched fail.
    if (bootstrapCache?.ok) {
      bootstrapCache.refreshFailedAt = now;
      return bootstrapCache.map;
    }
    // Nothing good to fall back on: record the failure under a SHORT negative
    // TTL so a transient blip costs a minute, not a day.
    bootstrapCache = { map, fetchedAt: now, ok: false };
    return map;
  }
}

/** Public-suffix-naive but correct for RDAP: the registry is keyed by the TLD. */
export function tldOf(domain: string): string {
  const parts = String(domain).trim().toLowerCase().replace(/\.$/, "").split(".");
  return parts.length > 1 ? parts[parts.length - 1] : "";
}

interface RdapEntity {
  roles?: string[];
  vcardArray?: unknown;
  remarks?: Array<{ title?: string; type?: string; description?: string[] }>;
}
interface RdapDoc {
  ldhName?: string;
  status?: string[];
  events?: Array<{ eventAction?: string; eventDate?: string }>;
  entities?: RdapEntity[];
  nameservers?: Array<{ ldhName?: string }>;
  remarks?: Array<{ title?: string; type?: string; description?: string[] }>;
}

/** vCard is a nested array form; the registrar's name is the `fn` entry. */
function vcardFullName(vcardArray: unknown): string | null {
  if (!Array.isArray(vcardArray) || vcardArray.length < 2) return null;
  const props = vcardArray[1];
  if (!Array.isArray(props)) return null;
  for (const p of props) {
    if (Array.isArray(p) && p[0] === "fn" && typeof p[3] === "string") return p[3];
  }
  return null;
}

/**
 * Registries signal withheld contact data through `remarks`, with either a
 * REDACTED type or wording to that effect. Detected structurally where the
 * registry gives us a type, and by an explicit title/description match
 * otherwise — never by scanning the whole document for the word.
 */
function detectRedaction(doc: RdapDoc): boolean {
  const pools: Array<{ title?: string; type?: string; description?: string[] }> = [
    ...(doc.remarks ?? []),
    ...(doc.entities ?? []).flatMap((e) => e.remarks ?? []),
  ];
  for (const rk of pools) {
    if (typeof rk.type === "string" && /redact|removed/i.test(rk.type)) return true;
    if (typeof rk.title === "string" && /redact|privacy|withheld/i.test(rk.title)) return true;
    const desc = (rk.description ?? []).join(" ");
    if (/redact|withheld for privacy|data protection|gdpr/i.test(desc)) return true;
  }
  return false;
}

export function parseRdapDoc(doc: RdapDoc): Omit<RdapResult, "ok" | "outcome" | "domain"> {
  const registrarEntity = (doc.entities ?? []).find((e) => (e.roles ?? []).includes("registrar"));
  return {
    registrar: registrarEntity ? vcardFullName(registrarEntity.vcardArray) : null,
    statuses: doc.status ?? [],
    events: (doc.events ?? []).map((e) => ({ action: e.eventAction, date: e.eventDate })),
    nameservers: (doc.nameservers ?? []).map((n) => n.ldhName ?? "").filter(Boolean),
    redacted: detectRedaction(doc),
  };
}

/**
 * One RDAP GET, classified.
 *
 * 404 / 200-with-no-record  -> measured_empty. The registry answered: no such
 *                              domain. A real result, not a failure, and there
 *                              is nothing to retry.
 * 429 / 5xx / network / abort -> failed. The question was never answered.
 * 2xx with a record          -> found.
 */
async function queryOnce(
  base: string,
  domain: string,
  fetchImpl: FetchLike,
): Promise<RdapResult> {
  const url = `${base.replace(/\/+$/, "")}/domain/${encodeURIComponent(domain)}`;
  let r: Response;
  try {
    r = await fetchImpl(url);
  } catch (e) {
    return { ok: false, outcome: "failed", domain, source: base, error: String(e) };
  }
  if (r.status === 404) {
    return { ok: true, outcome: "measured_empty", domain, source: base, status: 404 };
  }
  if (r.status === 429 || r.status >= 500) {
    return {
      ok: false, outcome: "failed", domain, source: base, status: r.status,
      error: `rdap upstream ${r.status}`,
    };
  }
  if (!r.ok) {
    // 400/403/451 and friends: the registry refused, it did not tell us the
    // domain is absent. Refusal is not a measured negative.
    return {
      ok: false, outcome: "failed", domain, source: base, status: r.status,
      error: `rdap refused ${r.status}`,
    };
  }
  const doc = await r.json().catch(() => null) as RdapDoc | null;
  if (!doc || (!doc.ldhName && !doc.status && !doc.events)) {
    return { ok: true, outcome: "measured_empty", domain, source: base, status: r.status };
  }
  return { ok: true, outcome: "found", domain, source: base, status: r.status, ...parseRdapDoc(doc), data: doc };
}

/**
 * Look a domain up, preferring the rdap.org aggregator and falling back to the
 * registry IANA says owns the TLD.
 *
 * The fallback fires on `measured_empty` as well as on `failed`, because the
 * aggregator's 404 is exactly the ambiguous case: it means EITHER the domain
 * does not exist OR rdap.org has no route for that zone. Only the registry can
 * tell those apart, so its answer wins whenever we can reach it. One retry is
 * spent on a `failed` registry response, per spec; a `measured_empty` is never
 * retried because there is nothing to wait for.
 */
export async function rdapLookup(
  domain: string,
  fetchImpl: FetchLike,
): Promise<RdapResult> {
  const clean = String(domain ?? "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!clean || !clean.includes(".")) {
    return { ok: false, outcome: "failed", domain: String(domain ?? ""), error: "not a domain" };
  }

  const viaAggregator = await queryOnce("https://rdap.org", clean, fetchImpl);
  if (viaAggregator.outcome === "found") return viaAggregator;

  const bootstrap = await loadBootstrap(fetchImpl);
  const bases = bootstrap.get(tldOf(clean)) ?? [];
  if (bases.length === 0) {
    // No registry to consult — either IANA is unreachable or it lists none for
    // this TLD. The aggregator is then the only source we have, so its answer
    // stands, flagged so a reader knows it was never corroborated.
    return { ...viaAggregator, unconfirmed: true };
  }

  let viaRegistry = await queryOnce(bases[0], clean, fetchImpl);
  if (viaRegistry.outcome === "failed") {
    // Exactly one retry — backoff and the dead-letter queue arrive with 1.2.
    viaRegistry = await queryOnce(bases[0], clean, fetchImpl);
  }
  if (viaRegistry.outcome === "found") return viaRegistry;

  // The registry is authoritative for its own zone: if it says no such domain,
  // that outranks the aggregator's inability to route.
  if (viaRegistry.outcome === "measured_empty") return viaRegistry;

  // Registry unreachable. We KNOW an authoritative source exists and we could
  // not reach it, so the aggregator's 404 cannot be promoted to an absence —
  // it was ambiguous precisely because it might mean "no route for this zone".
  // Returning `measured_empty` here would assert something never established,
  // which is the whole defect this module removes.
  //
  // `unconfirmed` is set here as well as on the no-registry-listed path: in
  // both cases nothing corroborated the aggregator, and a reader should not
  // have to know WHICH way the corroboration failed to know that it did.
  return { ...viaRegistry, unconfirmed: true };
}
