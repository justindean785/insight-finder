// lib/outcome-lessons.ts — fresh planner adaptations derived from durable live-call outcomes.
//
// Stored agent_memory lessons remain the long-term memory axis. This module adds
// a read-only feedback loop: recent cross-case outcomes become synthetic lesson
// rows for the existing memory brief, so the next run can change tool choice or
// retry strategy without treating telemetry as evidence or writing a verdict.

export const OUTCOME_LESSON_WINDOW_DAYS = 14;
export const OUTCOME_LESSON_MIN_ATTEMPTS = 5;
export const OUTCOME_LESSON_MIN_FAILURE_SHARE = 0.6;
export const OUTCOME_LESSON_MIN_THREADS = 2;
export const OUTCOME_LESSON_FETCH_LIMIT = 5000;
const DAY_MS = 86_400_000;

export function outcomeLessonCutoffIso(nowMs: number = Date.now()): string {
  return new Date(nowMs - OUTCOME_LESSON_WINDOW_DAYS * DAY_MS).toISOString();
}

export type OutcomeUsageRow = {
  tool_name: string;
  outcome: string | null;
  cached: boolean | null;
  status_code: number | null;
  error_msg: string | null;
  thread_id: string | null;
  created_at: string;
};

type FailureClass = "credential_plan" | "transport" | "rate_limited" | "input_rejected" | "other";
const CLASS_ORDER: readonly FailureClass[] = ["credential_plan", "transport", "rate_limited", "input_rejected", "other"];
const RATE_RE = /rate.?limit|too many requests|\b429\b/i;
const CREDENTIAL_RE = /unauthori[sz]ed|forbidden|api.?key|permission|subscription|\bplan\b|quota|credit|balance|payment|billing|\b40[123]\b/i;
const TRANSPORT_RE = /timeout|timed out|abort|econn|enotfound|etimedout|fetch failed|network|socket|\bdns\b|unreachable|connection|\b5\d\d\b/i;
const INPUT_RE = /invalid|validation|schema|expected|required|unrecognized|malformed|bad request|must be|not a valid|input/i;

function classify(row: OutcomeUsageRow): FailureClass {
  const code = row.status_code;
  const text = row.error_msg ?? "";
  if (code === 429) return "rate_limited";
  if (code === 401 || code === 402 || code === 403) return "credential_plan";
  if (code === 408 || (code != null && code >= 500 && code <= 599)) return "transport";
  if (code === 400 || code === 422) return "input_rejected";
  if (RATE_RE.test(text)) return "rate_limited";
  if (CREDENTIAL_RE.test(text)) return "credential_plan";
  if (TRANSPORT_RE.test(text)) return "transport";
  if (INPUT_RE.test(text)) return "input_rejected";
  return "other";
}

const LABEL: Record<FailureClass, string> = {
  credential_plan: "plan or credential refusals",
  transport: "timeouts or server errors",
  rate_limited: "rate limiting",
  input_rejected: "rejected inputs",
  other: "unclassified failures",
};
const ADAPTATION: Record<FailureClass, string> = {
  credential_plan: "check plan, permissions and provider policy; corroborate through a source with a different credential",
  transport: "allow one later retry, then corroborate through an independent source",
  rate_limited: "space subsequent calls and use an independent source if the limit persists",
  input_rejected: "validate the selector and schema before retrying; never repeat the rejected call unchanged",
  other: "inspect the failure detail and corroborate independently before spending more attempts",
};

export type DerivedOutcomeLessonRow = {
  id: string;
  kind: "lesson";
  scope: "global";
  subject: string;
  content: string;
  confidence: null;
  hit_count: number;
  created_at: string;
};

/** Deterministic, context-only rows. No raw errors, selectors or case ids enter the prompt. */
export function deriveOutcomeLessonRows(rows: readonly OutcomeUsageRow[], nowMs: number = Date.now()): DerivedOutcomeLessonRow[] {
  const cutoff = nowMs - OUTCOME_LESSON_WINDOW_DAYS * DAY_MS;
  // `failedThreads`, not every thread the tool ran in: the cross-case rule exists so one case's fault cannot
  // steer unrelated investigations, and a success elsewhere must not stand in for a second failing case.
  type Acc = { attempts: number; failed: number; failedThreads: Set<string>; classes: Record<FailureClass, number> };
  const by = new Map<string, Acc>();
  for (const row of rows) {
    if (row.cached !== false || (row.outcome !== "ok" && row.outcome !== "failed")) continue;
    const at = Date.parse(row.created_at);
    const tool = String(row.tool_name ?? "").trim().toLowerCase();
    if (!tool || !Number.isFinite(at) || at < cutoff) continue;
    const acc = by.get(tool) ?? {
      attempts: 0,
      failed: 0,
      failedThreads: new Set<string>(),
      classes: { credential_plan: 0, transport: 0, rate_limited: 0, input_rejected: 0, other: 0 },
    };
    acc.attempts++;
    if (row.outcome === "failed") {
      acc.failed++;
      if (row.thread_id) acc.failedThreads.add(row.thread_id);
      acc.classes[classify(row)]++;
    }
    by.set(tool, acc);
  }

  const createdAt = new Date(nowMs).toISOString();
  return [...by.entries()]
    .filter(([, acc]) =>
      acc.attempts >= OUTCOME_LESSON_MIN_ATTEMPTS &&
      acc.failed / acc.attempts >= OUTCOME_LESSON_MIN_FAILURE_SHARE &&
      acc.failedThreads.size >= OUTCOME_LESSON_MIN_THREADS)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([tool, acc]) => {
      const ranked = CLASS_ORDER.map((kind) => [kind, acc.classes[kind]] as const)
        .filter(([, count]) => count > 0)
        .sort((a, b) => b[1] - a[1]);
      const dominant = ranked.length > 0 && (ranked.length === 1 || ranked[0][1] > ranked[1][1]) ? ranked[0][0] : null;
      const reason = dominant ? `mostly ${LABEL[dominant]}` : "a mix of failure kinds";
      const adaptation = dominant
        ? ADAPTATION[dominant]
        : "inspect the failure mix and corroborate independently before spending more attempts";
      return {
        id: `outcome:${tool}`,
        kind: "lesson",
        scope: "global",
        subject: `tool:${tool}`,
        content: `Observed ${acc.failed} of ${acc.attempts} live attempts fail in ${OUTCOME_LESSON_WINDOW_DAYS} days across ${acc.failedThreads.size} cases; ${reason}. Next run: ${adaptation}.`,
        confidence: null,
        hit_count: 0,
        created_at: createdAt,
      };
    });
}

