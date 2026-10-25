/**
 * The case's own name, when it says more than the selector does. A blank,
 * placeholder or selector-echo title returns null, and the header falls back to
 * the selector as its heading.
 */
export function humanCaseName(title: string | null, seedValue: string | null, seedDisplay: string): string | null {
  const t = (title ?? "").trim();
  if (!t || /^(new investigation|investigation|untitled)$/i.test(t)) return null;
  const norm = (s: string | null) => (s ?? "").trim().toLowerCase();
  if (norm(t) === norm(seedValue) || norm(t) === norm(seedDisplay)) return null;
  return t;
}
