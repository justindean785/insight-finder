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

  it("does not duplicate a healthy streamed report whose DB row has a different id", () => {
    const local = [{ id: "client-assistant", role: "assistant", parts: ["complete report"] }];
    const persisted = [{ id: "db-assistant", role: "assistant", parts: ["complete report"] }];
    expect(mergePersistedChatMessages(local, persisted)).toEqual(local);
  });
});
