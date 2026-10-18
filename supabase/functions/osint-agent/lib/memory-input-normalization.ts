// lib/memory-input-normalization.ts — schema-safe normalization of memory_save / minimax_correlate input.
//
// Why. A model that means well sends the right data in a slightly wrong SHAPE: the entry fields at the top level instead
// of inside `entries`, `text` where the field is `content`, a list of sentences where one string is wanted, or an array of
// JSON strings for `artifacts`. The AI SDK rejects the call before `execute`, the step is burnt and the learning is lost
// (or, for a missing `subject`, an element is silently dropped).
//
// What it does — every rule is a pure re-SHAPING of data the model already sent, never a decision about it:
//   • memory_save, flat entry:   {kind, subject, content, …}  →  {entries: [{kind, subject, content, …}]}
//       only when `entries` is ABSENT, `scope` is the only other key, and kind/subject/content are all present;
//   • memory_save, element field names: type→kind, text|learning|note→content, value|selector→subject
//       only when the canonical field is absent AND exactly one alias for it is present;
//   • memory_save, element `content` that is an array of non-empty strings → the strings joined with a space
//       (a list of sentences is the same text; anything else — object, number, mixed array — is left to be rejected);
//   • minimax_correlate, `artifacts` elements that are JSON strings → parsed, only when they parse to a plain object.
//
// What it will NOT do (each pinned by a test):
//   • no VALUE is ever changed or mapped: `kind` keeps its value and must still be one of pattern/connection/lesson/identity
//     (no synonyms — a `lesson` bypasses the write gate and an `identity` escalates memory authority, so guessing one is
//     not harmless); `scope` is never defaulted or repaired (a bad scope stays a rejection, it is not widened to global);
//     `confidence`, `related_values` and `subject_kind` pass through untouched;
//   • no ambiguity is resolved by guessing: two aliases for one field, an alias beside its canonical field, an unknown extra
//     key beside flat fields, or an `entries` that is already present → the input is returned UNCHANGED;
//   • no authority is added: nothing here sets reviewed/confirmed/linkage fields, a source, or a score.
//
// KILL SWITCH, read at CALL TIME: MEMORY_INPUT_NORMALIZATION_DISABLED=true. /health proof key:
// checks.memory_input_normalization.

export function memoryInputNormalizationDisabled(): boolean {
  return (Deno.env.get("MEMORY_INPUT_NORMALIZATION_DISABLED") ?? "").trim().toLowerCase() === "true";
}

type Rec = Record<string, unknown>;
const isPlain = (v: unknown): v is Rec => !!v && typeof v === "object" && !Array.isArray(v);

/** canonical field → the field names a model has been seen to use instead. */
const ENTRY_ALIASES: Record<string, string[]> = {
  kind: ["type"],
  content: ["text", "learning", "note"],
  subject: ["value", "selector"],
};
const ENTRY_FIELDS = new Set(["kind", "subject", "subject_kind", "related_values", "content", "confidence"]);
const MAX_JOINED_SENTENCES = 8;

/** Rename aliases to their canonical field. Ambiguous input is returned as the SAME object, unchanged. */
export function normalizeMemoryEntry(entry: unknown): unknown {
  if (memoryInputNormalizationDisabled() || !isPlain(entry)) return entry;
  let out: Rec | null = null;
  for (const [canonical, aliases] of Object.entries(ENTRY_ALIASES)) {
    if (canonical in entry) continue; // the canonical field wins; an alias beside it is ignored, as before
    const present = aliases.filter((a) => a in entry);
    if (present.length !== 1) continue; // none → nothing to do; several → ambiguous, leave it
    out ??= { ...entry };
    out[canonical] = entry[present[0]];
    delete out[present[0]];
  }
  const base = out ?? entry;
  // A list of sentences is the same text. Anything that is not an array of non-empty strings is left to be rejected.
  const c = base.content;
  if (Array.isArray(c) && c.length > 0 && c.length <= MAX_JOINED_SENTENCES && c.every((s) => typeof s === "string" && s.trim().length > 0)) {
    out = { ...base, content: (c as string[]).map((s) => s.trim()).join(" ") };
  }
  return out ?? entry;
}

/**
 * memory_save: the entry fields sent at the top level instead of inside `entries`. Returns the input UNCHANGED unless it is
 * exactly a flat entry (plus, optionally, `scope`).
 */
export function wrapFlatMemoryEntry(raw: unknown): unknown {
  if (memoryInputNormalizationDisabled() || !isPlain(raw) || "entries" in raw) return raw;
  const { scope, ...rest } = raw;
  const entry = normalizeMemoryEntry(rest);
  if (!isPlain(entry)) return raw;
  // Every remaining key must be a known entry field — an unknown extra key makes the intent ambiguous.
  if (!Object.keys(entry).every((k) => ENTRY_FIELDS.has(k))) return raw;
  if (typeof entry.kind !== "string" || typeof entry.subject !== "string" || typeof entry.content !== "string") return raw;
  return "scope" in raw ? { entries: [entry], scope } : { entries: [entry] };
}

/** minimax_correlate: parse `artifacts` elements that are JSON strings, only when they parse to a plain object. */
export function parseStringArtifactElements(v: unknown): unknown {
  if (memoryInputNormalizationDisabled() || !Array.isArray(v)) return v;
  let changed = false;
  const out = v.map((el) => {
    if (typeof el !== "string") return el;
    try {
      const parsed = JSON.parse(el.trim());
      if (isPlain(parsed)) { changed = true; return parsed; }
    } catch { /* not JSON: left for the schema to reject */ }
    return el;
  });
  return changed ? out : v;
}

/** /health → checks.memory_input_normalization. Presence proves this build; ok:false means a rule failed its own probe. */
export function memoryInputNormalizationSelfTest(): { ok: boolean; detail: string } {
  if (memoryInputNormalizationDisabled()) return { ok: true, detail: "LEGACY via MEMORY_INPUT_NORMALIZATION_DISABLED" };
  const wrong: string[] = [];
  const flat = wrapFlatMemoryEntry({ kind: "lesson", subject: "s", content: "abc", scope: "case" }) as { entries?: Rec[]; scope?: unknown };
  if (flat.entries?.length !== 1 || flat.entries[0].kind !== "lesson" || flat.scope !== "case") wrong.push("flat entry not wrapped");
  const joined = normalizeMemoryEntry({ kind: "lesson", subject: "s", content: ["a b", "c d"] }) as Rec;
  if (joined.content !== "a b c d") wrong.push("sentence list not joined");
  const ambiguous = { kind: "lesson", subject: "s", text: "x", note: "y" };
  if (normalizeMemoryEntry(ambiguous) !== ambiguous) wrong.push("an ambiguous alias was guessed");
  const synonym = { kind: "insight", subject: "s", content: "abc" };
  if ((normalizeMemoryEntry(synonym) as Rec).kind !== "insight") wrong.push("a kind value was rewritten");
  const withEntries = { entries: [], kind: "lesson", subject: "s", content: "abc" };
  if (wrapFlatMemoryEntry(withEntries) !== withEntries) wrong.push("an input that already has entries was rewritten");
  return wrong.length
    ? { ok: false, detail: wrong.join("; ") }
    : { ok: true, detail: "memory_save/minimax_correlate input is re-shaped only when unambiguous; values (kind, scope, confidence) are never rewritten" };
}
