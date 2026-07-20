import { createClient } from "npm:@supabase/supabase-js@2";
import { loadReviewsForThread, applyReviewsToArtifacts } from "./reviews.ts";
import { hasReportShape, stripReasoning } from "./orchestrator-finalize.ts";

export const RUN_HEARTBEAT_INTERVAL_MS = 15_000;
export const STALE_RUN_AFTER_MS = 75_000;
export const RECOVERY_ARTIFACT_LIMIT = 40;
export const RECENT_ASSISTANT_WINDOW_MS = 2 * 60_000;

// recovery_reason sentinels for the report-less refresh sweep. A run that is
// recovered before it accumulated a report-shaped assistant message is flagged
// REPORTLESS_REASON; the refresh sweep later (once auto-persist / record_artifacts
// findings are durable) regenerates a real Findings report and flips the flag to
// REPORT_REFRESHED_REASON. The conditional UPDATE on this column is the atomic
// claim that makes the sweep race-safe across concurrent isolates.
export const REPORTLESS_REASON = "recovered_reportless_pending";
export const REPORT_REFRESHED_REASON = "recovered_report_refreshed";

type DbClient = ReturnType<typeof createClient>;

export type RecoverableThread = {
  id: string;
  user_id: string;
  title?: string | null;
  seed_value?: string | null;
  status?: string | null;
  run_started_at?: string | null;
  last_heartbeat_at?: string | null;
  updated_at?: string | null;
};

export type RecoveryArtifact = {
  id?: string | null;
  kind?: string | null;
  value?: string | null;
  confidence?: number | null;
  source?: string | null;
  created_at?: string | null;
};

export type RecoveryAssistantState = {
  shouldInsert: boolean;
  reason: "none" | "no_assistant" | "assistant_before_run" | "assistant_stale";
};

export function isStaleActiveThread(thread: RecoverableThread, nowMs: number = Date.now(), staleMs: number = STALE_RUN_AFTER_MS): boolean {
  if (thread.status !== "active") return false;
  const heartbeat = thread.last_heartbeat_at ? new Date(thread.last_heartbeat_at).getTime() : NaN;
  const fallback = thread.updated_at ? new Date(thread.updated_at).getTime() : NaN;
  const lastLive = Number.isFinite(heartbeat) ? heartbeat : fallback;
  return Number.isFinite(lastLive) && nowMs - lastLive > staleMs;
}

function escapeCell(value: unknown): string {
  return String(value ?? "—").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim().slice(0, 220) || "—";
}

export function buildRecoveredAssistantText(
  thread: Pick<RecoverableThread, "seed_value" | "title" | "last_heartbeat_at" | "run_started_at">,
  artifacts: RecoveryArtifact[],
): string {
  const seed = thread.seed_value?.trim() || thread.title?.trim() || "this investigation";
  const lastLive = thread.last_heartbeat_at ?? thread.run_started_at ?? null;
  const rows = artifacts.slice(0, RECOVERY_ARTIFACT_LIMIT);
  const header = [
    "## Findings report — recovered run",
    "",
    `The investigation for **${escapeCell(seed)}** was interrupted before the agent could write its closing response. The saved evidence below was recovered from durable artifacts already written during the run.`,
    lastLive ? `Last heartbeat: ${lastLive}.` : "Last heartbeat was not recorded.",
    "",
  ];
  if (rows.length === 0) {
    // Deliberately NOT report-shaped (no "report/findings/summary" heading, no
    // table, no tier labels) so needsFinishedReportRefresh() treats this thread
    // as still needing a real report once durable artifacts land. Writing a
    // definitive "## Findings report … No confirmed artifacts were recorded"
    // here is the bug that made a run which actually found everything look empty:
    // the stub was written on an early CPU-killed cycle (0 artifacts) and never
    // refreshed after later cycles persisted findings.
    return [
      "### Run interrupted",
      "",
      `The investigation for **${escapeCell(seed)}** stopped before it finished, and no findings had been saved at that point.`,
      lastLive ? `Last heartbeat: ${lastLive}.` : "Last heartbeat was not recorded.",
      "",
      "If findings are collected on a follow-up pass they will appear here automatically; you can also re-run the seed to continue.",
    ].join("\n");
  }
  const table = [
    "| # | Kind | Value | Confidence | Source |",
    "|---:|---|---|---:|---|",
    ...rows.map((a, i) => `| ${i + 1} | ${escapeCell(a.kind)} | ${escapeCell(a.value)} | ${a.confidence ?? "—"} | ${escapeCell(a.source)} |`),
  ];
  return [
    ...header,
    "### Recovered findings",
    ...table,
    "",
    rows.length === artifacts.length ? `Recovered ${rows.length} artifact${rows.length === 1 ? "" : "s"}.` : `Showing top ${rows.length} of ${artifacts.length} recovered artifacts.`,
    "",
    "### Gaps",
    "- The run was closed by stale-run recovery, so this is not a full model-written synthesis.",
    "- Treat unresolved leads as pending until a follow-up run verifies them.",
  ].join("\n");
}

