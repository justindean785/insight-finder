import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * Analyst review states. Renamed for clarity (Nov 2026):
 *   reviewed            -> confirmed   (analyst attests this is TRUE)
 *   important           -> key         (critical lead, prioritise in report)
 *   needs_verification  -> recheck     (something looks off, needs another pass)
 *   dismissed                          (false positive, hide)
 * Old keys are migrated transparently on read.
 */
export type ReviewState =
  | "new"
  | "confirmed"
  | "recheck"
  | "key"
  | "dismissed"
  | "wrong";

export const REVIEW_STATES: ReviewState[] = [
  "new",
  "confirmed",
  "key",
  "recheck",
  "wrong",
  "dismissed",
];

export const REVIEW_LABEL: Record<ReviewState, string> = {
  new: "New",
  confirmed: "Confirmed true",
  recheck: "Needs another look",
  key: "Key finding",
  dismissed: "False positive",
  wrong: "Marked false (teach agent)",
};

export const REVIEW_SHORT: Record<ReviewState, string> = {
  new: "New",
  confirmed: "Confirm",
  recheck: "Recheck",
  key: "Key",
  dismissed: "Dismiss",
  wrong: "False",
};

export const REVIEW_HELP: Record<ReviewState, string> = {
  new: "Not yet reviewed by you.",
  confirmed:
    "You confirmed this is true. Boosts confidence (+20) and upgrades the label toward CONFIRMED.",
  recheck:
    "Looks suspect — wants another tool / source to back it up. Lowers confidence (-20) and downgrades toward VERIFY/LOW.",
  key:
    "Critical lead, pin to the top of the report. Also confirms it (+25 confidence).",
  dismissed:
    "False positive. Forces label to FAILED and hides from clusters/pivots.",
  wrong:
    "Wrong / incorrect data. Forces FAILED, and writes a durable lesson to agent memory so future investigations skip this lead.",
};

/** Confidence adjustment applied to artifact.confidence when computing the label. */
export const REVIEW_CONFIDENCE_DELTA: Record<ReviewState, number> = {
  new: 0,
  confirmed: 20,
  key: 25,
  recheck: -20,
  dismissed: 0, // handled as FAILED override
  wrong: -40,   // pull confidence down hard in addition to FAILED override
};

export const REVIEW_CLASS: Record<ReviewState, string> = {
  new: "text-muted-foreground border-border bg-secondary/40",
  confirmed:
    "text-[hsl(var(--confidence-high))] border-[hsl(var(--confidence-high))]/40 bg-[hsl(var(--confidence-high))]/10",
  recheck:
    "text-[hsl(var(--confidence-mid))] border-[hsl(var(--confidence-mid))]/40 bg-[hsl(var(--confidence-mid))]/10",
  key: "text-primary border-primary/40 bg-primary/10",
  dismissed:
    "text-muted-foreground border-border bg-secondary/40 line-through opacity-60",
  wrong:
    "text-destructive border-destructive/40 bg-destructive/10 line-through",
};

const LEGACY_KEY = (threadId: string) => `proximity:review:${threadId}`;
const EVT = "proximity:review-changed";

type Map = Record<string, ReviewState>;
type NoteMap = Record<string, string>;

const LEGACY: Record<string, ReviewState> = {
  reviewed: "confirmed",
  important: "key",
  needs_verification: "recheck",
};

/** Module-level cache keyed by threadId so multiple hook consumers share state without refetching. */
const cache = new Map<string, { states: Map; notes: NoteMap; loaded: boolean }>();

function ensure(threadId: string) {
  let c = cache.get(threadId);
  if (!c) { c = { states: {}, notes: {}, loaded: false }; cache.set(threadId, c); }
  return c;
}

function emit(threadId: string) {
  window.dispatchEvent(new CustomEvent(EVT, { detail: { threadId } }));
}

/** Pull legacy localStorage entries (if any) into the DB once per thread. */
async function migrateLegacy(threadId: string, userId: string) {
  try {
    const raw = localStorage.getItem(LEGACY_KEY(threadId));
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, string>;
    const rows: { thread_id: string; artifact_id: string; user_id: string; state: ReviewState }[] = [];
    for (const [artifactId, v] of Object.entries(parsed)) {
      const mapped = (LEGACY[v] ?? v) as ReviewState;
      if (REVIEW_STATES.includes(mapped) && mapped !== "new") {
        rows.push({ thread_id: threadId, artifact_id: artifactId, user_id: userId, state: mapped });
      }
    }
    if (rows.length) {
      await supabase.from("artifact_reviews").upsert(rows, { onConflict: "user_id,artifact_id" });
    }
    localStorage.removeItem(LEGACY_KEY(threadId));
  } catch { /* ignore */ }
}

