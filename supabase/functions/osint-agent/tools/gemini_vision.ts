// tools/gemini_vision.ts
//
// Gemini multimodal read tool — the eyes MiniMax-M2.7 does not have. M2.7 is
// text-only; feeding it an image produces the live false-identity failure mode
// (a mugshot chained face→name to an unrelated person). This tool sends image or
// PDF-page bytes to Gemini Flash and returns STRUCTURED, LEAD-TIER observations
// so the orchestrator can reason about what a picture/document actually contains
// instead of recording a bare URL or guessing from surrounding text.
//
// These are LIVE runtime tool defs (AI-SDK `tool()`), imported and late-attached
// into buildTools() in tool-registry.ts — mirroring tools/indicia.ts. Gated on
// GEMINI_API_KEY in capabilities.ts (the readiness gate drops it from the schema
// on a keyless deploy) and classed `ai_summary` in source-classification.ts, so a
// single vision/document pass is capped ≤55 and can NEVER reach Confirmed.
//
// TWO MODES:
//   • image    → { visible_text, watermarks, handles, attributes, scene, confidence }
//                ATTRIBUTES ONLY for people — the source URL / watermark / @handle
//                is the anchor, never a face-derived identity. Set reverse_search
//                to also ask Gemini (google_search grounding) where the image
//                appears online.
//   • document → { extracted_text, tables, selectors, confidence }
//                This is what finally READS dork-harvested PDFs and uploaded docs
//                instead of recording the URL blind.
//
// OUTCOME CONTRACT (drives cache.ts classifyToolOutcome via the returned object):
//   • parsed result           → { ok:true, mode, ... }                    → ok
//   • key missing / no input  → { error:"...not configured" | "...no input"} → skipped
//   • non-2xx / parse failure → { ok:false, status?, error }              → failed
//   • network error / timeout → { error }                                 → failed
//
// Gemini-derived values are LEAD-TIER: tag provenance `inferred_from_vision`
// (image) / `extracted_from_document` (document) on every derived selector at the
// recording site. This file returns raw structured observations only; it does not
// and must not set confidence or touch minor-safety / chain-of-custody gates.

import { tool } from "npm:ai@6";
import { z } from "npm:zod@3";
import { geminiVision, type GeminiPart } from "../providers.ts";
import { assertSafeUrl } from "../safety.ts";

// Read the key at CALL time (not an import-time const). In prod the key is set
// before the isolate starts, so this equals the const; it also keeps the tool's
// behavior decoupled from module-load order (a test can set the key without
// polluting env.ts's boot-time fallback-provider selection for other modules).
const geminiKey = (): string | undefined => Deno.env.get("GEMINI_API_KEY");

// Gemini inline_data caps a single request near 20MB total; stay under it so a
// large scan/PDF fails fast with a clear message rather than a 400 from Google.
const MAX_VISION_BYTES = 18 * 1024 * 1024;
const VISION_FETCH_TIMEOUT_MS = 25_000;
// Bound the returned text so a huge PDF can't blow the orchestrator context.
const MAX_RETURN_TEXT = 8_000;

const IMAGE_MIME = /^image\/(png|jpe?g|gif|webp|bmp|heic|heif|avif)$/i;
const DOC_MIME = /^application\/pdf$/i;

/** Chunked base64 — avoids a call-stack overflow that a single spread over a
 *  multi-MB Uint8Array would hit. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function guessMime(pathname: string, mode: "image" | "document"): string {
  const ext = pathname.match(/\.([a-z0-9]{1,5})(?:$|\?|#)/i)?.[1]?.toLowerCase();
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", bmp: "image/bmp", heic: "image/heic", avif: "image/avif",
    pdf: "application/pdf",
  };
  return (ext && map[ext]) || (mode === "document" ? "application/pdf" : "image/jpeg");
}

type FetchBytesResult =
  | { ok: true; bytes: Uint8Array; mime: string }
  | { ok: false; error: string; status?: number };

/** Fetch attachment/URL bytes with an SSRF guard, size + time bounds, and a
 *  post-redirect host re-check — same shape as archiver.archiveAttachment. */
