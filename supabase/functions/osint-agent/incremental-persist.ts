/**
 * incremental-persist.ts — sanitized mid-run progress checkpoints.
 *
 * WHY
 *   `streamText` only flushes the final assistant UIMessage in `onFinish`. If the
 *   isolate is CPU-killed mid-run (a routine failure mode for long OSINT runs),
 *   `onFinish` never fires and the analyst sees no findings in chat — even though
 *   the artifacts themselves are already durably persisted to `public.artifacts`
 *   (record_artifacts AWAITS that insert). This module surfaces a compact,
 *   SANITIZED progress checkpoint in chat after each step's record_artifacts
 *   hits, so the chat reflects progress up to the point of failure.
 *
 * ARCHITECTURE — why `messages` is an acceptable checkpoint store (see PR §arch)
 *   - The DURABLE source of truth is `public.artifacts` (normalized, already
 *     persisted, survives a kill). This module NEVER treats chat as the source
 *     of truth; a checkpoint is a best-effort UI projection.
 *   - The checkpoint text is DERIVED from the post-`scrubArtifactRows` contract
 *     record_artifacts returns — never from the raw `accepted` payload (which
 *     carries the PRE-scrub value and no safety flags). So no un-sanitized value
 *     ever reaches chat history.
 *   - Checkpoints carry a stable `_incremental` marker so the frontend collapses
 *     them once the final report lands (no duplicate rows) and so the edge
 *     excludes them from the model context on later steps/turns (no prompt bloat
 *     that would raise CPU-kill pressure).
 *
 * SAFETY — why raw values are never trusted
 *   A strict display-safe allowlist EXCLUDES credentials / secrets / tokens /
 *   cookies, raw breach payloads, possible-minor artifacts, collision-quarantined
 *   artifacts, and anything a value-level secret pattern matches. Truncation is
 *   NOT redaction and is never used as a substitute for it.
 *
 * RELIABILITY — why the write survives a kill
 *   The caller AWAITS a bounded persist AND registers it with
 *   `EdgeRuntime.waitUntil`, so the write is covered by BOTH the SDK's
 *   onStepFinish-await (ai@6 awaits the callback) AND the isolate keep-alive —
 *   correctness does not depend on either one alone.
 */

/** Milliseconds the caller will block on a checkpoint insert before moving on.
 *  The underlying promise keeps running (held by `registerBackground`); this
 *  bound only stops a slow DB from stalling the investigation. */
export const CHECKPOINT_AWAIT_MS = 4000;

/** Max findings listed in a single checkpoint message (kill-safety, not display). */
export const MAX_CHECKPOINT_ITEMS_SHOWN = 25;

/** Kinds whose values must NEVER be projected into chat history. */
export const CHECKPOINT_KIND_DENYLIST = new Set<string>([
  "credential", "credentials", "password", "passwd", "secret", "api_key", "apikey",
  "token", "access_token", "refresh_token", "session", "session_token", "cookie",
  "private_key", "seed_phrase", "mnemonic",
  "breach", "breach_record", "breach_payload", "stealer_log", "combolist", "leak_record",
  "dob", "date_of_birth", "ssn", "sin", "passport", "national_id",
  "bank_account", "iban", "card", "credit_card", "cvv", "pin",
  "excluded_collision", "excluded_collision_summary",
]);

/** Value-level secret pattern — defense in depth for an allowed kind that
 *  nonetheless carries token-shaped text (e.g. a JWT pasted into a note). */
export const CHECKPOINT_SECRET_VALUE_RE =
  /(?:pass(?:word|wd)?\b|secret\b|api[_-]?key|bearer\s|authorization:|-----BEGIN|\baccess[_-]?token\b|\brefresh[_-]?token\b|\bsession[_-]?(?:id|token)\b|\bcvv\b|\bssn\b|eyJ[A-Za-z0-9_-]{10,}\.)/i;

/** A post-scrub artifact row projected to a checkpoint descriptor (full form,
 *  used internally for the display-safe decision + audited by tests). */