export function shouldInsertRecoveredAssistant(
  thread: Pick<RecoverableThread, "run_started_at" | "last_heartbeat_at" | "updated_at">,
  latestAssistantCreatedAt?: string | null,
  nowMs: number = Date.now(),
  recentWindowMs: number = RECENT_ASSISTANT_WINDOW_MS,
): RecoveryAssistantState {
  if (!latestAssistantCreatedAt) return { shouldInsert: true, reason: "no_assistant" };
  const assistantMs = new Date(latestAssistantCreatedAt).getTime();
  if (!Number.isFinite(assistantMs)) return { shouldInsert: true, reason: "assistant_stale" };

  const runStartMs = thread.run_started_at ? new Date(thread.run_started_at).getTime() : NaN;
  if (Number.isFinite(runStartMs) && assistantMs < runStartMs) {
    return { shouldInsert: true, reason: "assistant_before_run" };
  }

  const liveMs = thread.last_heartbeat_at
    ? new Date(thread.last_heartbeat_at).getTime()
    : thread.updated_at
      ? new Date(thread.updated_at).getTime()
      : NaN;
  if (Number.isFinite(liveMs) && assistantMs < liveMs - recentWindowMs) {
    return { shouldInsert: true, reason: "assistant_stale" };
  }
  if (nowMs - assistantMs > recentWindowMs && Number.isFinite(liveMs) && liveMs > assistantMs) {
    return { shouldInsert: true, reason: "assistant_stale" };
  }

  return { shouldInsert: false, reason: "none" };
}

async function recoverOneStaleThread(
  db: DbClient,
  thread: RecoverableThread,
  now: Date,
  reason: string,
): Promise<{ recovered: boolean; assistantInserted: boolean; artifactCount: number; error?: string }> {
  if (!isStaleActiveThread(thread, now.getTime())) return { recovered: false, assistantInserted: false, artifactCount: 0 };
  const [{ data: latestAssistant }, { data: artifacts, count: artifactCount }] = await Promise.all([
    db.from("messages").select("created_at").eq("thread_id", thread.id).eq("role", "assistant").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("artifacts").select("id,kind,value,confidence,source,created_at", { count: "exact" }).eq("thread_id", thread.id).order("confidence", { ascending: false }).order("created_at", { ascending: true }).limit(RECOVERY_ARTIFACT_LIMIT),
  ]);
  let assistantInserted = false;
  // Track whether we wrote a REAL findings report (>=1 durable artifact). If not,
  // flag the thread REPORTLESS_REASON so the refresh sweep regenerates the report
  // once findings become durable (the CPU-kill-before-finalize case).
  let realReportWritten = false;
  const assistantState = shouldInsertRecoveredAssistant(
    thread,
    (latestAssistant as { created_at?: string } | null)?.created_at ?? null,
    now.getTime(),
  );
  if (assistantState.shouldInsert) {
    // Never surface analyst-rejected artifacts in a recovered findings report.
    //
    // FAIL-CLOSED: if the verdicts can't be read, do NOT write a recovered report
    // built from unfiltered rows — a recovery report is durable and user-facing,
    // so a transient error would republish findings the analyst marked FALSE.
    // The thread is still finalized below; only the report is withheld.
    const review = await loadReviewsForThread(db, thread.id, thread.user_id);
    if (!review.ok) {
      console.warn(JSON.stringify({
        event: "recovery_report_skipped_review_state_unavailable",
        thread_id: thread.id, error: review.error,
      }));
    } else {
      const liveArtifacts = applyReviewsToArtifacts((artifacts ?? []) as Array<Record<string, unknown>>, review);
      const text = buildRecoveredAssistantText(thread, liveArtifacts as RecoveryArtifact[]);
      const { error: insertErr } = await db.from("messages").insert({ thread_id: thread.id, user_id: thread.user_id, role: "assistant", parts: [{ type: "text", text }] });
      if (insertErr) return { recovered: false, assistantInserted: false, artifactCount: artifactCount ?? 0, error: insertErr.message };
      assistantInserted = true;
      realReportWritten = (liveArtifacts?.length ?? 0) > 0;
    }
  }
  // When no real findings report was written (0 artifacts at recovery, review
  // unavailable, or a fresh non-report assistant already present), leave the
  // thread flagged so the refresh sweep can complete it once findings are durable.
  const finalReason = realReportWritten ? reason : REPORTLESS_REASON;
  const { error: updateErr } = await db.from("threads").update({ status: "finished", recovered_at: now.toISOString(), recovery_reason: finalReason, updated_at: now.toISOString() }).eq("id", thread.id).eq("status", "active");
  if (updateErr) return { recovered: false, assistantInserted, artifactCount: artifactCount ?? 0, error: updateErr.message };
  return { recovered: true, assistantInserted, artifactCount: artifactCount ?? 0 };
}

