/**
 * dispatch-quarantine.ts — the DISPATCH half of the `subject_unlinked` boundary.
 *
 * Quarantine already binds at WRITE (`auto-persist-findings.ts`) and at READ-BACK
 * (`lib/cluster.ts`, `graph.ts`, the report). It never bound at DISPATCH. So a
 * name-only harvest left its quarantined selectors sitting in the model's context
 * window, each one eligible to seed its own paid multi-tool stack — the real
 * driver of run spam and paid-cap pressure, not a cap that is too low.
 *
 * THE CONTRACT is the same one the other two halves keep: authority, not
 * deletion. A quarantined row stays persisted, visible on the Evidence board and
 * present in the report's collision section. What it may not do is START WORK.
 *
 * ── TWO DESIGN HAZARDS, both deliberate ──────────────────────────────────────
 *
 * 1. KEY BY `type:normalizedValue`, NEVER BY VALUE ALONE. Selector normalizers
 *    collapse text, so a `name` and a `username` can land on the same string.
 *    Keying by value alone lets an ordinary name RESTORE AUTHORITY to a
 *    quarantined username (and, inversely, lets a quarantined name silently
 *    disable an unrelated username). `src/lib/quarantine.ts` already gets this
 *    right; this mirrors it on the dispatch side.
 *
 * 2. A REFUSAL MUST READ AS A REFUSAL. `repairUnknownTool` → `UNKNOWN_TOOL_SINK`
 *    returns `{ ok: true, dropped: true }`, which is how a call to a tool
 *    disabled since 2026-07-09 reached a chain-of-custody record as `completed`.
 *    This module returns `ok: false` and deliberately avoids the vocabulary
 *    `isIntentionalSkip` matches — in particular the word "gated", which
 *    `SKIP_REASON_RE` treats as an intentional no-op. `deriveOk` consults
 *    `isIntentionalSkip` BEFORE `ok`, so a refusal phrased with that word would
 *    be logged `ok=true` and disappear from the failure metric.
 */

import { isSubjectUnlinked } from "./quarantine.ts";

/** The refusal marker, on the payload and in the log, so it is greppable. */
export const DISPATCH_REFUSAL_MARKER = "subject_unlinked_dispatch_boundary";

/**
 * The dispatch key. `type` and `value` BOTH participate — see hazard 1 above.
 * The value is expected to be already normalized by `circuit.normalizeSelector`,
 * which is type-aware; this only lower-cases and trims to stay idempotent.
 */
export function dispatchKey(selectorType: string, normalizedValue: string): string {
  return `${(selectorType ?? "").trim().toLowerCase()}:${(normalizedValue ?? "").trim().toLowerCase()}`;
}

/**
 * Is this (type, value) pair quarantined for DISPATCH?
 *
 * Fails OPEN on an empty selector: a call with no selector at all is not a
 * quarantined-selector call, and refusing it would break every tool that takes
 * no target (finalize, record_finding, the planner).
 */
export function isDispatchRefused(
  quarantined: ReadonlySet<string>,
  selectorType: string | readonly string[],
  normalizedValue: string,
): boolean {
  if (!normalizedValue) return false;
  const types = typeof selectorType === "string" ? [selectorType] : selectorType;
  return types.some((t) => quarantined.has(dispatchKey(t, normalizedValue)));
}