async function fetchBytes(
  url: string,
  mode: "image" | "document",
  signal: AbortSignal | undefined,
): Promise<FetchBytesResult> {
  let safe: URL;
  try {
    safe = assertSafeUrl(url);
  } catch (e) {
    return { ok: false, error: `unsafe or invalid url: ${e instanceof Error ? e.message : String(e)}` };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VISION_FETCH_TIMEOUT_MS);
  const onExt = () => ctrl.abort();
  if (signal) {
    if (signal.aborted) ctrl.abort();
    else signal.addEventListener("abort", onExt, { once: true });
  }
  try {
    const res = await fetch(safe.toString(), { redirect: "follow", signal: ctrl.signal });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, error: `fetch failed HTTP ${res.status}`, status: res.status };
    }
    // Re-validate the POST-redirect host against SSRF (a 30x could land on an
    // internal address). `res.url` is populated by the runtime on a real fetch;
    // guard on it so this doesn't misfire when it's empty (the input URL was
    // already validated above).
    if (res.url) {
      try { assertSafeUrl(res.url); } catch { return { ok: false, error: "unsafe redirect target" }; }
    }
    const ct = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength === 0) return { ok: false, error: "empty response body" };
    if (buf.byteLength > MAX_VISION_BYTES) {
      return { ok: false, error: `attachment too large (${buf.byteLength} bytes > ${MAX_VISION_BYTES})` };
    }
    return { ok: true, bytes: buf, mime: ct || guessMime(safe.pathname, mode) };
  } catch (err) {
    const isAbort = err instanceof DOMException && err.name === "AbortError";
    return { ok: false, error: isAbort ? "vision fetch timed out" : `vision fetch error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExt);
  }
}

/** Pull the first balanced {...} JSON object out of an LLM reply (it may wrap the
 *  JSON in prose or a ```json fence). Returns null if none parses. */
function extractJson(text: string): Record<string, unknown> | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text;
  const start = fenced.indexOf("{");
  const end = fenced.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(fenced.slice(start, end + 1));
    return obj && typeof obj === "object" ? obj as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const IMAGE_SYSTEM =
  "You are an OSINT image reader. Read ONLY what is literally visible; never infer or guess a person's identity from their face. Return STRICT JSON, no prose, with exactly these keys: " +
  '{"visible_text": string (all readable text/overlays/signage verbatim), ' +
  '"watermarks": string[] (site/source watermarks or stamps, e.g. "bustednewspaper.com"), ' +
  '"handles": string[] (any @handles, usernames, URLs, cashtags visible), ' +
  '"attributes": string[] (observable physical/scene attributes ONLY — apparent clothing, tattoos, setting, objects; NO identity, NO name), ' +
  '"scene": string (one-sentence description of what the image shows), ' +
  '"confidence": number 0-100 (how legible the extraction was)}. ' +
  "If a field has nothing, use an empty string or empty array. Do NOT fabricate.";

const DOC_SYSTEM =
  "You are an OSINT document reader. Extract the document's actual content. Return STRICT JSON, no prose, with exactly these keys: " +
  '{"extracted_text": string (the substantive text, trimmed of boilerplate), ' +
  '"tables": array (each table as an array of row objects or arrays; [] if none), ' +
  '"selectors": string[] (every email, @handle, username, phone number, and URL found in the document), ' +
  '"confidence": number 0-100 (extraction legibility)}. ' +
  "If the document is empty/unreadable, set confidence low and fields empty. Do NOT fabricate.";

interface GeminiVisionArgs {
  mode: "image" | "document";
  url?: string;
  base64?: string;
  mime_type?: string;
  reverse_search?: boolean;
  question?: string;
}

const getSignal = (opts: unknown): AbortSignal | undefined =>
  (opts as { abortSignal?: AbortSignal } | undefined)?.abortSignal;

/** Shared runtime: assemble parts, call Gemini, parse structured result. */
export async function runGeminiVision(
  args: GeminiVisionArgs,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const { mode, url, base64, mime_type, reverse_search, question } = args;
  if (!geminiKey()) {
    // Gated by capabilities.ts, so defensive only. "not configured" → skip.
    return { error: "GEMINI_API_KEY not configured", source: "gemini_vision", mode };
  }
  if (!url && !base64) {
    return { error: "gemini_vision: no input — provide a url or base64", source: "gemini_vision", mode };
  }

  let mime: string;
  let data: string;
  if (base64) {
    data = base64.replace(/^data:[^;]+;base64,/, "");
    mime = mime_type || (mode === "document" ? "application/pdf" : "image/jpeg");
  } else {
    const fetched = await fetchBytes(url!, mode, signal);
    if (!fetched.ok) {
      return { ok: false, status: fetched.status, source: "gemini_vision", mode, url, error: `gemini_vision ${fetched.error}` };
    }
    mime = mime_type || fetched.mime;
    data = toBase64(fetched.bytes);
  }

  // Sanity-gate the mime so we don't ship a text/html error page to Gemini as an
  // "image". Fall back to the mode default when a signed-URL host omits it.
  if (mode === "image" && !IMAGE_MIME.test(mime)) mime = "image/jpeg";
  if (mode === "document" && !DOC_MIME.test(mime) && !IMAGE_MIME.test(mime)) mime = "application/pdf";

  const instruction = mode === "image"
    ? `Read this image.${question ? ` Focus: ${question}.` : ""}${reverse_search ? " Also use search to report where this exact image appears online, if anywhere, and cite the URLs." : ""}`
    : `Read this document and extract its content.${question ? ` Focus: ${question}.` : ""}`;

  const parts: GeminiPart[] = [
    { text: instruction },
    { inline_data: { mime_type: mime, data } },
  ];

  const res = await geminiVision({
    parts,
    system: mode === "image" ? IMAGE_SYSTEM : DOC_SYSTEM,
    useGrounding: mode === "image" && !!reverse_search,
    signal,
  });

  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      source: "gemini_vision",
      mode,
      url,
      error: `gemini_vision ${mode} failed (HTTP ${res.status})`,
      detail: String((res.raw as { error?: { message?: unknown } })?.error?.message ?? "").slice(0, 300),
    };
  }

  const parsed = extractJson(res.text);
  if (!parsed) {
    return {
      ok: false,
      status: res.status,
      source: "gemini_vision",
      mode,
      url,
      error: "gemini_vision: model returned no parseable JSON",
      raw_text: res.text.slice(0, 1200),
    };
  }

  // Trim any giant text field so the tool result can't blow the context window.
  for (const k of ["visible_text", "extracted_text"]) {
    if (typeof parsed[k] === "string" && (parsed[k] as string).length > MAX_RETURN_TEXT) {
      parsed[k] = (parsed[k] as string).slice(0, MAX_RETURN_TEXT);
      parsed[`${k}_truncated`] = true;
    }
  }

  return {
    ok: true,
    source: "gemini_vision",
    mode,
    ...(url ? { url } : {}),
    // Lead-tier provenance tag — the recording site stamps this onto every
    // derived selector; a single vision pass is never Confirmed.
    provenance: mode === "image" ? "inferred_from_vision" : "extracted_from_document",
    result: parsed,
    ...(res.citations.length ? { reverse_search_citations: res.citations.slice(0, 20) } : {}),
    ...(res.queries.length ? { reverse_search_queries: res.queries } : {}),
  };
}

