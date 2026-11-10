/**
 * evidence-record-expand.ts — show the whole finding behind a cut-off Evidence
 * Record line. DISPLAY ONLY: the stored message is never changed.
 *
 * The edge appends "## Evidence Record — authoritative" to the stored report
 * (supabase/functions/osint-agent/lib/evidence-record.ts). Each line is
 * `- <value> — <pct> — <tier>`, and the value is cut at 300 characters with "…"
 * on purpose: the block is byte-bounded so it can never starve the report's
 * storage budget, and that bound must stay. The full text already lives on the
 * finding's own artifact row, which the workspace has loaded. So the chat swaps
 * a cut line's value for the row's full value — only when exactly one finding
 * row matches it, and only inside that block. Anything ambiguous renders as
 * stored. Measured 2026-11-10: 14 of 16 findings in 30 days were longer than 300
 * characters, so most Evidence Record lines were cut.
 *
 * Tier and percentage are NOT recomputed: they stay exactly as the engine wrote
 * them. A finding stored at the 500-character `record_finding` cap says so.
 *
 * Kill switch: VITE_EVIDENCE_RECORD_EXPAND_DISABLED=true (build-time) renders
 * every line exactly as stored.
 */

/** Must equal EVIDENCE_RECORD_HEADING in the edge module (pinned by the test). */
export const EVIDENCE_RECORD_HEADING = "## Evidence Record — authoritative";
/** The edge module's MAX_VALUE_CHARS. */
export const RECORD_VALUE_MAX_CHARS = 300;
/** `record_finding` stores `conclusion.slice(0, 500)` (lib/finding-row.ts). */
export const FINDING_STORED_MAX_CHARS = 500;

export const STORED_CAP_NOTE = "_(stored text ends here: it was cut at 500 characters when recorded)_";

type FindingLike = { kind?: unknown; value?: unknown };

/**
 * The edge module's `sanitizeValue`, minus the 300-character cut: control
 * characters become spaces, `|` → `/`, `[` → `(`, `]` → `)`, whitespace collapses.
 * Same rules on both sides, so the expanded line can never introduce a table
 * separator or a bracketed tier label the stored one did not have.
 */
export function sanitizeRecordValue(v: unknown): string {
  const raw = typeof v === "string" ? v : "";
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\|/g, "/")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/\s+/g, " ")
    .trim();
}

export interface FindingFullText {
  /** 300-char sanitized prefix → full sanitized value, or null when two findings share it. */
  byPrefix: ReadonlyMap<string, { full: string; storedAtCap: boolean } | null>;
}

/** Index the thread's finding rows that the record would have cut. Pure. */
export function buildFindingFullText(rows: readonly FindingLike[] | null | undefined): FindingFullText {
  const byPrefix = new Map<string, { full: string; storedAtCap: boolean } | null>();
  for (const r of rows ?? []) {
    if (typeof r?.kind !== "string" || r.kind.trim().toLowerCase() !== "finding") continue;
    const full = sanitizeRecordValue(r.value);
    if (full.length <= RECORD_VALUE_MAX_CHARS) continue;
    const key = full.slice(0, RECORD_VALUE_MAX_CHARS);
    const entry = { full, storedAtCap: typeof r.value === "string" && r.value.length >= FINDING_STORED_MAX_CHARS };
    if (!byPrefix.has(key)) byPrefix.set(key, entry);
    else if (byPrefix.get(key)?.full !== full) byPrefix.set(key, null); // ambiguous: never guess
  }
  return { byPrefix };
}

const RECORD_LINE = /^- (.*)… — (n\/a|\d{1,3}%) — (Confirmed|Likely|Possible|Weak|Unverified)$/;

/** Expand cut lines inside every Evidence Record block of `prose`. Pure; returns `prose` untouched when nothing applies. */
export function expandEvidenceRecordLines(prose: string, index: FindingFullText | null | undefined): string {
  if (!index || index.byPrefix.size === 0 || !prose.includes(EVIDENCE_RECORD_HEADING)) return prose;
  const lines = prose.split("\n");
  let inRecord = false;
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === EVIDENCE_RECORD_HEADING) { inRecord = true; continue; }
    if (inRecord && /^#{1,6} /.test(line)) { inRecord = false; continue; }
    if (!inRecord) continue;
    const m = RECORD_LINE.exec(line);
    if (!m || m[1].length !== RECORD_VALUE_MAX_CHARS) continue;
    const hit = index.byPrefix.get(m[1]);
    if (!hit) continue;
    lines[i] = `- ${hit.full} — ${m[2]} — ${m[3]}${hit.storedAtCap ? ` ${STORED_CAP_NOTE}` : ""}`;
    changed = true;
  }
  return changed ? lines.join("\n") : prose;
}

/** Build-time kill switch. */
export function evidenceRecordExpandDisabled(
  env: Record<string, unknown> = (import.meta as unknown as { env?: Record<string, unknown> }).env ?? {},
): boolean {
  return String(env.VITE_EVIDENCE_RECORD_EXPAND_DISABLED ?? "").trim().toLowerCase() === "true";
}