/** Concatenated text of an assistant message's text parts (recovery-local). */
function assistantTextFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p) => (p as { type?: string })?.type === "text" && typeof (p as { text?: unknown })?.text === "string")
    .map((p) => (p as { text: string }).text)
    .join("\n")
    .trim();
}

/**
 * A finished thread needs a regenerated report when it has >=1 durable artifact
 * but its latest assistant message carries no report shape (only checkpoints, a
 * "run interrupted" note, or reasoning). Pure so it unit-tests without a DB.
 */
export function needsFinishedReportRefresh(latestAssistantText: string, artifactCount: number): boolean {
  if (artifactCount <= 0) return false;
  return !hasReportShape(stripReasoning(latestAssistantText ?? ""));
}

export async function recoverStaleThreadById(db: DbClient, threadId: string, opts?: { now?: Date; reason?: string }) {
  const now = opts?.now ?? new Date();
  const { data, error } = await db.from("threads").select("id,user_id,title,seed_value,status,run_started_at,last_heartbeat_at,updated_at").eq("id", threadId).maybeSingle();
  if (error) return { recovered: false, assistantInserted: false, artifactCount: 0, error: error.message };
  if (!data) return { recovered: false, assistantInserted: false, artifactCount: 0 };
  return recoverOneStaleThread(db, data as RecoverableThread, now, opts?.reason ?? "stale heartbeat recovered before new request");
}

export async function recoverStaleActiveThreads(db: DbClient, opts?: { now?: Date; limit?: number; reason?: string }) {
  const now = opts?.now ?? new Date();
  const cutoff = new Date(now.getTime() - STALE_RUN_AFTER_MS).toISOString();
  const { data, error } = await db.from("threads").select("id,user_id,title,seed_value,status,run_started_at,last_heartbeat_at,updated_at").eq("status", "active").or(`last_heartbeat_at.lt.${cutoff},and(last_heartbeat_at.is.null,updated_at.lt.${cutoff})`).order("updated_at", { ascending: true }).limit(opts?.limit ?? 20);
  if (error) throw new Error(error.message);
  let recovered = 0;
  let assistantInserted = 0;
  let errors = 0;
  for (const row of (data ?? []) as RecoverableThread[]) {
    const res = await recoverOneStaleThread(db, row, now, opts?.reason ?? "stale heartbeat recovered by sweeper");
    if (res.error) errors++;
    if (res.recovered) recovered++;
    if (res.assistantInserted) assistantInserted++;
  }
  return { scanned: (data ?? []).length, recovered, assistantInserted, errors };
}

/**
 * Refresh sweep: regenerate a real Findings report for threads that were recovered
 * report-less (flagged REPORTLESS_REASON) but now have durable artifacts. This is
 * the completion for the dominant failure: the isolate is CPU-killed before it can
 * write its closing report, recovery finalizes the thread with no report, and later
 * cycles / auto-persist leave findings durable. Runs at request startup alongside
 * the stale-active sweep.
 *
 * Race-safe: the report is only inserted after an ATOMIC conditional UPDATE claims
 * the thread (recovery_reason REPORTLESS_REASON -> REPORT_REFRESHED_REASON); a
 * concurrent isolate that lost the claim inserts nothing. Fail-closed on review
 * state. Purely ADDITIVE — never deletes or rewrites an existing message/artifact.
 */
