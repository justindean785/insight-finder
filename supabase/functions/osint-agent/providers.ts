/**
 * providers.ts — MiniMax provider, minimaxChat helper, safeJson, and Gemini grounded search.
 * Extracted from index.ts (lines 163–282).
 */

import { createOpenAICompatible } from "npm:@ai-sdk/openai-compatible@1";
import { MODELS } from "./models.ts";
import { MINIMAX_API_KEY, GEMINI_API_KEY, fetchRetry } from "./env.ts";

// ---- MiniMax OpenAI-compatible provider ----------------------------------------
export const minimax = createOpenAICompatible({
  name: "minimax",
  baseURL: "https://api.minimax.io/v1",
  headers: { Authorization: `Bearer ${MINIMAX_API_KEY}` },
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
  }
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
  try {
    const r = await fetchRetry(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const txt = await r.text();
    let raw: any;
    try { raw = JSON.parse(txt); } catch { raw = { raw: txt.slice(0, 4000) }; }
    const cand = raw?.candidates?.[0];
    const parts: Array<{ text?: string }> = cand?.content?.parts ?? [];
    const text = parts.map((p) => p?.text ?? "").join("\n").trim();
    const chunks: any[] = cand?.groundingMetadata?.groundingChunks ?? [];
    const citations = chunks
      .map((c) => c?.web)
      .filter((w) => w && typeof w.uri === "string")
      .map((w) => ({ uri: String(w.uri), title: w.title ? String(w.title) : undefined }));
    const queries: string[] = cand?.groundingMetadata?.webSearchQueries ?? [];
    return { ok: r.ok, status: r.status, text, citations, queries, raw };
  } finally {
    clearTimeout(timer);
  }
}