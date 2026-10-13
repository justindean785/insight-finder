// lib/negative-lookup.ts — a lookup that found nothing is a RESULT, not a failure,
// and not evidence.
//
// Two tools reported a negative in a shape the rest of the pipeline misread, in
// opposite directions:
//
//  • shodan_internetdb answers HTTP 404 for any IP it has no record of. The tool
//    returned `{ ok: false, status: 404 }`, so `circuit.classifyResult` filed it as
//    `http_404`, and a SECOND distinct 404 disabled the tool for the whole thread
//    ("endpoint returned 404 on 2 distinct inputs — disabled for thread"). A third,
//    perfectly valid IP was then refused, and the refusal itself was logged
//    `outcome=failed` (see tool-outcome.ts SKIP_RE), feeding dead-target memory.
//    Measured 2026-10-06: 8 empty-404 + 4 local-disable "failures" on one case.
//
//  • jina_reader_scrape answers HTTP 200 for a page whose ORIGIN returned an error,
//    with the error in the body: `Title: …\n\nURL Source: …\n\nWarning: Target URL
//    returned error 404: Not Found\n\nMarkdown Content:`. The tool returned
//    `{ ok: true, markdown }`, so the error page was saved and cited as page
//    evidence. 73 of 1,047 stored scrape outputs have this shape (404 ×27,
//    403 ×23, 405 ×10, 429 ×7, 400 ×4, 410 ×1, 401 ×1).
//
// The contract here is the one gravatar_profile / ransomwarelive_lookup already use:
// a PROVEN negative is `ok:true, found:false` (so it stays billable-as-free,
// cacheable and circuit-healthy) and the persisted outcome becomes `empty` through
// PROVEN_EMPTY_PREDICATES. Everything else about a response is left exactly as it was.
//
// KILL SWITCH, read at CALL TIME: NEGATIVE_LOOKUP_DISABLED=true restores both tools'
// previous return shapes on the running build with no deploy.

export function negativeLookupSemanticsDisabled(): boolean {
  return (Deno.env.get("NEGATIVE_LOOKUP_DISABLED") ?? "").trim().toLowerCase() === "true";
}

// ---- shodan_internetdb -------------------------------------------------------

/**
 * Shape the InternetDB response. Only HTTP 404 changes: it is the provider's
 * documented "no information available" answer, a proven negative. 401/403/429/5xx
 * and every 2xx keep the legacy `{ ok: r.ok, status, data }` so a genuine provider
 * failure is still a failure and a 2xx is untouched.
 *
 * The negative deliberately does NOT carry a `status` key: the circuit breaker and
 * the usage logger both read `status`, and a bare 404 there is exactly what made this
 * look like a dead endpoint. The upstream code travels as `upstream_status`.
 */
export function shapeShodanResponse(status: number, ok: boolean, data: unknown, ip?: unknown): Record<string, unknown> {
  if (status === 404 && !negativeLookupSemanticsDisabled() && isIpLiteral(ip) && isNoInformationBody(data)) {
    return {
      ok: true,
      found: false,
      upstream_status: 404,
      data,
      note: "Shodan InternetDB holds no record for this IP — a normal negative. It says nothing about whether the host is exposed, only that InternetDB has not indexed it.",
    };
  }
  return { ok, status, data };
}

// A 404 is a PROVEN negative only when BOTH hold — each was measured against the live endpoint on 2026-10-06:
//  • the input is an IP literal. InternetDB answers the identical `404 {"detail":"No information available"}` for
//    `notanip` and `1.2.3` as for a real unindexed address, so without this a typo'd hostname would read as
//    "InternetDB holds no record" and be cached for 24 h.
//  • the body is InternetDB's documented "no information" answer. If the endpoint is retired, moved or fronted by a
//    page that 404s EVERYTHING, the body is different — and that must stay a failure, so the circuit breaker's
//    "404 on 2 distinct inputs → endpoint dead" protection still fires instead of being silently turned into
//    "no record" for every IP.
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
export function isIpLiteral(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (IPV4_RE.test(s)) return true;
  // IPv6 (permissive on purpose: a malformed IPv6 stays a failure only if it has no colons or non-hex characters).
  return s.length <= 45 && s.includes(":") && /^[0-9a-f:.]+$/i.test(s) && (s.match(/:/g) ?? []).length >= 2;
}
export function isNoInformationBody(data: unknown): boolean {
  const d = (data as { detail?: unknown } | null)?.detail;
  return typeof d === "string" && d.trim().toLowerCase() === "no information available";
}

// ---- jina_reader_scrape ------------------------------------------------------

// Jina's own header block, which ALWAYS leads the body when the origin errored.
// Anchored at the start so a page that merely QUOTES the phrase deep in its content
// (an article about error codes) is never mistaken for an error page.
// `URL Source:` is REQUIRED: all 192 cached error pages in production (2026-10-06) carry Title → URL Source →
// Warning, none lead with Warning or skip URL Source, and requiring it stops a page whose own <title> contains a
// forged "Warning: Target URL returned error 404" line from being read as nonexistent.
const JINA_TARGET_ERROR_RE =
  /^\s*(?:Title:[^\n]*\n+)?URL Source:[^\n]*\n+Warning:\s*Target URL returned error\s+(\d{3})\b/i;

