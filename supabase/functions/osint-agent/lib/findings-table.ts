/**
 * lib/findings-table.ts — the engine, not the model, authors the closing Findings table.
 *
 * The orchestrator writes the literal line `{{FINDINGS_TABLE}}` where the table belongs;
 * `persistFinalMessages` replaces it from the rows this run PERSISTED, before the message
 * is stored. CLAUDE.md "The report layer bypasses the integrity engine": `record_finding`
 * and `confidence.ts` already compute the right numbers, and the model then retyped the
 * table in prose. This module is the carrier that was missing. It computes NOTHING.
 *
 * DESIGN CONSTRAINTS (each one is pinned by supabase/tests/osint-agent/findings_table_test.ts):
 *
 *  - PURE. No I/O, no clock. The only import is the zero-import evidence-record.ts, so the
 *    ladder, the cap rule and the finding predicate have ONE definition (those three are
 *    already pinned against the frontend by src/test/evidence-record-ladder-pin.test.ts).
 *
 *  - PERSISTED VALUES ONLY. Confidence is `effectiveConfidence(row)` — the stored column
 *    clamped by `metadata.confidence_cap_applied` — and the label is the ladder tier of
 *    that number. `metadata.label` is the model's own unchecked pick and `metadata.status`
 *    is a second input that can drift from the number; neither is read (same rule as
 *    evidence-record.ts, #477).
 *
 *  - FAILS CLOSED. Rows are only ever listed when the artifact read AND the analyst-verdict
 *    read both succeeded. "Could not read the verdicts" is not "nothing was rejected".
 *
 *  - CANNOT MANUFACTURE A REPORT. A GFM table is, by `hasReportShape`'s own definition,
 *    report shape. So `expandFindingsTableInParts` expands only when the message ALREADY
 *    has report shape without the marker line (the caller's predicate, structural — never
 *    inferred from prose), and it returns a COPY: `finalMessages` is never mutated, so the
 *    completion contract (I-2) still judges what the model actually wrote.
 *
 *  - CANNOT FAIL FINALIZE. Every entry point catches, logs the error NAME only, and returns
 *    its input unchanged.
 *
 *  - NO REGEX OVER MODEL PROSE. The only recognised input is the literal marker, alone on a
 *    line (surrounding whitespace and one trailing colon tolerated).
 */
import {
  confidenceTierLabel,
  effectiveConfidence,
  isFindingRow,
  type ArtifactRetrieval,
  type ReviewAuthority,
} from "./evidence-record.ts";

export const FINDINGS_TABLE_MARKER = "{{FINDINGS_TABLE}}";

/** Rows rendered. Deliberately far below the 500-row artifact fetch: the table sits
 *  BEFORE the Network and Summary sections, and capPartsSize keeps a PREFIX, so an
 *  unbounded table would push those sections past the persisted-message cap. */
export const FINDINGS_TABLE_MAX_ROWS = 60;
/** Hard byte ceiling for the whole rendered block (table + footer). */
export const FINDINGS_TABLE_MAX_BYTES = 16_000;
export const FINDINGS_TABLE_CELL_MAX_CHARS = 160;
const SOURCE_CELL_MAX_CHARS = 40;
/** Held back from the byte budget for the footer / disclosure lines. */
const FOOTER_RESERVE_BYTES = 900;

export const FINDINGS_TABLE_UNAVAILABLE_LINE =
  "_Findings table unavailable: the run's stored rows could not be read during finalization._";
export const FINDINGS_TABLE_REVIEW_UNAVAILABLE_LINE =
  "_Findings table withheld: analyst review state could not be read during finalization, so no rows are " +
  "listed rather than risk republishing one the analyst rejected._";

export interface FindingsTableInput {
  /** The artifact rows as fetched — every kind. The caller MUST already have removed
   *  analyst-rejected rows (`dropRejectedArtifacts`); this module cannot import reviews.ts. */
  rows: unknown[];
  /** Total artifacts on the thread (the pre-rejection collected count). */
  totalArtifactCount: number;
  retrieval: ArtifactRetrieval;
  reviews: ReviewAuthority;
  /** `kind='finding'` rows that analyst review removed, for the footer. */
  rejectedFindingCount: number;
}