/**
 * The selector types to test for one dispatch, in priority order.
 *
 * WHY THIS EXISTS — a real gap, not a convenience. The wrapper's
 * `detectSelectorType` reads `input.kind` / `input.selector_type` and **never
 * `input.type`**, then falls through to the generic literal `"value"`. But the
 * paid breach tools' own schemas take `{ type, value }` — `breach_check`,
 * `oathnet_lookup` and friends. So a quarantined `username` arriving as
 * `{ type: "username", value: "…" }` is classified `value:…` by the wrapper, and
 * a key built from the artifact's `kind` (`username:…`) would never match it.
 * The boundary would hold for cheap tools and leak on exactly the expensive ones
 * it exists to stop.
 *
 * THIS IS STILL TYPE-KEYED, NOT VALUE-KEYED. Only types the CALLER actually
 * declared are considered — the wrapper's computed type, plus a literal
 * `input.type` when present. A quarantined `username` is still NOT refused when
 * the same text is dispatched as a `name`, because `name` is neither of those
 * candidates. That is hazard 1 above, and it stays closed.
 *
 * Deliberately NOT fixed here: `detectSelectorType` itself. It also keys the
 * circuit breaker, the dedup cache and telemetry, so teaching it `type` would
 * silently repartition all three. That is a separate change with its own
 * evidence, not a drive-by inside this boundary.
 */
export function dispatchTypeCandidates(
  computedType: string,
  input: unknown,
): string[] {
  const out: string[] = [];
  const push = (t: unknown) => {
    if (typeof t !== "string") return;
    const v = t.trim().toLowerCase();
    if (v && !out.includes(v)) out.push(v);
  };
  push(computedType);
  const inp = (input ?? {}) as Record<string, unknown>;
  push(inp.type);
  return out;
}

/**
 * The refusal message. A FIXED STRING — nothing is interpolated into it, ever.
 *
 * `isIntentionalSkip` classifies a tool result by regex-matching the joined text of
 * `error`, `note`, `reason` and `detail` against `SKIP_REASON_RE`, and `deriveOk`
 * consults it BEFORE `ok`. So any caller-influenced text reaching one of those four
 * fields can flip a refusal to `ok: true` and delete it from the failure metric.
 * The original build interpolated two such values:
 *
 *   • `subject_unlinked_reason`, written by the classifier from model output; and
 *   • the normalized selector itself, which is target-controlled.
 *
 * Either one containing "gated" (`\bgated\b` matches inside `gated.com`), the
 * phrase "not configured", or a normalized name spelled "not configured" was enough
 * to turn this refusal into a logged no-op — the precise failure that let
 * `dork_harvest` reach a chain-of-custody record as `completed`.
 *
 * Scrubbing the interpolated text would be a filter to keep in step with a regex
 * that lives in another module. A constant cannot drift. The selector, its type and
 * the quarantine reason are preserved as STRUCTURED FIELDS, which no classifier
 * reads, so the payload is no less auditable — `quarantine_reason` is deliberately
 * not named `reason`.
 */
export const DISPATCH_REFUSAL_ERROR =
  "refused: this selector is quarantined as subject_unlinked and may not start a tool call. " +
  "The row remains on the Evidence board; only its authority to drive work is withheld. " +
  "An analyst can clear it by confirming linkage.";

/**
 * The refusal payload. Explicitly NOT a success and explicitly NOT a skip.
 *
 * `ok: false` makes `deriveOk` log it as a non-success; the absence of `skipped`
 * and of any `SKIP_REASON_RE` vocabulary keeps `isIntentionalSkip` false; the
 * absence of `dropped` keeps it distinguishable from the unknown-tool sink.
 */
export function quarantineRefusal(
  tool: string,
  selectorType: string,
  normalizedValue: string,
  reason?: string | null,
): Record<string, unknown> {
  return {
    ok: false,
    refused: true,
    refused_by: DISPATCH_REFUSAL_MARKER,
    tool,
    selector_type: selectorType,
    selector: normalizedValue,
    // Structured, and deliberately NOT called `reason` — `isIntentionalSkip` reads
    // `error`/`note`/`reason`/`detail`, and this string comes from the classifier.
    quarantine_reason: typeof reason === "string" && reason.trim() ? reason.trim() : null,
    error: DISPATCH_REFUSAL_ERROR,
  };
}

/** An artifact row as read back from `public.artifacts` for this purpose. */
export type QuarantineRow = {
  kind?: unknown;
  value?: unknown;
  metadata?: unknown;
};

