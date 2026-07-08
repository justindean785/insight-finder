// attachment-intake.ts — read uploaded images/PDFs BEFORE identity reasoning.
//
// The orchestrator (MiniMax-M2.7) is TEXT-ONLY. An uploaded mugshot or PDF was
// previously recorded as a bare URL and never read, so the model reasoned about
// a picture it could not see — the live false-identity failure. This module runs
// at intake, deterministically, before the streamText loop:
//   1. parse the "Attached files:" block the composer appends to the user message,
//   2. route each image/PDF through gemini_vision (image vs document mode),
//   3. record extracted watermarks/handles/selectors as LEAD-TIER artifacts
//      (ai_summary class, provenance inferred_from_vision / extracted_from_document),
//   4. return a concise text summary the caller injects into the system prompt so
//      the text-only model finally "sees" what the attachment contained.
//
// Best-effort: every failure is swallowed (never blocks the investigation). It
// does NOT assert identity from a face — attributes only — and records only
// public anchors (source watermark, @handle, document selectors).

import type { UIMessage } from "npm:ai@6";
import { runGeminiVision } from "./tools/gemini_vision.ts";
import { buildAutoRecordedRow } from "./auto-record-integrity.ts";
import { scrubArtifactRows } from "./safety.ts";
import { GEMINI_API_KEY } from "./env.ts";

const MARKER = "Attached files:";
// - [name](url) (meta)   — Supabase signed URLs are base64url, so they carry no ')'.
const LINE_RE = /^\s*-\s*\[(.+?)\]\((.+?)\)\s*(?:\((.*)\))?\s*$/;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|heif)(?:\?|$)/i;
const PDF_EXT = /\.pdf(?:\?|$)/i;
const DOC_EXT = /\.(pdf|docx?|pptx?|xlsx?|csv|txt|rtf)(?:\?|$)/i;

export interface ParsedAttachment { name: string; url: string; meta: string }

/** Split the composer's "Attached files:" block off a user message body. */
export function parseAttachments(text: string): ParsedAttachment[] {
  const i = text.indexOf(MARKER);
  if (i === -1) return [];
  const out: ParsedAttachment[] = [];
  for (const line of text.slice(i + MARKER.length).split("\n")) {
    const m = line.match(LINE_RE);
    if (m) out.push({ name: m[1].trim(), url: m[2].trim(), meta: (m[3] ?? "").trim() });
  }
  return out;
}

export function isImageAttachment(a: ParsedAttachment): boolean {
  return IMAGE_EXT.test(a.name) || IMAGE_EXT.test(a.url) || /image\//i.test(a.meta);
}
export function isDocAttachment(a: ParsedAttachment): boolean {
  return DOC_EXT.test(a.name) || DOC_EXT.test(a.url) || /(pdf|word|excel|document|text\/)/i.test(a.meta);
}

/** Concatenate a user message's text parts (mirror extractManualOverrideSelector). */
export function messageText(msg: UIMessage | undefined): string {
  if (!msg || !Array.isArray(msg.parts)) return "";
  return msg.parts
    .filter((p): p is { type: "text"; text: string } => p?.type === "text" && typeof (p as { text?: unknown }).text === "string")
    .map((p) => p.text)
    .join("\n");
}

/** Classify a document selector string into an artifact kind. */
function selectorKind(s: string): { kind: string; value: string } | null {
  const v = s.trim();
  if (!v) return null;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { kind: "email", value: v.toLowerCase() };
  if (/^https?:\/\/\S+$/i.test(v)) return { kind: "url", value: v };
  if (/^@?[a-z0-9._-]{3,30}$/i.test(v) && /[a-z]/i.test(v) && !/^\+?\d/.test(v)) return { kind: "username", value: v.replace(/^@/, "") };
  const digits = v.replace(/[^\d]/g, "");
  if (digits.length >= 10 && digits.length <= 15 && /^[\d\s()+.-]+$/.test(v)) return { kind: "phone", value: v };
  return null;
}

/** A watermark that looks like a source domain (e.g. "bustednewspaper.com"). */
function domainLike(s: string): string | null {
  const m = s.trim().toLowerCase().match(/([a-z0-9-]+\.)+[a-z]{2,}/);
  return m ? m[0] : null;
}

interface IntakeDeps {
  // Structural, PromiseLike shape so the real SupabaseClient (whose .insert()
  // returns a thenable PostgrestFilterBuilder, not a plain Promise) is accepted.
  supabase: { from: (t: string) => { insert: (rows: unknown[]) => PromiseLike<{ error: { message?: string } | null }> } };
  userId: string;
  threadId: string;
  bumpArtifacts?: (n: number, kinds: string[]) => void;
}

export interface AttachmentIntakeResult {
  ran: boolean;
  attachments_read: number;
  artifacts_inserted: number;
  /** Human/model-readable summary to inject into the system prompt. */
  summary: string;
}

const MAX_ATTACHMENTS = 4; // bound latency/cost — a run rarely uploads more.

