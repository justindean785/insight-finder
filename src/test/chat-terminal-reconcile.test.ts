import { describe, expect, it } from "vitest";
import {
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
