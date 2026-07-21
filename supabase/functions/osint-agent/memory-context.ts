export type SeedMemoryRow = {
  kind?: string | null;
  subject?: string | null;
  content?: string | null;
  confidence?: number | null;
};

const INLINE_SECRET_RE =
  /\b(password|passwd|pwd|ssn|social security number|token|secret)\b(\s*[:=]\s*)([^\s,;]+)/gi;

export function normalizeMemorySeed(seed: string): string {
  return String(seed ?? "").trim().toLowerCase().slice(0, 320);
}

function safeMemoryContent(content: string): string {
  return String(content ?? "")
    .replace(INLINE_SECRET_RE, (_match, label: string, separator: string) =>
      `${label}${separator}[REDACTED]`)
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 320);
}

/** Compact, deterministic context injected on every run for the current seed. */
export function buildSeedMemoryContext(rows: SeedMemoryRow[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const row of rows ?? []) {
    const content = safeMemoryContent(row.content ?? "");
    if (!content) continue;
    const key = `${row.kind ?? "note"}:${content.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(
      `- [MEMORY:${row.kind ?? "note"}${row.confidence != null ? ` ${row.confidence}` : ""}] ${content}`,
    );
    if (lines.length >= 8) break;
  }
  if (lines.length === 0) return "";
  return [
    "\n\n## Prior investigation memory for this seed",
    "Use these saved lessons/connections when planning. Do not repeat resolved lookups; verify memory against current evidence and cite it as [MEMORY].",
    ...lines,
  ].join("\n");
}