export async function refreshFinishedThreadReports(db: DbClient, opts?: { now?: Date; limit?: number }) {
  const now = opts?.now ?? new Date();
  const { data, error } = await db
    .from("threads")
    .select("id,user_id,title,seed_value,status,run_started_at,last_heartbeat_at,updated_at,recovery_reason")
    .eq("status", "finished")
    .eq("recovery_reason", REPORTLESS_REASON)
    .order("updated_at", { ascending: false })
    .limit(opts?.limit ?? 5);
  if (error) return { scanned: 0, refreshed: 0, cleared: 0, errors: 1 };
  let refreshed = 0;
  let cleared = 0;
  let errors = 0;
  for (const thread of (data ?? []) as RecoverableThread[]) {
    try {
      const [{ data: latestAssistant }, { data: artifacts, count: artifactCount }] = await Promise.all([
        db.from("messages").select("parts,created_at").eq("thread_id", thread.id).eq("role", "assistant").order("created_at", { ascending: false }).limit(1).maybeSingle(),
        db.from("artifacts").select("id,kind,value,confidence,source,created_at", { count: "exact" }).eq("thread_id", thread.id).order("confidence", { ascending: false }).order("created_at", { ascending: true }).limit(RECOVERY_ARTIFACT_LIMIT),
      ]);
      const latestText = assistantTextFromParts((latestAssistant as { parts?: unknown } | null)?.parts);
      if (!needsFinishedReportRefresh(latestText, artifactCount ?? 0)) {
        // Either a real report already exists or there are no artifacts — stop
        // revisiting this thread by clearing the flag.
        await db.from("threads").update({ recovery_reason: REPORT_REFRESHED_REASON, updated_at: now.toISOString() }).eq("id", thread.id).eq("recovery_reason", REPORTLESS_REASON);
        cleared++;
        continue;
      }
      // Fail-closed: never synthesize from unfiltered rows if verdicts are unreadable.
      const review = await loadReviewsForThread(db, thread.id, thread.user_id);
      if (!review.ok) { errors++; continue; }
      const liveArtifacts = applyReviewsToArtifacts((artifacts ?? []) as Array<Record<string, unknown>>, review);
      if (liveArtifacts.length === 0) {
        await db.from("threads").update({ recovery_reason: REPORT_REFRESHED_REASON, updated_at: now.toISOString() }).eq("id", thread.id).eq("recovery_reason", REPORTLESS_REASON);
        cleared++;
        continue;
      }
      // Atomic claim: only the isolate whose conditional UPDATE matches a row writes
      // the report, so concurrent sweeps never double-insert.
      const { data: claimed, error: claimErr } = await db
        .from("threads")
        .update({ recovery_reason: REPORT_REFRESHED_REASON, updated_at: now.toISOString() })
        .eq("id", thread.id)
        .eq("recovery_reason", REPORTLESS_REASON)
        .select("id");
      if (claimErr) { errors++; continue; }
      if (!claimed || (Array.isArray(claimed) && claimed.length === 0)) continue; // lost the race
      const text = buildRecoveredAssistantText(thread, liveArtifacts as RecoveryArtifact[]);
      const { error: insertErr } = await db.from("messages").insert({ thread_id: thread.id, user_id: thread.user_id, role: "assistant", parts: [{ type: "text", text }] });
      if (insertErr) {
        // Best-effort restore so a later sweep retries rather than dropping the report.
        await db.from("threads").update({ recovery_reason: REPORTLESS_REASON }).eq("id", thread.id).eq("recovery_reason", REPORT_REFRESHED_REASON);
        errors++;
        continue;
      }
      refreshed++;
    } catch (_e) {
      errors++;
    }
  }
  return { scanned: (data ?? []).length, refreshed, cleared, errors };
}

export async function markRunStarted(db: DbClient, threadId: string, startedAt: Date = new Date()): Promise<void> {
  const iso = startedAt.toISOString();
  const { error } = await db.from("threads").update({ status: "active", run_started_at: iso, last_heartbeat_at: iso, recovered_at: null, recovery_reason: null, updated_at: iso }).eq("id", threadId);
  if (error) console.warn("[run-heartbeat] start marker failed:", error.message);
}

export function startRunHeartbeat(db: DbClient, threadId: string, opts?: { startedAt?: Date; intervalMs?: number }): { pulse: () => void; stop: () => void } {
  let stopped = false;
  let inFlight = false;
  const write = () => {
    if (stopped || inFlight) return;
    inFlight = true;
    const iso = new Date().toISOString();
    db.from("threads").update({ last_heartbeat_at: iso, updated_at: iso }).eq("id", threadId).eq("status", "active")
      .then(({ error }: { error: { message?: string } | null }) => { if (error) console.warn("[run-heartbeat] pulse failed:", error.message ?? error); }, (e: unknown) => console.warn("[run-heartbeat] pulse threw:", e))
      .finally(() => { inFlight = false; });
  };
  markRunStarted(db, threadId, opts?.startedAt).catch((e) => console.warn("[run-heartbeat] start threw:", e));
  const timer = setInterval(write, opts?.intervalMs ?? RUN_HEARTBEAT_INTERVAL_MS);
  return { pulse: write, stop: () => { stopped = true; clearInterval(timer); } };
}