/**
 * Build the refused-key set from persisted artifacts.
 *
 * `normalize` is injected rather than imported so this module stays free of the
 * circuit/cache import graph and can be unit-tested on its own; callers pass
 * `circuit.normalizeSelector` so the key matches what dispatch computes.
 *
 * Only `subject_unlinked === true` AND NOT `linkage_confirmed === true` refuses —
 * the same predicate as `src/lib/quarantine.ts`'s `isQuarantined`. An explicit
 * human linkage decision is the ONLY thing that clears it; ordinary attestation
 * (`reviewed`, "confirmed", "key") answers "is this value real?", never "does it
 * belong to the subject?".
 */
export function buildRefusedKeys(
  rows: readonly QuarantineRow[] | null | undefined,
  normalize: (kind: string, raw: unknown) => string,
): Set<string> {
  const out = new Set<string>();
  for (const row of rows ?? []) {
    const meta = row?.metadata;
    if (!isSubjectUnlinked(meta)) continue;
    if ((meta as Record<string, unknown> | null)?.linkage_confirmed === true) continue;
    const kind = typeof row.kind === "string" ? row.kind : "";
    const raw = typeof row.value === "string" ? row.value : "";
    if (!kind || !raw) continue;
    const norm = normalize(kind, raw);
    if (norm) out.add(dispatchKey(kind, norm));
  }
  return out;
}

/** The quarantine reason for a refused key, for the refusal message. */
export function reasonForKey(
  rows: readonly QuarantineRow[] | null | undefined,
  normalize: (kind: string, raw: unknown) => string,
  selectorType: string,
  normalizedValue: string,
): string | null {
  const want = dispatchKey(selectorType, normalizedValue);
  for (const row of rows ?? []) {
    const kind = typeof row.kind === "string" ? row.kind : "";
    const raw = typeof row.value === "string" ? row.value : "";
    if (!kind || !raw) continue;
    if (dispatchKey(kind, normalize(kind, raw)) !== want) continue;
    const r = (row.metadata as Record<string, unknown> | null)?.subject_unlinked_reason;
    if (typeof r === "string" && r.trim()) return r.trim();
  }
  return null;
}

// ── reading the thread COMPLETELY ─────────────────────────────────────────────
//
// The refused-key set is only as good as the read that builds it. The first build
// issued ONE unbounded `.select().eq()`, which PostgREST answers with at most
// `db-max-rows` rows and NO error — a well-formed, short 200. So on a thread
// longer than that cap the set was built from a prefix and every quarantined
// selector past it dispatched normally. The boundary reopened silently, and it did
// so on exactly the threads it exists for: a name-only harvest is what makes a
// thread long enough to cross the cap in the first place.

/** Rows requested per round-trip. The server may return fewer; the loop copes. */
export const REFUSED_ARTIFACT_PAGE_SIZE = 1000;
/**
 * Hard ceiling on rows scanned for one thread, so a runaway thread cannot spin the
 * loop forever. Production's largest thread is 351 rows (measured 2026-08-31 over
 * 9,877 artifacts across 186 threads), so this is ~57x headroom, and reaching it is
 * disclosed rather than silently treated as the end of the thread.
 */
export const REFUSED_ARTIFACT_SCAN_MAX = 20000;

/** One page as PostgREST returns it. */
export type RefusedArtifactPage = {
  data?: readonly QuarantineRow[] | null;
  count?: number | null;
  error?: { message?: string } | null;
};

/** Fetch rows `[from, to]` inclusive. Injected so this stays free of the DB client. */
export type RefusedArtifactReader = (from: number, to: number) => Promise<RefusedArtifactPage>;

export type RefusedArtifactRead = {
  keys: Set<string>;
  rows: QuarantineRow[];
  /** True only when the whole thread was read. Callers must not cache a `false`. */
  complete: boolean;
  scanned: number;
  /** Why the read stopped short, for the log. Null when `complete`. */
  reason: string | null;
};

