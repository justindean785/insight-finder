/**
 * Shared Serus scan orchestration, kept separate from the AI SDK tool wrapper
 * so transport tests can import it without pulling in npm:ai.
 */

import { SERUS_API_KEY, fetchRetry } from "../env.ts";

const SERUS_BASE = "https://api.serus.ai/v1";
const POLL_INTERVAL_MS = 2500;
const POLL_MAX_RETRIES = 10;

function buildScanUrl(scanId: string, reveal = false): string {
  return reveal
    ? `${SERUS_BASE}/darkweb/scans/${scanId}?reveal=true`
    : `${SERUS_BASE}/darkweb/scans/${scanId}`;
}

/** Build a Serus-authorized fetch wrapper. Throws on missing key. */
function serusHeaders(): HeadersInit {
  if (!SERUS_API_KEY) {
    throw Object.assign(new Error("SERUS_API_KEY not configured"), {
      code: "serus_key_missing",
    });
  }
  return {
    Authorization: `Bearer ${SERUS_API_KEY}`,
    "Content-Type": "application/json",
  };
}

/** Map a non-2xx Serus response into a structured error object the LLM can act on. */
export function serusErrorPayload(status: number, body: unknown): {
  error: string;
  code: string;
  status: number;
  message: string;
  request_id?: string;
  hint: string;
} {
  const e = (body as { error?: { code?: string; message?: string; request_id?: string } })?.error;
  const code = e?.code ?? `http_${status}`;
  const message = e?.message ?? `Serus API returned HTTP ${status}`;
  const hint = (() => {
    switch (status) {
      case 401: return "API key invalid, revoked, or expired. Rotate the key in the Serus dashboard and update the edge function secret.";
      case 402: return "Insufficient Serus credits. Top up the account before continuing.";
      case 403: return "Key lacks the required scope. Verify the key has darkweb:scan (and darkweb:reveal if you want unmasked fields).";
      case 404: return "Scan ID not found. The scan may have expired or the ID is malformed — retry the initial scan.";
      case 415: return "Wrong Content-Type. The tool already sends application/json — this is a bug.";
      case 422: return "Identifier format rejected. Check the identifier value matches the chosen identifierType.";
      case 429: return "Rate limited. Wait ~1s and retry. Do not fire >3 writes/sec to Serus.";
      default:  return status >= 500 ? "Server-side failure on Serus. Retry with exponential backoff." : "Unknown Serus error.";
    }
  })();
  return { error: "serus_api_error", code, status, message, request_id: e?.request_id, hint };
}

type InitiateResponse = { id?: string; status?: string; identifierType?: string };
type PollResponse = {
  id?: string;
  status?: "processing" | "success" | "failed";
  identifierType?: string;
  isBreached?: boolean;
  checkedAt?: string;
  createdAt?: string;
  scanType?: string;
  breaches?: Array<{
    breachAuthority?: { id?: string; name?: string; logoPath?: string; dataClasses?: string[] };
    isMasked?: boolean;
  }>;
  pastes?: Array<{ id?: string; title?: string; date?: string }>;
  extractedData?: {
    emails?: string[];
    usernames?: string[];
    phones?: string[];
    names?: string[];
    cryptoAddresses?: string[];
  };
};

/** A terminal poll response (success or failed). Used by shapeTerminalResult. */
type TerminalPollResponse = Omit<PollResponse, "status"> & {
  status: "success" | "failed";
};

/** Returns the scanId from an initiate response, or null if the response is malformed. */
export function parseInitiateResponse(text: string, status: number): { scanId: string | null; ok: boolean } {
  if (status < 200 || status >= 300) return { scanId: null, ok: false };
  let data: InitiateResponse;
  try { data = JSON.parse(text); } catch { return { scanId: null, ok: false }; }
  return { scanId: typeof data.id === "string" ? data.id : null, ok: !!data.id };
}

/** Returns true if a poll response indicates the scan is finished (success or failed). */
export function isTerminalStatus(data: PollResponse | null): boolean {
  return !!data && (data.status === "success" || data.status === "failed");
}

