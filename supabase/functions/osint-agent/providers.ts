/**
 * providers.ts — MiniMax provider, minimaxChat helper, safeJson, and Gemini grounded search.
 * Extracted from index.ts (lines 163–282).
 */

import { createOpenAICompatible } from "npm:@ai-sdk/openai-compatible@1";
import { MODELS } from "./models.ts";
import {
  MINIMAX_API_KEY, GEMINI_API_KEY, PERPLEXITY_API_KEY, fetchRetry,
  LOVABLE_API_KEY, ALLOW_LOVABLE_FALLBACK, GEMINI_FALLBACK_MODEL_ID,
  ORCHESTRATOR_FETCH,
} from "./env.ts";
import { selectFallbackProvider } from "./orchestrator_select.ts";

// ---- MiniMax OpenAI-compatible provider ----------------------------------------
// MiniMax is the primary (near-always-live) orchestrator — every investigation
// runs through it unless GROK/OPENADAPTER keys are set. `fetch: ORCHESTRATOR_FETCH`
// bounds it with an idle-timeout guard (see fetch_retry.ts) so a stalled stream
// can't hang the run forever; without it this was the one unbounded outbound call
// in the codebase.
export const minimax = createOpenAICompatible({
  name: "minimax",
  baseURL: "https://api.minimax.io/v1",
  headers: { Authorization: `Bearer ${MINIMAX_API_KEY}` },
  fetch: ORCHESTRATOR_FETCH,
});

// Direct MiniMax chat-completions caller for sub-agent helpers + native plugins (web_search).
// Used by the minimax_* tools below to let MiniMax do reasoning, extraction, and live web
// search as first-class capabilities — not just as the top-level orchestrator.
export async function minimaxChat(opts: {
  model?: string;
  system?: string;
  user: string;
  json?: boolean;
  webSearch?: boolean;
  temperature?: number;
  maxTokens?: number;
  /** Optional external abort signal (e.g. a health probe's bounded timeout).
   *  When it fires, the underlying fetch is aborted — without it, an external
   *  timeout only abandons the promise while the paid MiniMax call keeps
   *  running to the internal 45s cap. */
  signal?: AbortSignal;
}): Promise<{ ok: boolean; status: number; content: string; raw: unknown }> {
  const body: Record<string, unknown> = {
    model: opts.model ?? MODELS.fast,
    messages: [
      ...(opts.system ? [{ role: "system", content: opts.system }] : []),
      { role: "user", content: opts.user },
    ],
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 1500,
  };
  if (opts.json) body.response_format = { type: "json_object" };
  if (opts.webSearch) body.tools = [{ type: "web_search" }];

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  // Chain an external signal (probe timeout / request cancellation) onto our
  // controller so it actually aborts the in-flight fetch, not just the await.
  const onExternalAbort = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    const r = await fetch("https://api.minimax.io/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${MINIMAX_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text();
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { raw = { raw: text.slice(0, 4000) }; }
    const content =
      (raw as { choices?: Array<{ message?: { content?: string } }> })
        ?.choices?.[0]?.message?.content ?? "";
    return { ok: r.ok, status: r.status, content, raw };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
  }
}