async function loadFromDb(threadId: string) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  await migrateLegacy(threadId, user.id);
  const { data } = await supabase
    .from("artifact_reviews")
    .select("artifact_id,state,note")
    .eq("thread_id", threadId)
    .eq("user_id", user.id);
  const c = ensure(threadId);
  c.states = {};
  c.notes = {};
  for (const row of (data ?? []) as { artifact_id: string; state: ReviewState; note: string | null }[]) {
    c.states[row.artifact_id] = row.state;
    if (row.note) c.notes[row.artifact_id] = row.note;
  }
  c.loaded = true;
  emit(threadId);
}

export function useReviewStates(threadId: string) {
  const c = ensure(threadId);
  const [map, setMap] = useState<Map>(c.states);
  const [notes, setNotes] = useState<NoteMap>(c.notes);
  const loadingRef = useRef(false);

  useEffect(() => {
    setMap(ensure(threadId).states);
    setNotes(ensure(threadId).notes);
    if (!ensure(threadId).loaded && !loadingRef.current) {
      loadingRef.current = true;
      loadFromDb(threadId).finally(() => { loadingRef.current = false; });
    }
    const onChange = (e: Event) => {
      const d = (e as CustomEvent).detail as { threadId?: string } | undefined;
      if (!d || d.threadId === threadId) {
        setMap({ ...ensure(threadId).states });
        setNotes({ ...ensure(threadId).notes });
      }
    };
    window.addEventListener(EVT, onChange);
    return () => window.removeEventListener(EVT, onChange);
  }, [threadId]);

  const get = useCallback((id: string): ReviewState => map[id] ?? "new", [map]);
  const getNote = useCallback((id: string): string => notes[id] ?? "", [notes]);

  const set = useCallback(
    async (
      id: string,
      state: ReviewState | null,
      ctx?: { value?: string; kind?: string },
    ) => {
      const c = ensure(threadId);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      if (state == null || state === "new") {
        delete c.states[id];
        emit(threadId);
        await supabase.from("artifact_reviews").delete().eq("artifact_id", id).eq("user_id", user.id);
      } else {
        c.states[id] = state;
        emit(threadId);
        await supabase.from("artifact_reviews").upsert(
          { thread_id: threadId, artifact_id: id, user_id: user.id, state },
          { onConflict: "user_id,artifact_id" },
        );
        // Teach the agent: when an analyst marks an artifact as factually
        // wrong, persist a durable cross-investigation lesson so future
        // runs recall it and skip the bad lead.
        if (state === "wrong" && ctx?.value) {
          const subject = String(ctx.value).trim().toLowerCase();
          if (subject) {
            const kindHint = ctx.kind ? ` (${ctx.kind})` : "";
            const entry = {
              kind: "lesson",
              subject,
              subject_kind: ctx.kind ?? null,
              related_values: [],
              content:
                `Analyst marked "${ctx.value}"${kindHint} as FALSE / incorrect data. ` +
                `Do NOT re-propose this artifact in future investigations for the same user. ` +
                `Treat as a confirmed false positive even if a tool surfaces it again.`,
              confidence: 95,
            };
            try {
              await supabase.rpc("save_agent_memories", {
                _user_id: user.id,
                _thread_id: threadId,
                _entries: [entry],
              });
            } catch { /* best-effort; UI state is already saved */ }
          }
        }
      }
    },
    [threadId],
  );

  const setNote = useCallback(
    async (id: string, note: string) => {
      const c = ensure(threadId);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const trimmed = note.trim();
      if (trimmed) c.notes[id] = trimmed; else delete c.notes[id];
      emit(threadId);
      // Need a row to attach a note to; default to "confirmed" if none exists yet.
      const existing = c.states[id];
      const stateToWrite = existing ?? "confirmed";
      if (!existing) { c.states[id] = stateToWrite; emit(threadId); }
      await supabase.from("artifact_reviews").upsert(
        { thread_id: threadId, artifact_id: id, user_id: user.id, state: stateToWrite, note: trimmed || null },
        { onConflict: "user_id,artifact_id" },
      );
    },
    [threadId],
  );

  const clear = useCallback(async () => {
    const c = ensure(threadId);
    c.states = {}; c.notes = {};
    emit(threadId);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    await supabase.from("artifact_reviews").delete().eq("thread_id", threadId).eq("user_id", user.id);
  }, [threadId]);

  return { map, notes, get, getNote, set, setNote, clear };
}