/** Map a terminal poll response to the orchestrator-facing result shape. */
export function shapeTerminalResult(
  last: TerminalPollResponse,
  scanId: string,
  initiatedAt: string,
  reveal: boolean,
) {
  return {
    ok: last.status === "success",
    status: last.status,
    scanId,
    identifierType: last.identifierType ?? undefined,
    isBreached: !!last.isBreached,
    totalBreaches: last.breaches?.length ?? 0,
    totalPastes: last.pastes?.length ?? 0,
    breaches: last.breaches,
    pastes: last.pastes,
    extractedData: last.extractedData,
    initiatedAt,
    completedAt: last.checkedAt ?? undefined,
    reveal,
    creditsUsed: 0.25,
    classification: (reveal ? "sensitive_unmasked" : "masked") as "masked" | "sensitive_unmasked",
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runSerusScan(
  identifierType: string,
  identifierValue: string,
  options: { reveal?: boolean; maxRetries?: number; intervalMs?: number } = {},
): Promise<{
  ok: boolean;
  status: "success" | "failed" | "timeout" | "error";
  scanId?: string;
  identifierType?: string;
  isBreached?: boolean;
  totalBreaches?: number;
  totalPastes?: number;
  breaches?: PollResponse["breaches"];
  pastes?: PollResponse["pastes"];
  extractedData?: PollResponse["extractedData"];
  initiatedAt?: string;
  completedAt?: string;
  reveal?: boolean;
  revealRequested?: boolean;
  creditsUsed?: number;
  classification?: "masked" | "sensitive_unmasked";
  error?: ReturnType<typeof serusErrorPayload>;
  revealError?: ReturnType<typeof serusErrorPayload>;
}> {
  const revealRequested = !!options.reveal;
  const maxRetries = options.maxRetries ?? POLL_MAX_RETRIES;
  const intervalMs = options.intervalMs ?? POLL_INTERVAL_MS;
  const initiatedAt = new Date().toISOString();

  let headers: HeadersInit;
  try {
    headers = serusHeaders();
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, status: "error", error: { error: "config", code: err?.code ?? "serus_key_missing", status: 0, message: err?.message ?? "", hint: "Set SERUS_API_KEY in the Supabase edge function secrets." } };
  }

  let init: Response;
  try {
    init = await fetchRetry(`${SERUS_BASE}/darkweb/scans`, {
      method: "POST",
      headers,
      body: JSON.stringify({ identifierType, identifierValue }),
    }, { retries: 1 });
  } catch (e) {
    return { ok: false, status: "error", error: { error: "network", code: "initiate_failed", status: 0, message: String(e), hint: "Network error reaching api.serus.ai. Check Supabase edge function outbound network." } };
  }
  const initText = await init.text();
  let initData: InitiateResponse;
  try { initData = JSON.parse(initText); } catch { initData = {}; }
  if (!init.ok || !initData.id) {
    let body: unknown = initText;
    try { body = JSON.parse(initText); } catch { /* keep raw */ }
    return { ok: false, status: "error", error: serusErrorPayload(init.status, body) };
  }
  const scanId = initData.id;

  let last: PollResponse | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    await sleep(intervalMs);
    let poll: Response;
    try {
      poll = await fetchRetry(buildScanUrl(scanId), { method: "GET", headers }, { retries: 1 });
    } catch (e) {
      if (attempt === maxRetries - 1) {
        return {
          ok: false,
          status: "timeout",
          scanId,
          identifierType,
          initiatedAt,
          revealRequested,
          error: { error: "network", code: "poll_failed", status: 0, message: String(e), hint: "Poll failed after retries. The scan may still be running on Serus; you can re-poll manually with GET /v1/darkweb/scans/<id>." },
        };
      }
      continue;
    }
    const pollText = await poll.text();
    let data: PollResponse;
    try { data = JSON.parse(pollText); } catch { data = { status: "failed" }; }
    if (!poll.ok) {
      let body: unknown = pollText;
      try { body = JSON.parse(pollText); } catch { /* keep raw */ }
      return { ok: false, status: "error", scanId, identifierType, revealRequested, error: serusErrorPayload(poll.status, body) };
    }
    last = data;
    if (isTerminalStatus(data)) break;
  }

  if (!last || !isTerminalStatus(last)) {
    return {
      ok: false,
      status: "timeout",
      scanId,
      identifierType,
      initiatedAt,
      revealRequested,
      error: { error: "timeout", code: "poll_exhausted", status: 0, message: `Scan did not complete within ${maxRetries * intervalMs / 1000}s.`, hint: "Re-poll manually with the scanId, or increase maxRetries." },
    };
  }

  let terminal = last as TerminalPollResponse;
  if (revealRequested && terminal.status === "success") {
    try {
      const revealRes = await fetchRetry(buildScanUrl(scanId, true), { method: "GET", headers }, { retries: 1 });
      const revealText = await revealRes.text();
      if (!revealRes.ok) {
        let body: unknown = revealText;
        try { body = JSON.parse(revealText); } catch { /* keep raw */ }
        return {
          ...shapeTerminalResult(terminal, scanId, initiatedAt, false),
          revealRequested: true,
          revealError: serusErrorPayload(revealRes.status, body),
        };
      }
      try {
        const revealData = JSON.parse(revealText) as PollResponse;
        if (isTerminalStatus(revealData)) terminal = revealData;
      } catch {
        // Keep masked terminal result if the reveal body is malformed.
      }
    } catch (e) {
      return {
        ...shapeTerminalResult(terminal, scanId, initiatedAt, false),
        revealRequested: true,
        revealError: {
          error: "network",
          code: "reveal_failed",
          status: 0,
          message: String(e),
          hint: "Masked scan completed, but the optional reveal fetch failed. Retry reveal only if unmasked fields are still required.",
        },
      };
    }
  }

  return {
    ...shapeTerminalResult(terminal, scanId, initiatedAt, revealRequested && terminal.status === "success"),
    revealRequested,
  };
}