// ---- Perplexity Sonar live web search ---------------------------------------
// The single working web-search path. MiniMax's chat API rejects the
// `tools:[{type:"web_search"}]` shape with HTTP 400, so live web search must
// NOT go through minimaxChat({webSearch:true}). Both the standalone
// `minimax_web_search` tool (tools/minimax.ts) and `dork_harvest`
// (tool-registry.ts) call this helper so there is one place that owns the
// working request shape (Perplexity `sonar`, native grounded search).
export async function perplexitySearch(opts: {
  query: string;
  /** Optional system-prompt override (e.g. dork_harvest's "return only URLs"). */
  system?: string;
  focus?: string;
  maxTokens?: number;
  /** Dependency injection for tests; defaults to the env-captured key. */
  apiKey?: string;
  signal?: AbortSignal;
}): Promise<{ ok: boolean; status: number; answer: string; citations: string[]; error?: string }> {
  const key = opts.apiKey ?? PERPLEXITY_API_KEY;
  if (!key) {
    return { ok: false, status: 0, answer: "", citations: [], error: "PERPLEXITY_API_KEY not configured" };
  }
  const system = opts.system ??
    "You are an OSINT web-search worker. Return a concise factual answer in bullet points. Do not speculate. Prefer specific names, dates, URLs, and identifiers. If nothing relevant is found, say so explicitly.";
  try {
    const r = await fetchRetry("https://api.perplexity.ai/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "sonar",
        messages: [
          { role: "system", content: system },
          { role: "user", content: `${opts.focus ? `Focus: ${opts.focus}\n\n` : ""}Query: ${opts.query}` },
        ],
        max_tokens: opts.maxTokens ?? 1200,
      }),
      signal: opts.signal,
    });
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      return { ok: false, status: r.status, answer: "", citations: [], error: `perplexity ${r.status}: ${body.slice(0, 300)}` };
    }
    const data = await r.json() as {
      choices?: { message?: { content?: string } }[];
      citations?: string[];
      search_results?: { url?: string }[];
    };
    const answer = (data.choices?.[0]?.message?.content ?? "").trim();
    const citations = (data.citations ?? data.search_results?.map((s) => s.url ?? "").filter(Boolean) ?? [])
      .filter((u) => typeof u === "string" && /^https?:\/\//i.test(u))
      .slice(0, 25);
    return { ok: true, status: r.status, answer, citations };
  } catch (e) {
    return { ok: false, status: 0, answer: "", citations: [], error: String(e) };
  }
}

// ---- MiniMax health signal (per-isolate) ------------------------------------
// When the orchestrator stream or a direct minimaxChat call recently succeeded,
// MiniMax is demonstrably alive, so index.ts can SKIP its preflight ping —
// removing an extra round-trip (and up to the 6s probe timeout on the unhealthy
// path) from time-to-first-token. Cold isolate ⇒ 0 ⇒ probe still runs (safe).
let lastMinimaxOkAt = 0;
export function markMinimaxHealthy(): void { lastMinimaxOkAt = Date.now(); }
export function minimaxHealthyWithin(ms: number): boolean {
  return lastMinimaxOkAt > 0 && Date.now() - lastMinimaxOkAt < ms;
}

export type FallbackResult = {
  ok: boolean;
  status: number;
  content: string;
  raw: unknown;
  usedFallback: boolean;
};

