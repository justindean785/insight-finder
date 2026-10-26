// lib/wayback-cdx.ts — the archive.org lookups behind wayback_cdx_search.
//
// Measured 2026-10-18 (tool_usage_log, 30 days): 49 calls, 1 ok, 19 empty, 21
// failed; 15 of the failures were timeouts at 22-26 s and 5 were archive.org 503s.
// The old tool ran its queries one after another: the 25-row sample (12 s per
// attempt, plus one retry), THEN the earliest/latest bookends (the same again).
// The worst case is about 48 s against the 25 s wrapper cap in cache.ts, and the
// wrapper discards everything when it fires.
//
// waybackCdxSearch issues the four archive.org queries AT ONCE, each with one
// attempt and its own budget, so the call answers within the slowest single
// query. It keeps whatever answered:
//   • a capture timestamp from any query proves the URL was archived, so a slow
//     sample query no longer turns into a failure (`partial:true`);
//   • `archived:false` is reported ONLY when the CDX sample query itself returned
//     a well-formed empty answer and no other query found a capture;
//   • a timeout, a 5xx or a malformed body is a failed read, never a negative.
// The latest capture falls back to the availability API (most recent playable
// capture) before the sample's own maximum. Each timestamp names its source.
//
// KILL SWITCH, read at CALL TIME: WAYBACK_CDX_PARALLEL_DISABLED=true restores the
// old sequential tool (waybackCdxSearchLegacy, moved here verbatim) with no deploy.

import { fetchRetry } from "../fetch_retry.ts";

/** Per-query budget for each CDX request (sample, earliest, latest). One attempt. */
export const WAYBACK_CDX_QUERY_TIMEOUT_MS = 10_000;
/** Budget for the availability API request. One attempt. */
export const WAYBACK_AVAILABILITY_TIMEOUT_MS = 8_000;
/** Headroom the slowest query must leave below the wrapper cap. */
const WRAPPER_MARGIN_MS = 2_000;

export function waybackCdxParallelDisabled(): boolean {
  return (Deno.env.get("WAYBACK_CDX_PARALLEL_DISABLED") ?? "").trim().toLowerCase() === "true";
}

type Read =
  | { ok: true; data: unknown }
  | { ok: false; status?: number; timeout?: boolean };

/** One attempt at a JSON read. An empty body counts as an empty array (CDX's no-result form). */
async function readJson(url: string, signal: AbortSignal | undefined, timeoutMs: number): Promise<Read> {
  try {
    const r = await fetchRetry(url, { signal }, { timeoutMs, retries: 0 });
    if (!r.ok) {
      await r.body?.cancel().catch(() => {});
      return { ok: false, status: r.status };
    }
    const text = (await r.text()).trim();
    if (!text) return { ok: true, data: [] };
    try {
      return { ok: true, data: JSON.parse(text) };
    } catch {
      return { ok: false };
    }
  } catch (e) {
    const timeout = (e instanceof DOMException && e.name === "AbortError") || /abort|timed out/i.test(String(e));
    return { ok: false, timeout };
  }
}

type Found<T> = { kind: "found"; value: T } | { kind: "empty" } | { kind: "failed"; status?: number; timeout?: boolean };

function failed(read: Read): Found<never> {
  return read.ok ? { kind: "failed" } : { kind: "failed", status: read.status, timeout: read.timeout };
}

type Capture = { timestamp: string | null; original: string | null; statuscode: string | null };

function parseSample(read: Read): Found<Capture[]> {
  if (!read.ok) return failed(read);
  if (!Array.isArray(read.data)) return { kind: "failed" };
  if (read.data.length < 2) return { kind: "empty" };
  const header = read.data[0] as string[];
  const ti = header.indexOf("timestamp"), oi = header.indexOf("original"), si = header.indexOf("statuscode");
  const rows = (read.data.slice(1) as string[][]).map((row) => ({
    timestamp: ti >= 0 ? row[ti] ?? null : null,
    original: oi >= 0 ? row[oi] ?? null : null,
    statuscode: si >= 0 ? row[si] ?? null : null,
  }));
  return { kind: "found", value: rows };
}

function parseBookend(read: Read): Found<string> {
  if (!read.ok) return failed(read);
  if (!Array.isArray(read.data)) return { kind: "failed" };
  if (read.data.length < 2) return { kind: "empty" };
  const hdr = read.data[0] as string[];
  const idx = hdr.indexOf("timestamp");
  const row = read.data[1] as string[];
  const ts = (idx >= 0 ? row[idx] : row[0]) ?? null;
  return ts ? { kind: "found", value: ts } : { kind: "empty" };
}

