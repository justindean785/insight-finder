import { createClient } from "npm:@supabase/supabase-js@2";
import { hasReportShape, stripReasoning } from "./orchestrator-finalize.ts";
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

export type RecoveryArtifactMetadata = {
  /** "observed" | "needs_corroboration" | "excluded" | … */
  status?: string | null;
  reason_not_confirmed?: string | null;
  source_category?: string[] | string | null;
  /** Set by auto-persist-findings.ts on every machine-extracted row. */
  auto_recorded?: boolean | null;
  auto_persist_source?: string | null;
  [k: string]: unknown;
};

export type RecoveryArtifact = {
  kind?: string | null;
  value?: string | null;
  confidence?: number | null;
  source?: string | null;
  created_at?: string | null;
  metadata?: RecoveryArtifactMetadata | null;
};

/** Artifact kinds that are control/telemetry records, never evidence. Matched
 *  STRUCTURALLY on `kind` — never by sniffing the rendered value for a title
 *  string, which would misfire on a legitimate finding that merely mentions one
 *  of these words. */
export const NON_EVIDENCE_KINDS = new Set<string>([
  "triage_decision",
  "coverage_audit",
  "tool_audit",
]);

/** Artifact kinds that ARE the exclusion record itself. */
export const EXCLUDED_KINDS = new Set<string>([
  "excluded_collision",
  "excluded_collision_summary",
]);

/** metadata.status values meaning "this row was ruled out". */
export const EXCLUDED_STATUSES = new Set<string>(["excluded", "excluded_collision", "rejected"]);

export type RecoveryRowClass = "excluded" | "non_evidence" | "candidate" | "reviewed";

/**
 * Classify one artifact for rendering. The recovered report is a document an
 * analyst reads as evidence, so the distinctions that matter are: was this row
 * ruled out, is it bookkeeping, and did a MODEL ever look at it.
 *
 * `auto_recorded: true` (written by auto-persist-findings.ts) is the reliable
 * negative signal for that last question. In the 2026-07-30 incident the model
 * called record_artifacts ZERO times, so every published row was extractor
 * output — yet the report presented all 27 as "Recovered findings".
 *
 * Conservative on missing metadata: a legacy row with no metadata at all cannot
 * be shown to have been model-reviewed, so it is a CANDIDATE, not a finding.
 */