async function callFallbackProvider(
  provider: "gemini" | "lovable",
  opts: Parameters<typeof minimaxChat>[0],
): Promise<{ ok: boolean; status: number; content: string; raw: unknown }> {
  // "gemini" = the direct Google API via its OpenAI-compatible endpoint — the
  // default fallback. "lovable" = the gateway, reachable only behind the
  // ALLOW_LOVABLE_FALLBACK opt-in (see selectFallbackProvider). Grok/xAI is
  // never a fallback.
  const isGemini = provider === "gemini";
  const baseURL = isGemini
    ? "https://generativelanguage.googleapis.com/v1beta/openai"
    : "https://ai.gateway.lovable.dev/v1";
  const model = isGemini ? GEMINI_FALLBACK_MODEL_ID : MODELS.fallback;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (isGemini) {
    headers["Authorization"] = `Bearer ${GEMINI_API_KEY}`;
  } else {
    headers["Lovable-API-Key"] = LOVABLE_API_KEY;
    headers["X-Lovable-AIG-SDK"] = "vercel-ai-sdk";
  }

  const body: Record<string, unknown> = {
    model,
    messages: [
      ...(opts.system ? [{ role: "system", content: opts.system }] : []),
      { role: "user", content: opts.user },
    ],
    temperature: opts.temperature ?? 0.2,
    max_tokens: opts.maxTokens ?? 1500,
  };
  if (opts.json) body.response_format = { type: "json_object" };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  // Defense-in-depth for the abort-cascade fix above: chain the caller's signal
  // (per-tool timeout / cancellation) onto this fetch too, so even if a fallback
  // is ever reached with a live-then-aborted signal it cancels the request
  // instead of running to the 60s cap off-ledger (Codex review).
  const onExternalAbort = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    const r = await fetch(`${baseURL}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text();
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { raw = { raw: text.slice(0, 4000) }; }
    const content =
      (raw as { choices?: Array<{ message?: { content?: string } }> })
        ?.choices?.[0]?.message?.content ?? "";
    return { ok: r.ok, status: r.status, content, raw };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
  }
}

export function shouldFallbackOnStatus(status: number): boolean {
  return status === 401 || status === 403 || status === 429 || status >= 500;
}

export function shouldFallbackOnError(e: unknown): boolean {
  if (e instanceof DOMException && e.name === "AbortError") return true;
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("abort")) return true;
  if (e instanceof TypeError) return true;
  if (/dns|ECONNREFUSED|ECONNRESET|ENOTFOUND|network|fetch failed/i.test(msg)) return true;
  return false;
}

export async function minimaxChatWithFallback(
  opts: Parameters<typeof minimaxChat>[0],
  // Optional dependency injection for testing the cascade without env mutation.
  // `env.ts` captures API keys at module load, so a test can't flip availability
  // after import. Production passes nothing → availability is read from the live
  // env bindings exactly as before, so runtime behavior is unchanged.
  deps?: { gemini?: boolean; lovable?: boolean; allowLovable?: boolean },
): Promise<FallbackResult> {
  try {
    const result = await minimaxChat(opts);
    if (!shouldFallbackOnStatus(result.status)) {
      return { ...result, usedFallback: false };
    }
    // Same orphaned-fallback guard as the catch path below, for the STATUS
    // branch: if MiniMax returns a non-throwing 5xx/429 AFTER the caller
    // already aborted (per-tool timeout — runWithToolTimeout has moved on),
    // do NOT fire a fallback. Return the MiniMax status result (clean skip,
    // matching the no-fallback status shape) instead of burning Lovable/Grok
    // quota off-ledger for a result nobody reads (Codex review, code-review).
    if (opts.signal?.aborted) {
      return { ...result, usedFallback: false };
    }
    console.warn(
      `[orchestrator-fallback] MiniMax failed (status=${result.status}), retrying on fallback`,
    );
  } catch (e) {
    if (!shouldFallbackOnError(e)) {
      throw e;
    }
    // Do NOT cascade to a fallback when the CALLER aborted (an external per-tool
    // timeout / request cancellation via opts.signal). runWithToolTimeout has
    // already returned the timeout result, so a fallback LLM call here is
    // orphaned — it burns Lovable/Grok quota + cost off-ledger in the background
    // for a result nobody reads (Codex review). Only MiniMax's OWN failure
    // (its internal timeout / 5xx / network error) should cascade.
    if (opts.signal?.aborted) {
      throw e;
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[orchestrator-fallback] MiniMax error (${msg}), retrying on fallback`);
  }

  const fb = selectFallbackProvider({
    gemini: deps?.gemini ?? !!GEMINI_API_KEY,
    lovable: deps?.lovable ?? !!LOVABLE_API_KEY,
    allowLovable: deps?.allowLovable ?? ALLOW_LOVABLE_FALLBACK,
  });
  if (!fb.provider) {
    return { ok: false, status: 0, content: "", raw: { error: fb.reason }, usedFallback: false };
  }
  console.warn(`[orchestrator-fallback] using ${fb.provider} (${fb.reason})`);
  const result = await callFallbackProvider(fb.provider, opts);
  return { ...result, usedFallback: true };
}

// ---- JSON parsing helper -------------------------------------------------------
export function safeJson<T = unknown>(s: string): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { /* try fence strip */ }
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) { try { return JSON.parse(m[1]) as T; } catch { /* fall through */ } }
  const start = s.indexOf("{"); const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) { try { return JSON.parse(s.slice(start, end + 1)) as T; } catch { /* noop */ } }
  return null;
}

