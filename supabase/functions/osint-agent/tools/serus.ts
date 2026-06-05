/**
 * tools/serus.ts — Serus darkweb scan agent.
 *
 * Implements the scan + poll flow documented in the Serus API spec:
 *   1. POST  /v1/darkweb/scans           -> { id, status: "processing" }
 *   2. GET   /v1/darkweb/scans/{id}      -> poll until status is "success" / "failed"
 *   3. GET   /v1/darkweb/scans/{id}?reveal=true   -> optional unmask (uses extra credits)
 *
 * Rate limits: 3 req/s write, 7 req/s read. Poller caps at 10 retries
 * (~30s total) before bailing out with status:"timeout" so the
 * orchestrator isn't blocked on a slow Serus scan.
 *
 * Identifier types: email | phone | username | domain | keyword | origin | password
 *
 * Error model: Serus returns { error: { type, code, message, request_id } }
 * on non-2xx. We surface code + message + a hint to the LLM so it can
 * decide whether to retry / skip / rotate the key.
 */

import { tool } from "npm:ai@6";
import { z } from "npm:zod@3";
import { SERUS_API_KEY, fetchRetry } from "../env.ts";

const SERUS_BASE = "https://api.serus.ai/v1";
const POLL_INTERVAL_MS = 2500;
const POLL_MAX_RETRIES = 10;

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
function serusErrorPayload(status: number, body: unknown): {
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

// ---- Pure helpers (exported for unit tests) ----------------------------

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
    // F-B3: classification marker so the recording layer + UI can flag
    // sensitive unmasked data and surface it appropriately.
    classification: (reveal ? "sensitive_unmasked" : "masked") as "masked" | "sensitive_unmasked",
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Initiate a scan and poll until terminal status. Pure orchestration —
 * exported separately so unit tests can exercise the poller without
 * hitting the network.
 */
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
  creditsUsed?: number;
  // F-B3: present on the success/failed path, set by shapeTerminalResult.
  classification?: "masked" | "sensitive_unmasked";
  error?: ReturnType<typeof serusErrorPayload>;
}> {
  const reveal = !!options.reveal;
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

  // 1. Initiate
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

  // 2. Poll
  let last: PollResponse | null = null;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    await sleep(intervalMs);
    let poll: Response;
    try {
      const url = reveal
        ? `${SERUS_BASE}/darkweb/scans/${scanId}?reveal=true`
        : `${SERUS_BASE}/darkweb/scans/${scanId}`;
      poll = await fetchRetry(url, { method: "GET", headers }, { retries: 1 });
    } catch (e) {
      // Network blip mid-poll — try again until we exhaust retries
      if (attempt === maxRetries - 1) {
        return {
          ok: false, status: "timeout", scanId, identifierType,
          initiatedAt,
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
      return { ok: false, status: "error", scanId, identifierType, error: serusErrorPayload(poll.status, body) };
    }
    last = data;
    if (data.status === "success" || data.status === "failed") break;
    // else status === "processing" — loop
  }

  if (!last || (last.status !== "success" && last.status !== "failed")) {
    return {
      ok: false, status: "timeout", scanId, identifierType, initiatedAt,
      error: { error: "timeout", code: "poll_exhausted", status: 0, message: `Scan did not complete within ${maxRetries * intervalMs / 1000}s.`, hint: "Re-poll manually with the scanId, or increase maxRetries." },
    };
  }

  // F-B3: classification is set by shapeTerminalResult so the recording
  // layer + UI can flag sensitive unmasked data. Using a single shaper
  // function keeps the contract identical to the one tested in
  // serus-poller.test.ts (vitest) and serus_test.ts (Deno).
  //
  // The runtime guard above guarantees `last.status` is "success" or
  // "failed" before we reach this return, but TypeScript can't carry
  // that narrowing across the `if (!last || ...)` branch. The cast
  // lifts `last` to the terminal type for the shaper call.
  return shapeTerminalResult(
    last as TerminalPollResponse,
    scanId,
    initiatedAt,
    reveal,
  );
}

export const serus_darkweb_scan = tool({
  description:
    "Serus darkweb exposure scan. One tool, seven identifier types (email, phone, username, domain, keyword, origin, password). Initiates a scan and polls until completion (~5–30s). Returns breach count, breach names + data classes (masked by default; pass `reveal:true` to unmask passwords/tokens if your Serus key has the darkweb:reveal scope), paste count, and any extracted PII (emails, usernames, phones, names, crypto addresses) Serus surfaces. Cost: 0.25 credits per scan. Use as a SECONDARY or CORROBORATING breach source alongside breach_check / leakcheck_lookup / hibp_lookup / oathnet_lookup — Serus has its own corpus that often catches hits the others miss, especially on phone/username/password. Note: SERUS_API_KEY must be configured in the edge function secrets for this tool to be available.",
  inputSchema: z.object({
    identifierType: z.enum(["email", "phone", "username", "domain", "keyword", "origin", "password"])
      .describe("Serus identifier type. `origin` is an IP or hostname; `password` should only be used on a confirmed seed you own or are authorized to test."),
    identifierValue: z.string().min(1).describe("The value to scan. Email format: user@domain.tld. Phone: E.164 with country code preferred."),
    reveal: z.boolean().optional().default(false)
      .describe("Pass true to request unmasked breach fields (passwords, tokens). Requires the SERUS key to have the darkweb:reveal scope — otherwise Serus returns 403."),
  }),
  execute: async ({ identifierType, identifierValue, reveal }) => {
    if (!SERUS_API_KEY) {
      return { error: "SERUS_API_KEY not configured", code: "serus_key_missing", hint: "Set SERUS_API_KEY in the Supabase edge function secrets and redeploy." };
    }
    return runSerusScan(identifierType, identifierValue, { reveal });
  },
});
