// lib/attachment-seed.ts — keep the composer's "Attached files:" block out of the case
// title and seed.
//
// MEASURED (handoff 2026-11-08 §5; NEXT_SESSION_PROMPT.md): auth.ts wrote the whole
// joined text of the first user message into `threads.title` (80 chars) and
// `threads.seed_value` (200 chars). When that message carries an upload, both columns
// held raw markdown with a 7-day SIGNED STORAGE URL cut part-way through, so the
// token sat in the database and the case header read "<email> Attached files: -
// [<file>…". And a typed seed above the block was never detected as a seed: the
// detector saw the whole multi-line text and fell back to `other`.
//
// Now the block is split off before the title and seed are derived:
//   - typed text + block  → title and seed come from the typed text only;
//   - block only          → title "Attachment: <first file name>" (+ " +N more"),
//                           seed_value "" (never a URL), seed type detected exactly
//                           as before, so the run's prompt is unchanged for that case;
//   - no block            → byte-identical to before.
// The frontend already treats an empty or attachment-only seed as "no subject"
// (src/lib/set-subject.ts `caseLacksSubject`), so the new stored shape is compatible.
//
// Kill switch, read at CALL TIME: ATTACHMENT_SEED_STRIP_DISABLED=true restores the old
// derivation exactly. Pure apart from that one env read.
import { ATTACHMENT_MARKER, parseAttachments, type ParsedAttachment } from "../attachment-intake.ts";
import { formatThreadTitle, THREAD_TITLE_MAX, type DetectedSeed } from "../validation.ts";

export const SEED_VALUE_MAX = 200;

export function attachmentSeedStripDisabled(
  env: (k: string) => string | undefined = (k) => {
    try {
      return Deno.env.get(k);
    } catch {
      return undefined;
    }
  },
): boolean {
  return (env("ATTACHMENT_SEED_STRIP_DISABLED") ?? "").trim().toLowerCase() === "true";
}

/** The typed part of a message and the parsed upload block, if the composer's block is present. */
export function splitAttachmentBlock(text: string): { typed: string; attachments: ParsedAttachment[] } {
  const raw = text ?? "";
  const i = raw.indexOf(ATTACHMENT_MARKER);
  if (i === -1) return { typed: raw.trim(), attachments: [] };
  const attachments = parseAttachments(raw);
  // The marker words with no parseable "- [name](url)" line are not the composer's
  // block — maybe the analyst typed them. Leave the text alone.
  if (attachments.length === 0) return { typed: raw.trim(), attachments: [] };
  return { typed: raw.slice(0, i).trim(), attachments };
}

/** "Attachment: <first name>" (+ " +N more"), within the title limit. No URL, ever. */
export function attachmentTitle(attachments: readonly ParsedAttachment[]): string {
  const first = (attachments[0]?.name ?? "file").replace(/\s+/g, " ").trim() || "file";
  const more = attachments.length > 1 ? ` +${attachments.length - 1} more` : "";
  const head = "Attachment: ";
  const room = Math.max(1, THREAD_TITLE_MAX - head.length - more.length);
  return `${head}${first.length > room ? first.slice(0, room - 1) + "…" : first}${more}`;
}

export interface ThreadSeedFields {
  title: string;
  seed_value: string;
  detected: DetectedSeed | null;
  /** Which path produced the fields — for the /health self-test and tests, never logged with values. */
  path: "legacy" | "no_attachment" | "typed_with_attachment" | "attachment_only";
}

/**
 * The title, seed text and detected seed for a thread's first user message.
 * `detect` is the caller's detector (detectSeedServer, or `() => null` when the thread
 * already has a title and the update is a no-op anyway).
 */
export function deriveThreadSeed(
  text: string,
  detect: (t: string) => DetectedSeed | null,
  disabled: boolean = attachmentSeedStripDisabled(),
): ThreadSeedFields {
  const legacy = (): ThreadSeedFields => {
    const detected = detect(text);
    return { title: formatThreadTitle(text, detected), seed_value: text.slice(0, SEED_VALUE_MAX), detected, path: "legacy" };
  };
  if (disabled) return legacy();
  const { typed, attachments } = splitAttachmentBlock(text);
  if (attachments.length === 0) return { ...legacy(), path: "no_attachment" };
  if (typed) {
    const detected = detect(typed);
    return {
      title: formatThreadTitle(typed, detected),
      seed_value: typed.slice(0, SEED_VALUE_MAX),
      detected,
      path: "typed_with_attachment",
    };
  }
  // Upload only. The seed TYPE is detected exactly as before (the run's prompt is
  // unchanged); only the stored title and seed text stop carrying the block.
  return { title: attachmentTitle(attachments), seed_value: "", detected: detect(text), path: "attachment_only" };
}

/** /health self-test on synthetic messages: no URL or token survives into a title or seed. Pure. */
export function attachmentSeedSelfTest(
  detect: (t: string) => DetectedSeed | null,
): { ok: boolean; switch: string; detail: string } {
  const sw = "ATTACHMENT_SEED_STRIP_DISABLED";
  if (attachmentSeedStripDisabled()) return { ok: true, switch: sw, detail: `LEGACY via ${sw}` };
  const url = "https://storage.example.test/object/sign/uploads/selftest.pdf?token=SELFTEST.TOKEN.VALUE";
  const block = `${ATTACHMENT_MARKER}\n- [selftest.pdf](${url}) (1.2 KB, application/pdf)`;
  const only = deriveThreadSeed(block, detect, false);
  const typed = deriveThreadSeed(`subject@example.com\n\n${block}`, detect, false);
  const leaks = (f: ThreadSeedFields) => /token=|\/object\/sign\/|https?:\/\//i.test(f.title + " " + f.seed_value);
  const ok = !leaks(only) && !leaks(typed) && only.title === "Attachment: selftest.pdf" && only.seed_value === "" &&
    typed.seed_value === "subject@example.com" && typed.detected?.kind === "email";
  return {
    ok,
    switch: sw,
    detail: ok
      ? "upload-only messages title as 'Attachment: <file>' with an empty seed; typed text above an upload is the seed; no URL or token is stored"
      : `onlyTitle=${JSON.stringify(only.title.slice(0, 40))} onlySeedEmpty=${only.seed_value === ""} typedKind=${typed.detected?.kind ?? "none"} leaks=${leaks(only) || leaks(typed)}`,
  };
}
