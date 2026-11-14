import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  applyRealtimeInsert,
  EVIDENCE_RECORD_HEADING,
  FINDINGS_TABLE_MARKER,
  isSameChatMessage,
  isTerminalThreadUpdate,
  mergePersistedChatMessages,
  shouldAbortClientStream,
} from "@/lib/chat-terminal-reconcile";

describe("terminal chat reconciliation", () => {
  it("does not abort a healthy finished stream while its final report is flushing", () => {
    expect(isTerminalThreadUpdate({ status: "finished" })).toBe(true);
    expect(shouldAbortClientStream({ status: "finished" })).toBe(false);
  });

  it("aborts dead streams closed by stale recovery or the analyst", () => {
    expect(shouldAbortClientStream({ status: "finished", recovered_at: "2026-07-19T15:00:00Z" })).toBe(true);
    expect(shouldAbortClientStream({ status: "stopped" })).toBe(true);
  });

  it("lets a server error chunk flush before durable reconciliation", () => {
    expect(shouldAbortClientStream({
      status: "finished",
      recovery_reason: "stream_error: provider disconnected",
    })).toBe(false);
  });

  it("adds a recovered DB report without discarding locally streamed tool activity", () => {
    const local = [
      { id: "user-1", parts: ["seed"] },
      { id: "tools-only", parts: ["tool activity"] },
    ];
    const persisted = [
      { id: "user-1", parts: ["seed from db"] },
      { id: "recovered-report", parts: ["Findings report — recovered run"] },
    ];

    expect(mergePersistedChatMessages(local, persisted)).toEqual([
      { id: "user-1", parts: ["seed from db"] },
      { id: "tools-only", parts: ["tool activity"] },
      { id: "recovered-report", parts: ["Findings report — recovered run"] },
    ]);
  });

  // This asserted `toEqual(local)` — the CLIENT copy surviving — until 2026-08-10.
  // That was an artefact of the old implementation (signature dedup could only
  // drop the persisted row, never adopt it), not a deliberate preference, and it
  // contradicted the sibling case above where a matching id lets the DB row
  // replace the local one. It is also the second half of the duplicate-message
  // bug: ChatWindow keys `setCreatedAtMap` on the DB row id, so keeping the
  // client copy renders that message without its timestamp. The invariant this
  // test is named for — no duplication — is unchanged and still asserted.
  it("does not duplicate a healthy streamed report whose DB row has a different id", () => {
    const local = [{ id: "client-assistant", role: "assistant", parts: ["complete report"] }];
    const persisted = [{ id: "db-assistant", role: "assistant", parts: ["complete report"] }];
    const merged = mergePersistedChatMessages(local, persisted);
    expect(merged).toHaveLength(1);
    expect(merged).toEqual(persisted);
  });
});