export const gemini_vision = tool({
  description:
    "READ an image or document with Gemini Flash (multimodal) — the orchestrator is text-only and CANNOT see images, so route any uploaded/harvested image or PDF here BEFORE reasoning about identity. mode='image' returns {visible_text, watermarks, handles, attributes, scene, confidence} (attributes only — never a face-derived identity; the watermark/@handle/source URL is the anchor). Set reverse_search=true to also find where the image appears online. mode='document' returns {extracted_text, tables, selectors, confidence} — use it to actually READ a dork-harvested or uploaded PDF instead of recording a bare URL. Pass a fully-qualified url (signed storage URLs work) OR base64. Results are LEAD-TIER (capped ≤55, never Confirmed on a single pass). ~$0.002/call.",
  inputSchema: z.object({
    mode: z.enum(["image", "document"]).describe("image → visual attributes/watermarks/handles; document → text/tables/selectors."),
    url: z.string().url().optional().describe("Fully-qualified http(s) URL to the image/PDF (signed storage URLs are fine)."),
    base64: z.string().optional().describe("Base64 (or data: URI) of the file, as an alternative to url."),
    mime_type: z.string().optional().describe("MIME type override, e.g. 'image/png' or 'application/pdf'."),
    reverse_search: z.boolean().optional().describe("Image mode only: also ask Gemini (Google Search grounding) where the image appears online."),
    question: z.string().optional().describe("Optional extra focus, e.g. 'read the booking sheet header' or 'extract the contact table'."),
  }),
  execute: async (args, opts) => runGeminiVision(args as GeminiVisionArgs, getSignal(opts)),
});