export type CheckpointItem = {
  kind: string;
  value: string;
  source: string | null;
  platform: string | null;
  subject_scope: string | null;
  selector_scope: string | null;
  confidence: number | null;
  collision: boolean;
  possible_minor: boolean;
  status: string | null;
  safety_flags: string[];
  display_safe: boolean;
};

/** The LEAN, display-safe subset that leaves record_artifacts in its tool result
 *  and is consumed by `onStepFinish`. Only display-safe items are ever emitted,
 *  so no sensitive value rides in the model-visible tool output. */
export type CheckpointEmission = {
  kind: string;
  value: string;
  source: string | null;
  confidence: number | null;
};

type RowLike = { kind?: unknown; value?: unknown; confidence?: unknown; source?: unknown; metadata?: unknown };

function metaOf(row: unknown): Record<string, unknown> {
  const m = (row as { metadata?: unknown })?.metadata;
  return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, unknown>) : {};
}
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
function truthy(v: unknown): boolean {
  return v === true || v === "true" || v === "yes" || v === "1";
}

/**
 * Classify a single (kind, value, metadata) for checkpoint display. Pure and
 * exhaustively unit-tested — this is the security boundary.
 */
export function checkpointSafety(
  kind: string,
  value: string,
  meta: Record<string, unknown>,
): { possible_minor: boolean; collision: boolean; flags: string[]; display_safe: boolean } {
  const flags: string[] = [];
  const k = kind.toLowerCase();

  const possible_minor = truthy(meta.possible_minor) || truthy(meta.minor_warning);
  if (possible_minor) flags.push("possible_minor");
  const sensitive = truthy(meta.sensitive);
  if (sensitive) flags.push("sensitive");

  const status = str(meta.status)?.toLowerCase() ?? null;
  const collision =
    k === "excluded_collision" || k === "excluded_collision_summary" ||
    truthy(meta.excluded_collision) || truthy(meta.is_collision) ||
    truthy(meta.different_person) || truthy(meta.unrelated) ||
    status === "excluded";
  if (collision) flags.push("collision");

  const deniedKind = CHECKPOINT_KIND_DENYLIST.has(k);
  if (deniedKind) flags.push("denied_kind");

  const secretish = CHECKPOINT_SECRET_VALUE_RE.test(value) || CHECKPOINT_SECRET_VALUE_RE.test(k);
  if (secretish) flags.push("secret_pattern");

  const display_safe = !possible_minor && !sensitive && !collision && !deniedKind && !secretish;
  return { possible_minor, collision, flags, display_safe };
}

/**
 * Project post-scrub artifact rows to the full checkpoint contract. Rows MUST be
 * the sanitized rows (post-`scrubArtifactRows`), so `metadata` carries the safety
 * flags the display-safe decision depends on.
 */
export function buildCheckpointContract(rows: RowLike[] | null | undefined): CheckpointItem[] {
  if (!Array.isArray(rows)) return [];
  const out: CheckpointItem[] = [];
  for (const row of rows) {
    const kind = str(row?.kind) ?? "";
    const rawVal = typeof row?.value === "string" ? row.value : row?.value == null ? "" : String(row.value);
    const value = rawVal.trim();
    if (!kind || !value) continue;
    const meta = metaOf(row);
    const s = checkpointSafety(kind, value, meta);
    out.push({
      kind,
      value,
      source: str(row?.source),
      platform: str(meta.platform),
      subject_scope: str(meta.subject_scope) ?? str(meta.subject),
      selector_scope: str(meta.selector_scope) ?? str(meta.selector),
      confidence: typeof row?.confidence === "number" ? row.confidence : null,
      collision: s.collision,
      possible_minor: s.possible_minor,
      status: str(meta.status),
      safety_flags: s.flags,
      display_safe: s.display_safe,
    });
  }
  return out;
}

/**
 * The value record_artifacts attaches to its result as `checkpoint`: the LEAN,
 * display-safe subset only. Unsafe items never leave the tool, so no sensitive
 * value reaches model-visible output or chat history.
 */
export function emitSafeCheckpoint(rows: RowLike[] | null | undefined): CheckpointEmission[] {
  return buildCheckpointContract(rows)
    .filter((i) => i.display_safe)
    .map((i) => ({ kind: i.kind, value: i.value, source: i.source, confidence: i.confidence }));
}