// ── The duplicate-message bug (production, 2026-08-10) ──────────────────────
//
// Every assistant message rendered TWICE in the workspace: once bare, once with
// a timestamp. The pairing is the tell — ChatWindow's setCreatedAtMap is keyed on
// the PERSISTED row id, so the DB copy gets a timestamp and the locally streamed
// copy does not. Two objects, one message.
//
// mergePersistedChatMessages dedupes on id, then falls back to
// JSON.stringify([role, parts]). The stream->DB boundary breaks that fallback:
// the AI SDK's live message and the row read back from Postgres have different
// client/DB ids AND structurally different `parts` — jsonb round-trips reorder
// keys, and the streamed object carries fields the persisted one never had. An
// exact string compare of two JSON encodings is not message identity.
describe("mergePersistedChatMessages — the stream/DB duplicate", () => {
  const local = [
    {
      id: "msg-client-abc",
      role: "assistant",
      parts: [{ type: "text", text: "Findings report", state: "done" }],
    },
  ];
  const persisted = [
    {
      id: "3f9a1c2e-0000-4000-8000-000000000001",
      role: "assistant",
      parts: [{ text: "Findings report", type: "text" }],
    },
  ];

  it("does not render the same assistant message twice", () => {
    expect(mergePersistedChatMessages(local, persisted)).toHaveLength(1);
  });

  it("prefers the persisted row, so the message keeps its durable id and timestamp", () => {
    expect(mergePersistedChatMessages(local, persisted)[0].id)
      .toBe("3f9a1c2e-0000-4000-8000-000000000001");
  });

  it("is not fooled by key order alone", () => {
    const a = [{ id: "a", role: "assistant", parts: [{ type: "text", text: "hi" }] }];
    const b = [{ id: "b", role: "assistant", parts: [{ text: "hi", type: "text" }] }];
    expect(mergePersistedChatMessages(a, b)).toHaveLength(1);
  });

  // Over-block guards — dedup must not swallow genuinely distinct messages.
  it("keeps two different assistant messages", () => {
    const a = [{ id: "a", role: "assistant", parts: [{ type: "text", text: "first" }] }];
    const b = [{ id: "b", role: "assistant", parts: [{ type: "text", text: "second" }] }];
    expect(mergePersistedChatMessages(a, b)).toHaveLength(2);
  });

  it("keeps same text from different roles", () => {
    const a = [{ id: "a", role: "user", parts: [{ type: "text", text: "same" }] }];
    const b = [{ id: "b", role: "assistant", parts: [{ type: "text", text: "same" }] }];
    expect(mergePersistedChatMessages(a, b)).toHaveLength(2);
  });

  it("still keeps a local tool-activity message the DB never persisted", () => {
    const localTools = [
      { id: "c1", role: "assistant", parts: [{ type: "text", text: "report" }] },
      { id: "tools-only", role: "assistant", parts: [{ type: "tool-oathnet", toolCallId: "t1" }] },
    ];
    const db = [{ id: "db1", role: "assistant", parts: [{ text: "report", type: "text" }] }];
    const merged = mergePersistedChatMessages(localTools, db);
    expect(merged).toHaveLength(2);
    expect(merged.some((m) => m.id === "tools-only")).toBe(true);
  });
});

/**
 * Production 2026-10-01 (spearheadlab case): the run flow rendered twice under
 * "Superseded report". The DB held ONE assistant message; the server had
 * appended the Evidence Record block to its last text part AFTER streaming, so
 * the stored row no longer matched the streamed copy by text and was appended.
 */
describe("the server's post-stream Evidence Record append is the same message", () => {
  const EVIDENCE = "\n\n## Evidence Record — authoritative\n\nNo authoritative finding rows were recorded for this run.";
  const live = {
    id: "client-1",
    role: "assistant",
    parts: [
      { type: "step-start" },
      { type: "text", text: "Starting." },
      { type: "tool-whois_lookup", toolCallId: "call_a", state: "output-available" },
      { type: "tool-dns_records", toolCallId: "call_b", state: "output-available" },
      { type: "text", text: "## Report\n\nFindings." },
    ],
  };
  const stored = {
    id: "8d4f0000-0000-4000-8000-00000000c48b",
    role: "assistant",
    parts: [
      { type: "step-start" },
      { text: "Starting.", type: "text" },
      { type: "tool-whois_lookup", toolCallId: "call_a" },
      { type: "tool-dns_records", toolCallId: "call_b" },
      { type: "text", text: `## Report\n\nFindings.${EVIDENCE}` },
    ],
  };

  it("reconcile adopts the stored row in place: one message, durable id, the appended block", () => {
    const merged = mergePersistedChatMessages([live], [stored]);
    expect(merged).toHaveLength(1);
    expect(merged[0].id).toBe(stored.id);
    expect(JSON.stringify(merged[0].parts)).toContain("Evidence Record");
  });

  it("the realtime-insert predicate agrees", () => {
    expect(isSameChatMessage(live, stored)).toBe(true);
  });

  it("matches a tool-bearing copy by its tool-call ids even when text was also capped", () => {
    const capped = { ...stored, parts: stored.parts.map((p) => (p.type === "text" ? { ...p, text: "[truncated]" } : p)) };
    expect(mergePersistedChatMessages([live], [capped])).toHaveLength(1);
  });

  it("a text-only reply that gained the block is the same message too", () => {
    const a = { id: "c", role: "assistant", parts: [{ type: "text", text: "Answer." }] };
    const b = { id: "d", role: "assistant", parts: [{ type: "text", text: `Answer.${EVIDENCE}` }] };
    expect(mergePersistedChatMessages([a], [b])).toHaveLength(1);
  });

  // Over-match guards — none of these may collapse.
  it("different tool-call ids are different messages", () => {
    const other = { ...stored, id: "other", parts: stored.parts.map((p) => ("toolCallId" in p ? { ...p, toolCallId: `${p.toolCallId}-2` } : p)) };
    expect(isSameChatMessage(live, { ...other, parts: other.parts.map((p) => (p.type === "text" ? { ...p, text: "different" } : p)) })).toBe(false);
  });

  it("a later message that merely continues the text is a different message", () => {
    const a = { id: "c", role: "assistant", parts: [{ type: "text", text: "Starting." }] };
    const b = { id: "d", role: "assistant", parts: [{ type: "text", text: "Starting. Then a second report." }] };
    expect(mergePersistedChatMessages([a], [b])).toHaveLength(2);
  });

  it("the same tool ids under a different role never match", () => {
    expect(isSameChatMessage(live, { ...stored, role: "user" })).toBe(false);
  });
});

