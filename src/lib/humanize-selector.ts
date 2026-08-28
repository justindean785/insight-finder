/**
 * Render a tool's selector as something an analyst reads, not as plumbing.
 *
 * When the seed is an uploaded file the selector is the SIGNED STORAGE URL,
 * which printed in full across two lines of the transcript:
 *
 *   https://<project>.supabase.co/storage/v1/object/sign/chat-uploads/
 *   <thread-uuid>/<msg-uuid>/1787738666550-jl6n4g-oathnet_export_….json
 *
 * — directly beneath the attachment chip that already names the file and its
 * size. So the row said the same thing twice, once unreadably, and put a signed
 * bucket path into a surface that gets screenshotted and pasted into reports.
 *
 * Uploads carry a `<epoch>-<nonce>-` prefix from the upload path; strip it so
 * the original filename is what shows.
 */
export function humanizeSelector(selector: string): string {
  if (!/^https?:\/\//i.test(selector)) return selector;
  let path: string;
  try {
    path = new URL(selector).pathname;
  } catch {
    return selector;
  }
  // Only collapse OUR upload paths. An arbitrary URL a tool was pointed at is
  // itself the selector and must stay legible as one. Checked BEFORE decoding,
  // so a foreign URL is never put through a decode it does not need.
  if (!selector.includes("/chat-uploads/")) return selector;
  const raw = path.split("/").filter(Boolean).pop() ?? "";
  if (!raw) return selector;
  // `new URL()` happily accepts a malformed percent sequence in the path — it
  // is `decodeURIComponent` that throws URIError on it (verified: "/a%",
  // "/%zz.json", "/%E0%A4%A" all parse and all throw). This runs during render
  // of a transcript row, so an unguarded throw takes the whole thread view
  // down over a cosmetic filename tidy-up. Fall back to the raw segment.
  let last: string;
  try {
    last = decodeURIComponent(raw);
  } catch {
    last = raw;
  }
  return last.replace(/^\d{10,}-[a-z0-9]+-/i, "") || last;
}
