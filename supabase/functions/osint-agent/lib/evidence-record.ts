/**
 * lib/evidence-record.ts — #479. The authoritative block appended to the stored
 * assistant message: what the ENGINE computed, printed beside prose that has
 * repeatedly claimed something else (thread 254e079e — prose "CONFIRMED, 95%",
 * `record_finding` computed 50; DB max 80).
 *
 * DESIGN CONSTRAINTS, all load-bearing:
 *
 *  - PURE AND TOTAL. This runs inside the finalize window, which owns this
 *    project's worst incidents (INCIDENT_2026-07-26). It performs no I/O, reads
 *    no clock, and must never throw for ANY input — `metadata` is untyped JSON and
 *    partly model-authored. Every unusable value degrades to a safe rendering.
 *
 *  - ZERO IMPORTS. Not incidental: `src/test/evidence-record-ladder-pin.test.ts`
 *    imports this Deno module from vitest to pin it against the frontend ladder.
 *    That seam only works while this file has nothing to resolve. Deno cannot
 *    import `@/lib`, so the ladder is DUPLICATED here and pinned by that test —
 *    the same duplicate-and-pin pattern `META_KINDS` uses
 *    (src/test/benchmark-audit-policy.test.ts:48).
 *
 *  - NO MODEL-AUTHORED FIELD IS EVER AUTHORITY (#477). The tier derives from the
 *    stored number alone. `metadata.label` is the model's own unchecked pick, and
 *    `metadata.status` — even though #486 now derives it server-side — is still
 *    not read here, because the number is sufficient and one input cannot drift
 *    from itself.
 *
 *  - IT CAN NEVER MAKE A BROKEN RUN LOOK COMPLETE. `hasReportShape`
 *    (orchestrator-finalize.ts:457) reads a markdown table separator or two
 *    bracketed tier labels as proof a run produced a report. The caller protects
 *    the contract structurally by not mutating `finalMessages`; this module holds
 *    the second line of defence by refusing to EMIT either shape, including out of
 *    hostile model-authored values. See `sanitizeValue`.
 */

/** The display ladder, mirroring src/lib/confidence-tier.ts exactly.
 *
 *  Deliberately NOT lib/cluster.ts's TIERS (…/50/30). That ladder's documented job
 *  is telling the MODEL what words to write (orchestrator-finalize.ts:258,
 *  system-prompt.ts:162) — the instruction this whole issue exists because the
 *  model ignores. This block renders inside CaseReport.tsx, which imports
 *  confidence-tier.ts, so agreeing with the badge on the same screen is what keeps
 *  the authoritative table from contradicting the UI around it. Measured on the
 *  live corpus: the two ladders disagree on 2,205 of 9,064 rows (24.3%). */
export const CONFIDENCE_TIERS = { CONFIRMED: 90, LIKELY: 75, POSSIBLE: 55, WEAK: 35 } as const;

export const EVIDENCE_RECORD_HEADING = "## Evidence Record — authoritative";
export const NO_FINDINGS_LINE = "_No authoritative finding rows were recorded for this run._";
export const RETRIEVAL_CEILING_LINE =
  "_Retrieval ceiling reached — this record may be incomplete._";

/** Hard ceiling on the block itself, so it can never starve the narrative's share
 *  of MAX_PERSISTED_ASSISTANT_PARTS_BYTES. The caller reserves exactly this budget. */
export const EVIDENCE_RECORD_MAX_BYTES = 32_000;
const MAX_ROWS = 50;
const MAX_VALUE_CHARS = 300;

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/** A 0–100 number, or null. Out-of-range is treated as unusable rather than
 *  clamped: a stored 101 is corrupt data, and reading it as "Confirmed" would let
 *  corruption publish the highest tier. */
function usableScore(x: unknown): number | null {
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  if (x < 0 || x > 100) return null;
  return x;
}

/** Map a score to its tier. Anything unusable is Unverified — never a throw, and
 *  never an inflation. */
export function confidenceTierLabel(score: unknown): string {
  const s = usableScore(score);
  if (s === null) return "Unverified";
  if (s >= CONFIDENCE_TIERS.CONFIRMED) return "Confirmed";
  if (s >= CONFIDENCE_TIERS.LIKELY) return "Likely";
  if (s >= CONFIDENCE_TIERS.POSSIBLE) return "Possible";
  if (s >= CONFIDENCE_TIERS.WEAK) return "Weak";
  return "Unverified";
}

