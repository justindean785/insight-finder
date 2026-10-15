/**
 * case-label.ts — a one-line label for a case in dense tables.
 *
 * `threads.title` is often the analyst's raw first message: a pasted report
 * ("=== OATHNET INTELLIGENCE === Found via oathnet… Date: …") or an upload
 * ("Attached files: - [export_x.json](https://…supabase.co/storage/…)"). Printed
 * verbatim in a narrow column, the storage URL ran across the number columns
 * (Intelligence → Per-case breakdown, measured 2026-10-15). This shortens the
 * DISPLAY only; the stored title is untouched and stays the link's tooltip.
 */
export function caseDisplayLabel(title: string | null | undefined, seed?: string | null): string {
  let t = (title ?? "").replace(/\s+/g, " ").trim();
  if (!t) return (seed ?? "").trim() || "Untitled case";
  // Markdown links → their visible text: "[export.json](https://…)" → "export.json".
  t = t.replace(/\[([^\]]+)\]\((?:[^()]|\([^)]*\))*\)/g, "$1");
  // Bare URLs → host only.
  t = t.replace(/https?:\/\/([^/\s)]+)[^\s)]*/gi, "$1");
  // "Attached files: - a.json - b.png" → "Attached: a.json, b.png"
  const attached = t.match(/^attached files?:\s*-?\s*(.+)$/i);
  if (attached) t = `Attached: ${attached[1].split(/\s+-\s+/).map((s) => s.trim()).filter(Boolean).join(", ")}`;
  // "=== OATHNET INTELLIGENCE === rest" → "OATHNET INTELLIGENCE — rest"
  t = t.replace(/^=+\s*([^=]+?)\s*=+\s*/, "$1 — ");
  t = t.replace(/\s+/g, " ").trim();
  return t || (seed ?? "").trim() || "Untitled case";
}
