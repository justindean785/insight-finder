/**
 * lib/memory-supersession.ts — a human rejection outranks a model memory.
 *
 * agent_memory holds two kinds of truth side by side and, until this module,
 * treated them the same: the agent's own end-of-run identity theories
 * ("this handle belonged to X and was transferred", confidence 74) and the
 * analyst's Wrong/Dismiss lessons ("Analyst marked X as FALSE", confidence 95).
 * Both were recalled, both were fed to the planner, ordered by confidence.
 *
 * Live case, thread b74049ad (2026-09-08): before the analyst reviewed anything,
 * the agent saved a confidence-74 theory that `glitterkittens12` belonged to
 * "Diamond Nicole" in Springfield and a confidence-60 identity memory linking the
 * Instagram to `dgoff1276@gmail.com` and `104.54.98.171`. The analyst then marked
 * that whole branch Wrong, which wrote 95-confidence lessons — and did NOT
 * invalidate the theories. The planner could recall both "this is probably the
 * prior owner" and "this is a confirmed false positive" for the same selector, in
 * the same prompt.
 *
 * This module fixes that at READ time and at WRITE time, with no schema change:
 *   - read:  a positive memory (identity / connection / pattern, or a lesson
 *            that is not an analyst FALSE marker) that ASSERTS a rejected selector
 *            is returned as `superseded`, not `active`. The row is untouched —
 *            audit history is preserved; it simply carries no authority.
 *   - write: a new positive memory asserting a selector the analyst has
 *            rejected in the current thread is refused before it can reach
 *            agent_memory, whose upsert ratchets confidence with GREATEST(old,new)
 *            and therefore can never be walked back after the fact.
 *
 * What counts as a rejected selector comes from two places, and both are human:
 *   1. analyst FALSE lessons present in the recalled rows themselves (the
 *      cross-investigation carrier of the decision — see the writer in
 *      src/lib/analyst-decisions.ts, whose wording ANALYST_FALSE_LESSON_RE pins);
 *   2. the current thread's Wrong/Dismiss reviews (the freshest decision).
 *
 * KEYSPACE — deliberately NOT the punctuation-collapsing normalizer. A memory
 * asserts a selector when its `subject` or a `related_values` entry equals the
 * rejected value under lower()/trim(), which is exactly how save_agent_memories
 * stores both columns. Free-text `content` is consulted for EMAIL-shaped selectors
 * only (the same rule memory_consolidate.ts applies), because an email is
 * unambiguous in prose and a name is not. Nothing here does substring matching
 * on arbitrary values — that is how a rejected `name` would suppress an
 * unrelated `username` (the hazard CLAUDE.md documents).
 */

export interface MemoryRow {
  id?: unknown;
  kind?: string | null;
  subject?: string | null;
  subject_kind?: string | null;
  related_values?: readonly string[] | null;
  content?: string | null;
  confidence?: number | null;
  created_at?: string | null;
  [k: string]: unknown;
}

/** A proposed memory_save entry (mirrors MemoryEntry in memory_consolidate.ts). */
export interface MemoryWrite {
  kind: string;
  subject: string;
  subject_kind?: string | null;
  related_values?: readonly string[] | null;
  content: string;
  confidence?: number;
}

/**
 * The analyst's Wrong → lesson wording, as written by src/lib/analyst-decisions.ts
 * `buildFalsePositiveLesson`. Production rows already carry this text, so the
 * reader recognises the SHIPPED wording rather than a new marker. A frontend test
 * pins the builder to this pattern so the two sides cannot drift silently.
 */
export const ANALYST_FALSE_LESSON_RE =
  /^\s*analyst marked\s+".+?"(?:\s*\([^)]*\))?\s+as\s+false\s*\/\s*incorrect data/i;

/** Memory kinds that make a POSITIVE claim about who a selector belongs to. */
const POSITIVE_KINDS = new Set(["identity", "connection", "pattern"]);

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
/** Below this a "selector" is too short to be one ("us", "ca") — never match it. */
const MIN_SELECTOR_LEN = 3;

/** The memory table's own key: lower(trim()). Not normalizeTarget — see header. */
export function memoryNorm(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

export function isAnalystFalseLesson(row: MemoryRow): boolean {
  return memoryNorm(row.kind) === "lesson" && ANALYST_FALSE_LESSON_RE.test(String(row.content ?? ""));
}

/** Rejected selector VALUES from the current thread's Wrong/Dismiss rows. */
export function rejectedSelectorsFromRows(
  rows: ReadonlyArray<{ value?: unknown }> | null | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const r of rows ?? []) {
    const v = memoryNorm(r?.value);
    if (v.length >= MIN_SELECTOR_LEN) out.add(v);
  }
  return out;
}