/**
 * Read the latest user message's image/PDF attachments through Gemini and record
 * lead-tier artifacts. Returns a summary for the caller to inject into context.
 * Never throws.
 */
export async function runAttachmentIntake(
  messages: UIMessage[],
  deps: IntakeDeps,
): Promise<AttachmentIntakeResult> {
  const empty: AttachmentIntakeResult = { ran: false, attachments_read: 0, artifacts_inserted: 0, summary: "" };
  if (!GEMINI_API_KEY) return empty; // no eyes without a key — stay silent, no phantom reads
  try {
    const latestUser = [...messages].reverse().find((m) => m.role === "user");
    const atts = parseAttachments(messageText(latestUser)).filter((a) => isImageAttachment(a) || isDocAttachment(a));
    if (atts.length === 0) return empty;

    const rows: Array<Record<string, unknown>> = [];
    const summaries: string[] = [];
    let read = 0;

    for (const a of atts.slice(0, MAX_ATTACHMENTS)) {
      const isImg = isImageAttachment(a) && !PDF_EXT.test(a.name) && !PDF_EXT.test(a.url);
      const mode = isImg ? "image" as const : "document" as const;
      const vis = await runGeminiVision({ mode, url: a.url, reverse_search: false }, undefined);
      if (!vis?.ok || !vis.result || typeof vis.result !== "object") continue;
      read++;
      const res = vis.result as Record<string, unknown>;

      if (mode === "image") {
        const watermarks = Array.isArray(res.watermarks) ? (res.watermarks as unknown[]).map(String) : [];
        const handles = Array.isArray(res.handles) ? (res.handles as unknown[]).map(String) : [];
        const attributes = Array.isArray(res.attributes) ? (res.attributes as unknown[]).map(String) : [];
        const scene = typeof res.scene === "string" ? res.scene : "";
        // Record source watermarks (domain-like) and public handles as leads.
        for (const w of watermarks) {
          const dom = domainLike(w);
          if (dom) rows.push(mkRow(deps, "domain", dom, a, "inferred_from_vision", { watermark: w }));
        }
        for (const h of handles) {
          const sk = selectorKind(h);
          if (sk) rows.push(mkRow(deps, sk.kind, sk.value, a, "inferred_from_vision", { from_image: a.name }));
        }
        summaries.push(
          `IMAGE "${a.name}" (read by Gemini vision — ATTRIBUTES ONLY, not an identity): ` +
          `scene: ${scene || "n/a"}; attributes: ${attributes.slice(0, 8).join(", ") || "none"}; ` +
          `watermarks: ${watermarks.join(", ") || "none"}; handles: ${handles.join(", ") || "none"}. ` +
          `Treat any watermark/handle as the SEED to pivot on; never assert a name from the face.`,
        );
      } else {
        const selectors = Array.isArray(res.selectors) ? (res.selectors as unknown[]).map(String) : [];
        const extracted = typeof res.extracted_text === "string" ? res.extracted_text : "";
        for (const s of selectors) {
          const sk = selectorKind(s);
          if (sk) rows.push(mkRow(deps, sk.kind, sk.value, a, "extracted_from_document", { from_document: a.name }));
        }
        summaries.push(
          `DOCUMENT "${a.name}" (read by Gemini — extracted text/selectors): ` +
          `selectors: ${selectors.slice(0, 15).join(", ") || "none"}. ` +
          `Excerpt: ${extracted.slice(0, 600)}${extracted.length > 600 ? "…" : ""}`,
        );
      }
    }

    let inserted = 0;
    if (rows.length) {
      const safeRows = scrubArtifactRows(rows);
      const { error } = await deps.supabase.from("artifacts").insert(safeRows);
      if (!error) {
        inserted = safeRows.length;
        deps.bumpArtifacts?.(safeRows.length, safeRows.map((r) => String((r as { kind?: unknown }).kind)));
      }
    }

    if (read === 0) return empty;
    const summary =
      `\n\n## Attachment intake (read before reasoning)\n` +
      `${read} uploaded file(s) were read by Gemini vision/document mode and any anchors recorded as LEAD-TIER artifacts (never Confirmed on one pass). ` +
      `You (the orchestrator) cannot see images directly — rely on this extraction:\n- ` +
      summaries.join("\n- ");
    return { ran: true, attachments_read: read, artifacts_inserted: inserted, summary };
  } catch (e) {
    console.warn("[attachment-intake] error:", (e as Error).message);
    return empty;
  }
}

function mkRow(
  deps: IntakeDeps,
  kind: string,
  value: string,
  a: ParsedAttachment,
  provenance: "inferred_from_vision" | "extracted_from_document",
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const built = buildAutoRecordedRow({
    kind,
    value,
    source: "gemini_vision",
    rawConfidence: 50, // lead tier; ai_summary cap (55) applies server-side too
    metadata: {
      provenance,
      attachment_name: a.name,
      discovered_via: provenance === "inferred_from_vision" ? "gemini_vision (image)" : "gemini_vision (document)",
      ...extra,
    },
  });
  return { thread_id: deps.threadId, user_id: deps.userId, ...built };
}
