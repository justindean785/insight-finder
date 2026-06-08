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