// ============================================================
// Gemini direct API (with google_search grounding) — used for
// "deep dorks": let Gemini actually execute the dork against
// real Google, then synthesize + return cited URLs in one call.
// ============================================================
export async function geminiGroundedSearch(opts: {
  prompt: string;
  model?: string;
  system?: string;
  temperature?: number;
  /** Optional external abort signal (e.g. a per-tool timeout). When it fires,
   *  the underlying fetch is aborted instead of running to the internal 60s cap. */
  signal?: AbortSignal;
}): Promise<{
  ok: boolean;
  status: number;
  text: string;
  citations: Array<{ uri: string; title?: string }>;
  queries: string[];
  raw: unknown;
}> {
  if (!GEMINI_API_KEY) {
    return { ok: false, status: 0, text: "", citations: [], queries: [], raw: { error: "GEMINI_API_KEY not configured" } };
  }
  const model = opts.model ?? "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_API_KEY}`;
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
    tools: [{ google_search: {} }],
    generationConfig: { temperature: opts.temperature ?? 0.2 },
  };
  if (opts.system) {
    body.systemInstruction = { role: "system", parts: [{ text: opts.system }] };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  // Chain an external signal (per-tool timeout) onto our controller so it aborts
  // the in-flight fetch, not just the await.
  const onExternalAbort = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    const r = await fetchRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const txt = await r.text();
    let raw: unknown;
    try { raw = JSON.parse(txt); } catch { raw = { raw: txt.slice(0, 4000) }; }

    interface GeminiWebChunk { uri?: unknown; title?: unknown }
    interface GeminiCandidate {
      content?: { parts?: Array<{ text?: unknown }> };
      groundingMetadata?: {
        groundingChunks?: Array<{ web?: GeminiWebChunk }>;
        webSearchQueries?: unknown;
      };
    }
    const rawObj = raw as { candidates?: GeminiCandidate[] } | null;
    const cand = rawObj?.candidates?.[0];
    const parts = cand?.content?.parts ?? [];
    const text = parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("\n").trim();
    const chunks = cand?.groundingMetadata?.groundingChunks ?? [];
    const citations = chunks
      .map((c) => c?.web)
      .filter((w): w is GeminiWebChunk & { uri: string } => !!w && typeof w.uri === "string")
      .map((w) => ({ uri: String(w.uri), title: typeof w.title === "string" ? w.title : undefined }));
    const rawQueries = cand?.groundingMetadata?.webSearchQueries;
    const queries: string[] = Array.isArray(rawQueries)
      ? rawQueries.filter((q): q is string => typeof q === "string")
      : [];
    return { ok: r.ok, status: r.status, text, citations, queries, raw };
  } catch (err) {
    // A timeout (our 60s timer) or an external-signal abort rejects the fetch
    // with an AbortError. Without this catch it propagates uncaught to the
    // caller (e.g. runGeminiVision → attachment-intake's top-level catch),
    // silently dropping the read. Return the same {ok:false} shape this
    // function already uses for the missing-key case so every caller handles it
    // as a graceful failure (and the attachment_intake_skip trace fires).
    const aborted = (err instanceof Error && err.name === "AbortError") || ctrl.signal.aborted;
    const message = aborted
      ? "gemini request timed out (60s)"
      : `gemini request error: ${err instanceof Error ? err.message : String(err)}`;
    return { ok: false, status: 0, text: "", citations: [], queries: [], raw: { error: message } };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
  }
}

// ---- Gemini multimodal (vision + document) -------------------------------------
// MiniMax-M2.7 is text-only and cannot see images — the live false-identity trace
// (a mugshot chained face→name to an unrelated person) was the direct result.
// Gemini Flash IS multimodal, so this helper sends inline image / PDF-page bytes
// alongside a text instruction and returns the model's text. It mirrors
// geminiGroundedSearch's URL/auth/timeout/abort-chaining exactly; the only
// differences are (1) the `parts` array carries `inline_data` blobs and (2)
// google_search grounding is opt-in (used for "has this image been posted
// anywhere" reverse-search intent, off by default for plain extraction).
export interface GeminiPart {
  text?: string;
  inline_data?: { mime_type: string; data: string };
}
// Force valid JSON output for the structured image/document readers — their system
// prompts demand STRICT JSON, but gemini-2.5-flash (a thinking model) will otherwise
// wrap the JSON in prose/fences or truncate a large extraction, so extractJson()
// returns null and the file reads as "no parseable JSON" (the likely "it didn't read
// my PDF" failure). responseMimeType is INCOMPATIBLE with the google_search grounding
// tool, so it is omitted when grounding is on (image reverse-search only). Pure +
// exported so the JSON-mode gate is unit-tested without a live Gemini call.
export function visionGenerationConfig(useGrounding: boolean, temperature = 0.1): Record<string, unknown> {
  const cfg: Record<string, unknown> = { temperature };
  if (!useGrounding) cfg.responseMimeType = "application/json";
  return cfg;
}

