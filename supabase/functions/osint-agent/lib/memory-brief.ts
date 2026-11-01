// lib/memory-brief.ts — M1: tool lessons from prior runs, injected at run start as CONTEXT.
//
// agent_memory already holds hundreds of lessons about how tools behave, but `memory_recall` matches on
// `subject` only, so a lesson learned about a TOOL is filed under the SELECTOR it was learned on and never
// resurfaces for the next case. This module adds the second axis: rows whose subject is `tool:<name>` are read
// once per request and rendered as a short block appended to the intermediate system prompt (the same channel
// as the resume brief in lib/next-pivot.ts), so the byte-identical cached base prompt, the finalize prompt and
// the salvage prompt are untouched.
//
// What a lesson may do: change WHICH tool the model tries or skips, and in what order.
// What it may never do: act as a source, corroborate a claim, raise a confidence cap or make anything verified.
// The block says so in its own header; that sentence is WORDING. The enforcement that memory is not evidence is
// lib/memory-context.ts on the record_artifacts write path (#721) plus the promote/report gates, and the fact
// that this block only ever reaches `intermediateSystem` (pinned by memory_brief_wiring_test.ts).
//
// ELIGIBILITY (hardening, 2026-10-31 — docs/plans/2026-10-31-intelligence-memory-plan.md §4.5). A row reaches the
// block only if ALL hold; the query enforces them server-side and `buildMemoryBrief` re-checks every row it is
// handed, so a widened query cannot leak on its own:
//   owner        user_id = the requesting user                          (query; RLS-asserted in CI)
//   scope        'global' — a case-scoped row is about ONE investigation (query + builder)
//   kind         'lesson' — patterns/connections/identity are selector memory, not this axis (query + builder)
//   registered   subject ∈ tool:<canonical name> ∪ tool:<alias key> for THIS run's registry (query + builder);
//                querying the registered set, rather than `LIKE 'tool:%'`, is what removes fetch-window
//                starvation: 40 rows about retired tools can no longer crowd out the eligible ones
//   freshness    created_at within MEMORY_BRIEF_MAX_AGE_DAYS (query + builder). created_at, NOT updated_at:
//                the agent_memory_updated_at trigger fires on every re-save, so updated_at proves nothing about
//                recent supporting evidence
//   not a marker the analyst false-positive wording is a selector EXCLUSION, never a tool lesson (builder)
//   provenance   none is recorded on agent_memory (no writer column); every row is `unreviewed`. M2's table
//                carries real provenance; until then the rules above are the whole safety case.
// SELECTION is deterministic: created_at desc, id asc, at most MEMORY_BRIEF_PER_TOOL_MAX rows per tool (a chatty
// tool cannot starve a quiet one), then the row/char caps. `confidence` and `hit_count` are never consulted:
// the upsert ratchets confidence with GREATEST(old,new) and bumps hit_count on re-save, so neither measures
// anything this block should rank by.
//
// Never rejects, carries its own deadline (which ABORTS the query, not just the wait), and an unreadable store
// means NO block — the run is unaffected. Telemetry is counts and reasons only: no lesson body, no row id, no
// hash, no invocation id (attribution is a separate approval unit, plan §4.11).
// Kill switches, read at call time: MEMORY_BRIEF_DISABLED=true (no block at all);
// MEMORY_BRIEF_LEGACY_ROWS=false (do not read agent_memory rows — today the only source).

import { isAnalystFalseLesson } from "./memory-supersession.ts";

type EnvReader = (k: string) => string | undefined;

