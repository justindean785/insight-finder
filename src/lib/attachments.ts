/**
 * attachments.ts — pure parsing of the "Attached files:" block that the
 * composer appends to a user message.
 *
 * User messages are rendered as plain text, so the raw markdown
 *   Attached files:
 *   - [name](signed-url) (type, size)
 * was showing the full Supabase signed URL (token and all) instead of the file.
 * This splits the human text from the attachments so the UI can render image
 * previews / file chips and never display the raw URL.
 */

export interface ParsedAttachment {
  name: string;
  url: string;
  /** e.g. "image/png, 1.2 MB" */
  meta: string;
}

export interface ParsedUserMessage {
  body: string;
  attachments: ParsedAttachment[];
}

const MARKER = "Attached files:";
// - [name](url) (meta)   — url has no ')' (Supabase signed URLs are base64url)
const LINE_RE = /^\s*-\s*\[(.+?)\]\((.+?)\)\s*(?:\((.*)\))?\s*$/;
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic)(?:\?|$)/i;

export function parseUserMessage(text: string): ParsedUserMessage {
  const i = text.indexOf(MARKER);
  if (i === -1) return { body: text, attachments: [] };
  const body = text.slice(0, i).replace(/\s+$/, "");
  const attachments: ParsedAttachment[] = [];
  for (const line of text.slice(i + MARKER.length).split("\n")) {
    const m = line.match(LINE_RE);
    if (m) attachments.push({ name: m[1].trim(), url: m[2].trim(), meta: (m[3] ?? "").trim() });
  }
  return { body, attachments };
}

export function isImageAttachment(a: ParsedAttachment): boolean {
  return IMAGE_EXT.test(a.name) || /image\//i.test(a.meta);
}

/**
 * The filenames of a message that is NOTHING but an "Attached files:" block —
 * null when the analyst typed text first, or when no file is named.
 *
 * Lenient on purpose: the edge stores a thread's `title` as the first 80 chars
 * and `seed_value` as the first 200, both of which cut a signed storage URL off
 * before its closing `)`, so `LINE_RE` above never matches the stored values.
 * Only the `[name](` prefix is required.
 */
export function attachmentOnlyNames(text: string | null | undefined): string[] | null {
  const raw = (text ?? "").trim();
  if (!raw.startsWith(MARKER)) return null;
  const names = [...raw.slice(MARKER.length).matchAll(/^\s*-\s*\[([^\]\n]+)\]\(/gm)].map((m) => m[1].trim()).filter(Boolean);
  return names.length > 0 ? names : null;
}

/** "scan.pdf" / "scan.pdf +2" — a short label for an attachment-only case. */
export function attachmentLabel(names: readonly string[]): string {
  return names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0];
}
