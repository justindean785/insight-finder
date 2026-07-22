import { createClient } from "npm:@supabase/supabase-js@2";
import { hasReportShape, stripReasoning } from "./orchestrator-finalize.ts";

export const RUN_HEARTBEAT_INTERVAL_MS = 15_000;
export const STALE_RUN_AFTER_MS = 75_000;
export const RECOVERY_ARTIFACT_LIMIT = 40;
export const RECENT_ASSISTANT_WINDOW_MS = 2 * 60_000;

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
  kind?: string | null;
  value?: string | null;
  confidence?: number | null;
  source?: string | null;
  created_at?: string | null;
};

export type RecoveryAssistantState = {
  shouldInsert: boolean;
  reason: "none" | "no_assistant" | "assistant_before_run" | "assistant_stale" | "report_present";
};

/** Join an assistant message's text parts into one string for report-shape checks. */
export function assistantPartsToText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return (parts as Array<{ type?: unknown; text?: unknown }>)
    .filter((p) => p?.type === "text")
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .join("\n");
}

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
    return [...header, "No confirmed artifacts were recorded before the interruption.", "", "### Gaps", "- The backend stopped before final synthesis completed.", "- Re-run the seed to continue collection."].join("\n");
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
  latestAssistantText?: string | null,
): RecoveryAssistantState {
  if (!latestAssistantCreatedAt) return { shouldInsert: true, reason: "no_assistant" };
  const assistantMs = new Date(latestAssistantCreatedAt).getTime();
  if (!Number.isFinite(assistantMs)) return { shouldInsert: true, reason: "assistant_stale" };

  const runStartMs = thread.run_started_at ? new Date(thread.run_started_at).getTime() : NaN;
  if (Number.isFinite(runStartMs) && assistantMs < runStartMs) {
    return { shouldInsert: true, reason: "assistant_before_run" };
  }

  // A closing REPORT from THIS run is already durably saved. The finalize path
  // now inserts the assistant report immediately before flipping status to
  // "finished"; a tail kill between those two writes leaves a real report on a
  // thread still marked `active`. Never overwrite it with a recovery stub — the
  // timing heuristics below can misfire when the sweeper runs well after the
  // report was written (e.g. a stray heartbeat pulsed after the insert, pushing
  // `now - assistantMs` past the window). This is scoped to this-run assistants:
  // the prior-turn case already returned above, so a stale earlier report cannot
  // suppress a genuine stub.
  if (latestAssistantText && hasReportShape(stripReasoning(latestAssistantText))) {
    return { shouldInsert: false, reason: "report_present" };
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
    db.from("messages").select("created_at,parts").eq("thread_id", thread.id).eq("role", "assistant").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("artifacts").select("kind,value,confidence,source,created_at", { count: "exact" }).eq("thread_id", thread.id).order("confidence", { ascending: false }).order("created_at", { ascending: true }).limit(RECOVERY_ARTIFACT_LIMIT),
  ]);
  let assistantInserted = false;
  const latestAssistantRow = latestAssistant as { created_at?: string; parts?: unknown } | null;
  const assistantState = shouldInsertRecoveredAssistant(
    thread,
    latestAssistantRow?.created_at ?? null,
    now.getTime(),
    RECENT_ASSISTANT_WINDOW_MS,
    assistantPartsToText(latestAssistantRow?.parts),
  );
  if (assistantState.shouldInsert) {
    const text = buildRecoveredAssistantText(thread, (artifacts ?? []) as RecoveryArtifact[]);
    const { error: insertErr } = await db.from("messages").insert({ thread_id: thread.id, user_id: thread.user_id, role: "assistant", parts: [{ type: "text", text }] });
    if (insertErr) return { recovered: false, assistantInserted: false, artifactCount: artifactCount ?? 0, error: insertErr.message };
    assistantInserted = true;
  }
  const { error: updateErr } = await db.from("threads").update({ status: "finished", recovered_at: now.toISOString(), recovery_reason: reason, updated_at: now.toISOString() }).eq("id", thread.id).eq("status", "active");
  if (updateErr) return { recovered: false, assistantInserted, artifactCount: artifactCount ?? 0, error: updateErr.message };
  return { recovered: true, assistantInserted, artifactCount: artifactCount ?? 0 };
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