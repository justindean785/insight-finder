// lib/historical-memory.ts — a memory result REPLAYED from an earlier turn is an unverified lead, never evidence.
//
// MITIGATION of authority escalation, not a report-integrity fix. The history label (lib/history-label.ts) covers
// assistant TEXT only. A thread started before the provenance change already stores `memory_recall` results — and
// `record_artifacts` results carrying `memory_hits` plus the old "incorporate confirmed connections … Do NOT
// re-investigate values already covered" hint — in its UI messages. The client replays them on every turn, so they
// re-enter the model's context untagged: no per-row provenance, no note, and the very wording the PR removes from the
// live surfaces. (The tool-result CACHE is a separate path, versioned in lib/tool-cache-version.ts.)
//
// WHAT THIS DOES — on the MODEL MESSAGES only, at request time. Nothing stored is rewritten: not the UI messages, not
// agent_memory, not an artifact, not an evidence row.
//   • a replayed `memory_recall` / `record_artifacts` / `record_artifact` result that carries recalled rows with no
//     recorded provenance gets every such row tagged exactly as the live path would tag it (`unreviewed`, or
//     `analyst_marker_pattern` for the analyst false-positive wording — an EXCLUSION, never an authority);
//   • the result is headed by `historical_memory_note` as its FIRST key, so every head-preserving trim keeps it
//     (summarizeToolResultValue keeps the head of the serialised value; truncateStr is slice(0, max));
//   • the legacy auto-recall hint, matched EXACTLY, is replaced by the current non-escalating one.
// Provenance cannot be reconstructed (agent_memory has no writer column), so the rule is the conservative one: a
// replayed row is an unverified prior-run lead. The mark can only LOWER what the model may believe; it adds no source,
// score, status or review field, and every recalled string (including breach values and minor-safety wording) is
// carried byte-for-byte.
//
// Results written AFTER the change are already tagged and are returned as the SAME objects, so a mark is never applied
// twice. Idempotent. KILL SWITCH (call time): HISTORICAL_MEMORY_MARK_DISABLED=true — or the master
// MEMORY_AUTHORITY_WORDING_DISABLED=true — returns the messages untouched. /health proof: checks.historical_memory.

import {
  LEGACY_AUTO_RECALL_HINT,
  MEMORY_CITATION_LABEL,
  autoRecallHint,
  historicalMemoryMarkDisabled,
  memoryAuthorityWordingDisabled,
  memoryProvenance,
} from "./memory-provenance.ts";
import type { MemoryRow } from "./memory-supersession.ts";

/** Tools whose stored results can carry recalled memory rows. */
const MEMORY_BEARING_TOOLS = new Set(["memory_recall", "record_artifacts", "record_artifact"]);

export const HISTORICAL_MEMORY_NOTE =
  "HISTORICAL MEMORY RESULT, replayed from an earlier turn of this conversation. These rows were returned before provenance tagging existed: who wrote them and what evidence backed them were not recorded, so they are unverified prior-run leads, not evidence and not corroboration. Do not treat any of them as confirmed, attested or analyst-reviewed. Re-verify a positive claim with a fresh source before reporting it, and cite it as " +
  MEMORY_CITATION_LABEL + ". Rows tagged `analyst_marker_pattern` are exclusions: do not re-propose the named value.";

interface MsgLike {
  role?: string;
  content?: unknown;
  [k: string]: unknown;
}

type RecordLike = Record<string, unknown>;
const isRecord = (v: unknown): v is RecordLike => !!v && typeof v === "object" && !Array.isArray(v);
const hasTag = (row: unknown): boolean => isRecord(row) && typeof row.provenance === "string";

/** Tag the untagged rows of one `memories` array; returns the same array when nothing needed tagging. */
function tagRows(rows: unknown[]): { rows: unknown[]; changed: boolean } {
  let changed = false;
  const out = rows.map((r) => {
    if (!isRecord(r) || hasTag(r)) return r;
    changed = true;
    return { ...r, provenance: memoryProvenance(r as MemoryRow) };
  });
  return changed ? { rows: out, changed } : { rows, changed };
}

