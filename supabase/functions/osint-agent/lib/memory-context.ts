// lib/memory-context.ts — E3: recalled memory is CONTEXT, never a source.
//
// `memory_recall` returns what a PRIOR investigation concluded. It is not an
// observation of anything in this one, yet the model lists it as a source on
// the rows it records ("memory_recall + FastPeopleSearch + CA Notary"; 14 rows
// on 2026-10-07..09). Listing it makes a recalled claim read as fresh
// corroboration in the Source column, the evidence record and the export.
//
// Effect on the write path only, never on stored rows:
//   - a memory token is REMOVED from the source label and disclosed as
//     metadata.context_from_memory (+ metadata.memory_context_label);
//   - a row whose ONLY source is memory keeps its label (so its class stays
//     `unknown`, cap 50) but is forced to status needs_review with
//     metadata.memory_only=true — nothing in THIS run observed it.
// It can only lower or relabel; it never raises confidence or promotes status.
// Kill switch, read at call time: MEMORY_AS_SOURCE_DISABLED=true.
//
// The CITATION LABEL (lib/memory-provenance.ts MEMORY_CITATION_LABEL, "[MEMORY - prior run, unverified]") is the
// string the system prompt tells the model to cite recalled memory under, so it is the shape this rule MOST needs
// to recognise (#738 independent review, finding 5). Three things make that work:
//   - a bracketed token may start with "[" — ONLY the shapes a model writes a citation in ("[MEMORY]", "[MEMORY - …",
//     "[MEMORY: …", "[MEMORY prior run …", "[memory_recall …"). A bracketed NAME that merely starts with the word
//     ("[Memory Alpha] wiki", "[memory lane blog]") is a source, not a citation;
//   - a CLOSED bracket group is ONE token, so the comma inside the label cannot split it. An UNMATCHED "[" is an
//     ordinary character, exactly as before bracket support (otherwise it swallows every later separator);
//   - the comma in "<memory token>, unverified" never separates when "unverified" ENDS the token: "unverified" is not
//     a source, it is the tail of the citation, bracketed or not. Anything after it ("unverified & X") is left alone,
//     so a real source is never swallowed into the memory token.

// Unbracketed: E3's rule, plus "," as a boundary — a token only ever contains a top-level comma when the citation tail
// ("memory_recall, unverified") was folded into it. Bracketed: "[", `memory`, then either a tool slug
// (memory_recall/_save/_search) or one of "]", a spaced dash, a colon, "(", or a citation word (prior, earlier, …) —
// so "[MEMORY]", "[ MEMORY - prior run, unverified ]", "[MEMORY prior run]", "[memory_recall + X]" match, while
// "[Memory Alpha]", "[memory lane blog]" and "[memory-lane.example.com]" do not.
const MEMORY_TOKEN_RE =
  /^(?:\[\s*memory(?:_(?:recall|save|search)\b|\s*\]|\s+[-\u2013\u2014]|\s*:|\s*\(|\s+(?:prior|earlier|previous|recalled|unverified)\b)|memory(?:_(?:recall|save|search))?(?:\s*\(|$|\s|,))/i;

const HEAD_CHARS = 256;

/** "unverified" ENDING the token right after a memory token's comma is the tail of the citation, never a source. Sticky: tested at an index, no slicing. */
const CITATION_TAIL_RE = /\s*unverified\s*(?=$|[\])+|;,])/iy;

function readEnvSafe(k: string): string | undefined {
  try {
    return (globalThis as { Deno?: { env: { get(k: string): string | undefined } } }).Deno?.env.get(k);
  } catch {
    return undefined;
  }
}

export function memoryAsSourceDisabled(env: (k: string) => string | undefined = readEnvSafe): boolean {
  return (env("MEMORY_AS_SOURCE_DISABLED") ?? "").trim().toLowerCase() === "true";
}

/** Indexes of "[" that have no matching "]" later in the string. Those are ordinary characters, not grouping. */
function unmatchedOpenBrackets(label: string): Set<number> {
  const open: number[] = [];
  for (let i = 0; i < label.length; i++) {
    if (label[i] === "[") open.push(i);
    else if (label[i] === "]" && open.length) open.pop();
  }
  return new Set(open);
}

