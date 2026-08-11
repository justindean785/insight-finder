/**
 * Server-rendered Findings table.
 *
 * WHY THIS EXISTS — measured on thread 64f7cc4b (2026-08-11), 28 persisted rows
 * vs. the model's hand-typed closing table:
 *
 *   Instagram   published 95 [CONFIRMED]   stored 70   cap_applied 70
 *   Telegram    published 70 [CONFIRMED]   stored 45   cap_applied 45
 *   Twitter/X   published 90 [CONFIRMED]   stored 70   cap_applied 70
 *   Apple Music published 90 [CONFIRMED]   stored 75   cap_applied 75
 *
 * Every row the model upgraded to CONFIRMED it also inflated; every row it left
 * at VERIFY/LOW matched storage exactly. Each of those rows carries an explicit
 * `reason_not_confirmed: "needs second independent class of evidence"` written
 * by the server — the engine did not stay silent and let the model guess, it
 * recorded a refusal to confirm and the prose printed CONFIRMED over it.
 *
 * `record_finding` (tool-registry.ts, audit F06) already derives the true
 * independent-source-class count and persists a capped confidence. Nothing in
 * this module recomputes any of that. It reads persisted columns and prints
 * them. That is the whole idea: the table becomes a VIEW of the evidence store
 * rather than a second, unaudited opinion about it.
 *
 * DELIBERATELY NOT DONE HERE:
 *   - No confidence math. See confidence.ts; this file must never import it.
 *   - No label derivation. The analyst label vocabulary
 *     (CONFIRMED/CORRELATED/INFERRED/VERIFY/LOW) is derived by
 *     `labelForArtifact` in src/lib/intel.ts, which this Deno function cannot
 *     import. Duplicating it would create a second implementation that drifts —
 *     exactly the class of bug this module exists to kill. So the table prints
 *     the server's OWN persisted strength word (`metadata.confidence_tier`) and
 *     the stored `reason_not_confirmed`, and omits a label column entirely.
 *     A wrong label is worse than no label. Label parity with the Evidence tab
 *     needs a shared module and is tracked separately.
 *   - Nothing here may fail finalize. Every entry point is total: it returns a
 *     string or the unmodified input, and never throws. See expandFindingsTable.
 */

/** The token the model emits in place of writing the table itself. */
export const FINDINGS_TABLE_MARKER = "{{FINDINGS_TABLE}}";

/** Upper bound on rendered rows, so one enormous thread cannot bloat the
 *  assistant row past the persisted-parts cap and lose the whole report. */
export const MAX_RENDERED_ROWS = 100;

/** The persisted shape this module reads. Intentionally a narrow structural
 *  type, not an import from the artifact model — this file is a renderer. */
export interface FindingRow {
  kind?: string | null;
  value?: string | null;
  confidence?: number | null;
  source?: string | null;
  metadata?: Record<string, unknown> | null;
}

/** The slice of the PostgREST builder this module uses. Declared structurally
 *  rather than importing the Supabase client type, so the renderer stays
 *  dependency-free and testable with a plain stub. */
interface FindingsQuery {
  select(columns: string): FindingsQuery;
  eq(column: string, value: string): FindingsQuery;
  order(column: string, opts: { ascending: boolean }): FindingsQuery;
  limit(n: number): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}
export interface FindingsDb {
  from(table: string): FindingsQuery;
}

/** Escape a cell so a value containing `|` or a newline cannot break the table
 *  or inject extra rows. Artifact values are attacker-influenced (they come
 *  from scraped pages), so this is a boundary, not cosmetics. */
