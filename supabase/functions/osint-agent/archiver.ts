/**
 * archiver.ts — Exa result trimming and attachment archiving.
 * Extracted from index.ts (lines 134–161 and 737–803).
 */

import { createClient } from "npm:@supabase/supabase-js@2";
import { assertSafeUrl } from "./safety.ts";

// ---- Exa result trimming -------------------------------------------------------
// Strip Exa response payloads to the fields the orchestrator actually reasons
// over. Full Exa responses include large `text` blobs, raw HTML metadata, and
// per-result subResults that bloat the context window without improving
// downstream synthesis.
export function trimExaResults(data: unknown): unknown {
  const d = data as Record<string, unknown> | null;
  if (!d || typeof d !== "object") return data;
  const rs = Array.isArray((d as any).results) ? (d as any).results : null;
  if (!rs) return d;
  const trimmed = rs.slice(0, 25).map((r: any) => {
    const text = typeof r?.text === "string" ? r.text.slice(0, 1500) : undefined;
    const summary = typeof r?.summary === "string" ? r.summary.slice(0, 600) : undefined;
    const highlights = Array.isArray(r?.highlights)
      ? r.highlights.slice(0, 4).map((h: string) => String(h).slice(0, 280))
      : undefined;
    return {
      url: r?.url,
      title: r?.title,
      author: r?.author,
      publishedDate: r?.publishedDate,
      score: r?.score,
      ...(summary ? { summary } : {}),
      ...(highlights?.length ? { highlights } : {}),
      ...(text ? { text } : {}),
    };
  });
  return { results: trimmed, requestId: (d as any).requestId, autopromptString: (d as any).autopromptString };
}

// ---- Attachment archiving ------------------------------------------------------
// Pull a non-HTML source_url, SHA-256 it, and stash in the private
// `evidence-archive` bucket. Best-effort: failures never throw.
// Returns archival metadata on success, or null on skip / failure.

export const ARCHIVE_MAX_BYTES = 25 * 1024 * 1024;
export const ARCHIVE_OK_TYPES = /^(image\/|application\/(pdf|zip|x-zip-compressed|json|xml|octet-stream|vnd\.|msword|x-)|audio\/|video\/|text\/(csv|plain|xml))/i;
export const ARCHIVE_SKIP_TYPES = /^(text\/html|application\/xhtml)/i;

export function extFromContentType(ct: string, url: string): string {
  const fromUrl = url.match(/\.([a-z0-9]{1,6})(?:\?|#|$)/i)?.[1]?.toLowerCase();
  if (fromUrl) return fromUrl;
  const m = ct.split(";")[0].trim().toLowerCase();
  const map: Record<string, string> = {
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif",
    "application/pdf": "pdf", "application/zip": "zip", "application/json": "json",
  };
  return map[m] ?? "bin";
}

export async function archiveAttachment(
  supabaseAdmin: ReturnType<typeof createClient>,
  threadId: string,
  userId: string,
  sourceUrl: string | null,
): Promise<{ path: string; sha256: string; bytes: number; content_type: string } | null> {
  if (!sourceUrl) return null;
  try {
    const safe = assertSafeUrl(sourceUrl);
    // HEAD first to gate type + size
    let ct = "application/octet-stream";
    let size = 0;
    try {
      const head = await fetch(safe.toString(), { method: "HEAD", redirect: "follow" });
      if (!head.ok) return null;
      ct = head.headers.get("content-type") ?? ct;
      size = Number(head.headers.get("content-length") ?? "0");
      if (ARCHIVE_SKIP_TYPES.test(ct)) return null;
      if (size > ARCHIVE_MAX_BYTES) return null;
    } catch {
      // some servers don't support HEAD; fall through to GET with size guard
    }
    const res = await fetch(safe.toString(), { redirect: "follow" });
    if (!res.ok) return null;
    // Re-validate post-redirect host
    try { assertSafeUrl(res.url); } catch { return null; }
    ct = res.headers.get("content-type") ?? ct;
    if (ARCHIVE_SKIP_TYPES.test(ct)) return null;
    if (!ARCHIVE_OK_TYPES.test(ct)) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > ARCHIVE_MAX_BYTES || buf.byteLength === 0) return null;
    const digest = await crypto.subtle.digest("SHA-256", buf);
    const sha256 = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
    const ext = extFromContentType(ct, safe.pathname);
    const path = `${userId}/${threadId}/${sha256}.${ext}`;
    const { error: upErr } = await supabaseAdmin.storage
      .from("evidence-archive")
      .upload(path, buf, { contentType: ct, upsert: true });
    if (upErr) {
      console.warn("[archiveAttachment] upload failed:", upErr.message);
      return null;
    }
    return { path, sha256, bytes: buf.byteLength, content_type: ct };
  } catch (e) {
    console.warn("[archiveAttachment] error:", (e as Error).message);
    return null;
  }
}