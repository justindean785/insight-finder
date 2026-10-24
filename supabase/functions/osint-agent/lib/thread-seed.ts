// lib/thread-seed.ts — the seed a correlate call may fall back to when the model omits it.
//
// MEASURED (thread 0ea52455, 2026-10-21, build aae1152): minimax_correlate was called with
// `{artifacts: "<json string>"}` and no `seed`, and was rejected by the schema before execute
// (uncharged, but a wasted step and a lost correlation). The input coercion cannot fill it: the
// schema cache is module-global (one schema per tool name for every thread), so a preprocess can
// never know THIS thread's seed. The fallback therefore resolves in execute, from the request:
//   1. the seed the model sent (trimmed) — always wins;
//   2. the request's PERSON seed (ToolContext.getSubjectSeedName, "" when not a person seed);
//   3. the thread's seed as the analyst typed it: the FIRST user message's text, classified by
//      detectSeedServer, accepted only for a STRUCTURAL kind (THREAD_SEED_KINDS). Never `other`
//      and never `person`: measured 2026-10-23, detectSeedServer labels any few-word prose
//      `person` ("look into this for me"), and CLAUDE.md is explicit that intent is not inferred
//      from prose.
// When nothing resolves, the tool keeps its existing uncharged skip, now saying what was tried.
// Never triageState.seed (guard.ts): that is module state shared across threads on an isolate.

export interface SeedLike {
  kind: string;
  normalized: string;
}

export type CorrelateSeedSource = "input" | "subject_name" | "thread_seed";

export interface CorrelateSeedResolution {
  seed: string;
  source: CorrelateSeedSource | null;
  /** Which fallbacks were consulted and found empty — for the skip message, never values. */
  tried: CorrelateSeedSource[];
}

type MessageLike = { role?: string; parts?: Array<{ type?: string; text?: string }> | null };

/** The first user message's text parts, joined; "" when there is none. */
export function firstUserText(messages: readonly MessageLike[] | null | undefined): string {
  for (const m of messages ?? []) {
    if (m?.role !== "user") continue;
    return (m.parts ?? [])
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text as string)
      .join(" ")
      .trim();
  }
  return "";
}

/** Kinds whose detection is a regex on the value's shape, never a word count. */
export const THREAD_SEED_KINDS: ReadonlySet<string> = new Set(["email", "username", "phone", "ip", "domain", "url", "crypto", "address"]);

/** The analyst's seed from the first user message, when it is a STRUCTURAL selector; null otherwise. */
export function threadSeedFromMessages(
  messages: readonly MessageLike[] | null | undefined,
  detect: (text: string) => SeedLike | null,
): string | null {
  const text = firstUserText(messages);
  if (!text || text.length > 512) return null;
  let d: SeedLike | null;
  try {
    d = detect(text);
  } catch {
    return null;
  }
  if (!d || !d.kind || !THREAD_SEED_KINDS.has(d.kind)) return null;
  const v = String(d.normalized ?? "").trim();
  return v ? v : null;
}

export function resolveCorrelateSeed(input: {
  seed: unknown;
  subjectName?: string | null;
  messages?: readonly MessageLike[] | null;
  detect: (text: string) => SeedLike | null;
}): CorrelateSeedResolution {
  const sent = typeof input.seed === "string" ? input.seed.trim() : "";
  if (sent) return { seed: sent, source: "input", tried: [] };
  const tried: CorrelateSeedSource[] = [];
  const subject = String(input.subjectName ?? "").trim();
  if (subject) return { seed: subject, source: "subject_name", tried };
  tried.push("subject_name");
  const thread = threadSeedFromMessages(input.messages, input.detect);
  if (thread) return { seed: thread, source: "thread_seed", tried };
  tried.push("thread_seed");
  return { seed: "", source: null, tried };
}

/** /health → checks.correlate_seed_default. Pure; PRESENCE proves the build. */
export function correlateSeedDefaultSelfTest(): { ok: boolean; detail: string } {
  const detect = (t: string): SeedLike | null =>
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t) ? { kind: "email", normalized: t.toLowerCase() } : { kind: "person", normalized: t };
  const msgs = [{ role: "user", parts: [{ type: "text", text: "Probe@Example.test" }] }];
  const a = resolveCorrelateSeed({ seed: " sent ", subjectName: "x", messages: msgs, detect });
  const b = resolveCorrelateSeed({ seed: "", subjectName: " Subject Name ", messages: msgs, detect });
  const c = resolveCorrelateSeed({ seed: undefined, subjectName: "", messages: msgs, detect });
  const d = resolveCorrelateSeed({ seed: null, subjectName: null, messages: [{ role: "user", parts: [{ type: "text", text: "some prose seed" }] }], detect });
  const ok = a.seed === "sent" && a.source === "input" &&
    b.seed === "Subject Name" && b.source === "subject_name" &&
    c.seed === "probe@example.test" && c.source === "thread_seed" &&
    d.source === null && d.tried.join(",") === "subject_name,thread_seed";
  return ok
    ? { ok: true, detail: "a correlate call with no seed falls back to the request's subject name, then the thread's first-message selector (never prose); otherwise an uncharged skip that says what was tried" }
    : { ok: false, detail: "correlate seed default misbehaving" };
}