/** Stable dedup key for a finding (kind + normalized value). */
export function checkpointKey(kind: string, value: string): string {
  return `${kind.toLowerCase()}:${value.trim().toLowerCase()}`;
}

/**
 * Deterministic checkpoint id (FNV-1a over threadId + sorted keys). Content-
 * derived — NEVER time/random — so a retry or replay of the same batch yields
 * the same id (idempotency + audit correlation).
 */
export function computeCheckpointId(threadId: string, keys: string[]): string {
  const basis = `${threadId}|${[...keys].sort().join("|")}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < basis.length; i++) {
    h ^= basis.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return "cp_" + (h >>> 0).toString(16).padStart(8, "0");
}

/** Render the checkpoint chat text from already-safe items, or null if none. */
export function renderCheckpointText(items: CheckpointEmission[]): string | null {
  if (!Array.isArray(items) || items.length === 0) return null;
  const shown = items.slice(0, MAX_CHECKPOINT_ITEMS_SHOWN);
  const remaining = items.length - shown.length;
  const bullets = shown.map((i) => `- **${i.kind}**: ${i.value}`).join("\n");
  const suffix = remaining > 0 ? `\n- …and ${remaining} more` : "";
  return `🔎 **Progress checkpoint** — recorded ${items.length} new finding${items.length === 1 ? "" : "s"}:\n${bullets}${suffix}`;
}

type SupabaseInsertLike = {
  from: (table: string) => {
    insert: (row: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
  };
};

export type CheckpointPersistContext = {
  supabase: SupabaseInsertLike;
  threadId: string;
  userId: string;
  /** Caller-owned dedup set, seeded from prior checkpoints (recovery/retry-safe). */
  seen: Set<string>;
  runId?: string | null;
};

export type CheckpointPersistResult = { inserted: boolean; count: number; checkpointId: string | null };

/**
 * Persist ONE checkpoint message for the new, display-safe findings in `items`.
 *
 * Independently re-validates every item against the allowlist (defense in depth,
 * even though only safe items are emitted upstream), dedups against the caller's
 * `seen` set, and never throws — a checkpoint failure must never break a run.
 */
export async function persistCheckpoint(
  ctx: CheckpointPersistContext,
  items: CheckpointEmission[] | null | undefined,
): Promise<CheckpointPersistResult> {
  if (!Array.isArray(items) || items.length === 0) return { inserted: false, count: 0, checkpointId: null };

  const fresh: CheckpointEmission[] = [];
  const keys: string[] = [];
  for (const it of items) {
    const kind = str(it?.kind);
    const value = typeof it?.value === "string" ? it.value.trim() : "";
    if (!kind || !value) continue;
    // Defense in depth: drop anything that fails the allowlist even here.
    if (!checkpointSafety(kind, value, {}).display_safe) continue;
    const key = checkpointKey(kind, value);
    if (ctx.seen.has(key)) continue;
    fresh.push({ kind, value, source: str(it?.source), confidence: typeof it?.confidence === "number" ? it.confidence : null });
    keys.push(key);
  }
  if (fresh.length === 0) return { inserted: false, count: 0, checkpointId: null };

  const text = renderCheckpointText(fresh);
  if (!text) return { inserted: false, count: 0, checkpointId: null };
  const checkpointId = computeCheckpointId(ctx.threadId, keys);

  try {
    const { error } = await ctx.supabase.from("messages").insert({
      thread_id: ctx.threadId,
      user_id: ctx.userId,
      role: "assistant",
      parts: [
        {
          type: "text",
          text,
          // Markers (ignored by the AI-SDK renderer): the frontend collapses
          // these once the final report lands, and the edge excludes them from
          // the model context. `_checkpoint_keys` seeds recovery-time dedup.
          _incremental: true,
          _checkpoint_id: checkpointId,
          _run_id: ctx.runId ?? null,
          _checkpoint_keys: keys,
        },
      ] as unknown,
    });
    if (error) {
      console.warn("[incremental-persist] insert failed:", error.message);
      return { inserted: false, count: 0, checkpointId };
    }
  } catch (e) {
    console.warn("[incremental-persist] insert threw:", (e as Error)?.message ?? e);
    return { inserted: false, count: 0, checkpointId };
  }
  for (const key of keys) ctx.seen.add(key);
  return { inserted: true, count: fresh.length, checkpointId };
}

/**
 * Pull the display-safe checkpoint emissions from a step's tool results. Reads
 * ONLY the `checkpoint` field record_artifacts emits (post-scrub) — never the
 * raw `accepted` payload.
 */
export function collectStepCheckpoint(toolResults: unknown[] | null | undefined): CheckpointEmission[] {
  if (!Array.isArray(toolResults)) return [];
  const out: CheckpointEmission[] = [];
  for (const tr of toolResults) {
    const t = tr as { toolName?: unknown; output?: unknown; result?: unknown };
    const name = typeof t?.toolName === "string" ? t.toolName : "";
    if (name !== "record_artifacts" && name !== "record_artifact") continue;
    const out0 = (t.output ?? t.result) as { ok?: unknown; checkpoint?: unknown } | null;
    if (!out0 || typeof out0 !== "object" || out0.ok !== true) continue;
    const cp = out0.checkpoint;
    if (!Array.isArray(cp)) continue;
    for (const c of cp) {
      const item = c as CheckpointEmission;
      if (item && typeof item === "object" && typeof item.kind === "string" && typeof item.value === "string") {
        out.push(item);
      }
    }
  }
  return out;
}

/** True when a UI message carries an incremental-checkpoint marker. */
export function isIncrementalMessage(m: unknown): boolean {
  const parts = (m as { parts?: unknown })?.parts;
  if (!Array.isArray(parts)) return false;
  return parts.some((p) => p && typeof p === "object" && (p as { _incremental?: unknown })._incremental === true);
}

/** Extract the checkpoint keys stored on an assistant message's parts. */
export function extractCheckpointKeys(parts: unknown): string[] {
  if (!Array.isArray(parts)) return [];
  const keys: string[] = [];
  for (const p of parts) {
    if (p && typeof p === "object" && (p as { _incremental?: unknown })._incremental === true) {
      const k = (p as { _checkpoint_keys?: unknown })._checkpoint_keys;
      if (Array.isArray(k)) for (const key of k) if (typeof key === "string") keys.push(key);
    }
  }
  return keys;
}

type SupabaseSelectLike = {
  from: (table: string) => {
    select: (cols: string) => {
      eq: (col: string, val: unknown) => Promise<{ data: Array<{ parts?: unknown }> | null; error: unknown }>;
    };
  };
};

/**
 * Seed a dedup set from checkpoints already persisted for this thread, so a
 * re-run or stale-run recovery never re-announces the same finding. Best-effort:
 * any failure yields an empty set (falls back to within-run dedup only).
 */
export async function loadSeenCheckpoints(supabase: SupabaseSelectLike, threadId: string): Promise<Set<string>> {
  const seen = new Set<string>();
  try {
    const { data, error } = await supabase.from("messages").select("parts").eq("thread_id", threadId);
    if (error || !Array.isArray(data)) return seen;
    for (const row of data) for (const key of extractCheckpointKeys(row?.parts)) seen.add(key);
  } catch (e) {
    console.warn("[incremental-persist] loadSeenCheckpoints failed:", (e as Error)?.message ?? e);
  }
  return seen;
}

/**
 * Register a best-effort background task with the Supabase Edge runtime so the
 * isolate is kept alive until it settles — independent of SDK callback-await
 * semantics. Falls back to fire-and-forget where `EdgeRuntime` is unavailable
 * (e.g. local `deno test`). Returns whether `waitUntil` was used.
 */
export function registerBackground(task: Promise<unknown>): boolean {
  const ert = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (ert && typeof ert.waitUntil === "function") {
    ert.waitUntil(task);
    return true;
  }
  void task;
  return false;
}

/** Await `p`, but never longer than `ms`. Resolves to `null` on timeout; the
 *  underlying promise keeps running (held alive by `registerBackground`). */
export async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