/**
 * Read every artifact on a thread, page by page, and build the refused-key set.
 *
 * ── THE THREE THINGS THAT MAKE THIS COMPLETE ─────────────────────────────────
 *
 * 1. IT ADVANCES BY ROWS ACTUALLY RETURNED, never by the page size it asked for.
 *    `db-max-rows` is PostgREST container config, not a database setting — it is
 *    not readable from SQL (`pgrst.db_max_rows` is absent from `pg_db_role_setting`
 *    on this project, checked 2026-08-31), so no constant here can be trusted to
 *    match it. A loop that assumed its requested window was honoured would step
 *    straight over every row the server trimmed, which is the same defect one level
 *    down. Advancing by `page.length` makes the loop correct for ANY server cap,
 *    including one changed later in the dashboard, and removes the need to know it.
 *
 * 2. IT ENDS ON EVIDENCE, NOT ON A SHORT PAGE. A short page is ambiguous: it means
 *    either "thread exhausted" or "the server trimmed this window". Only an empty
 *    page, or `count` (the true unpaged total) being reached, ends the scan.
 *
 * 3. ORDERING IS APPEND-ONLY AND TOTAL. The caller orders by `created_at, id`, so
 *    rows written DURING the scan — `auto-persist-findings` runs in the same request
 *    — land at the tail and cannot shift a row backwards past the cursor, which is
 *    how offset paging skips rows. `id` breaks `created_at` ties, so the order is
 *    total and pages cannot overlap. Duplicates would be harmless anyway (`keys` is
 *    a Set) but skips would not be.
 *
 * Typical cost is ONE round-trip: `count: "exact"` arrives with page one, and every
 * production thread fits in a single page, so the loop exits on `rows.length >= total`
 * without a probe request.
 *
 * ── AND THE ONE THING IT DELIBERATELY DOES NOT DO ────────────────────────────
 *
 * It does not fail closed. An incomplete read yields the keys it did get — which are
 * still SOUND, every one of them a genuine quarantine — plus `complete: false` so the
 * caller can refuse to cache it and say so in the log. Failing closed would refuse
 * every tool call in the run on a transient artifacts read, converting a database
 * blip into a total investigation outage and writing a chain-of-custody record that
 * claims the whole thread was quarantined. This boundary is a cost-and-contamination
 * control; the authorization boundaries (write, read-back, promote) are separate,
 * still bind, and are unaffected by this read failing.
 */
export async function loadRefusedArtifacts(
  read: RefusedArtifactReader,
  normalize: (kind: string, raw: unknown) => string,
): Promise<RefusedArtifactRead> {
  const rows: QuarantineRow[] = [];
  let complete = false;
  let reason: string | null = null;
  let total: number | null = null;
  let from = 0;

  while (from < REFUSED_ARTIFACT_SCAN_MAX) {
    const to = Math.min(from + REFUSED_ARTIFACT_PAGE_SIZE, REFUSED_ARTIFACT_SCAN_MAX) - 1;
    let page: RefusedArtifactPage;
    try {
      page = await read(from, to);
    } catch (e) {
      reason = `page ${from}-${to} threw: ${e instanceof Error ? e.message : String(e)}`;
      break;
    }
    if (page?.error) {
      // A FAILED PAGE IS NOT AN EMPTY THREAD. Keep the rows already in hand — their
      // keys are real refusals — and report the read as partial.
      reason = `page ${from}-${to} failed: ${page.error.message ?? "unknown error"}`;
      break;
    }
    const got = Array.isArray(page?.data) ? page.data : null;
    if (!got) {
      reason = `page ${from}-${to} returned no rows array`;
      break;
    }
    rows.push(...got);
    if (typeof page.count === "number") total = page.count;
    if (got.length === 0) { complete = true; break; }
    from += got.length;
    if (total !== null && rows.length >= total) { complete = true; break; }
  }
  if (!complete && reason === null) {
    reason = `scan ceiling ${REFUSED_ARTIFACT_SCAN_MAX} reached`;
  }
  return { keys: buildRefusedKeys(rows, normalize), rows, complete, scanned: rows.length, reason };
}
