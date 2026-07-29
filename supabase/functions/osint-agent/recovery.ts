import { createClient } from "npm:@supabase/supabase-js@2";
import { hasNoFindingsDecision, hasReportShape, stripReasoning } from "./orchestrator-finalize.ts";
import { loadReviewsForThread, applyReviewsToArtifacts } from "./reviews.ts";

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
  reason: "none" | "no_assistant" | "assistant_before_run" | "assistant_stale" | "report_present" | "no_findings_present";
};

/** Join an assistant message's text parts into one string for report-shape checks. */
export function assistantPartsToText(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return (parts as Array<{ type?: unknown; text?: unknown }>)
    .filter((p) => p?.type === "text")
    .map((p) => (typeof p?.text === "string" ? p.text : ""))
    .join("\n");
}

/**
 * Kill switch for the run-marker eligibility gate (P0-A, 2026-07-26). Set back to
 * `false` to restore the old behavior where ANY heartbeat-stale `active` thread was
 * recoverable — including one that never ran. Only flip this to debug the gate.
 */
export const REQUIRE_RUN_MARKER_FOR_RECOVERY = true;

/**
 * Did a run ever actually START on this thread?
 *
 * THE P0-A INVARIANT: a thread with no run marker is NOT an interrupted
 * investigation — it is a blank thread nobody has used yet, and recovering it
 * fabricates a "Findings report — recovered run" for a run that never happened.
 *
 * A blank thread is born `status='active'` (the `threads.status` column default,
 * and `WorkspaceHeader.createInvestigation` inserts only `user_id`), with both
 * timestamps NULL. `isStaleActiveThread` then falls back to `updated_at` — which
 * for a blank thread equals its creation time — so ~90s after the analyst clicks
 * "New", the thread reads as a 90s-dead run and the health sweep reaps it. In
 * production this produced 14 ghost recoveries on threads that had never received
 * a single user message, and left 192 of 264 threads eligible for the same.
 *
 * `run_started_at` and `last_heartbeat_at` are written ONLY by `markRunStarted` /
 * `startRunHeartbeat`, so either one proves a real invocation began. Verified in
 * production: zero rows carry a heartbeat without `run_started_at`, so this is the
 * exact boundary between "ran" and "never ran" — not a heuristic.
 */
export function hasRunMarker(thread: Pick<RecoverableThread, "run_started_at" | "last_heartbeat_at">): boolean {
  return Boolean(thread.run_started_at || thread.last_heartbeat_at);
}