describe("only the server's Evidence Record append collapses (Codex P2 on #671)", () => {
  it("a later answer that restates and expands an earlier one is a different message", () => {
    const a = { id: "c", role: "assistant", parts: [{ type: "text", text: "The domain is on Vercel." }] };
    const b = { id: "d", role: "assistant", parts: [{ type: "text", text: "The domain is on Vercel.\n\nMore detail: it also uses Zoho mail." }] };
    expect(isSameChatMessage(a, b)).toBe(false);
    expect(mergePersistedChatMessages([a], [b])).toHaveLength(2);
  });

  it("the heading matches the edge function's EVIDENCE_RECORD_HEADING", () => {
    const edge = readFileSync(resolve(__dirname, "../../supabase/functions/osint-agent/lib/evidence-record.ts"), "utf8");
    expect(edge).toContain(`export const EVIDENCE_RECORD_HEADING = "${EVIDENCE_RECORD_HEADING}";`);
  });
});

describe("applyRealtimeInsert (Codex P2 on #671)", () => {
  const EVIDENCE = `\n\n${EVIDENCE_RECORD_HEADING}\n\n_No authoritative finding rows were recorded for this run._`;
  const live = { id: "client-1", role: "assistant", parts: [{ type: "text", text: "Report." }] };
  const row = { id: "db-1", role: "assistant", parts: [{ type: "text", text: `Report.${EVIDENCE}` }] };

  it("replaces the live copy in place once no stream is running: durable id, Evidence Record", () => {
    const next = applyRealtimeInsert([{ id: "u", role: "user", parts: [] }, live], row, false);
    expect(next).toHaveLength(2);
    expect(next[1].id).toBe("db-1");
    expect(JSON.stringify(next[1].parts)).toContain("Evidence Record");
  });

  it("leaves the live copy alone mid-stream, so the SDK never re-appends it", () => {
    const current = [live];
    expect(applyRealtimeInsert(current, row, true)).toBe(current);
  });

  it("appends a row that is not on screen, streaming or not", () => {
    const other = { id: "db-2", role: "assistant", parts: [{ type: "text", text: "A different message." }] };
    expect(applyRealtimeInsert([live], other, true)).toHaveLength(2);
    expect(applyRealtimeInsert([live], other, false)).toHaveLength(2);
  });

  it("an echo of a row already adopted is a no-op", () => {
    const current = [row];
    expect(applyRealtimeInsert(current, row, false)).toBe(current);
  });
});