export async function geminiVision(opts: {
  parts: GeminiPart[];
  system?: string;
  model?: string;
  temperature?: number;
  /** Add the google_search tool so Gemini can check where an image appears. */
  useGrounding?: boolean;
  /** Optional external abort signal (per-tool timeout). Aborts the fetch. */
  signal?: AbortSignal;
}): Promise<{
  ok: boolean;
  status: number;
  text: string;
  citations: Array<{ uri: string; title?: string }>;
  queries: string[];
  raw: unknown;
}> {
  // Read the key at call time (not the import-time const): keeps vision decoupled
  // from module-load order so a test can enable it without polluting env.ts's
  // boot-time fallback-provider selection. In prod the key is set before the
  // isolate starts, so this is identical to the const.
  const apiKey = Deno.env.get("GEMINI_API_KEY");
  if (!apiKey) {
    return { ok: false, status: 0, text: "", citations: [], queries: [], raw: { error: "GEMINI_API_KEY not configured" } };
  }
  // Flash multimodal SKU; reuses the same env override as the orchestrator
  // fallback, with a vision-specific override for operators who want to pin a
  // different multimodal model without moving the text fallback.
  const model = opts.model ?? Deno.env.get("GEMINI_VISION_MODEL_ID") ?? GEMINI_FALLBACK_MODEL_ID ?? "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body: Record<string, unknown> = {
    contents: [{ role: "user", parts: opts.parts }],
    generationConfig: visionGenerationConfig(opts.useGrounding ?? false, opts.temperature ?? 0.1),
  };
  if (opts.useGrounding) body.tools = [{ google_search: {} }];
  if (opts.system) {
    body.systemInstruction = { role: "system", parts: [{ text: opts.system }] };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  const onExternalAbort = () => ctrl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  try {
    const r = await fetchRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const txt = await r.text();
    let raw: unknown;
    try { raw = JSON.parse(txt); } catch { raw = { raw: txt.slice(0, 4000) }; }

    interface GeminiWebChunk { uri?: unknown; title?: unknown }
    interface GeminiCandidate {
      content?: { parts?: Array<{ text?: unknown }> };
      groundingMetadata?: {
        groundingChunks?: Array<{ web?: GeminiWebChunk }>;
        webSearchQueries?: unknown;
      };
    }
    const rawObj = raw as { candidates?: GeminiCandidate[] } | null;
    const cand = rawObj?.candidates?.[0];
    const parts = cand?.content?.parts ?? [];
    const text = parts.map((p) => (typeof p?.text === "string" ? p.text : "")).join("\n").trim();
    const chunks = cand?.groundingMetadata?.groundingChunks ?? [];
    const citations = chunks
      .map((c) => c?.web)
      .filter((w): w is GeminiWebChunk & { uri: string } => !!w && typeof w.uri === "string")
      .map((w) => ({ uri: String(w.uri), title: typeof w.title === "string" ? w.title : undefined }));
    const rawQueries = cand?.groundingMetadata?.webSearchQueries;
    const queries: string[] = Array.isArray(rawQueries)
      ? rawQueries.filter((q): q is string => typeof q === "string")
      : [];
    return { ok: r.ok, status: r.status, text, citations, queries, raw };
  } catch (err) {
    // A timeout (our 60s timer) or an external-signal abort rejects the fetch
    // with an AbortError. Without this catch it propagates uncaught to the
    // caller (e.g. runGeminiVision → attachment-intake's top-level catch),
    // silently dropping the read. Return the same {ok:false} shape this
    // function already uses for the missing-key case so every caller handles it
    // as a graceful failure (and the attachment_intake_skip trace fires).
    const aborted = (err instanceof Error && err.name === "AbortError") || ctrl.signal.aborted;
    const message = aborted
      ? "gemini request timed out (60s)"
      : `gemini request error: ${err instanceof Error ? err.message : String(err)}`;
    return { ok: false, status: 0, text: "", citations: [], queries: [], raw: { error: message } };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onExternalAbort);
  }
}