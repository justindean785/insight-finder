// tools/attachment-analyze.ts
//
// Vision OCR / image analysis for user-uploaded attachments (signed storage URLs).
// Primary path: direct Gemini generateContent (vision). Fallback: Lovable AI Gateway
// OpenAI-compatible multimodal chat when GEMINI_API_KEY is absent but LOVABLE is set.

import { tool } from "npm:ai@6";
import { z } from "npm:zod@3";
import { GEMINI_API_KEY, LOVABLE_API_KEY } from "../env.ts";
import { fetchT } from "../fetch_retry.ts";
import { assertSafeUrl } from "../safety.ts";

const VISION_MODEL = "gemini-2.5-flash";
const GATEWAY_VISION_MODEL = "google/gemini-2.5-flash";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 12_000;
const VISION_TIMEOUT_MS = 25_000;

const OCR_PROMPT =
  "You are an OSINT evidence extractor. Analyze this image and return STRICT JSON only (no markdown fences) with keys:\n" +
  '  "description": string — 1-3 sentence summary of what the image shows,\n' +
  '  "extracted_text": string — all readable text verbatim (OCR), or "" if none,\n' +
  '  "entities": { "emails": string[], "phones": string[], "usernames": string[], "domains": string[], "ips": string[], "names": string[], "addresses": string[], "wallets": string[] }\n' +
  "Extract every selector you can see (emails, handles, phones, domains, IPs, person names, street addresses, crypto wallets). " +
  "Do not invent data that is not visible.";

export interface AttachmentAnalyzeResult {
  ok?: boolean;
  empty?: boolean;
  source?: string;
  image_url?: string;
  content_type?: string;
  description?: string;
  extracted_text?: string;
  entities?: Record<string, string[]>;
  filename?: string;
  raw?: unknown;
  error?: string;
  status?: number;
}

function parseVisionJson(text: string): Omit<AttachmentAnalyzeResult, "ok" | "source" | "image_url" | "content_type"> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as AttachmentAnalyzeResult;
  } catch { /* try fence strip */ }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1]) as AttachmentAnalyzeResult;
    } catch { /* fall through */ }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1)) as AttachmentAnalyzeResult;
    } catch { /* noop */ }
  }
  return { description: trimmed.slice(0, 2000), extracted_text: trimmed, entities: {} };
}

