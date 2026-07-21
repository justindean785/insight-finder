import { createClient } from "npm:@supabase/supabase-js@2";

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

export type RecoveryMemory = {
  kind?: string | null;
  subject?: string | null;
  content?: string | null;
  confidence?: number | null;
};

export type RecoveryAssistantState = {
  shouldInsert: boolean;
  reason: "none" | "no_assistant" | "assistant_before_run" | "assistant_stale";
};

/**
 * The generated Database types are not wired into this client, so supabase-js
 * infers every `.update()` payload parameter as `never`. Funnelling the claim
 * and its release through one helper keeps that cast in a single place instead
 * of repeating it at each call site.
 */
function threadsUpdate(db: DbClient, patch: Record<string, unknown>) {
  return db.from("threads").update(patch as never);
}

/** Human-readable next-pivot actions by artifact kind — mirrors the completed
 *  report shape from buildReportMarkdown / SUGGESTED_TOOLS_BY_KIND (intel.ts)
 *  without importing the frontend module into the edge runtime. */
const RECOVERY_PIVOT_ACTIONS_BY_KIND: Record<string, string[]> = {
  email: [
    "Verifying email deliverability",
    "Checking linked avatar data",
    "Reviewing restricted indicators",
    "Evaluating sensitive-source indicators",
  ],
  username: [
    "Checking developer profile traces",
    "Reviewing community activity history",
    "Reviewing tech community footprint",
    "Building targeted search queries",
  ],
  phone: [
    "Checking phone association",
    "Reviewing restricted indicators",
    "Cross-checking breach exposure",
  ],
  ip: [
    "Gathering IP intelligence",
    "Fingerprinting exposed services",
    "Running network reconnaissance",
  ],
  domain: [
    "Reviewing domain registration",
    "Checking DNS and certificates",
    "Scanning related infrastructure",
  ],
  url: [
    "Fingerprinting the page",
    "Checking archive history",
    "Reviewing URL reputation",
  ],
  social_profile: [
    "Pulling the live profile",
    "Corroborating the handle across platforms",
  ],
  name: [
    "Running independent identity checks",
    "Building targeted search queries",
  ],
  address: [
    "Corroborating with property records",
    "Cross-checking associated residents",
  ],
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

/** Build kind-grouped + value-concrete next-pivot lines for a recovered run.
 *  Heading uses "Pivots" (not only "Steps") so frontend extractRecommendedPivots
 *  can populate the Next Steps rail. */
export function buildRecoveredNextPivots(
  artifacts: RecoveryArtifact[],
  memories: RecoveryMemory[] = [],
): string[] {
  const byKind = new Map<string, RecoveryArtifact[]>();
  for (const a of artifacts) {
    const kind = String(a.kind ?? "").trim().toLowerCase();
    const value = String(a.value ?? "").trim();
    if (!kind || !value) continue;
    if (!RECOVERY_PIVOT_ACTIONS_BY_KIND[kind]) continue;
    const list = byKind.get(kind) ?? [];
    if (list.some((x) => String(x.value).trim().toLowerCase() === value.toLowerCase())) continue;
    list.push(a);
    byKind.set(kind, list);
  }
  const lines: string[] = [];
  // Concrete value pivots FIRST so extractRecommendedPivots (6-card cap) prefers
  // actionable Investigate/Corroborate lines over kind-summary rows.
  const concrete: string[] = [];
  for (const [kind, arts] of byKind) {
    for (const a of arts.slice(0, 2)) {
      const value = String(a.value ?? "").trim();
      if (!value) continue;
      const actions = RECOVERY_PIVOT_ACTIONS_BY_KIND[kind] ?? [];
      const hint = actions.slice(0, 2).join("; ") || "corroborate with independent sources";
      if (kind === "username" || kind === "social_profile") {
        concrete.push(`- Corroborate username ${value} across platforms — ${hint}`);
      } else if (kind === "email" || kind === "phone" || kind === "ip" || kind === "domain") {
        concrete.push(`- Investigate ${value} — recovered ${kind} lead; ${hint}`);
      } else {
        concrete.push(`- Review ${value} — recovered ${kind} lead; ${hint}`);
      }
      if (concrete.length >= 4) break;
    }
    if (concrete.length >= 4) break;
  }
  lines.push(...concrete);
  // Kind-grouped consider lines (reference report shape from phone seed run).
  for (const [kind, actions] of Object.entries(RECOVERY_PIVOT_ACTIONS_BY_KIND)) {
    if (!byKind.has(kind)) continue;
    lines.push(`- **${kind}** — consider: ${actions.join(", ")}`);
  }
  for (const m of memories.slice(0, 5)) {
    const subject = String(m.subject ?? "").trim();
    const content = String(m.content ?? "").trim().replace(/\s+/g, " ").slice(0, 160);
    if (!subject || !content) continue;
    // Avoid secret-like memory content in the public stub.
    if (/\b(password|passcode|secret|token|cookie|session|credential|ssn|cvv)\b/i.test(content)) continue;
    lines.push(`- Review ${subject} — [MEMORY] ${content}`);
  }
  return lines;
}

export function buildRecoveredAssistantText(
  thread: Pick<RecoverableThread, "seed_value" | "title" | "last_heartbeat_at" | "run_started_at">,
  artifacts: RecoveryArtifact[],
  memories: RecoveryMemory[] = [],
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
  const pivotLines = buildRecoveredNextPivots(rows, memories);
  const pivotsSection = pivotLines.length > 0
    ? ["## Recommended Next Pivots", ...pivotLines, ""]
    : [
      "## Recommended Next Pivots",
      "- Re-run the seed to continue collection — no durable artifact kinds were available to derive pivots.",
      "",
    ];
  if (rows.length === 0) {
    return [
      ...header,
      "No confirmed artifacts were recorded before the interruption.",
      "",
      ...pivotsSection,
      "### Gaps",
      "- The backend stopped before final synthesis completed.",
      "- Re-run the seed to continue collection.",
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
    ...pivotsSection,
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

async function loadRecoveryMemories(
  db: DbClient,
  userId: string,
  subjects: string[],
): Promise<RecoveryMemory[]> {
  const cleaned = [...new Set(subjects.map((s) => s.trim().toLowerCase()).filter((s) => s.length >= 2))].slice(0, 12);
  if (cleaned.length === 0) return [];
  // Prefer memories tied to this user's subjects overlapping recovered values.
  // Best-effort: failures return [] so recovery still inserts the artifact stub.
  try {
    const orFilter = cleaned.map((s) => `subject.eq.${s}`).join(",");
    const { data, error } = await db
      .from("agent_memory")
      .select("kind,subject,content,confidence")
      .eq("user_id", userId)
      .or(orFilter)
      .order("confidence", { ascending: false })
      .limit(8);
    if (error) {
      console.warn("[recovery] agent_memory lookup failed:", error.message);
      return [];
    }
    return (data ?? []) as RecoveryMemory[];
  } catch (e) {
    console.warn("[recovery] agent_memory lookup threw:", e);
    return [];
  }
}

async function recoverOneStaleThread(
  db: DbClient,
  thread: RecoverableThread,
  now: Date,
  reason: string,
): Promise<{ recovered: boolean; assistantInserted: boolean; artifactCount: number; error?: string }> {
  if (!isStaleActiveThread(thread, now.getTime())) return { recovered: false, assistantInserted: false, artifactCount: 0 };

  // ---- ATOMIC CLAIM ---------------------------------------------------------
  // The ONE step that decides which of several concurrent sweeps (startup sweep,
  // /health sweep, pre-request sweep) gets to recover this thread. Every entry
  // point routes through here, so this is the single serialization point.
  //
  // It is a real compare-and-swap, not read-then-write: Postgres evaluates the
  // WHERE clause and mutates the row in one indivisible statement, so at most one
  // caller's UPDATE can match. `.select("id")` is what makes the CAS observable —
  // WITHOUT it a zero-row UPDATE returns no error, which is exactly why the old
  // code had both callers believe they had won.
  //
  // The swap is guarded on BOTH conditions this recovery decision rests on:
  //   status = 'active'          — nobody else has already claimed or finished it
  //   last_heartbeat_at = <read> — the run has not resumed since we read the row
  // The heartbeat guard closes the window between the caller's read and this
  // claim; a run that pulsed in between changes the value, our WHERE matches
  // nothing, and we correctly decline to recover a thread that is alive again.
  //
  // Placed BEFORE the artifact query and the report insert (the old code ran the
  // status flip LAST, after inserting). A caller that loses never reaches the
  // insert at all, so a duplicate "Findings report — recovered run" is
  // structurally impossible rather than merely unlikely.
  const claimIso = now.toISOString();
  const claimPatch = { status: "finished", recovered_at: claimIso, recovery_reason: reason, updated_at: claimIso };
  const claimBase = threadsUpdate(db, claimPatch).eq("id", thread.id).eq("status", "active");
  // `.eq(col, null)` is `col = NULL` in SQL, which is never true — a null
  // heartbeat has to be matched with IS NULL or the claim can never succeed.
  const { data: claimed, error: claimErr } = await (
    thread.last_heartbeat_at == null
      ? claimBase.is("last_heartbeat_at", null)
      : claimBase.eq("last_heartbeat_at", thread.last_heartbeat_at)
  ).select("id");
  if (claimErr) return { recovered: false, assistantInserted: false, artifactCount: 0, error: claimErr.message };
  if (!Array.isArray(claimed) || claimed.length === 0) {
    // Lost the race (or the run resumed) — another caller owns this thread.
    return { recovered: false, assistantInserted: false, artifactCount: 0 };
  }

  const [{ data: latestAssistant }, { data: artifacts, count: artifactCount }] = await Promise.all([
    db.from("messages").select("created_at").eq("thread_id", thread.id).eq("role", "assistant").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    db.from("artifacts").select("kind,value,confidence,source,created_at", { count: "exact" }).eq("thread_id", thread.id).order("confidence", { ascending: false }).order("created_at", { ascending: true }).limit(RECOVERY_ARTIFACT_LIMIT),
  ]);
  let assistantInserted = false;
  const assistantState = shouldInsertRecoveredAssistant(
    thread,
    (latestAssistant as { created_at?: string } | null)?.created_at ?? null,
    now.getTime(),
  );
  if (assistantState.shouldInsert) {
    const arts = (artifacts ?? []) as RecoveryArtifact[];
    const subjects = [
      thread.seed_value ?? "",
      ...arts.map((a) => String(a.value ?? "")),
    ];
    const memories = await loadRecoveryMemories(db, thread.user_id, subjects);
    const text = buildRecoveredAssistantText(thread, arts, memories);
    const { error: insertErr } = await db.from("messages").insert({ thread_id: thread.id, user_id: thread.user_id, role: "assistant", parts: [{ type: "text", text }] });
    if (insertErr) {
      // The claim succeeded but the report did not land. Releasing the claim is
      // what keeps this RETRYABLE: leaving the thread `finished` would strand it
      // terminal with no report and no sweep would ever look at it again. We put
      // it back exactly as we found it — including the original `updated_at`, so
      // it still reads as stale — and the next sweep re-claims and retries. The
      // guard on status='finished' means we only ever undo OUR OWN claim.
      const { error: releaseErr } = await threadsUpdate(db, { status: "active", recovered_at: null, recovery_reason: null, updated_at: thread.updated_at ?? claimIso })
        .eq("id", thread.id)
        .eq("status", "finished");
      if (releaseErr) {
        // Observable rather than silent: the thread is terminal with no report.
        console.warn(`[recovery] claim release failed for ${thread.id} after insert error:`, releaseErr.message);
      }
      return { recovered: false, assistantInserted: false, artifactCount: artifactCount ?? 0, error: insertErr.message };
    }
    assistantInserted = true;
  }
  // No trailing status flip: the claim above already finalized the thread, and
  // repeating it here is what let a losing caller report success.
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