/** Rejected selector VALUES carried by analyst FALSE lessons among `rows`. */
export function rejectedSelectorsFromLessons(rows: ReadonlyArray<MemoryRow>): Set<string> {
  const out = new Set<string>();
  for (const r of rows) {
    if (!isAnalystFalseLesson(r)) continue;
    const v = memoryNorm(r.subject);
    if (v.length >= MIN_SELECTOR_LEN) out.add(v);
  }
  return out;
}

/**
 * Does this memory ASSERT the selector — name it as its subject, list it as a
 * related value, or (emails only) mention it in its content?
 */
export function memoryAssertsSelector(row: MemoryRow | MemoryWrite, selector: string): boolean {
  const sel = memoryNorm(selector);
  if (sel.length < MIN_SELECTOR_LEN) return false;
  if (memoryNorm(row.subject) === sel) return true;
  for (const rv of row.related_values ?? []) if (memoryNorm(rv) === sel) return true;
  if (EMAIL_RE.test(sel)) {
    const content = memoryNorm(row.content);
    if (content.includes(sel)) return true;
  }
  return false;
}

export interface SupersededMemory {
  row: MemoryRow;
  /** the rejected selector the row asserted */
  selector: string;
  source: "analyst_lesson" | "thread_review";
}

export interface SupersessionResult {
  active: MemoryRow[];
  superseded: SupersededMemory[];
}

/**
 * Partition recalled memory into what may carry authority and what a human has
 * since overruled. Analyst FALSE lessons are always active — they ARE the ruling.
 */
export function applyMemorySupersession(
  rows: ReadonlyArray<MemoryRow> | null | undefined,
  threadRejectedRows: ReadonlyArray<{ value?: unknown }> | null | undefined,
): SupersessionResult {
  const list = Array.isArray(rows) ? rows : [];
  const fromLessons = rejectedSelectorsFromLessons(list);
  const fromThread = rejectedSelectorsFromRows(threadRejectedRows);
  const active: MemoryRow[] = [];
  const superseded: SupersededMemory[] = [];
  for (const row of list) {
    if (isAnalystFalseLesson(row)) { active.push(row); continue; }
    const kind = memoryNorm(row.kind);
    // Only claims about who a selector belongs to can contradict a rejection.
    // A neutral lesson ("breach DB Y has stale phones") is not one.
    const positive = POSITIVE_KINDS.has(kind) || kind === "lesson";
    if (!positive) { active.push(row); continue; }
    let hit: SupersededMemory | null = null;
    for (const sel of fromThread) {
      if (memoryAssertsSelector(row, sel)) { hit = { row, selector: sel, source: "thread_review" }; break; }
    }
    if (!hit) {
      for (const sel of fromLessons) {
        if (memoryAssertsSelector(row, sel)) { hit = { row, selector: sel, source: "analyst_lesson" }; break; }
      }
    }
    if (hit) superseded.push(hit); else active.push(row);
  }
  return { active, superseded };
}

export interface RefusedWrite<T extends MemoryWrite> {
  entry: T;
  selector: string;
  reason: string;
}

/**
 * The write gate. A positive memory (identity / connection / pattern) that asserts
 * a selector the analyst has rejected is refused — never persisted, returned with a
 * reason so the caller can log it to memory_merge_candidates as `blocked`. Lessons
 * pass: an agent lesson may legitimately record that a selector WAS a false lead.
 */
export function refuseConflictingMemoryWrites<T extends MemoryWrite>(
  entries: ReadonlyArray<T>,
  rejectedSelectors: ReadonlySet<string>,
): { toPersist: T[]; refused: RefusedWrite<T>[] } {
  const toPersist: T[] = [];
  const refused: RefusedWrite<T>[] = [];
  for (const e of entries) {
    const kind = memoryNorm(e.kind);
    let hit: string | null = null;
    if (POSITIVE_KINDS.has(kind)) {
      for (const sel of rejectedSelectors) {
        if (memoryAssertsSelector(e, sel)) { hit = sel; break; }
      }
    }
    if (hit) {
      refused.push({
        entry: e,
        selector: hit,
        reason: `conflicts with an active analyst rejection of "${hit}" in this thread — a rejected selector cannot be written back as ${kind} memory`,
      });
    } else {
      toPersist.push(e);
    }
  }
  return { toPersist, refused };
}