export function isStaleActiveThread(thread: RecoverableThread, nowMs: number = Date.now(), staleMs: number = STALE_RUN_AFTER_MS): boolean {
  if (thread.status !== "active") return false;
  // Never-started threads are not interrupted runs — see hasRunMarker.
  if (REQUIRE_RUN_MARKER_FOR_RECOVERY && !hasRunMarker(thread)) return false;
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
  latestAssistantParts?: unknown,
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

  // The OTHER half of the I-2 completion contract. A run may also terminate legitimately
  // with an explicit `finalize_no_findings` decision instead of a report — and that
  // decision lives in a `tool-finalize_no_findings` PART, which assistantPartsToText
  // drops on the floor (it keeps only `type === "text"`). Without this, an isolate that
  // died after persisting a valid no-findings assistant row but before the status flip
  // got stamped with recovery metadata and rendered Interrupted, even though
  // meetsCompletionContract accepts it. Delegating to hasNoFindingsDecision — rather
  // than re-implementing the part scan here — keeps recovery and the finalize contract
  // in agreement by construction, so when that helper is tightened to require a
  // successful, schema-valid output this path inherits the fix automatically.
  if (latestAssistantParts && hasNoFindingsDecision([{ role: "assistant", parts: latestAssistantParts } as unknown as Parameters<typeof hasNoFindingsDecision>[0][number]])) {
    return { shouldInsert: false, reason: "no_findings_present" };
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
    db.from("artifacts").select("id,kind,value,confidence,source,created_at", { count: "exact" }).eq("thread_id", thread.id).order("confidence", { ascending: false }).order("created_at", { ascending: true }).limit(RECOVERY_ARTIFACT_LIMIT),
  ]);
  // Analyst verdicts apply to the recovery stub too. The stub is a REPORT the
  // analyst reads, built straight from durable artifacts — so without this a
  // finding already marked FALSE comes back as a recovered "finding", on a run the
  // analyst never even got to see finish. Best-effort here (unlike the run paths):
  // if verdicts are unreadable we still recover, because suppressing the stub
  // entirely would strand a genuinely dead run with no report at all — but we log
  // it, and applyReviewsToArtifacts returns [] on !ok so nothing rejected leaks.
  const recoveryReviews = await loadReviewsForThread(db as unknown as Parameters<typeof loadReviewsForThread>[0], thread.id, thread.user_id);
  if (!recoveryReviews.ok) {
    console.warn(JSON.stringify({
      event: "recovery_review_state_unavailable", thread_id: thread.id, error: recoveryReviews.error,
    }));
  }
  const reviewedArtifacts = recoveryReviews.ok
    ? applyReviewsToArtifacts((artifacts ?? []) as Array<Record<string, unknown>>, recoveryReviews)
    : (artifacts ?? []);
  let assistantInserted = false;
  const latestAssistantRow = latestAssistant as { created_at?: string; parts?: unknown } | null;
  const assistantState = shouldInsertRecoveredAssistant(
    thread,
    latestAssistantRow?.created_at ?? null,
    now.getTime(),
    RECENT_ASSISTANT_WINDOW_MS,
    assistantPartsToText(latestAssistantRow?.parts),
    latestAssistantRow?.parts,
  );
  if (!assistantState.shouldInsert) {
    // Nothing to stub, but the thread is genuinely stale — still close it out.
    // `.select("id")` is REQUIRED: without it a lost status race is indistinguishable
    // from a won one and this branch reported recovered:true for a thread it never
    // claimed, inflating the sweeper's recovered count with phantom recoveries.
    // Both halves of the completion contract count as a clean finish, not a recovery:
    // a durable report-shaped message OR an explicit finalize_no_findings decision.
    const reportAlreadyDurable = assistantState.reason === "report_present" || assistantState.reason === "no_findings_present";
    const { data: closed, error: closeErr } = await db
      .from("threads")
      .update({
        status: "finished",
        recovered_at: reportAlreadyDurable ? null : now.toISOString(),
        recovery_reason: reportAlreadyDurable ? null : reason,
        updated_at: now.toISOString(),
      })
      .eq("id", thread.id)
      .eq("status", "active")
      .select("id");
    if (closeErr) return { recovered: false, assistantInserted: false, artifactCount: artifactCount ?? 0, error: closeErr.message };
    const claimed = !!closed && (closed as unknown[]).length > 0;
    return { recovered: claimed && !reportAlreadyDurable, assistantInserted: false, artifactCount: artifactCount ?? 0 };
  }

  // ---- CLAIM BEFORE WRITING (2026-07-26 race fix) ----
  // The stub insert used to run FIRST, unguarded, with the status compare-and-set
  // after it. A live run that finalized in between then lost the race in the worst
  // possible way: its own status flip won, our UPDATE no-opped (so recovered_at and
  // recovery_reason stayed NULL), but the "Findings report — recovered run" stub was
  // ALREADY inserted — landing on top of a complete investigation with no marker
  // explaining it. Observed on thread 01b9567f: a full fingerprint.to report at
  // 14:40:11, a recovery stub moments later, recovery_reason NULL.
  //
  // Claiming first makes the stub strictly conditional on winning the compare-and-set:
  // if `finished` was already written by the real run, we claim nothing and write
  // nothing.
  const { data: claimed, error: claimErr } = await db
    .from("threads")
    .update({ status: "finished", recovered_at: now.toISOString(), recovery_reason: reason, updated_at: now.toISOString() })
    .eq("id", thread.id).eq("status", "active").select("id");
  if (claimErr) return { recovered: false, assistantInserted: false, artifactCount: artifactCount ?? 0, error: claimErr.message };
  if (!claimed || (claimed as unknown[]).length === 0) {
    // Someone else finalized this thread first. Their report stands; say nothing.
    return { recovered: false, assistantInserted: false, artifactCount: artifactCount ?? 0 };
  }

  // Re-read the latest assistant AFTER the claim. The run may have inserted its real
  // report between our first read and the claim — that report must still veto the
  // stub, and only a post-claim read can see it.
  const { data: freshAssistant } = await db
    .from("messages").select("created_at,parts").eq("thread_id", thread.id).eq("role", "assistant")
    .order("created_at", { ascending: false }).limit(1).maybeSingle();
  const freshRow = freshAssistant as { created_at?: string; parts?: unknown } | null;
  const freshState = shouldInsertRecoveredAssistant(
    thread, freshRow?.created_at ?? null, now.getTime(), RECENT_ASSISTANT_WINDOW_MS,
    assistantPartsToText(freshRow?.parts),
    freshRow?.parts,
  );
  if (!freshState.shouldInsert) {
    // ---- RELEASE THE CLAIM (2026-07-26, blocker 1) ----
    // A real report landed between our first read and the claim. Suppressing the stub
    // is necessary but NOT sufficient: the claim already stamped recovered_at /
    // recovery_reason, and the live run's own completion UPDATE is guarded on
    // status='active' — which we just consumed — so it can no longer clear them. The
    // thread would sit `finished` + recovery metadata and render Interrupted even
    // though the investigation completed normally and durably.
    //
    // Release by clearing ONLY our own stamp: the WHERE ties back to the exact
    // recovered_at + recovery_reason we wrote, so a different recovery worker's claim
    // is never cleared. `status` stays "finished" — that part is correct, the run IS
    // over; only the "this was interrupted" label is wrong.
    const { error: releaseErr } = await db
      .from("threads")
      .update({ recovered_at: null, recovery_reason: null, updated_at: now.toISOString() })
      .eq("id", thread.id)
      .eq("recovered_at", now.toISOString())
      .eq("recovery_reason", reason);
    if (releaseErr) {
      return { recovered: false, assistantInserted: false, artifactCount: artifactCount ?? 0, error: releaseErr.message };
    }
    // Not a recovery: a durable report exists and the thread is labelled complete.
    return { recovered: false, assistantInserted: false, artifactCount: artifactCount ?? 0 };
  }

  // reviewedArtifacts, NOT the raw fetch: the stub is a REPORT the analyst reads, so a
  // finding they marked FALSE must not come back inside it. applyReviewsToArtifacts
  // returns [] when the verdicts are unreadable, so this fails closed.
  const text = buildRecoveredAssistantText(thread, reviewedArtifacts as RecoveryArtifact[]);
  const { error: insertErr } = await db.from("messages").insert({ thread_id: thread.id, user_id: thread.user_id, role: "assistant", parts: [{ type: "text", text }] });
  if (insertErr) {
    // ---- ROLL BACK THE CLAIM ON STUB-INSERT FAILURE (PR #387 review, P2) ----
    // The claim above already flipped status to "finished", but the recovered report
    // never landed. Left as-is, no sweep will ever retry — the sweep scans only
    // status='active' rows — so a transient insert failure permanently strands a
    // genuinely interrupted run: closed, stamped as recovered, with no report.
    // Reopen the thread so the next sweep re-runs the whole claim + stub sequence.
    //
    // The WHERE is keyed on the exact recovered_at + recovery_reason THIS claim wrote
    // (the same token the durable-report release above uses): if the row no longer
    // carries our stamp — a new run restarted via markRunStarted, or a later worker
    // owns it — the UPDATE matches nothing and their state is untouched.
    //
    // last_heartbeat_at MUST be bumped to `now` here too (Codex review on this PR,
    // P2): isStaleActiveThread checks last_heartbeat_at FIRST and only falls back to
    // updated_at when the heartbeat is null, so reopening with a fresh updated_at but
    // a stale, untouched last_heartbeat_at leaves the row immediately re-eligible for
    // ANY concurrent sweep (the health-check sweep in index.ts, a cron tick, another
    // request) — not just the one that failed. When this recovery runs as the
    // pre-request check inside setupRequest, that race lets a concurrent sweep win,
    // recover the thread, and insert the recovered-run stub AFTER the analyst's new
    // message that setupRequest is about to write, misattributing the prior run's
    // report onto the new turn. Bumping the heartbeat holds the thread "live" for one
    // more STALE_RUN_AFTER_MS window — long enough for this request's own
    // startRunHeartbeat to stamp a genuinely fresh run marker — while still leaving it
    // eligible again if this request never gets that far (crashes, insert keeps
    // failing) and the run really is abandoned.
    const { data: released, error: rollbackErr } = await db
      .from("threads")
      .update({ status: "active", recovered_at: null, recovery_reason: null, last_heartbeat_at: now.toISOString(), updated_at: now.toISOString() })
      .eq("id", thread.id)
      .eq("recovered_at", now.toISOString())
      .eq("recovery_reason", reason)
      .select("id");
    if (rollbackErr) {
      // Claim stands but the stub is missing — the pre-rollback failure mode.
      // recovered:true is honest here: the close DID commit and will render Interrupted.
      return { recovered: true, assistantInserted: false, artifactCount: artifactCount ?? 0, error: `${insertErr.message}; claim rollback failed: ${rollbackErr.message}` };
    }
    console.warn(JSON.stringify({
      event: "recovery_stub_insert_failed", thread_id: thread.id,
      claim_released: !!released && (released as unknown[]).length > 0, error: insertErr.message,
    }));
    return { recovered: false, assistantInserted: false, artifactCount: artifactCount ?? 0, error: insertErr.message };
  }
  assistantInserted = true;
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
  let query = db.from("threads").select("id,user_id,title,seed_value,status,run_started_at,last_heartbeat_at,updated_at").eq("status", "active");
  // Mirror hasRunMarker in the QUERY, not just the per-row check. Two reasons:
  // correctness is already covered by isStaleActiveThread, but the sweep is
  // LIMITed — and never-started threads are the oldest `active` rows on the table,
  // so under `order(updated_at asc)` they were filling the entire 20-row budget and
  // starving the genuinely-dead runs this sweeper exists to reap.
  if (REQUIRE_RUN_MARKER_FOR_RECOVERY) {
    query = query.or("run_started_at.not.is.null,last_heartbeat_at.not.is.null");
  }
  const { data, error } = await query.or(`last_heartbeat_at.lt.${cutoff},and(last_heartbeat_at.is.null,updated_at.lt.${cutoff})`).order("updated_at", { ascending: true }).limit(opts?.limit ?? 20);
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