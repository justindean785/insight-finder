// attachment-block.ts — the composer's "Attached files:" block, and the case seed
// that is left when it is taken off a first message.
//
// PURE: no network, no Gemini, no Supabase. `attachment-intake.ts` re-exports the
// parser from here, so `auth.ts` and `/health` can use it without pulling the
// vision tooling into their import graph.
//
// WHY THIS EXISTS. The composer appends
//
//     Attached files:
//     - [name](signed-url) (mime, size)
//
// to the analyst's text. The edge used to store and classify that whole string as
// the case seed, so an upload-started case got `seed_type = "other"`, a title and
// `seed_value` holding a signed storage URL cut off mid-token, and a run that never
// saw the typed name/email as its seed. The seed is what the analyst TYPED; an
// upload is evidence, not a selector.
//
// KILL SWITCH (read at call time): ATTACHMENT_SEED_STRIP_DISABLED=true makes
// `splitSeedText` a pass-through, which restores the old stored values and the old
// run-time seed byte-for-byte at every call site at once.
import { detectSeedServer, formatThreadTitle, THREAD_TITLE_MAX } from "../validation.ts";

export const ATTACHMENT_MARKER = "Attached files:";
// - [name](url) (meta)   — Supabase signed URLs are base64url, so they carry no ')'.
const LINE_RE = /^\s*-\s*\[(.+?)\]\((.+?)\)\s*(?:\((.*)\))?\s*$/;

export interface ParsedAttachment { name: string; url: string; meta: string }

/** Split the composer's "Attached files:" block off a user message body. */
export function parseAttachments(text: string): ParsedAttachment[] {
  const i = text.indexOf(ATTACHMENT_MARKER);
  if (i === -1) return [];
  const out: ParsedAttachment[] = [];
  for (const line of text.slice(i + ATTACHMENT_MARKER.length).split("\n")) {
    const m = line.match(LINE_RE);
    if (m) out.push({ name: m[1].trim(), url: m[2].trim(), meta: (m[3] ?? "").trim() });
  }
  return out;
}

export function attachmentSeedStripDisabled(): boolean {
  return Deno.env.get("ATTACHMENT_SEED_STRIP_DISABLED") === "true";
}

export interface SeedText {
  /** What the analyst typed, with the attachment block removed. "" for an upload-only message. */
  typed: string;
  /** The attachments named in the block; empty when there is no block to strip. */
  attachments: ParsedAttachment[];
}

/**
 * Separate the analyst's typed text from the composer's attachment block.
 *
 * Contract (pinned by supabase/tests/osint-agent/attachment_seed_test.ts):
 *  - kill switch on                       → { typed: text, attachments: [] }  (pass-through)
 *  - no marker, or a marker with NO parseable attachment line (prose that merely
 *    contains the words)                  → { typed: text, attachments: [] }  (untouched)
 *  - marker + ≥1 attachment               → typed = the text before the block, trimmed
 */
export function splitSeedText(text: string): SeedText {
  const untouched: SeedText = { typed: text, attachments: [] };
  if (attachmentSeedStripDisabled()) return untouched;
  const attachments = parseAttachments(text);
  if (attachments.length === 0) return untouched;
  // Cut at the FIRST marker, the same place `parseAttachments` starts reading, so
  // "where the block begins" has one definition.
  return { typed: text.slice(0, text.indexOf(ATTACHMENT_MARKER)).trim(), attachments };
}

/** "Attachment: scan.pdf" / "Attachment: scan.pdf +2" — never a URL. */
export function attachmentTitle(names: readonly string[]): string {
  const first = names[0] ?? "file";
  const more = names.length > 1 ? ` +${names.length - 1}` : "";
  const prefix = "Attachment: ";
  return `${prefix}${first.slice(0, THREAD_TITLE_MAX - prefix.length - more.length)}${more}`;
}

export interface DerivedThreadSeed {
  title: string;
  /** Stored in threads.seed_value. "" for an upload-only message — never a URL. */
  seedValue: string;
  /** The classified seed; null when `classify` is false (the thread already has a title). */
  detected: ReturnType<typeof detectSeedServer>;
}

/**
 * What `auth.ts` stores for a thread's first message.
 *
 * `classify` mirrors the caller's "is this still a New investigation?" check: when
 * false, nothing is classified and the title is the plain truncated text, exactly
 * as before.
 */
export function deriveThreadSeed(text: string, opts: { classify: boolean }): DerivedThreadSeed {
  const { typed, attachments } = splitSeedText(text);
  if (attachments.length > 0 && typed === "") {
    // Upload-only: a title that names the file, an EMPTY seed, and the same
    // `other` routing these cases have always had.
    return {
      title: attachmentTitle(attachments.map((a) => a.name)),
      seedValue: "",
      detected: opts.classify ? { kind: "other", raw: "", normalized: "" } : null,
    };
  }
  const detected = opts.classify ? detectSeedServer(typed) : null;
  return { title: formatThreadTitle(typed, detected), seedValue: typed.slice(0, 200), detected };
}

/** True when the first message carried at least one attachment (and the strip is live). */
export function hasSeedAttachments(text: string): boolean {
  return splitSeedText(text).attachments.length > 0;
}

/** `/health` proof key `checks.attachment_seed`. Synthetic values only. */
export function attachmentSeedSelfTest(): { ok: boolean; detail: string } {
  if (attachmentSeedStripDisabled()) return { ok: true, detail: "LEGACY via ATTACHMENT_SEED_STRIP_DISABLED" };
  const block =
    "Attached files:\n- [scan.pdf](https://storage.example.com/storage/v1/object/sign/chat-uploads/a.pdf?token=SYNTHETIC) (application/pdf, 1 MB)";
  const leaks = (s: string) => /token=|\/object\/sign\/|https?:\/\//i.test(s);
  const uploadOnly = deriveThreadSeed(block, { classify: true });
  const named = deriveThreadSeed(`Jordan Example\n\n${block}`, { classify: true });
  const wrong: string[] = [];
  if (uploadOnly.seedValue !== "" || leaks(uploadOnly.title)) wrong.push("upload-only");
  if (uploadOnly.title !== "Attachment: scan.pdf") wrong.push("upload-only title");
  if (named.detected?.kind !== "person" || leaks(named.seedValue) || leaks(named.title)) wrong.push("typed+upload");
  return wrong.length
    ? { ok: false, detail: `wrong: ${wrong.join(" | ")}` }
    : { ok: true, detail: "seed is the typed text; upload-only stores an empty seed; no URL in title or seed" };
}