export function classifyRecoveryRow(a: RecoveryArtifact): RecoveryRowClass {
  const kind = String(a.kind ?? "").trim();
  const md = (a.metadata ?? {}) as RecoveryArtifactMetadata;
  const status = String(md.status ?? "").trim().toLowerCase();

  if (EXCLUDED_KINDS.has(kind) || EXCLUDED_STATUSES.has(status)) return "excluded";
  if (NON_EVIDENCE_KINDS.has(kind)) return "non_evidence";
  if (md.auto_recorded === true || typeof md.auto_persist_source === "string") return "candidate";
  if (a.metadata == null) return "candidate";
  return "reviewed";
}

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
  const classified = artifacts.map((a) => ({ a, cls: classifyRecoveryRow(a) }));
  const reviewed = classified.filter((r) => r.cls === "reviewed").map((r) => r.a);
  const candidates = classified.filter((r) => r.cls === "candidate").map((r) => r.a);
  const excluded = classified.filter((r) => r.cls === "excluded").map((r) => r.a);
  const suppressed = classified.filter((r) => r.cls === "non_evidence").length;

  // Reviewed evidence FIRST, always — never interleaved with candidates and never
  // outranked by a bulk row that merely carries a bigger number. A hardcoded
  // extractor literal (breach rows are pushed at a flat 55) must not sort above a
  // model-reviewed finding at 45. Ordering within each section stays
  // confidence-descending, which is meaningful among peers.
  const shown = [...reviewed, ...candidates].slice(0, RECOVERY_ARTIFACT_LIMIT);
  const shownReviewed = shown.filter((a) => classifyRecoveryRow(a) === "reviewed");
  const shownCandidates = shown.filter((a) => classifyRecoveryRow(a) === "candidate");

  const header = [
    "## Interrupted run — recovered evidence",
    "",
    `The investigation for **${escapeCell(seed)}** was interrupted before the agent could write its closing response. **This is not a findings report.** The rows below are whatever was already durably written when the run stopped, presented as-is.`,
    lastLive ? `Last heartbeat: ${lastLive}.` : "Last heartbeat was not recorded.",
    "",
  ];

  const renderTable = (rows: RecoveryArtifact[]) => [
    "| # | Kind | Value | Confidence | Status | Source |",
    "|---:|---|---|---:|---|---|",
    ...rows.map((a, i) => {
      const md = (a.metadata ?? {}) as RecoveryArtifactMetadata;
      const status = md.status ? escapeCell(md.status) : "—";
      return `| ${i + 1} | ${escapeCell(a.kind)} | ${escapeCell(a.value)} | ${a.confidence ?? "—"} | ${status} | ${escapeCell(a.source)} |`;
    }),
  ];

  const caveats = (rows: RecoveryArtifact[]): string[] => {
    const reasons = new Set<string>();
    for (const a of rows) {
      const r = (a.metadata as RecoveryArtifactMetadata | null)?.reason_not_confirmed;
      if (typeof r === "string" && r.trim()) reasons.add(r.trim());
    }
    if (reasons.size === 0) return [];
    return ["", "Why these are not confirmed:", ...[...reasons].map((r) => `- ${r}`)];
  };

  const out = [...header];

  if (shownReviewed.length > 0) {
    out.push("### Model-reviewed findings", ...renderTable(shownReviewed), ...caveats(shownReviewed), "");
  }

  if (shownCandidates.length > 0) {
    out.push(
      "### Machine-extracted candidates — UNREVIEWED",
      "",
      "Written automatically by the tool-output extractor. **No model or analyst judgement was applied to these rows**, and they have not been checked for same-name collisions or subject relevance. Treat them as leads to verify, not as findings.",
      "",
      ...renderTable(shownCandidates),
      ...caveats(shownCandidates),
      "",
    );
  }

  if (shownReviewed.length === 0) {
    out.push(
      candidates.length > 0
        ? "**No model-reviewed findings exist for this run.** Every row above is unreviewed extractor output."
        : "**No evidence was durably recorded before the interruption.**",
      "",
    );
  }

  if (excluded.length > 0) {
    // Disclose WHAT was ruled out by kind, not just how many — a bare count is
    // unauditable ("ruled out 12 things" tells the analyst nothing about whether
    // the exclusion was reasonable). Values are deliberately NOT reprinted: the
    // codebase already treats `breach` values as unsafe to project into chat
    // history, and an excluded collision row is by definition a THIRD PARTY's
    // data — reprinting it in an "appendix" would republish exactly the PII the
    // exclusion exists to keep out of the report. The rows stay in the artifacts
    // table, so the Evidence board remains the auditable surface for values.
    const byKind = new Map<string, number>();
    for (const a of excluded) {
      const k = String(a.kind ?? "unknown");
      byKind.set(k, (byKind.get(k) ?? 0) + 1);
    }
    const breakdown = [...byKind.entries()].sort((x, y) => y[1] - x[1]).map(([k, n]) => `${n}× ${k}`).join(", ");
    out.push(
      `${excluded.length} row${excluded.length === 1 ? " was" : "s were"} ruled out (same-name collision or explicit exclusion) and ${excluded.length === 1 ? "is" : "are"} not shown: ${breakdown}. Values are withheld because an excluded row is another person's data; inspect them on the Evidence board if the exclusion needs review.`,
      "",
    );
  }
  if (suppressed > 0) {
    out.push(`${suppressed} control/telemetry record${suppressed === 1 ? "" : "s"} (triage decisions, audits) omitted — these are not evidence.`, "");
  }

  const totalEligible = reviewed.length + candidates.length;
  // "### Recovery summary" is load-bearing, not decoration: hasReportShape()
  // matches a heading containing report|findings|summary|… or a markdown table.
  // The stub MUST stay report-shaped so shouldInsertRecoveredAssistant sees
  // `report_present` on a re-sweep and does not stack a second stub. With rows
  // present the tables satisfy that; with ZERO rows there is no table and the new
  // top heading ("Interrupted run — recovered evidence") deliberately avoids the
  // word "report", so this heading is what keeps the empty case shaped.
  out.push("### Recovery summary");
  out.push(
    shown.length === totalEligible
      ? `${shown.length} recovered row${shown.length === 1 ? "" : "s"}: ${shownReviewed.length} model-reviewed, ${shownCandidates.length} unreviewed.`
      : `Showing ${shown.length} of ${totalEligible} recovered rows: ${shownReviewed.length} model-reviewed, ${shownCandidates.length} unreviewed.`,
    "",
    "### Gaps",
    "- The run was closed by stale-run recovery, so this is not a full model-written synthesis.",
    "- Treat unresolved leads as pending until a follow-up run verifies them.",
  );
  return out.join("\n");
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
    // `metadata` is REQUIRED, not optional enrichment: status,
    // reason_not_confirmed, source_category and the collision/exclusion flags all
    // live there. Omitting it is what made the recovered report unable to tell an
    // excluded same-name collision from a finding, or extractor output from
    // model-reviewed evidence — every integrity field the recording layer had
    // already computed was simply not fetched.
    db.from("artifacts").select("id,kind,value,confidence,source,created_at,metadata", { count: "exact" }).eq("thread_id", thread.id).order("confidence", { ascending: false }).order("created_at", { ascending: true }).limit(RECOVERY_ARTIFACT_LIMIT),
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

  // ---- FORENSICS FOR THE NEXT NATURAL FAILURE ----
  // The 2026-07-30 run death is UNRESOLVED and reproduced on a re-run. Diagnosing
  // it after the fact was blocked by two things, both fixable here at zero cost
  // and without a paid canary:
  //   (a) resumeThread() overwrites run_started_at/last_heartbeat_at and NULLs
  //       recovered_at/recovery_reason, so the moment an analyst retypes into the
  //       thread the dead run's lifecycle snapshot is gone. Emitting it at
  //       recovery time preserves it in the log regardless.
  //   (b) the heartbeat is NOT on a fixed cadence — pulse() also fires on tool
  //       events — so the interval cannot be reconstructed afterwards and any
  //       tick-lattice arithmetic is invalid. Record the real elapsed values.
  // Deliberately no PII: ids, timestamps and counts only, never seed_value/title.
  const runStartMs = thread.run_started_at ? new Date(thread.run_started_at).getTime() : NaN;
  const lastBeatMs = thread.last_heartbeat_at ? new Date(thread.last_heartbeat_at).getTime() : NaN;
  console.log(JSON.stringify({
    event: "run_death_forensics",
    thread_id: thread.id,
    reason,
    run_started_at: thread.run_started_at ?? null,
    last_heartbeat_at: thread.last_heartbeat_at ?? null,
    // Elapsed run life. Compare against ORCHESTRATOR_WALL_CLOCK_MS (180s) to tell
    // "hit the ceiling" from "died early", and against FINALIZE_RESERVE_MS to tell
    // whether the forced-finalize window had even opened.
    run_elapsed_ms: Number.isFinite(runStartMs) && Number.isFinite(lastBeatMs) ? lastBeatMs - runStartMs : null,
    // How long the corpse sat before a sweep found it. STALE_RUN_AFTER_MS is a
    // FLOOR, not a schedule — the sweep is opportunistic, so this is unbounded.
    silent_ms: Number.isFinite(lastBeatMs) ? now.getTime() - lastBeatMs : null,
    artifact_count: artifactCount ?? 0,
    had_run_marker: !!(thread.run_started_at || thread.last_heartbeat_at),
    terminal_writer: "stale_recovery",
  }));
  let assistantInserted = false;
  const latestAssistantRow = latestAssistant as { created_at?: string; parts?: unknown } | null;
  const assistantState = shouldInsertRecoveredAssistant(
    thread,
    latestAssistantRow?.created_at ?? null,
    now.getTime(),
    RECENT_ASSISTANT_WINDOW_MS,
    assistantPartsToText(latestAssistantRow?.parts),
  );
  if (!assistantState.shouldInsert) {
    // Nothing to stub, but the thread is genuinely stale — still close it out.
    // `.select("id")` is REQUIRED: without it a lost status race is indistinguishable
    // from a won one and this branch reported recovered:true for a thread it never
    // claimed, inflating the sweeper's recovered count with phantom recoveries.
    const { data: closed, error: closeErr } = await db.from("threads").update({ status: "finished", recovered_at: now.toISOString(), recovery_reason: reason, updated_at: now.toISOString() }).eq("id", thread.id).eq("status", "active").select("id");
    if (closeErr) return { recovered: false, assistantInserted: false, artifactCount: artifactCount ?? 0, error: closeErr.message };
    return { recovered: !!closed && (closed as unknown[]).length > 0, assistantInserted: false, artifactCount: artifactCount ?? 0 };
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
  if (insertErr) return { recovered: true, assistantInserted: false, artifactCount: artifactCount ?? 0, error: insertErr.message };
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