describe("in-place Findings-table expansion is the same message (Codex P1 on #974)", () => {
  const TABLE = "| # | Finding |\n| --- | --- |\n| 1 | synthetic row |";
  const EVIDENCE = `\n\n${EVIDENCE_RECORD_HEADING}\n\n_No authoritative finding rows were recorded for this run._`;
  const msg = (id: string, ...texts: string[]) => ({
    id,
    role: "assistant",
    parts: texts.map((text) => ({ type: "text", text })),
  });
  const liveText = `Summary line.\n\n## Findings\n\n${FINDINGS_TABLE_MARKER}\n\n## Next steps\n\n- one`;
  const expanded = liveText.replace(FINDINGS_TABLE_MARKER, TABLE);

  it("a stored text with the marker line replaced by a table collapses onto the streamed copy", () => {
    expect(isSameChatMessage(msg("c", liveText), msg("d", expanded))).toBe(true);
    expect(mergePersistedChatMessages([msg("c", liveText)], [msg("d", expanded)])).toHaveLength(1);
  });

  it("composes with the Evidence Record append on the last text part", () => {
    expect(isSameChatMessage(msg("c", liveText), msg("d", `${expanded}${EVIDENCE}`))).toBe(true);
  });

  it("matches when the marker sits in an earlier text part and a later part follows", () => {
    const live = msg("c", `## Findings\n\n${FINDINGS_TABLE_MARKER}`, "Closing paragraph.");
    const stored = msg("d", `## Findings\n\n${TABLE}`, "Closing paragraph.");
    expect(isSameChatMessage(live, stored)).toBe(true);
  });

  it("matches when the server removed the marker line (table withheld, nothing rendered)", () => {
    expect(isSameChatMessage(msg("c", liveText), msg("d", liveText.replace(FINDINGS_TABLE_MARKER, "")))).toBe(true);
  });

  it("tolerates a trailing colon and surrounding spaces on the marker line, as the server does", () => {
    const live = `Intro.\n\n  ${FINDINGS_TABLE_MARKER}:  \n\nOutro.`;
    expect(isSameChatMessage(msg("c", live), msg("d", `Intro.\n\n${TABLE}\n\nOutro.`))).toBe(true);
  });

  it("handles several marker lines (first gets the table, later ones are removed)", () => {
    const live = `A.\n${FINDINGS_TABLE_MARKER}\nB.\n${FINDINGS_TABLE_MARKER}\nC.`;
    expect(isSameChatMessage(msg("c", live), msg("d", `A.\n${TABLE}\nB.\n\nC.`))).toBe(true);
  });

  it("matches when the marker is the LAST line of the report, alone and with the Evidence Record", () => {
    const live = `## Findings\n\n${FINDINGS_TABLE_MARKER}`;
    expect(isSameChatMessage(msg("c", live), msg("d", `## Findings\n\n${TABLE}`))).toBe(true);
    expect(isSameChatMessage(msg("c", live), msg("d", `## Findings\n\n${TABLE}${EVIDENCE}`))).toBe(true);
  });

  it("matches when a one-character segment also occurs inside the rendered table", () => {
    const live = `A.\n${FINDINGS_TABLE_MARKER}\nB.`;
    expect(isSameChatMessage(msg("c", live), msg("d", `A.\n${TABLE}\nB.`))).toBe(true);
  });

  it("does NOT collapse when text around the marker changed (a different answer)", () => {
    const other = expanded.replace("Summary line.", "A completely different summary.");
    expect(isSameChatMessage(msg("c", liveText), msg("d", other))).toBe(false);
    expect(mergePersistedChatMessages([msg("c", liveText)], [msg("d", other)])).toHaveLength(2);
  });

  it("does NOT collapse when the text after the marker is missing or reordered", () => {
    expect(isSameChatMessage(msg("c", liveText), msg("d", `Summary line.\n\n## Findings\n\n${TABLE}`))).toBe(false);
    expect(isSameChatMessage(
      msg("c", `A.\n${FINDINGS_TABLE_MARKER}\nB.\nC.`),
      msg("d", `A.\n${TABLE}\nC.\nB.`),
    )).toBe(false);
  });

  it("does NOT collapse extra trailing prose after the last segment (only the Evidence Record may follow)", () => {
    expect(isSameChatMessage(msg("c", liveText), msg("d", `${expanded}\n\nMore detail added later.`))).toBe(false);
  });

  it("a marker-free message gets no new leniency", () => {
    expect(isSameChatMessage(msg("c", "Plain."), msg("d", "Plain. And more."))).toBe(false);
  });

  it("a marker inside a sentence (not on its own line) is not treated as the marker", () => {
    const live = `Write ${FINDINGS_TABLE_MARKER} to get a table.`;
    expect(isSameChatMessage(msg("c", live), msg("d", `Write ${TABLE} to get a table.`))).toBe(false);
  });

  it.skipIf(!existsSync(resolve(__dirname, "../../supabase/functions/osint-agent/lib/findings-table.ts")))(
    "the marker matches the edge function's FINDINGS_TABLE_MARKER",
    () => {
      const edge = readFileSync(resolve(__dirname, "../../supabase/functions/osint-agent/lib/findings-table.ts"), "utf8");
      expect(edge).toContain(`export const FINDINGS_TABLE_MARKER = "${FINDINGS_TABLE_MARKER}";`);
    },
  );
});