export function escapeCell(raw: unknown, max = 160): string {
  const s = String(raw ?? "").replace(/\r?\n|\r/g, " ").replace(/\|/g, "\\|").trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function metaString(meta: Record<string, unknown> | null | undefined, key: string): string {
  const v = meta?.[key];
  return typeof v === "string" ? v.trim() : "";
}

/** Every distinct source backing the row: the `source` column plus
 *  `metadata.sources`, deduped case-insensitively. `metadata.sources` very
 *  often repeats `source`, and counting that twice is precisely how a single
 *  corpus reads as corroboration. */
export function rowSources(row: FindingRow): string[] {
  const meta = row.metadata ?? {};
  const listed = Array.isArray(meta.sources) ? (meta.sources as unknown[]) : [];
  const all = [row.source, ...listed]
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of all) {
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

/**
 * Render the table from persisted rows. Pure and total — never throws, never
 * reads a clock, never touches the network.
 */
export function renderFindingsTable(rows: readonly FindingRow[] | null | undefined): string {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) {
    return "_No evidence rows are persisted for this run, so no findings table can be generated._";
  }

  // Strongest first, so the table leads with what the evidence store actually
  // supports rather than the order tools happened to fire.
  const ordered = [...list].sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0));
  const shown = ordered.slice(0, MAX_RENDERED_ROWS);

  const lines: string[] = [];
  lines.push("| # | Finding | Kind | Confidence | Strength | Sources | Not confirmed because |");
  lines.push("|---|---|---|---|---|---|---|");

  shown.forEach((row, i) => {
    const meta = row.metadata ?? {};
    const conf = typeof row.confidence === "number" ? String(row.confidence) : "—";
    const tier = metaString(meta, "confidence_tier") || "—";
    const sources = rowSources(row);
    // Show the count alongside the names: "1 source class" is the fact that
    // decides whether anything can be CONFIRMED at all, and burying it in a
    // comma list is how it stops being read.
    const sourceCell = sources.length > 0 ? `${sources.length} — ${sources.join(", ")}` : "—";
    const why = metaString(meta, "reason_not_confirmed") || "—";
    lines.push(
      `| ${i + 1} | ${escapeCell(row.value)} | ${escapeCell(row.kind, 32)} | ${conf} | ${escapeCell(tier, 24)} | ${escapeCell(sourceCell, 80)} | ${escapeCell(why, 120)} |`,
    );
  });

  if (ordered.length > shown.length) {
    lines.push("");
    lines.push(`_Showing the ${shown.length} highest-confidence of ${ordered.length} persisted rows._`);
  }

  lines.push("");
  lines.push(
    "_Generated from the evidence store. Confidence values are the server-computed, " +
      "cap-applied numbers persisted with each artifact — not estimates written into " +
      "this message. Where a row says it needs a second independent source class, it " +
      "is NOT confirmed, whatever the surrounding prose says._",
  );
  return lines.join("\n");
}

/** The text substituted when rows could not be read at all. Says what happened
 *  instead of silently emitting an empty table that reads like "no findings". */
export const FINDINGS_TABLE_UNAVAILABLE =
  "_The findings table could not be generated: the evidence store could not be read " +
  "when this report was written. This is a rendering failure, NOT a finding that no " +
  "evidence exists — open the Evidence tab for the authoritative rows._";

/**
 * Replace every occurrence of the marker across a `messages.parts` array.
 *
 * TOTAL BY CONSTRUCTION. This runs inside the finalize window, immediately
 * before the terminal assistant row is inserted. If it throws, the report row
 * never lands and the run is scored as an interrupted investigation — the exact
 * incident class in INCIDENT_2026-07-26. So every failure path returns the
 * input unchanged, and the caller is expected to insert whatever comes back.
 *
 * `rows === null` means "the read failed", which is different from
 * "the read returned nothing"; the former gets the explicit unavailable notice,
 * the latter gets the empty-store sentence from renderFindingsTable.
 */
export function expandFindingsTable(
  parts: unknown,
  rows: readonly FindingRow[] | null,
): unknown {
  try {
    if (!Array.isArray(parts)) return parts;
    const replacement = rows === null ? FINDINGS_TABLE_UNAVAILABLE : renderFindingsTable(rows);
    let touched = false;
    const next = parts.map((part) => {
      if (!part || typeof part !== "object") return part;
      const p = part as Record<string, unknown>;
      if (p.type !== "text" || typeof p.text !== "string") return part;
      if (!p.text.includes(FINDINGS_TABLE_MARKER)) return part;
      touched = true;
      return { ...p, text: p.text.split(FINDINGS_TABLE_MARKER).join(replacement) };
    });
    return touched ? next : parts;
  } catch (e) {
    console.error(
      JSON.stringify({ event: "findings_table_expand_fail", error: (e as Error)?.message ?? String(e) }),
    );
    return parts;
  }
}

/**
 * Read the rows to render. Returns `null` on ANY failure so the caller can tell
 * "could not read" apart from "nothing recorded" — never throws, never rejects.
 */
export async function fetchFindingRows(
  supabase: FindingsDb,
  threadId: string,
  userId: string,
): Promise<FindingRow[] | null> {
  try {
    const { data, error } = await supabase
      .from("artifacts")
      .select("kind,value,confidence,source,metadata")
      .eq("thread_id", threadId)
      .eq("user_id", userId)
      .order("confidence", { ascending: false })
      .limit(MAX_RENDERED_ROWS);
    if (error) {
      console.error(
        JSON.stringify({ event: "findings_table_fetch_fail", thread_id: threadId, error: error.message }),
      );
      return null;
    }
    return Array.isArray(data) ? (data as FindingRow[]) : [];
  } catch (e) {
    console.error(
      JSON.stringify({
        event: "findings_table_fetch_throw",
        thread_id: threadId,
        error: (e as Error)?.message ?? String(e),
      }),
    );
    return null;
  }
}