/** The origin's HTTP status when `body` is a Jina-wrapped origin error, else null. */
export function parseJinaTargetError(body: string): number | null {
  const m = JINA_TARGET_ERROR_RE.exec(body.slice(0, 1000));
  if (!m) return null;
  const code = Number(m[1]);
  return code >= 400 && code <= 599 ? code : null;
}

/**
 * Shape a Jina 200 body.
 *   • origin 404 / 410 — the page is not there: a proven negative (`found:false`).
 *     The error page's markdown is NOT returned, so it cannot be persisted or cited.
 *   • any other origin error — the page could not be read: a failure of THIS READ,
 *     not of the Jina provider. `origin_error:true` tells the circuit breaker not to
 *     count it against Jina's health (see circuit.classifyResult), and the origin's
 *     code travels as `target_status`, never `status`: a bare 403 in `status` would
 *     suppress the whole provider as "401/403 unauthorized".
 *   • anything else — unchanged.
 */
export function shapeJinaBody(url: string, text: string, maxChars: number): Record<string, unknown> {
  if (!negativeLookupSemanticsDisabled()) {
    const target = parseJinaTargetError(text);
    if (target === 404 || target === 410) {
      return {
        ok: true,
        found: false,
        url,
        target_status: target,
        note: `The origin answered HTTP ${target}: the page does not exist at this URL — a normal negative. The reader's error page is not page content and is not returned.`,
      };
    }
    if (target !== null) {
      return {
        ok: false,
        origin_error: true,
        error: `jina target error ${target}`,
        target_status: target,
        url,
        hint: target === 429
          ? "the origin rate-limited the reader — wait, or try wayback_snapshots"
          : "the origin refused or failed the read — try wayback_snapshots, socialfetch_web_read, or a different source",
      };
    }
  }
  return { ok: true, url, markdown: text.slice(0, maxChars), truncated: text.length > maxChars };
}

// ---- /health -----------------------------------------------------------------

/**
 * `/health` → `checks.negative_lookup_semantics`. Presence of the key proves this
 * build is deployed; `ok:false` means the rule no longer behaves as documented.
 */
export function negativeLookupSelfTest(): { ok: boolean; detail: string } {
  if (negativeLookupSemanticsDisabled()) {
    return { ok: true, detail: "LEGACY via NEGATIVE_LOOKUP_DISABLED" };
  }
  const wrong: string[] = [];
  const s404 = shapeShodanResponse(404, false, { detail: "No information available" }, "192.0.2.1");
  if (s404.ok !== true || s404.found !== false || "status" in s404) wrong.push("shodan 404 not a clean negative");
  const s500 = shapeShodanResponse(500, false, {}, "192.0.2.1");
  if (s500.ok !== false || s500.status !== 500) wrong.push("shodan 500 no longer a failure");
  const s200 = shapeShodanResponse(200, true, { ip: "192.0.2.1" }, "192.0.2.1");
  if (s200.ok !== true || "found" in s200) wrong.push("shodan 200 changed");

  const sBadIp = shapeShodanResponse(404, false, { detail: "No information available" }, "notanip");
  if (sBadIp.ok !== false || sBadIp.status !== 404) wrong.push("shodan 404 for a non-IP read as a negative");
  const sOtherBody = shapeShodanResponse(404, false, { detail: "Not Found" }, "192.0.2.1");
  if (sOtherBody.ok !== false || sOtherBody.status !== 404) wrong.push("shodan 404 with an undocumented body read as a negative");

  const errPage = (code: number) =>
    `Title: Not Found\n\nURL Source: https://example.test/x\n\nWarning: Target URL returned error ${code}: Not Found\n\nMarkdown Content:\n`;
  const j404 = shapeJinaBody("https://example.test/x", errPage(404), 18000);
  if (j404.ok !== true || j404.found !== false || "markdown" in j404) wrong.push("jina 404 page not a clean negative");
  const j403 = shapeJinaBody("https://example.test/x", errPage(403), 18000);
  if (j403.ok !== false || j403.origin_error !== true || "status" in j403) wrong.push("jina 403 page not an origin error");
  const jOk = shapeJinaBody("https://example.test/x", "Title: A\n\nURL Source: https://example.test/x\n\nMarkdown Content:\nhello", 18000);
  if (jOk.ok !== true || jOk.markdown === undefined) wrong.push("jina normal page changed");
  const jQuote = shapeJinaBody(
    "https://example.test/x",
    "Title: HTTP errors\n\nURL Source: https://example.test/x\n\nMarkdown Content:\nWarning: Target URL returned error 404 is what Jina prints.",
    18000,
  );
  if (jQuote.ok !== true || jQuote.found === false) wrong.push("jina page quoting the phrase misread");

  return wrong.length
    ? { ok: false, detail: wrong.join("; ") }
    : {
      ok: true,
      detail: "shodan 404 and jina origin 404/410 are proven-empty (ok:true, found:false); other jina origin errors are failed reads that do not count against provider health",
    };
}
