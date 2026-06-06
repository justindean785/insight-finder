/**
 * tool_response.ts — Pure, request-context-free interpreters for the
 * third-party API responses consumed by the LIVE inline tools in index.ts.
 *
 * Why this module exists: the inline tools are defined inside the request
 * handler's closure and cannot be imported/unit-tested directly. These
 * functions take ONLY the HTTP outcome + parsed body (no Supabase, no request
 * scope), so they are trivially testable — the same idiom serus.ts uses with
 * `parseInitiateResponse`. The contract they lock in:
 *
 *   A failed lookup (HTTP 4xx/5xx, a 200-with-error-body, or a non-result
 *   payload) must NEVER masquerade as an authoritative empty/clean/not-found
 *   result — that produces false negatives in OSINT investigations.
 *
 * Each is covered by tool_response_test.ts. Keep call sites in index.ts thin
 * (delegate the decision here) so the tests actually exercise live behavior.
 */

/**
 * `{success:false}`-at-HTTP-200 envelope (OSINTNova/Bosint, leakcheck public).
 * ok requires a 2xx AND the absence of an explicit `success:false`. A missing
 * `success` field (undefined) is treated as success so genuine result bodies
 * that don't carry the flag are unaffected.
 */
export function okWithSuccessFlag(httpOk: boolean, body: unknown): boolean {
  const success = (body as { success?: boolean } | null | undefined)?.success;
  return httpOk && success !== false;
}

/**
 * SocialFetch `{error:{code,message}}` envelope. Returns the error object when
 * present, else undefined. Per the SocialFetch docs, failures use 4xx/5xx, but
 * a defensive check also catches an error envelope returned on a 200.
 */
export function socialfetchError(
  body: unknown,
): { code?: string; message?: string } | undefined {
  return (body as { error?: { code?: string; message?: string } } | null | undefined)
    ?.error;
}

/**
 * HackerTarget's free API returns HTTP 200 with a plain-text error/quota body
 * (e.g. "error invalid host", "API count exceeded - ...", "No DNS Records
 * found"). Without this, those strings get returned as legitimate recon lines.
 */
export function isHackertargetApiError(trimmedBody: string): boolean {
  return (
    /^error/i.test(trimmedBody) ||
    trimmedBody.startsWith("API count exceeded") ||
    trimmedBody.startsWith("No DNS Records") ||
    trimmedBody === "No records found"
  );
}

/**
 * crt.sh: a usable response requires a 2xx AND a JSON array. crt.sh frequently
 * 5xxs or returns an HTML overload page; either must read as a failure, not
 * "0 subdomains".
 */
export function isCrtshOk(httpOk: boolean, body: unknown): boolean {
  return httpOk && Array.isArray(body);
}

/**
 * Cloudflare DoH, per record-type. Distinguishes a genuine empty result
 * (DNS RCODE NOERROR=0 / NXDOMAIN=3) from a lookup failure (HTTP error, or a
 * DNS rcode such as SERVFAIL=2) so an empty Answer set can't masquerade as an
 * authoritative "no records". Returns an error string, or null when trustworthy.
 */
export function dohTypeError(
  httpOk: boolean,
  httpStatus: number,
  dnsStatus: unknown,
): string | null {
  if (!httpOk) return `doh http ${httpStatus}`;
  if (typeof dnsStatus === "number" && dnsStatus !== 0 && dnsStatus !== 3) {
    return `dns rcode ${dnsStatus}`;
  }
  return null;
}

/**
 * Blockchair ETH dashboard. Blockchair signals errors via `context.error` in a
 * 200 body, and returns `data:null` for an address with no data. Either must
 * read as a failed lookup, not "wallet found, no activity". Returns an error
 * string, or null when the dashboard payload is real.
 */
export function blockchairError(body: unknown): string | null {
  const b = body as { data?: unknown; context?: { error?: unknown } } | null | undefined;
  if (b?.context?.error) return String(b.context.error);
  if (b?.data == null) return "blockchair returned no address data";
  return null;
}