/** Mark one tool-result VALUE. Returns the SAME object when there is nothing to mark. */
function markValue(value: unknown): unknown {
  if (!isRecord(value)) return value;
  let changed = false;
  const next: RecordLike = { ...value };

  // memory_recall shape: { memories: [...] }
  if (Array.isArray(value.memories) && value.memories.length > 0) {
    const t = tagRows(value.memories);
    if (t.changed) {
      next.memories = t.rows;
      changed = true;
    }
  }
  // record_artifacts shape: { memory_hits: [{ subject, count, memories: [...] }], memory_hint }
  if (Array.isArray(value.memory_hits) && value.memory_hits.length > 0) {
    let hitsChanged = false;
    const hits = value.memory_hits.map((h) => {
      if (!isRecord(h) || !Array.isArray(h.memories) || h.memories.length === 0) return h;
      const t = tagRows(h.memories);
      if (!t.changed) return h;
      hitsChanged = true;
      return { ...h, memories: t.rows };
    });
    if (hitsChanged) {
      next.memory_hits = hits;
      changed = true;
    }
    // The escalating hint is replaced only when it is EXACTLY the legacy text; any other string is left alone.
    if (value.memory_hint === LEGACY_AUTO_RECALL_HINT) {
      next.memory_hint = autoRecallHint();
      changed = true;
    }
  }
  if (!changed) return value;
  // The note goes FIRST so head-preserving trims keep it.
  const { historical_memory_note: _drop, ...rest } = next;
  return { historical_memory_note: HISTORICAL_MEMORY_NOTE, ...rest };
}

function markContent(content: unknown): { content: unknown; changed: boolean } {
  if (!Array.isArray(content)) return { content, changed: false };
  let changed = false;
  const out = content.map((part) => {
    const p = part as { type?: string; toolName?: unknown; output?: unknown } | null;
    if (
      !p || p.type !== "tool-result" || typeof p.toolName !== "string" || !MEMORY_BEARING_TOOLS.has(p.toolName) ||
      !isRecord(p.output) || p.output.type !== "json" || !("value" in p.output)
    ) return part;
    const marked = markValue(p.output.value);
    if (marked === p.output.value) return part;
    changed = true;
    return { ...(p as Record<string, unknown>), output: { ...p.output, value: marked } };
  });
  return changed ? { content: out, changed } : { content, changed };
}

export function markHistoricalMemoryResults<T extends MsgLike>(messages: ReadonlyArray<T>): T[] {
  const list = Array.isArray(messages) ? [...messages] : [];
  if (historicalMemoryMarkDisabled()) return list;
  return list.map((m) => {
    if (m?.role !== "tool") return m;
    const r = markContent(m.content);
    return r.changed ? ({ ...m, content: r.content } as T) : m;
  });
}

/** /health proof: PRESENCE of the key proves this build; ok:false means the marking regressed. Runs the real function on a synthetic history. */
export function historicalMemorySelfTest(): { ok: boolean; detail: string } {
  if (memoryAuthorityWordingDisabled()) return { ok: true, detail: "LEGACY via MEMORY_AUTHORITY_WORDING_DISABLED" };
  if (historicalMemoryMarkDisabled()) return { ok: true, detail: "LEGACY via HISTORICAL_MEMORY_MARK_DISABLED" };
  const history = [
    { role: "user", content: [{ type: "text", text: "synthetic seed" }] },
    { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "memory_recall", input: {} }] },
    {
      role: "tool",
      content: [{
        type: "tool-result", toolCallId: "c1", toolName: "memory_recall",
        output: { type: "json", value: { ok: true, count: 1, memories: [{ kind: "identity", content: "synthetic claim", confidence: 80 }] } },
      }],
    },
    { role: "user", content: [{ type: "text", text: "synthetic follow-up" }] },
  ];
  const once = markHistoricalMemoryResults(history);
  const twice = markHistoricalMemoryResults(once);
  const part = (once[2].content as Array<{ output?: { value?: Record<string, unknown> } }>)[0];
  const v = part.output?.value ?? {};
  const rows = (v.memories as Array<Record<string, unknown>> | undefined) ?? [];
  const marked = Object.keys(v)[0] === "historical_memory_note" && rows[0]?.provenance === "unreviewed";
  const contentIntact = rows[0]?.content === "synthetic claim" && rows[0]?.confidence === 80;
  const othersUntouched = once[0] === history[0] && once[1] === history[1] && once[3] === history[3];
  const idempotent = twice.every((m, i) => m === once[i]);
  const ok = marked && contentIntact && othersUntouched && idempotent;
  return {
    ok,
    detail: ok
      ? "replayed memory rows tagged unreviewed and headed by the note; content, other messages and pairing untouched; idempotent"
      : `marked=${marked} content=${contentIntact} others=${othersUntouched} idem=${idempotent}`,
  };
}
