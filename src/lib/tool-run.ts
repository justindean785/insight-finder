export type ToolTone = "error" | "skip" | "ok" | "pending";
export type ToolRuntimeMeta = {
  stage?: string;
  cycle_id?: number;
  cache_layer?: string;
  stale_cache?: boolean;
  selector?: string;
  selector_type?: string;
  expected_value?: number;
  rejection_reason?: string;
  weak_lead?: boolean;
  weak_lead_reasons?: string[];
  source_created_at?: string;
};

type ToolOutput = Record<string, unknown> | null;

function asOutput(value: unknown): ToolOutput {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function deriveToolRuntime(output: unknown): ToolRuntimeMeta | null {
  const data = asOutput(output);
  if (!data || !data._runtime || typeof data._runtime !== "object" || Array.isArray(data._runtime)) return null;
  return data._runtime as ToolRuntimeMeta;
}

function formatCredits(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(value < 10 ? 2 : 1).replace(/\.?0+$/, "");
}

export function parseHttpStatusFromError(err: unknown): number | null {
  const msg = String((err as { message?: unknown })?.message ?? err ?? "");
  const m = msg.match(/\bHTTP\s*([45]\d{2})\b/i) ?? msg.match(/\bstatus\s*[:=]\s*([45]\d{2})\b/i) ?? msg.match(/\b([45]\d{2})\b/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export function describeTransportError(err: unknown): string {
  const msg = String((err as { message?: unknown })?.message ?? err ?? "").toLowerCase();
  const status = parseHttpStatusFromError(err);
  if (status === 401) return "Session expired — your login has timed out. Sign in again to continue.";
  if (status === 403) return "Access denied — this thread doesn't belong to your account. Open your own thread or create a new one.";
  if (status === 404) return "Edge function not deployed — the OSINT agent backend wasn't found. Deploy the Supabase function and retry.";
  if (status === 429) return "Rate limited by the scan backend — too many requests. Wait ~30 seconds and try again.";
  if (status === 502 || status === 503 || status === 504) return "Scan backend temporarily unavailable — upstream provider or dependency is down. Retry in a minute.";
  if (status && status >= 500) return `Backend error (HTTP ${status}) — the OSINT agent encountered a server fault. Check Supabase function logs for details.`;
  if (/failed to fetch|networkerror|network request failed|load failed|dns/i.test(msg)) return "Network failure — cannot reach the scan backend. Verify your Supabase project is running and the function URL is correct.";
  return "Scan request failed before the stream started — check the browser console for transport details.";
}

// A clean negative — the tool ran fine and simply found nothing (e.g.
// `{ ok:false, error:"not found" }` or a provider 404). This is an EMPTY
// outcome, not a fault. Mirrors the authoritative edge classifier
// (osint-agent/tool-outcome.ts `classifyToolOutcome` → `EMPTY_RE` + a bare 404)
// that already drives the Tools tab's neutral `outcome:"empty"` bucket, so the
// live chat cards stop painting the same successful-negative result alarming red.
// Scoped to not-found / 404 — the edge's "no usable result" phrase is left to the
// client's SKIP handling (also neutral), preserving its existing classification.
const EMPTY_REASON_RE = /not found\b|\b404\b/i;

function isCleanEmptyResult(output: Record<string, unknown> | null): boolean {
  if (!output) return false;
  const status = typeof output.status === "string" ? output.status.toLowerCase() : "";
  if (status === "empty" || status === "not_found" || status === "no_results") return true;
  const code = typeof output.status_code === "number" ? output.status_code
    : typeof output.statusCode === "number" ? output.statusCode
    : null;
  if (code === 404) return true;
  return EMPTY_REASON_RE.test(deriveToolReason(output));
}

export function deriveToolTone(part: {
  state?: string;
  errorText?: unknown;
  output?: unknown;
}): ToolTone {
  const output = asOutput(part.output);
  if (part.state === "output-error" || part.errorText != null) return "error";
  if (output?.skipped === true) return "skip";
  // ok:false with a "not found"/empty reason is a clean negative, not an error.
  if (output?.ok === false) return isCleanEmptyResult(output) ? "ok" : "error";
  return part.state === "output-available" ? "ok" : "pending";
}

/** Operational status with the analyst-relevant distinctions a bare tone lacks:
 *  a *gated* call was blocked by a triage/policy/budget gate (an intentional
 *  decision, not a fault), and a *degraded* call returned a partial/stale result
 *  or hit a temporarily-disabled provider (worth a second look, but not a hard
 *  failure). Only a real provider/runtime error counts as *failed*. */
export type ToolStatus = "succeeded" | "failed" | "skipped" | "gated" | "degraded" | "pending";

// Budget / policy / quota / triage / orchestration stops — an intentional
// control decision, not a fault. These must read as "Gated", never red
// "Failed". Covers the planner's EV gate ("expected value N below 70"), the
// per-investigation burst / cycle caps, and the "execution plan required" gate.
const GATE_REASON_RE = /\bgate(d|s)?\b|triage|policy|not promoted|budget|over[\s-]?budget|cost cap|quota|rate[\s-]?limit|expected value\b|\bev below\b|burst limit|cycle limit|execution plan required/i;
// Dedup / guard / no-op skips — the tool was intentionally not run, or ran and
// produced nothing actionable. Not a fault.
const SKIP_REASON_RE = /duplicate call|guard not met|already used this seed|high-cost tool already used|no usable result|\bskipped\b/i;
// Provider unhealthy / temporarily disabled / circuit-open / 5xx upstream —
// degraded, not failed (the fault is on the provider side). A 4xx (e.g. 404)
// is left as a real failure since it usually points at a bad request/path.
const DEGRADED_REASON_RE = /provider disabled|temporarily disabled|\bdisabled\b|unavailable|circuit|unhealthy|degraded|stale|timeout|http\s*5\d\d|\b5\d\d\b/i;

export function deriveToolStatus(part: {
  state?: string;
  errorText?: unknown;
  output?: unknown;
}): ToolStatus {
  const output = asOutput(part.output);
  const runtime = deriveToolRuntime(output);
  const reasonText = [
    typeof part.errorText === "string" ? part.errorText : "",
    output ? deriveToolReason(output) : "",
    runtime?.rejection_reason ?? "",
  ].join(" ").toLowerCase();

  // An "error-ish" outcome: stream error, explicit errorText, or ok:false. Before
  // calling it a failure, see whether the reason is really a gate or a degraded
  // provider — budget exhaustion and "provider disabled" are not hard failures.
  const erroredOut = part.state === "output-error" || part.errorText != null || output?.ok === false;
  if (erroredOut) {
    if (GATE_REASON_RE.test(reasonText)) return "gated";
    if (SKIP_REASON_RE.test(reasonText)) return "skipped";
    if (DEGRADED_REASON_RE.test(reasonText)) return "degraded";
    // Clean negative last (mirrors the edge classifier's governance→empty→failed
    // precedence): an ok:false tool result whose reason is just "not found"/404 is
    // an EMPTY success, not a fault. Never reclassify a hard stream output-error.
    const cleanNegative = output?.ok === false && part.state !== "output-error" && part.errorText == null;
    if (cleanNegative && isCleanEmptyResult(output)) return "succeeded";
    return "failed";
  }

  if (output) {
    if (output.gated === true) return "gated";
    if (output.skipped === true) {
      return GATE_REASON_RE.test(reasonText) ? "gated" : "skipped";
    }
    if (output.degraded === true || output.partial === true) return "degraded";
    if (runtime?.stale_cache === true) return "degraded";
    const status = typeof output.status === "string" ? output.status.toLowerCase() : "";
    if (status === "timeout" || status === "partial" || status === "degraded") return "degraded";
  }
  return part.state === "output-available" ? "succeeded" : "pending";
}

export function deriveToolReason(output: unknown): string {
  const data = asOutput(output);
  if (!data) return "";
  const raw =
    data.reason ??
    (typeof data.error === "string" ? data.error : null) ??
    (typeof data.message === "string" ? data.message : null) ??
    ((data.error && typeof data.error === "object" && typeof (data.error as { message?: unknown }).message === "string")
      ? (data.error as { message: string }).message
      : null);
  return typeof raw === "string" ? raw.trim() : "";
}

export function deriveToolCharge(output: unknown): { label: string | null; title: string | null } {
  const data = asOutput(output);
  if (!data) return { label: null, title: null };
  if (data._cached) return { label: "0 cr", title: "Loaded from cache — no provider call." };
  if (data.skipped === true) return { label: "0 cr", title: "Skipped before any provider request." };
  const creditsUsed = typeof data.creditsUsed === "number" ? data.creditsUsed : null;
  if (creditsUsed == null) return { label: null, title: null };
  const revealMayCostExtra = data.reveal === true || data.revealRequested === true;
  return {
    label: `${formatCredits(creditsUsed)}${revealMayCostExtra ? "+" : ""} cr`,
    title: revealMayCostExtra
      ? "Known scan cost plus any optional reveal charge."
      : "Reported by the tool output.",
  };
}

export function deriveToolPreview(name: string, output: unknown): string | null {
  const data = asOutput(output);
  if (!data) return null;
  if (name === "serus_darkweb_scan") {
    const status = typeof data.status === "string" ? data.status : null;
    if (status === "timeout") return "scan timed out";
    if (status === "error") return "scan error";
    if (status === "failed") return "scan failed";
    if (status === "success") {
      const breaches = typeof data.totalBreaches === "number" ? data.totalBreaches : null;
      const pastes = typeof data.totalPastes === "number" ? data.totalPastes : null;
      if (breaches != null || pastes != null) {
        const bits = [
          breaches != null ? `${breaches} breach${breaches === 1 ? "" : "es"}` : null,
          pastes != null ? `${pastes} paste${pastes === 1 ? "" : "s"}` : null,
        ].filter(Boolean);
        if (bits.length > 0) return bits.join(" · ");
      }
      return "scan complete";
    }
  }
  if (Array.isArray(data.found)) return `${typeof data.hits === "number" ? data.hits : data.found.length} hits`;
  if (Array.isArray(data.subdomains)) return `${data.subdomains.length} subdomains`;
  if (data.data && typeof data.data === "object") {
    const count = Object.keys(data.data as Record<string, unknown>).length;
    if (count > 0) return `${count} fields`;
  }
  return null;
}