/**
 * The number the block is allowed to publish: never above the server's recorded
 * cap. This is #481's shipped display invariant (src/lib/intel.ts:265
 * `recordedConfidenceCap`) reused rather than re-invented — `record_finding`
 * persists `confidence: axes.case` UNCAPPED and carries the ceiling separately in
 * `metadata.confidence_cap_applied`, so a block that printed the raw column would
 * publish above the cap on the same page where the badge clamps.
 *
 * An unusable cap is ignored, not trusted. The value can only ever LOWER a
 * displayed number, so the failure mode is fail-safe in the direction that matters.
 */
export function effectiveConfidence(row: unknown): number | null {
  if (!isRecord(row)) return null;
  const base = usableScore(row.confidence);
  if (base === null) return null;
  const meta = isRecord(row.metadata) ? row.metadata : {};
  const cap = usableScore(meta.confidence_cap_applied);
  return cap === null ? base : Math.min(base, cap);
}

/**
 * Make a model-authored value safe to print.
 *
 * The control-character strip is the 2026-08-02 incident (one NUL anywhere in the
 * tree fails the JSONB insert and discards the whole finished report). The
 * pipe/bracket neutralisation is the completion-contract defence: raw, a value
 * containing "|---" is a markdown table separator and "[Confirmed] [Confirmed]" is
 * two tier labels, either of which is enough for `hasReportShape` to read a stub
 * run as a finished report.
 */
function sanitizeValue(v: unknown): string {
  const raw = typeof v === "string" ? v : "";
  const cleaned = raw
    // Both linters see this file: Deno lints the edge function, and ESLint reaches
    // it because the ladder pin imports it from vitest. The control class is the
    // point of the rule, so each needs its own waiver.
    // deno-lint-ignore no-control-regex
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, " ")
        .replace(/\|/g, "/")
    .replace(/\[/g, "(")
    .replace(/\]/g, ")")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "(no value recorded)";
  return cleaned.length > MAX_VALUE_CHARS ? cleaned.slice(0, MAX_VALUE_CHARS) + "…" : cleaned;
}

const byteLength = (s: string): number => new TextEncoder().encode(s).length;

interface EvidenceRecordInput {
  /** The salvage rows as fetched — every kind; this module selects its own. */
  rows: unknown[];
  /** Total artifacts on the thread, so the zero-findings state is a statement. */
  totalArtifactCount: number;
  /** True when the fetch hit its row limit, so completeness cannot be claimed. */
  retrievalCeilingHit: boolean;
}

/**
 * Render the block. Total: any malformed envelope degrades to the zero-findings
 * statement rather than throwing.
 */
export function buildEvidenceRecord(input: EvidenceRecordInput): string {
  const env = isRecord(input) ? input : ({} as Record<string, unknown>);
  const rows = Array.isArray(env.rows) ? env.rows : [];
  const total = usableCount(env.totalArtifactCount);
  const ceiling = env.retrievalCeilingHit === true;

  const findings = rows
    .filter((r): r is Record<string, unknown> =>
      isRecord(r) && typeof r.kind === "string" && r.kind.trim().toLowerCase() === "finding"
    )
    .map((r) => ({
      value: sanitizeValue(r.value),
      score: effectiveConfidence(r),
      id: typeof r.id === "string" ? r.id : "",
    }))
    // Deterministic: strongest first, id as the tiebreak so the same rows in any
    // fetch order render byte-identical. Unusable scores sort last.
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const head: string[] = [EVIDENCE_RECORD_HEADING, ""];
  if (ceiling) head.push(RETRIEVAL_CEILING_LINE, "");

  if (findings.length === 0) {
    head.push(
      `${NO_FINDINGS_LINE} ${total} artifact${total === 1 ? "" : "s"} were collected; ` +
        `nothing in the narrative above was adjudicated by the scoring engine.`,
    );
    return head.join("\n");
  }

  // Bound by BOTH row count and bytes: one hostile 50KB value must not consume the
  // reserved budget, and 400 rows must not either. Whatever is dropped is disclosed.
  const lines: string[] = [];
  let used = byteLength(head.join("\n"));
  let shown = 0;
  for (const f of findings) {
    if (shown >= MAX_ROWS) break;
    
    const pct = f.score === null ? "n/a" : `${f.score}%`;
    const line = `- ${f.value} — ${pct} — ${confidenceTierLabel(f.score)}`;
    const cost = byteLength(line) + 1;
    if (used + cost > EVIDENCE_RECORD_MAX_BYTES - 200) break; // 200: the disclosure line
    lines.push(line);
    used += cost;
    shown += 1;
  }

  const dropped = findings.length - shown;
  const out = [...head, ...lines];
  if (dropped > 0) {
    out.push("", `_… ${dropped} further row${dropped === 1 ? "" : "s"} not shown; the record is bounded to protect the storage budget._`);
  }
  return out.join("\n");
}

function usableCount(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) && x >= 0 ? Math.floor(x) : 0;
}
