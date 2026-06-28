/**
 * breach-request.ts — pure request-shape builders for the breach providers.
 *
 * Extracted so the exact wire format is unit-tested. Live tool defs in
 * tool-registry.ts call these (the tools/*.ts copies are stale mirrors).
 */

// LeakCheck v2's /query endpoint AUTO-DETECTS the identifier type when `type`
// is OMITTED. Passing `type=auto` explicitly is rejected with HTTP 400 — it is
// not a valid enum value — which was the cause of the leakcheck_lookup 400s in
// the production trace audit (30+ calls). Only append `type` for a concrete,
// non-"auto" value.
export function buildLeakcheckUrl(value: string, type?: string | null): string {
  const base = `https://leakcheck.io/api/v2/query/${encodeURIComponent(value.trim())}`;
  return type && type !== "auto"
    ? `${base}?type=${encodeURIComponent(type)}`
    : base;
}

// OathNet: v2 breach search for email/username/phone/domain, ip-info for ip.
// (The production 502s are an upstream-availability problem handled by fetchRetry
// at the call site, not a request-shape bug — so construction is preserved.)
export function buildOathnetUrl(type: string, value: string): string {
  if (type === "ip") {
    return `https://oathnet.org/api/service/ip-info?ip=${encodeURIComponent(value)}`;
  }
  const params = new URLSearchParams();
  if (type === "domain") params.set("email_domain", value);
  else params.set("q", value);
  params.set("limit", "50");
  return `https://oathnet.org/api/service/v2/breach/search?${params.toString()}`;
}