/** Split on top-level separators only (a "+" inside a parenthetical or a closed [bracketed label] stays put). */
function splitTopLevel(label: string): string[] {
  const parts: string[] = [];
  const unmatched = unmatchedOpenBrackets(label);
  let depth = 0;
  let cur = "";
  // First HEAD_CHARS of the current token. MEMORY_TOKEN_RE is anchored at the start, so the verdict needs only the
  // head; re-reading the whole accumulated token at every folded comma was quadratic (600 KB took ~9 s).
  let head = "";
  for (let i = 0; i < label.length; i++) {
    const ch = label[i];
    if (ch === "(" || (ch === "[" && !unmatched.has(i))) depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === "+" || ch === "|" || ch === ";" || ch === ",")) {
      // "<memory token>, unverified": the comma is part of the citation, not a boundary between two sources.
      if (ch === ",") {
        CITATION_TAIL_RE.lastIndex = i + 1;
        if (CITATION_TAIL_RE.test(label) && MEMORY_TOKEN_RE.test(head.trimStart())) {
          cur += ch;
          continue;
        }
      }
      parts.push(cur);
      cur = "";
      head = "";
      continue;
    }
    cur += ch;
    if (head.length < HEAD_CHARS) head += ch;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

export const isMemoryContextToken = (token: string): boolean => MEMORY_TOKEN_RE.test(token.trim());

export interface MemoryContextResult {
  source: string | undefined;
  metadata: Record<string, unknown> | undefined;
  /** true when a memory token was found (and the rule is on). */
  memory: boolean;
  /** true when memory was the ONLY source. */
  memoryOnly: boolean;
}

export function applyMemoryContext(
  source: string | undefined | null,
  metadata: Record<string, unknown> | undefined | null,
): MemoryContextResult {
  const passthrough: MemoryContextResult = {
    source: source ?? undefined,
    metadata: metadata ?? undefined,
    memory: false,
    memoryOnly: false,
  };
  if (memoryAsSourceDisabled() || typeof source !== "string" || !source) return passthrough;
  const tokens = splitTopLevel(source);
  const memTokens = tokens.filter(isMemoryContextToken);
  if (!memTokens.length) return passthrough;
  const rest = tokens.filter((t) => !isMemoryContextToken(t));
  const memoryOnly = rest.length === 0;
  const meta: Record<string, unknown> = {
    ...(metadata ?? {}),
    context_from_memory: true,
    memory_context_label: memTokens.join(" + "),
    ...(memoryOnly ? { memory_only: true, status: "needs_review" } : {}),
  };
  return {
    source: memoryOnly ? source : rest.join(" + "),
    metadata: meta,
    memory: true,
    memoryOnly,
  };
}

/** /health self-test; PRESENCE of the key proves the build. */
export function memoryContextSelfTest(): { ok: boolean; detail: string } {
  if (memoryAsSourceDisabled()) return { ok: true, detail: "LEGACY via MEMORY_AS_SOURCE_DISABLED" };
  const mixed = applyMemoryContext("memory_recall + FastPeopleSearch + CA Notary", {});
  const only = applyMemoryContext("memory_recall (prior investigation)", {});
  const clean = applyMemoryContext("FastPeopleSearch", {});
  // The citation label the prompt teaches (finding 5): one token, removed from a mixed source, memory-only alone.
  const cited = applyMemoryContext("[MEMORY - prior run, unverified] + FastPeopleSearch", {});
  const citedOnly = applyMemoryContext("[MEMORY - prior run, unverified]", {});
  const ok = mixed.source === "FastPeopleSearch + CA Notary" && mixed.metadata?.context_from_memory === true &&
    only.memoryOnly && only.metadata?.status === "needs_review" && !clean.memory &&
    cited.source === "FastPeopleSearch" && citedOnly.memoryOnly;
  return ok
    ? { ok: true, detail: "memory tokens leave the source label (context_from_memory); memory-only rows -> needs_review" }
    : { ok: false, detail: "memory-context rule misbehaving" };
}