export interface FindingsTableEvent {
  name: "findings_table_expanded" | "findings_table_expansion_failed";
  marker_found: boolean;
  /** Marker lines consumed (the first receives the table, any further ones are removed). */
  replaced: number;
  rows: number;
  adjudicated: number;
  withheld: number;
  /** Set when the marker was present but deliberately left raw. */
  skipped?: "no_report_shape";
  /** Error NAME only — a thrown message can echo row content into shared logs. */
  error?: string;
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const byteLength = (s: string): number => new TextEncoder().encode(s).length;

const usableCount = (x: unknown): number =>
  typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0;

const metaTrue = (v: unknown): boolean => v === true || v === "true";

/** Process-bookkeeping rows: the agent's own scaffolding, not evidence about the subject
 *  (lib/cluster.ts BOOKKEEPING_KINDS — duplicated because cluster.ts has heavy imports). */
const BOOKKEEPING_KINDS = new Set(["triage_decision", "cluster_decision", "coverage_audit", "tool_audit"]);

/** Why a row gets no line in the table, or null when it is listed.
 *  Quarantine is DISCLOSURE, not deletion: these rows are counted in the footer and keep
 *  their provenance in the artifact table; they just never gain a figure here. */
function withheldReason(row: Record<string, unknown>): "bookkeeping" | "excluded" | "quarantined" | null {
  const kind = typeof row.kind === "string" ? row.kind.trim().toLowerCase() : "";
  const meta = isRecord(row.metadata) ? row.metadata : {};
  if (BOOKKEEPING_KINDS.has(kind)) return "bookkeeping";
  if (kind === "excluded_collision" || metaTrue(meta.excluded_collision)) return "excluded";
  // The escape hatch is DURABLE linkage the analyst confirmed, never name equality.
  if (metaTrue(meta.subject_unlinked) && !metaTrue(meta.linkage_confirmed)) return "quarantined";
  return null;
}

/** Make one cell safe to print. Truncates BEFORE escaping so escapes never grow past the
 *  cap, and escapes every character that could break the table or inject markup/links. */
function cell(v: unknown, max: number): string {
  const raw = typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : "";
  let s = raw
    // Both linters reach this file (Deno lints the edge function; ESLint lints supabase/functions too).
    // deno-lint-ignore no-control-regex
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "—";
  if (s.length > max) s = s.slice(0, max) + "…";
  return s.replace(/[\\|<>[\]`*~]/g, (c) => "\\" + c);
}

/** Distinct source-class count as the engine PERSISTED it (`metadata.source_category`);
 *  "—" when it stored nothing. Never derived from the `source` string here — the three
 *  counting systems (source classes / effective sources / breach names) stay separate and
 *  this column is the first one only. */
function sourceClassCell(row: Record<string, unknown>): string {
  const meta = isRecord(row.metadata) ? row.metadata : {};
  const sc = meta.source_category;
  if (!Array.isArray(sc)) return "—";
  const distinct = new Set(sc.filter((x): x is string => typeof x === "string" && x.trim() !== "").map((x) => x.trim().toLowerCase()));
  return distinct.size > 0 ? String(distinct.size) : "—";
}

function basisCell(row: Record<string, unknown>): string {
  if (!isFindingRow(row)) return "evidence row";
  const meta = isRecord(row.metadata) ? row.metadata : {};
  return meta.finding_origin === "synthesis" ? "finding (synthesis)" : "finding";
}

interface Built {
  text: string;
  rows: number;
  adjudicated: number;
  withheld: number;
}

function build(input: FindingsTableInput): Built {
  const env = isRecord(input) ? input : ({} as Record<string, unknown>);
  const retrieval = env.retrieval === "complete" || env.retrieval === "ceiling_hit" ? env.retrieval : "unavailable";
  const reviewsOk = env.reviews === "applied";
  const empty = { rows: 0, adjudicated: 0, withheld: 0 };
  // Order matters and matches evidence-record.ts: an unreadable population cannot be
  // described at all, and an unchecked one cannot be published.
  if (retrieval === "unavailable") return { text: FINDINGS_TABLE_UNAVAILABLE_LINE, ...empty };
  if (!reviewsOk) return { text: FINDINGS_TABLE_REVIEW_UNAVAILABLE_LINE, ...empty };

  const all = (Array.isArray(env.rows) ? env.rows : []).filter(isRecord);
  let withheld = 0;
  const eligible: Record<string, unknown>[] = [];
  for (const r of all) {
    if (withheldReason(r) === null) eligible.push(r);
    else withheld += 1;
  }
  const adjudicated = eligible.filter(isFindingRow).length;

  // Deterministic: findings first, strongest first, id as the tiebreak (the fetch carries no
  // timestamp), unusable scores last — so the same rows in any fetch order are byte-identical.
  const sorted = eligible
    .map((r) => ({ r, score: effectiveConfidence(r), finding: isFindingRow(r), id: typeof r.id === "string" ? r.id : "" }))
    .sort((a, b) =>
      Number(b.finding) - Number(a.finding) ||
      (b.score ?? -1) - (a.score ?? -1) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );

  const lines: string[] = [];
  let shown = 0;
  if (sorted.length > 0) {
    const header = [
      "| # | Finding / value | Kind | Basis | Source | Label | Confidence | Source classes |",
      "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ];
    lines.push(...header);
    let used = byteLength(header.join("\n"));
    for (const { r, score } of sorted) {
      if (shown >= FINDINGS_TABLE_MAX_ROWS) break;
      const line = `| ${shown + 1} | ${cell(r.value, FINDINGS_TABLE_CELL_MAX_CHARS)} | ${cell(r.kind, 32)} | ${basisCell(r)} | ` +
        `${cell(r.source, SOURCE_CELL_MAX_CHARS)} | ${confidenceTierLabel(score)} | ${score === null ? "—" : `${score}%`} | ${sourceClassCell(r)} |`;
      const cost = byteLength(line) + 1;
      if (used + cost > FINDINGS_TABLE_MAX_BYTES - FOOTER_RESERVE_BYTES) break;
      lines.push(line);
      used += cost;
      shown += 1;
    }
  }

  const rejected = usableCount(env.rejectedFindingCount);
  const parts = [
    `${sorted.length} row${sorted.length === 1 ? "" : "s"} from this run's evidence record`,
    `${adjudicated} recorded as findings (record_finding)`,
  ];
  if (withheld > 0) parts.push(`${withheld} withheld (quarantined, excluded as namesake, or process-bookkeeping rows)`);
  if (rejected > 0) parts.push(`${rejected} finding row${rejected === 1 ? "" : "s"} excluded by analyst review`);
  const footer: string[] = [
    `_Basis: ${parts.join("; ")}. Confidence is the stored value clamped by its recorded cap; the label is the ladder tier of that number; nothing here is recomputed._`,
  ];
  if (sorted.length > shown) {
    footer.push(`_Showing the first ${shown} of ${sorted.length} rows; the remainder is in the case's evidence record._`);
  }
  if (retrieval === "ceiling_hit") {
    footer.push("_Evidence-record retrieval ceiling reached — rows below the fetched window may be missing._");
  }
  const text = (lines.length ? [...lines, ""] : []).concat(footer).join("\n");
  return { text, rows: sorted.length, adjudicated, withheld };
}

/** Render the block. Pure; may throw on hostile input — the expand* entry points catch. */
export function renderFindingsTable(input: FindingsTableInput): string {
  return build(input).text;
}

// ---- marker handling --------------------------------------------------------------------

/** The literal marker alone on a line; whitespace and one trailing colon tolerated. */
const markerLineRe = (): RegExp => /^[ \t]*\{\{FINDINGS_TABLE\}\}[ \t]*:?[ \t]*\r?$/gm;

const noMarkerEvent = (): FindingsTableEvent => ({
  name: "findings_table_expanded", marker_found: false, replaced: 0, rows: 0, adjudicated: 0, withheld: 0,
});

const failureEvent = (e: unknown, markerFound: boolean): FindingsTableEvent => ({
  name: "findings_table_expansion_failed",
  marker_found: markerFound,
  replaced: 0, rows: 0, adjudicated: 0, withheld: 0,
  error: (e instanceof Error && typeof e.name === "string" ? e.name : "NonError").slice(0, 64),
});

/** Replace marker lines in one string. The FIRST receives the table; later ones are removed
 *  (one table per report — a duplicate would double the byte cost and the claims). */
function replaceMarkers(text: string, table: string, state: { used: boolean; replaced: number }): string {
  return text.replace(markerLineRe(), () => {
    state.replaced += 1;
    if (state.used) return "";
    state.used = true;
    return table;
  });
}

/** String form. Marker absent → unchanged. Any throw → unchanged + failure event. */
export function expandFindingsTable(
  content: string,
  input: FindingsTableInput,
): { content: string; event: FindingsTableEvent } {
  let markerFound = false;
  try {
    if (typeof content !== "string" || !markerLineRe().test(content)) return { content, event: noMarkerEvent() };
    markerFound = true;
    const built = build(input);
    const state = { used: false, replaced: 0 };
    const out = replaceMarkers(content, built.text, state);
    return {
      content: out,
      event: {
        name: "findings_table_expanded", marker_found: true, replaced: state.replaced,
        rows: built.rows, adjudicated: built.adjudicated, withheld: built.withheld,
      },
    };
  } catch (e) {
    return { content, event: failureEvent(e, markerFound) };
  }
}

const isTextPart = (p: unknown): p is { type: "text"; text: string } =>
  isRecord(p) && p.type === "text" && typeof p.text === "string";

/**
 * Parts form — what `persistFinalMessages` calls. Returns a COPY with the text parts
 * expanded; `parts` and every element of it are left untouched (invariant 3: the
 * completion contract keeps judging the in-memory message).
 *
 * `shapeOk` is the caller's report-shape predicate (`hasReportShape ∘ stripReasoning`).
 * It is evaluated on the message text WITHOUT the marker lines: a stub whose only
 * substance is the marker is left raw, so the expansion can never make a broken run's
 * STORED message look complete to the stale-run sweeper (recovery.ts reads the stored text).
 */
export function expandFindingsTableInParts(
  parts: unknown[],
  input: FindingsTableInput,
  opts: { shapeOk: (text: string) => boolean },
): { parts: unknown[]; event: FindingsTableEvent } {
  let markerFound = false;
  try {
    if (!Array.isArray(parts)) return { parts, event: noMarkerEvent() };
    const texts = parts.filter(isTextPart).map((p) => p.text);
    if (!markerLineRe().test(texts.join("\n"))) return { parts, event: noMarkerEvent() };
    markerFound = true;
    const withoutMarker = texts.map((t) => t.replace(markerLineRe(), "")).join("\n");
    if (!opts.shapeOk(withoutMarker)) {
      return {
        parts,
        event: { ...noMarkerEvent(), marker_found: true, skipped: "no_report_shape" },
      };
    }
    const built = build(input);
    const state = { used: false, replaced: 0 };
    const next = parts.map((p) => (isTextPart(p) && markerLineRe().test(p.text)
      ? { ...p, text: replaceMarkers(p.text, built.text, state) }
      : p));
    return {
      parts: next,
      event: {
        name: "findings_table_expanded", marker_found: true, replaced: state.replaced,
        rows: built.rows, adjudicated: built.adjudicated, withheld: built.withheld,
      },
    };
  } catch (e) {
    return { parts, event: failureEvent(e, markerFound) };
  }
}

// ---- /health proof key ------------------------------------------------------------------

/** Synthetic fixture: invented values only, reserved example names. */
export const FINDINGS_TABLE_SELF_TEST_ROWS: unknown[] = [
  {
    id: "st-f1", kind: "finding", value: "synthetic claim alpha", confidence: 95, source: "record_finding",
    metadata: { confidence_cap_applied: 60, source_category: ["breach_corpus", "live_profile"], label: "CONFIRMED" },
  },
  { id: "st-a1", kind: "username", value: "synthetic_handle_beta", confidence: 55, source: "username_sweep", metadata: {} },
  { id: "st-q1", kind: "username", value: "synthetic_stranger_gamma", confidence: 65, source: "username_sweep", metadata: { subject_unlinked: true } },
];

export const FINDINGS_TABLE_SELF_TEST_EXPECTED = [
  "| # | Finding / value | Kind | Basis | Source | Label | Confidence | Source classes |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
  "| 1 | synthetic claim alpha | finding | finding | record_finding | Possible | 60% | 2 |",
  "| 2 | synthetic_handle_beta | username | evidence row | username_sweep | Possible | 55% | — |",
  "",
  "_Basis: 2 rows from this run's evidence record; 1 recorded as findings (record_finding); 1 withheld (quarantined, excluded as namesake, or process-bookkeeping rows). Confidence is the stored value clamped by its recorded cap; the label is the ladder tier of that number; nothing here is recomputed._",
].join("\n");

/** Self-test behind `checks.findings_table`: render the frozen fixture and compare. A drift in
 *  the cap rule, the ladder, the ordering or the withholding changes this string. */
export function runFindingsTableSelfTest(): { ok: boolean; detail: string; expected: string; actual: string } {
  let actual = "";
  try {
    actual = renderFindingsTable({
      rows: FINDINGS_TABLE_SELF_TEST_ROWS,
      totalArtifactCount: FINDINGS_TABLE_SELF_TEST_ROWS.length,
      retrieval: "complete",
      reviews: "applied",
      rejectedFindingCount: 0,
    });
  } catch (e) {
    return {
      ok: false, detail: `self-test threw ${e instanceof Error ? e.name : "NonError"}`,
      expected: FINDINGS_TABLE_SELF_TEST_EXPECTED, actual,
    };
  }
  const ok = actual === FINDINGS_TABLE_SELF_TEST_EXPECTED;
  return {
    ok,
    detail: ok ? "fixture renders to the pinned table" : "rendered fixture differs from the pinned table",
    expected: FINDINGS_TABLE_SELF_TEST_EXPECTED,
    actual,
  };
}
