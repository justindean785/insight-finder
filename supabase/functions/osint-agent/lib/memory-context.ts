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
// to recognise (#738 independent review, finding 5). Two things make that work: a leading "[" is allowed, and a
// bracketed group is ONE token — the comma inside the label must not split it into a fake "unverified" source.
// The unbracketed form "MEMORY - prior run, unverified" has the same comma and is rejoined before splitting.

// Optional leading "[", then `memory`, then a boundary. "]" is a boundary so "[MEMORY]" matches; "memorial",
// "memorybank.example.com" and "[memory-lane.example.com]" do not.
const MEMORY_TOKEN_RE = /^\[?\s*memory(?:_(?:recall|save|search))?(?:\s*\(|\s*\]|$|\s)/i;

// "MEMORY - prior run, unverified" (brackets dropped by the model): drop the comma so it stays one token.
// The lookbehind skips the BRACKETED form, which splitTopLevel already keeps whole and whose text must survive
// verbatim in `memory_context_label`.
const UNBRACKETED_CITATION_COMMA_RE = /(?<!\[\s*)\b(memory\s*[-\u2013\u2014]\s*prior[\s-]+run),\s*(unverified)\b/gi;

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

/** Split on top-level separators only (a "+" inside a parenthetical or a [bracketed label] stays put). */
function splitTopLevel(label: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of label) {
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    if (depth === 0 && (ch === "+" || ch === "|" || ch === ";" || ch === ",")) {
      parts.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
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
  const tokens = splitTopLevel(source.replace(UNBRACKETED_CITATION_COMMA_RE, "$1 $2"));
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