function readEnvSafe(k: string): string | undefined {
  try {
    return (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(k);
  } catch {
    return undefined;
  }
}

export function memoryBriefDisabled(env: EnvReader = readEnvSafe): boolean {
  return (env("MEMORY_BRIEF_DISABLED") ?? "").trim().toLowerCase() === "true";
}

/** Default ON. `false` stops the agent_memory read entirely (the brief is then empty until another source exists). */
export function memoryBriefLegacyRowsEnabled(env: EnvReader = readEnvSafe): boolean {
  return (env("MEMORY_BRIEF_LEGACY_ROWS") ?? "").trim().toLowerCase() !== "false";
}

export const TOOL_LESSON_PREFIX = "tool:";
export const MEMORY_BRIEF_MAX_CHARS = 1600;
export const MEMORY_BRIEF_MAX_ROWS = 12;
export const MEMORY_BRIEF_PER_TOOL_MAX = 2;
export const MEMORY_BRIEF_MAX_AGE_DAYS = 90;
/** Rows read from the store, AFTER the server-side registered-subject filter; the per-tool cap and render caps apply next. */
export const MEMORY_BRIEF_FETCH_LIMIT = 120;
const ROW_CONTENT_CHARS = 220;
const READ_DEADLINE_MS = 2500;
const DAY_MS = 86_400_000;

export function toolLessonSubject(name: string): string {
  return `${TOOL_LESSON_PREFIX}${String(name ?? "").trim().toLowerCase()}`;
}

export function freshnessCutoffIso(nowMs: number = Date.now()): string {
  return new Date(nowMs - MEMORY_BRIEF_MAX_AGE_DAYS * DAY_MS).toISOString();
}

/** The alias key's canonical name when the canonical tool is registered; the name itself when registered; else "". */
export function canonicalToolName(
  name: string,
  availableTools: ReadonlySet<string>,
  aliases: Readonly<Record<string, string>> = {},
): string {
  const n = String(name ?? "").trim().toLowerCase();
  if (!n) return "";
  if (availableTools.has(n)) return n;
  const target = aliases[n];
  return target && availableTools.has(target) ? target : "";
}

/** `tool:<name>` for every registered tool plus every alias key that resolves to a registered tool. Deduplicated. */
export function registeredToolSubjects(
  toolNames: Iterable<string>,
  aliases: Readonly<Record<string, string>> = {},
): string[] {
  const available = new Set(Array.from(toolNames, (t) => String(t).trim().toLowerCase()).filter(Boolean));
  const out = new Set<string>();
  for (const t of available) out.add(toolLessonSubject(t));
  for (const [alias, target] of Object.entries(aliases)) {
    if (available.has(String(target).trim().toLowerCase())) out.add(toolLessonSubject(alias));
  }
  return Array.from(out);
}

export type BriefMemoryRow = {
  id?: unknown;
  kind?: unknown;
  scope?: unknown;
  subject?: unknown;
  content?: unknown;
  confidence?: unknown;
  hit_count?: unknown;
  created_at?: unknown;
};

export type IneligibleReason = "scope" | "kind" | "stale" | "false_marker" | "unregistered" | "empty" | "per_tool_cap";
export type MemoryBriefReason = "injected" | "disabled" | "no_rows";
export type MemoryBriefOutcome = {
  text: string;
  reason: MemoryBriefReason;
  stats: {
    /** tool:-keyed rows handed to the builder (selector memories are not counted). */
    rows: number;
    injected: number;
    /** Rows that carried a tool: subject but failed an eligibility rule or the per-tool cap. */
    droppedIneligible: number;
    reasons: Record<IneligibleReason, number>;
    truncated: boolean;
    chars: number;
  };
};

const HEADER =
  "## TOOL LESSONS FROM PRIOR RUNS (context, not evidence)\n" +
  "How these tools behaved in earlier investigations. They may be stale. A lesson changes which tool you try or skip, " +
  "never what a finding means: it is not a source, not corroboration, and a tool that worked before proves nothing now. " +
  "If a lesson says a tool failed and it is the only route to a selector, one fresh attempt is still fine.\n";

/** One line of untrusted text: control chars dropped, whitespace collapsed, bounded. Structural hygiene only — a
 *  lesson cannot open a new heading or line in the prompt. It is NOT semantic prompt-injection protection. */
function oneLine(v: unknown, max: number): string {
  let spaced = "";
  for (const ch of String(v ?? "")) {
    const c = ch.codePointAt(0) ?? 0;
    spaced += c < 32 || c === 127 ? " " : ch;
  }
  const s = spaced.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function rawToolName(subject: unknown): string {
  const s = String(subject ?? "").trim().toLowerCase();
  return s.startsWith(TOOL_LESSON_PREFIX) ? s.slice(TOOL_LESSON_PREFIX.length).trim() : "";
}

function createdMs(v: unknown): number {
  const t = typeof v === "number" ? v : Date.parse(String(v ?? ""));
  return Number.isFinite(t) ? t : NaN;
}

const emptyReasons = (): Record<IneligibleReason, number> => ({
  scope: 0, kind: 0, stale: 0, false_marker: 0, unregistered: 0, empty: 0, per_tool_cap: 0,
});

export function buildMemoryBrief(
  args: {
    rows: ReadonlyArray<BriefMemoryRow>;
    /** This run's registry. Absent ⇒ no registry check (tests only); index.ts always passes it. */
    availableTools?: ReadonlySet<string>;
    aliases?: Readonly<Record<string, string>>;
    disabled?: boolean;
    now?: () => number;
  },
): MemoryBriefOutcome {
  const reasons = emptyReasons();
  const empty = (reason: MemoryBriefReason, rows = 0, droppedIneligible = 0): MemoryBriefOutcome => ({
    text: "", reason, stats: { rows, injected: 0, droppedIneligible, reasons, truncated: false, chars: 0 },
  });
  if (args.disabled ?? memoryBriefDisabled()) return empty("disabled");

  const nowMs = (args.now ?? Date.now)();
  const cutoff = nowMs - MEMORY_BRIEF_MAX_AGE_DAYS * DAY_MS;
  const aliases = args.aliases ?? {};

  type Eligible = { row: BriefMemoryRow; tool: string; content: string; created: number; id: string };
  const tooled: BriefMemoryRow[] = [];
  const eligible: Eligible[] = [];
  let dropped = 0;
  const drop = (r: IneligibleReason) => { reasons[r]++; dropped++; };

  for (const r of Array.isArray(args.rows) ? args.rows : []) {
    const raw = rawToolName(r?.subject);
    if (!raw) continue; // not this axis; not counted
    tooled.push(r);
    // Re-check every server-side predicate: the builder must be safe even if the query is widened.
    if (String(r.scope ?? "").trim().toLowerCase() !== "global") { drop("scope"); continue; }
    if (String(r.kind ?? "").trim().toLowerCase() !== "lesson") { drop("kind"); continue; }
    const created = createdMs(r.created_at);
    if (!Number.isFinite(created) || created < cutoff) { drop("stale"); continue; }
    if (isAnalystFalseLesson({ kind: String(r.kind), content: String(r.content ?? "") })) { drop("false_marker"); continue; }
    const tool = args.availableTools ? canonicalToolName(raw, args.availableTools, aliases) : raw;
    if (!tool) { drop("unregistered"); continue; }
    const content = oneLine(r.content, ROW_CONTENT_CHARS);
    if (!content) { drop("empty"); continue; }
    eligible.push({ row: r, tool, content, created, id: String(r.id ?? "") });
  }
  if (eligible.length === 0) return empty("no_rows", tooled.length, dropped);

  // Deterministic: newest first, then id. Nothing else may influence the order.
  eligible.sort((a, b) => (b.created - a.created) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const perTool = new Map<string, number>();
  let text = HEADER;
  let injected = 0;
  let truncated = false;
  for (const e of eligible) {
    const seen = perTool.get(e.tool) ?? 0;
    if (seen >= MEMORY_BRIEF_PER_TOOL_MAX) { drop("per_tool_cap"); continue; }
    if (injected >= MEMORY_BRIEF_MAX_ROWS) { truncated = true; break; }
    const line = `- ${TOOL_LESSON_PREFIX}${e.tool} — ${e.content}\n`;
    if (text.length + line.length > MEMORY_BRIEF_MAX_CHARS) { truncated = true; break; }
    text += line;
    perTool.set(e.tool, seen + 1);
    injected++;
  }
  if (injected === 0) return empty("no_rows", tooled.length, dropped);
  text = text.replace(/\n$/, "");
  return {
    text,
    reason: "injected",
    stats: { rows: tooled.length, injected, droppedIneligible: dropped, reasons, truncated, chars: text.length },
  };
}

// ---- loading -----------------------------------------------------------------------------------

export type ToolLessonRead = { data: BriefMemoryRow[] | null; error: { message?: string } | null };
export type ToolLessonLoad = { rows: BriefMemoryRow[]; reason: "ok" | "read_failed" | "deadline"; ms: number };

/** The minimal PostgREST chain the query uses. index.ts passes the real supabase-js client; the isolation test passes
 *  a recording fake. Typed structurally here so neither needs a cast at the call site. */
type ToolLessonChain = {
  eq(k: string, v: unknown): ToolLessonChain;
  in(k: string, v: ReadonlyArray<string>): ToolLessonChain;
  gte(k: string, v: unknown): ToolLessonChain;
  order(k: string, o: { ascending: boolean }): ToolLessonChain;
  limit(n: number): ToolLessonChain;
  abortSignal(s: AbortSignal): PromiseLike<ToolLessonRead>;
};
type ToolLessonDb = { from(table: string): { select(cols: string): ToolLessonChain } };

/**
 * The ONE query. Every eligibility predicate the builder re-checks is applied here first, so the fetch window
 * only ever holds rows that can be used (no starvation by retired tools), ordered deterministically, bounded,
 * and cancellable through `signal`.
 */
export function toolLessonQuery(
  db: unknown,
  args: { userId: string; subjects: ReadonlyArray<string>; cutoffIso: string; signal: AbortSignal },
): PromiseLike<ToolLessonRead> {
  const q = (db as ToolLessonDb).from("agent_memory")
    .select("id,kind,scope,subject,content,confidence,hit_count,created_at")
    .eq("user_id", args.userId)
    .eq("scope", "global")
    .eq("kind", "lesson")
    .in("subject", args.subjects)
    .gte("created_at", args.cutoffIso)
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(MEMORY_BRIEF_FETCH_LIMIT)
    .abortSignal(args.signal);
  return q;
}

/** Run the read behind a deadline that ABORTS it. Never rejects; any failure is "no lessons", reported by reason. */
export async function loadToolLessons(
  read: (signal: AbortSignal) => PromiseLike<ToolLessonRead>,
  opts: { deadlineMs?: number; now?: () => number } = {},
): Promise<ToolLessonLoad> {
  const now = opts.now ?? Date.now;
  const started = now();
  const done = (rows: BriefMemoryRow[], reason: ToolLessonLoad["reason"]): ToolLessonLoad => ({ rows, reason, ms: now() - started });
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => { ctrl.abort(); resolve("deadline"); }, opts.deadlineMs ?? READ_DEADLINE_MS);
    });
    const res = await Promise.race([Promise.resolve().then(() => read(ctrl.signal)), deadline]);
    if (res === "deadline") return done([], "deadline");
    if (res.error || !Array.isArray(res.data)) return done([], "read_failed");
    return done(res.data, "ok");
  } catch {
    return done([], "read_failed");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ---- observability -----------------------------------------------------------------------------

/** Counts and reasons only — never a lesson body, a row id or a hash (a lesson can name a selector; ids and hashes
 *  are attribution, which is a separately approved unit). */
export function memoryBriefEvent(
  threadId: string,
  outcome: MemoryBriefOutcome,
  extra: { ms?: number; readReason?: string | null } = {},
): Record<string, unknown> {
  return {
    event: outcome.text ? "memory_brief" : "memory_brief_skipped",
    thread_id: threadId,
    injected: !!outcome.text,
    reason: outcome.reason,
    rows: outcome.stats.rows,
    injected_rows: outcome.stats.injected,
    dropped_ineligible: outcome.stats.droppedIneligible,
    reasons: { ...outcome.stats.reasons },
    truncated: outcome.stats.truncated,
    chars: outcome.stats.chars,
    ms: extra.ms ?? null,
    read_reason: extra.readReason ?? null,
  };
}

/** /health proof. PRESENCE proves the deployed bundle; the wiring itself is pinned by memory_brief_wiring_test.ts. */
export function memoryBriefSelfTest(): { ok: boolean; switch: string; detail: string } {
  if (memoryBriefDisabled()) {
    return { ok: true, switch: "MEMORY_BRIEF_DISABLED", detail: "LEGACY via MEMORY_BRIEF_DISABLED: no tool-lesson brief is built" };
  }
  const now = Date.parse("2026-10-31T00:00:00Z");
  const fresh = new Date(now - 2 * DAY_MS).toISOString();
  const stale = new Date(now - (MEMORY_BRIEF_MAX_AGE_DAYS + 5) * DAY_MS).toISOString();
  const probe = buildMemoryBrief({
    rows: [
      { id: "1", kind: "lesson", scope: "global", subject: "tool:probe_tool", content: "probe lesson", created_at: fresh },
      { id: "2", kind: "lesson", scope: "global", subject: "tool:probe_alias", content: "alias lesson", created_at: fresh },
      { id: "3", kind: "lesson", scope: "global", subject: "probe@example.test", content: "selector memory is not this axis", created_at: fresh },
      { id: "4", kind: "lesson", scope: "global", subject: "tool:gone_tool", content: "retired", created_at: fresh },
      { id: "5", kind: "pattern", scope: "global", subject: "tool:probe_tool", content: "a pattern, not a lesson", created_at: fresh },
      { id: "6", kind: "lesson", scope: "case", subject: "tool:probe_tool", content: "case-scoped", created_at: fresh },
      { id: "7", kind: "lesson", scope: "global", subject: "tool:probe_tool", content: "too old", created_at: stale },
    ],
    availableTools: new Set(["probe_tool"]),
    aliases: { probe_alias: "probe_tool" },
    disabled: false,
    now: () => now,
  });
  const s = probe.stats;
  const ok = probe.reason === "injected" &&
    s.injected === 2 && s.droppedIneligible === 4 &&
    s.reasons.unregistered === 1 && s.reasons.kind === 1 && s.reasons.scope === 1 && s.reasons.stale === 1 &&
    probe.text.includes("context, not evidence") && probe.text.includes("tool:probe_tool — probe lesson") &&
    probe.text.includes("tool:probe_tool — alias lesson") && !probe.text.includes("probe_alias") &&
    !probe.text.includes("probe@example.test") && !probe.text.includes("gone_tool") &&
    !probe.text.includes("a pattern") && !probe.text.includes("case-scoped") && !probe.text.includes("too old") &&
    probe.text.length <= MEMORY_BRIEF_MAX_CHARS &&
    buildMemoryBrief({ rows: [], disabled: false }).reason === "no_rows" &&
    registeredToolSubjects(["probe_tool"], { probe_alias: "probe_tool", other: "missing" }).length === 2;
  return {
    ok,
    switch: "MEMORY_BRIEF_DISABLED",
    detail: ok
      ? "tool: lessons render as capped context-only text; selector memories, non-lesson kinds, case scope, stale rows and unregistered tools are excluded; aliases resolve to canonical names"
      : "memory brief self-probe failed",
  };
}
