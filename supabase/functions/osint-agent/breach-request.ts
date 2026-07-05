/**
 * breach-request.ts — pure request-shape builders for the breach providers.
 *
 * Extracted so the exact wire format is unit-tested. Live tool defs in
 * tool-registry.ts call these (the tools/*.ts copies are stale mirrors).
 */

// LeakCheck v2's /query endpoint AUTO-DETECTS the identifier type when `type`
// is OMITTED. Passing `type=auto` explicitly is rejected with HTTP 400 — it is
// not a valid enum value — which was one cause of the leakcheck_lookup 400s.
//
// The REMAINING production 400s (25×, through 2026-07-05, verified from
// tool_usage_log.input_json) came from two concrete request-shape bugs:
//   1. type=phone with an E.164 value ("+19165629177"). LeakCheck v2 wants BARE
//      DIGITS for phone — the leading "+" and any separators are rejected 400.
//      → normalize phone values to digits only.
//   2. type=keyword name+location queries ("chester dean rocklin ca"). The v2
//      /query endpoint 400s on keyword searches (not enabled on this plan / not a
//      /query type). Name searches belong to oathnet_lookup type:'name', so
//      `keyword` is removed from the leakcheck tool schema and never reaches here.
// This builder still normalizes defensively in case a keyword value slips through.
export function buildLeakcheckUrl(value: string, type?: string | null): string {
  const t = type && type !== "auto" ? type : null;
  // LeakCheck v2 phone lookups require the number as bare digits (country code
  // included, no "+"/spaces/dashes/parens). Normalizing here fixes the 400s and
  // keeps callers free to pass a formatted E.164 selector.
  const normalized = t === "phone" ? value.replace(/[^0-9]/g, "") : value.trim();
  const base = `https://leakcheck.io/api/v2/query/${encodeURIComponent(normalized)}`;
  return t ? `${base}?type=${encodeURIComponent(t)}` : base;
}

// OathNet: v2 breach search for email/username/phone/domain/name, ip-info for ip.
// email/username/phone/NAME all go through the same free-text `q=` breach search
// (a name is just a broader query — expect same-name collisions in the results);
// domain uses `email_domain`; ip uses the dedicated ip-info endpoint.
// (The production 502s are an upstream-availability problem handled by fetchRetry
// at the call site, not a request-shape bug — so construction is preserved.)
export function buildOathnetUrl(type: string, value: string): string {
  if (type === "ip") {
    return `https://oathnet.org/api/service/ip-info?ip=${encodeURIComponent(value)}`;
  }
  const params = new URLSearchParams();
  if (type === "domain") params.set("email_domain", value);
  else params.set("q", value); // email | username | phone | name → free-text query
  params.set("limit", "50");
  return `https://oathnet.org/api/service/v2/breach/search?${params.toString()}`;
}