function parseAvailability(read: Read): Found<string> {
  if (!read.ok) return failed(read);
  const snaps = (read.data as { archived_snapshots?: { closest?: { available?: boolean; timestamp?: string } } } | null)
    ?.archived_snapshots;
  if (!snaps || typeof snaps !== "object") return { kind: "failed" };
  const c = snaps.closest;
  return c?.available === true && typeof c.timestamp === "string" && c.timestamp
    ? { kind: "found", value: c.timestamp }
    : { kind: "empty" };
}

export type WaybackCdxOptions = {
  signal?: AbortSignal;
  /** Test seam: smaller budgets so a "slow" archive takes milliseconds. */
  timeouts?: { cdxMs?: number; availabilityMs?: number };
};

/** The parallel lookup (the default). See the header for the rules it keeps. */
export async function waybackCdxSearch(url: string, opts: WaybackCdxOptions = {}): Promise<Record<string, unknown>> {
  const cdxMs = opts.timeouts?.cdxMs ?? WAYBACK_CDX_QUERY_TIMEOUT_MS;
  const availabilityMs = opts.timeouts?.availabilityMs ?? WAYBACK_AVAILABILITY_TIMEOUT_MS;
  const base = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json`;
  const [sampleRead, earliestRead, latestRead, availabilityRead] = await Promise.all([
    readJson(`${base}&fl=timestamp,original,statuscode&limit=25&collapse=urlkey`, opts.signal, cdxMs),
    readJson(`${base}&fl=timestamp&limit=1`, opts.signal, cdxMs),
    readJson(`${base}&fl=timestamp&limit=-1`, opts.signal, cdxMs),
    readJson(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, opts.signal, availabilityMs),
  ]);
  const sample = parseSample(sampleRead);
  const earliest = parseBookend(earliestRead);
  const latest = parseBookend(latestRead);
  const available = parseAvailability(availabilityRead);

  const rows = sample.kind === "found" ? sample.value : [];
  const sampleTs = rows.map((x) => x.timestamp).filter((t): t is string => !!t).sort();
  const pick = (...c: Array<[string | null | undefined, string]>): [string | null, string | null] => {
    for (const [v, src] of c) if (v) return [v, src];
    return [null, null];
  };
  const [earliestTs, earliestSource] = pick(
    [earliest.kind === "found" ? earliest.value : null, "cdx"],
    [sampleTs[0], "sample"],
  );
  const [latestTs, latestSource] = pick(
    [latest.kind === "found" ? latest.value : null, "cdx"],
    [available.kind === "found" ? available.value : null, "availability"],
    [sampleTs[sampleTs.length - 1], "sample"],
  );
  const anyCapture = !!(earliestTs || latestTs);

  if (sample.kind === "found") {
    return {
      ok: true, url, archived: true,
      earliest: earliestTs, latest: latestTs,
      earliest_source: earliestSource, latest_source: latestSource,
      sampled_count: rows.length,
      capped: rows.length >= 25,
      captures: rows.slice(0, 25),
    };
  }
  if (anyCapture) {
    return {
      ok: true, url, archived: true, partial: true,
      earliest: earliestTs, latest: latestTs,
      earliest_source: earliestSource, latest_source: latestSource,
      sampled_count: 0, capped: false, captures: [],
      note: sample.kind === "empty"
        ? "The CDX index returned no rows for this exact URL, but another archive.org lookup found a capture; no sample rows."
        : "The CDX sample query failed (timeout or server error); capture existence comes from the other archive.org lookups, so there are no sample rows.",
    };
  }
  if (sample.kind === "empty") {
    return {
      ok: true, url, archived: false, sampled_count: 0, capped: false,
      earliest: null, latest: null, earliest_source: null, latest_source: null, captures: [],
    };
  }
  if (typeof sample.status === "number") {
    return { ok: false, status: sample.status, error: `wayback cdx ${sample.status}`, url };
  }
  if (sample.timeout) {
    console.warn(`[wayback_cdx_search] timed out for ${url} (archive.org slow / tool cap)`);
    return { ok: false, error: "wayback_cdx_search timed out (archive.org slow)", _timeout: true, url };
  }
  return { ok: false, error: "wayback cdx returned an unreadable (non-JSON) body", url };
}

/**
 * The pre-2026-10-18 sequential tool, kept verbatim for the kill switch.
 * archive.org's CDX endpoint is chronically slow (p95 ~60s); the wrapper's AbortSignal
 * is forwarded into every fetch so a hit on the cap cancels the request cleanly.
 */
export async function waybackCdxSearchLegacy(url: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  try {
    const base = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(url)}&output=json`;
    // Accurate bookends, NOT derived from the capped sample page: CDX
    // default order is chronological, so &limit=1 is the oldest capture and
    // &limit=-1 is the newest. Each is failure-tolerant (null on any error).
    const firstTs = async (limit: string): Promise<string | null> => {
      try {
        const r = await fetchRetry(`${base}&fl=timestamp&limit=${limit}`, { signal }, { timeoutMs: 12_000, retries: 1 });
        if (!r.ok) { await r.body?.cancel().catch(() => {}); return null; }
        const data = await r.json().catch(() => null);
        if (!Array.isArray(data) || data.length < 2) return null;
        const hdr = data[0] as string[];
        const idx = hdr.indexOf("timestamp");
        const row = data[1] as string[];
        return ((idx >= 0 ? row[idx] : row[0]) ?? null) as string | null;
      } catch { return null; }
    };
    // Small sample page for context (collapsed to unique urlkeys).
    const r = await fetchRetry(`${base}&limit=25&collapse=urlkey`, { signal }, { timeoutMs: 12_000, retries: 1 });
    if (!r.ok) return { ok: false, status: r.status, error: `wayback cdx ${r.status}`, url };
    const data = await r.json().catch(() => null);
    // CDX json: row[0] is the header (["urlkey","timestamp","original","statuscode",...]).
    if (!Array.isArray(data) || data.length < 2) {
      return { ok: true, url, archived: false, sampled_count: 0, capped: false, earliest: null, latest: null, captures: [] };
    }
    const header = data[0] as string[];
    const ti = header.indexOf("timestamp"), oi = header.indexOf("original"), si = header.indexOf("statuscode");
    const rows = (data.slice(1) as string[][]).map((row) => ({
      timestamp: ti >= 0 ? row[ti] ?? null : null,
      original: oi >= 0 ? row[oi] ?? null : null,
      statuscode: si >= 0 ? row[si] ?? null : null,
    }));
    const [earliest, latest] = await Promise.all([firstTs("1"), firstTs("-1")]);
    // Fall back to the sample's own min/max only if a bookend query failed.
    const sampleTs = rows.map((x) => x.timestamp).filter((t): t is string => !!t).sort();
    return {
      ok: true, url, archived: true,
      earliest: earliest ?? sampleTs[0] ?? null,
      latest: latest ?? sampleTs[sampleTs.length - 1] ?? null,
      sampled_count: rows.length,
      capped: rows.length >= 25,
      captures: rows.slice(0, 25),
    };
  } catch (e) {
    // Explicit timeout surface: an AbortError here is the tool cap / archive.org
    // being too slow, NOT a code error.
    const isAbort = e instanceof DOMException && e.name === "AbortError";
    if (isAbort) {
      console.warn(`[wayback_cdx_search] timed out for ${url} (archive.org slow / tool cap)`);
      return { ok: false, error: "wayback_cdx_search timed out (archive.org slow)", _timeout: true, url };
    }
    return { error: String(e instanceof Error ? e.message : e) };
  }
}

/**
 * `/health` → `checks.wayback_cdx_budget`. Presence proves this build is deployed;
 * `ok:false` means the slowest single query no longer clears the wrapper cap.
 */
export function waybackCdxBudgetSelfTest(wrapperCapMs: number): { ok: boolean; detail: string } {
  if (waybackCdxParallelDisabled()) {
    return { ok: true, detail: "LEGACY via WAYBACK_CDX_PARALLEL_DISABLED: sequential queries, worst case about 48 s" };
  }
  const slowest = Math.max(WAYBACK_CDX_QUERY_TIMEOUT_MS, WAYBACK_AVAILABILITY_TIMEOUT_MS);
  const ok = slowest + WRAPPER_MARGIN_MS <= wrapperCapMs;
  return {
    ok,
    detail: ok
      ? `4 archive.org queries in parallel, slowest budget ${slowest} ms inside the ${wrapperCapMs} ms wrapper; partial results kept; a failed read is never a negative`
      : `slowest query budget ${slowest} ms does not clear the ${wrapperCapMs} ms wrapper with ${WRAPPER_MARGIN_MS} ms margin`,
  };
}