async function fetchImageAsBase64(
  imageUrl: string,
  signal: AbortSignal | undefined,
): Promise<{ base64: string; contentType: string } | { error: string }> {
  let parsed: URL;
  try {
    parsed = assertSafeUrl(imageUrl);
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }

  let resp: Response;
  try {
    resp = await fetchT(parsed.toString(), { signal }, FETCH_TIMEOUT_MS);
  } catch (e) {
    const isAbort = e instanceof DOMException && e.name === "AbortError";
    return { error: isAbort ? "attachment image fetch timed out" : `attachment image fetch failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (!resp.ok) {
    await resp.body?.cancel().catch(() => {});
    return { error: `attachment image HTTP ${resp.status}` };
  }

  const contentType = (resp.headers.get("content-type") ?? "image/jpeg").split(";")[0].trim();
  if (!/^image\//i.test(contentType)) {
    await resp.body?.cancel().catch(() => {});
    return { error: `attachment_analyze expects an image content-type, got ${contentType}` };
  }

  const buf = new Uint8Array(await resp.arrayBuffer());
  if (buf.byteLength > MAX_IMAGE_BYTES) {
    return { error: `attachment image too large (${buf.byteLength} bytes, max ${MAX_IMAGE_BYTES})` };
  }

  let binary = "";
  for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]!);
  return { base64: btoa(binary), contentType };
}

async function geminiVisionAnalyze(
  base64: string,
  contentType: string,
  signal: AbortSignal | undefined,
): Promise<{ ok: true; text: string } | { ok: false; status: number; error: string }> {
  if (!GEMINI_API_KEY) {
    return { ok: false, status: 0, error: "GEMINI_API_KEY not configured" };
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${VISION_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  const body = {
    contents: [{
      role: "user",
      parts: [
        { text: OCR_PROMPT },
        { inline_data: { mime_type: contentType, data: base64 } },
      ],
    }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
  };

  let resp: Response;
  try {
    resp = await fetchT(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }, VISION_TIMEOUT_MS);
  } catch (e) {
    const isAbort = e instanceof DOMException && e.name === "AbortError";
    return { ok: false, status: 0, error: isAbort ? "attachment_analyze vision timed out" : String(e) };
  }

  const raw = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = (raw as { error?: { message?: string } })?.error?.message ?? resp.statusText;
    return { ok: false, status: resp.status, error: `gemini vision HTTP ${resp.status}: ${msg}` };
  }

  const parts = (raw as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> })
    ?.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p) => p?.text ?? "").join("\n").trim();
  if (!text) return { ok: false, status: resp.status, error: "gemini vision returned empty content" };
  return { ok: true, text };
}

async function gatewayVisionAnalyze(
  dataUrl: string,
  signal: AbortSignal | undefined,
): Promise<{ ok: true; text: string } | { ok: false; status: number; error: string }> {
  if (!LOVABLE_API_KEY) {
    return { ok: false, status: 0, error: "LOVABLE_API_KEY not configured" };
  }

  try {
    const [{ createOpenAICompatible }, { generateText }] = await Promise.all([
      import("npm:@ai-sdk/openai-compatible@1"),
      import("npm:ai@6"),
    ]);

    const provider = createOpenAICompatible({
      name: "lovable-ai-gateway",
      baseURL: "https://ai.gateway.lovable.dev/v1",
      headers: {
        "Lovable-API-Key": LOVABLE_API_KEY,
        "X-Lovable-AIG-SDK": "vercel-ai-sdk",
      },
    });

    const result = await generateText({
      model: provider.chatModel(GATEWAY_VISION_MODEL),
      messages: [{
        role: "user",
        content: [
          { type: "text", text: OCR_PROMPT },
          { type: "image", image: dataUrl },
        ],
      }],
      temperature: 0.1,
      abortSignal: signal,
    });
    const text = (result.text ?? "").trim();
    if (!text) return { ok: false, status: 0, error: "lovable gateway vision returned empty content" };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, status: 0, error: `lovable gateway vision failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function analyzeAttachmentImage(
  imageUrl: string,
  signal?: AbortSignal,
): Promise<AttachmentAnalyzeResult> {
  if (!GEMINI_API_KEY && !LOVABLE_API_KEY) {
    return { error: "attachment_analyze unavailable — set GEMINI_API_KEY or LOVABLE_API_KEY", source: "attachment_analyze" };
  }

  const fetched = await fetchImageAsBase64(imageUrl, signal);
  if ("error" in fetched) {
    return { error: fetched.error, source: "attachment_analyze", image_url: imageUrl };
  }

  let vision = await geminiVisionAnalyze(fetched.base64, fetched.contentType, signal);
  if (!vision.ok && LOVABLE_API_KEY) {
    const dataUrl = `data:${fetched.contentType};base64,${fetched.base64}`;
    vision = await gatewayVisionAnalyze(dataUrl, signal);
  }
  if (!vision.ok) {
    return {
      ok: false,
      status: vision.status || undefined,
      error: vision.error,
      source: "attachment_analyze",
      image_url: imageUrl,
      content_type: fetched.contentType,
    };
  }

  const parsed = parseVisionJson(vision.text);
  if (!parsed) {
    return {
      ok: false,
      error: "attachment_analyze could not parse vision response",
      source: "attachment_analyze",
      image_url: imageUrl,
      raw: vision.text.slice(0, 4000),
    };
  }

  const entities = parsed.entities ?? {};
  for (const k of Object.keys(entities)) {
    if (!Array.isArray(entities[k])) delete entities[k];
  }

  const hasText = !!(parsed.extracted_text?.trim() || parsed.description?.trim());
  const hasEntities = Object.values(entities).some((v) => Array.isArray(v) && v.length > 0);

  return {
    ok: hasText || hasEntities,
    source: "attachment_analyze",
    image_url: imageUrl,
    content_type: fetched.contentType,
    description: parsed.description,
    extracted_text: parsed.extracted_text,
    entities,
    ...(hasText || hasEntities ? {} : { empty: true, error: "attachment_analyze: no readable text or selectors found in image" }),
  };
}

export const attachment_analyze = tool({
  description:
    "Vision OCR + image analysis for user-uploaded image attachments (signed storage URL). Extracts visible text and OSINT selectors (emails, phones, usernames, domains, IPs, names, addresses, wallets). Use when jina_reader_scrape cannot OCR an image attachment. ~$0.002/call.",
  inputSchema: z.object({
    image_url: z.string().url().describe("Signed HTTPS URL of the uploaded image (from the Attached files block)."),
    filename: z.string().optional().describe("Original filename for provenance in artifacts."),
  }),
  execute: async ({ image_url, filename }, opts) => {
    const signal = (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
    const result = await analyzeAttachmentImage(image_url, signal);
    if (filename) {
      return { ...result, filename };
    }
    return result;
  },
});