/** Pure deploy proof: repeated live failures produce bounded planning context, not evidence. */
export function outcomeLessonsSelfTest(): { ok: boolean; detail: string } {
  const now = Date.parse("2026-11-02T12:00:00Z");
  const rows: OutcomeUsageRow[] = Array.from({ length: 6 }, (_, i) => ({
    tool_name: "health_outcome_probe",
    outcome: i < 5 ? "failed" : "ok",
    cached: false,
    status_code: i < 5 ? 503 : null,
    error_msg: i < 5 ? "private health-probe upstream detail" : null,
    thread_id: `probe-case-${i % 2}`,
    created_at: new Date(now - 86_400_000).toISOString(),
  }));
  const lessons = deriveOutcomeLessonRows(rows, now);
  const tooFewAttempts = deriveOutcomeLessonRows(rows.slice(0, 4), now);
  const lesson = lessons[0];
  const ok = lessons.length === 1 && tooFewAttempts.length === 0 &&
    lesson.subject === "tool:health_outcome_probe" && lesson.confidence === null &&
    lesson.content.includes("5 of 6 live attempts fail") && lesson.content.includes("across 2 cases") &&
    lesson.content.includes("one later retry") && !lesson.content.includes("private health-probe") &&
    !lesson.content.includes("probe-case-");
  return {
    ok,
    detail: `14-day, newest-first cap ${OUTCOME_LESSON_FETCH_LIMIT}; lessons require ${OUTCOME_LESSON_MIN_ATTEMPTS} live attempts, ${OUTCOME_LESSON_MIN_FAILURE_SHARE * 100}% failures and ${OUTCOME_LESSON_MIN_THREADS} cases; context only`,
  };
}

export type OutcomeLessonRead = { data: OutcomeUsageRow[] | null; error: { message?: string } | null };
type OutcomeLessonChain = {
  eq(k: string, v: unknown): OutcomeLessonChain;
  gte(k: string, v: unknown): OutcomeLessonChain;
  order(k: string, o: { ascending: boolean }): OutcomeLessonChain;
  limit(n: number): OutcomeLessonChain;
  abortSignal(s: AbortSignal): PromiseLike<OutcomeLessonRead>;
};
type OutcomeLessonDb = { from(table: string): { select(cols: string): OutcomeLessonChain } };

/** Bounded newest-first read; the shared memory-brief deadline aborts it. */
export function toolOutcomeQuery(
  db: unknown,
  args: { userId: string; cutoffIso: string; signal: AbortSignal },
): PromiseLike<OutcomeLessonRead> {
  return (db as OutcomeLessonDb).from("tool_usage_log")
    .select("tool_name,outcome,cached,status_code,error_msg,thread_id,created_at")
    .eq("user_id", args.userId)
    .eq("cached", false)
    .gte("created_at", args.cutoffIso)
    .order("created_at", { ascending: false })
    .limit(OUTCOME_LESSON_FETCH_LIMIT)
    .abortSignal(args.signal);
}

/**
 * The outcome read's OWN deadline, deliberately shorter than memory-brief's shared READ_DEADLINE_MS (2500).
 * `loadToolLessons` races the whole read against that shared timer and resolves EMPTY on expiry, so an outcome
 * read that is still pending then takes the already-loaded stored lessons down with it. Settling first, as
 * "no derived rows", keeps the failure isolated to the rows that are new here.
 */
export const OUTCOME_READ_DEADLINE_MS = 1500;

/** `toolOutcomeQuery` behind its own aborting deadline. Never rejects: any failure is `{ data: null, error }`. */
export function boundedOutcomeRead(
  db: unknown,
  args: { userId: string; cutoffIso: string; signal: AbortSignal },
  deadlineMs: number = OUTCOME_READ_DEADLINE_MS,
): Promise<OutcomeLessonRead> {
  const ctrl = new AbortController();
  const relay = () => ctrl.abort();
  if (args.signal.aborted) ctrl.abort();
  else args.signal.addEventListener("abort", relay, { once: true });
  const failed = (message: string): OutcomeLessonRead => ({ data: null, error: { message } });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<OutcomeLessonRead>((resolve) => {
    timer = setTimeout(() => { ctrl.abort(); resolve(failed("outcome_read_deadline")); }, deadlineMs);
  });
  const read = Promise.resolve()
    .then(() => toolOutcomeQuery(db, { ...args, signal: ctrl.signal }))
    .catch(() => failed("outcome_read_failed"));
  return Promise.race([read, deadline]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    args.signal.removeEventListener("abort", relay);
  });
}
