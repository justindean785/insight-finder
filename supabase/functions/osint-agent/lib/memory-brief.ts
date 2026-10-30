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
// The block says so in its own header (see lib/memory-provenance.ts for the same rule on recalled memory).
//
// Never rejects, carries its own deadline, and an unreadable store means NO block — the run is unaffected.
// Kill switch, read at call time: MEMORY_BRIEF_DISABLED=true.

function readEnvSafe(k: string): string | undefined {
  try {
    return (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(k);
  } catch {
    return undefined;
  }
}

export function memoryBriefDisabled(env: (k: string) => string | undefined = readEnvSafe): boolean {
  return (env("MEMORY_BRIEF_DISABLED") ?? "").trim().toLowerCase() === "true";
}

export const TOOL_LESSON_PREFIX = "tool:";
export const MEMORY_BRIEF_MAX_CHARS = 1600;
export const MEMORY_BRIEF_MAX_ROWS = 12;
/** Rows read from the store; the render caps are applied after the registry filter. */
export const MEMORY_BRIEF_FETCH_LIMIT = 40;
const ROW_CONTENT_CHARS = 220;
const READ_DEADLINE_MS = 2500;

export function toolLessonSubject(name: string): string {
  return `${TOOL_LESSON_PREFIX}${String(name ?? "").trim().toLowerCase()}`;
}

export type BriefMemoryRow = {
  id?: unknown;
  kind?: unknown;
  subject?: unknown;
  content?: unknown;
  confidence?: unknown;
  hit_count?: unknown;
};

export type MemoryBriefReason = "injected" | "disabled" | "no_rows";
export type MemoryBriefOutcome = {
  text: string;
  reason: MemoryBriefReason;
  stats: { rows: number; injected: number; droppedUnavailable: number; truncated: boolean; chars: number };
};

const HEADER =
  "## TOOL LESSONS FROM PRIOR RUNS (context, not evidence)\n" +
  "How these tools behaved in earlier investigations. They may be stale. A lesson changes which tool you try or skip, " +
  "never what a finding means: it is not a source, not corroboration, and a tool that worked before proves nothing now. " +
  "If a lesson says a tool failed and it is the only route to a selector, one fresh attempt is still fine.\n";

function num(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** One line of untrusted text: control chars dropped, whitespace collapsed, bounded. */
function oneLine(v: unknown, max: number): string {
  let spaced = "";
  for (const ch of String(v ?? "")) {
    const c = ch.codePointAt(0) ?? 0;
    spaced += c < 32 || c === 127 ? " " : ch;
  }
  const s = spaced.replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function toolName(subject: unknown): string {
  const s = String(subject ?? "").trim().toLowerCase();
  return s.startsWith(TOOL_LESSON_PREFIX) ? s.slice(TOOL_LESSON_PREFIX.length).trim() : "";
}

export function buildMemoryBrief(
  args: { rows: ReadonlyArray<BriefMemoryRow>; availableTools?: ReadonlySet<string>; disabled?: boolean },
): MemoryBriefOutcome {
  const empty = (reason: MemoryBriefReason, rows = 0, droppedUnavailable = 0): MemoryBriefOutcome => ({
    text: "", reason, stats: { rows, injected: 0, droppedUnavailable, truncated: false, chars: 0 },
  });
  if (args.disabled ?? memoryBriefDisabled()) return empty("disabled");

  const tooled = (Array.isArray(args.rows) ? args.rows : []).filter((r) => toolName(r?.subject) !== "");
  let droppedUnavailable = 0;
  const live = tooled.filter((r) => {
    if (!args.availableTools) return true;
    const ok = args.availableTools.has(toolName(r.subject));
    if (!ok) droppedUnavailable++;
    return ok;
  });
  const body = live.filter((r) => oneLine(r.content, 1) !== "");
  if (body.length === 0) return empty("no_rows", tooled.length, droppedUnavailable);

  body.sort((a, b) => num(b.confidence) - num(a.confidence) || num(b.hit_count) - num(a.hit_count));

  let text = HEADER;
  let injected = 0;
  let truncated = false;
  for (const r of body) {
    if (injected >= MEMORY_BRIEF_MAX_ROWS) { truncated = true; break; }
    const line = `- ${TOOL_LESSON_PREFIX}${toolName(r.subject)} — ${oneLine(r.content, ROW_CONTENT_CHARS)}\n`;
    if (text.length + line.length > MEMORY_BRIEF_MAX_CHARS) { truncated = true; break; }
    text += line;
    injected++;
  }
  if (injected === 0) return empty("no_rows", tooled.length, droppedUnavailable);
  text = text.replace(/\n$/, "");
  return { text, reason: "injected", stats: { rows: tooled.length, injected, droppedUnavailable, truncated, chars: text.length } };
}

// ---- loading -----------------------------------------------------------------------------------

export type ToolLessonRead = { data: BriefMemoryRow[] | null; error: { message?: string } | null };
export type ToolLessonLoad = { rows: BriefMemoryRow[]; reason: "ok" | "read_failed" | "deadline"; ms: number };

/** Run the read behind a deadline. Never rejects; any failure is "no lessons", reported by reason. */
export async function loadToolLessons(
  read: () => PromiseLike<ToolLessonRead>,
  opts: { deadlineMs?: number; now?: () => number } = {},
): Promise<ToolLessonLoad> {
  const now = opts.now ?? Date.now;
  const started = now();
  const done = (rows: BriefMemoryRow[], reason: ToolLessonLoad["reason"]): ToolLessonLoad => ({ rows, reason, ms: now() - started });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => resolve("deadline"), opts.deadlineMs ?? READ_DEADLINE_MS);
    });
    const res = await Promise.race([Promise.resolve().then(read), deadline]);
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

/** Counts and a reason only — never a lesson body (a lesson can name a selector). */
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
    dropped_unavailable: outcome.stats.droppedUnavailable,
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
  const probe = buildMemoryBrief({
    rows: [
      { subject: "tool:probe_tool", content: "probe lesson", confidence: 70 },
      { subject: "probe@example.test", content: "selector memory is not this axis", confidence: 99 },
      { subject: "tool:gone_tool", content: "stale", confidence: 90 },
    ],
    availableTools: new Set(["probe_tool"]),
    disabled: false,
  });
  const ok = probe.reason === "injected" &&
    probe.stats.injected === 1 && probe.stats.droppedUnavailable === 1 &&
    probe.text.includes("context, not evidence") && probe.text.includes("tool:probe_tool") &&
    !probe.text.includes("probe@example.test") && !probe.text.includes("gone_tool") &&
    probe.text.length <= MEMORY_BRIEF_MAX_CHARS &&
    buildMemoryBrief({ rows: [], disabled: false }).reason === "no_rows";
  return {
    ok,
    switch: "MEMORY_BRIEF_DISABLED",
    detail: ok
      ? "tool: lessons render as capped context-only text; selector memories and unregistered tools are excluded"
      : "memory brief self-probe failed",
  };
}
