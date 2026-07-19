import { describe, it, expect } from "vitest";
import { dedupeCheckpoints, isCheckpointMessage } from "@/lib/chat-checkpoints";

const user = (text: string) => ({ id: `u-${text}`, role: "user", parts: [{ type: "text", text }] });
const checkpoint = (id: string, text = "🔎 Progress checkpoint") => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text, _incremental: true, _checkpoint_id: id }],
});
const report = (text = "Final OSINT report") => ({ id: "report", role: "assistant", parts: [{ type: "text", text }] });

describe("chat-checkpoints — dedupeCheckpoints (report #6: no duplicate rows)", () => {
  it("keeps checkpoints while the run is in progress (no final report yet)", () => {
    const msgs = [user("go"), checkpoint("cp1"), checkpoint("cp2")];
    const out = dedupeCheckpoints(msgs);
    expect(out).toHaveLength(3);
    expect(out.filter(isCheckpointMessage)).toHaveLength(2);
  });

  it("hides checkpoints once a final assistant report has landed", () => {
    const msgs = [user("go"), checkpoint("cp1"), checkpoint("cp2"), report()];
    const out = dedupeCheckpoints(msgs);
    expect(out).toHaveLength(2);
    expect(out.map((m) => m.id)).toEqual(["u-go", "report"]);
    expect(out.some(isCheckpointMessage)).toBe(false);
  });

  it("keeps a checkpoint that belongs to a NEW run started after the last report", () => {
    const msgs = [user("go"), checkpoint("cp1"), report(), user("again"), checkpoint("cp2")];
    const out = dedupeCheckpoints(msgs);
    // cp1 (before the report) is dropped; cp2 (after it, new run) is kept.
    expect(out.map((m) => m.id)).toEqual(["u-go", "report", "u-again", "cp2"]);
  });

  it("preserves order and identity of non-checkpoint messages", () => {
    const msgs = [user("a"), report("r1"), user("b")];
    expect(dedupeCheckpoints(msgs)).toEqual(msgs);
  });

  it("does not treat a checkpoint as the 'final report' that hides its siblings", () => {
    // Two checkpoints, no real report → both kept (a checkpoint is not a report).
    const msgs = [checkpoint("cp1"), checkpoint("cp2")];
    expect(dedupeCheckpoints(msgs)).toHaveLength(2);
  });

  it("is a no-op on empty / non-array input", () => {
    expect(dedupeCheckpoints([])).toEqual([]);
    // Defensive runtime guard for bad callers. Cast (not @ts-expect-error): this
    // tsconfig has strictNullChecks off, so the bad call isn't a type error and a
    // directive would be flagged unused (TS2578).
    expect(dedupeCheckpoints(undefined as unknown as { role?: string }[])).toBeUndefined();
  });
});

describe("chat-checkpoints — isCheckpointMessage", () => {
  it("detects the _incremental marker", () => {
    expect(isCheckpointMessage(checkpoint("x"))).toBe(true);
    expect(isCheckpointMessage(report())).toBe(false);
    expect(isCheckpointMessage(user("hi"))).toBe(false);
    expect(isCheckpointMessage(null)).toBe(false);
  });
});
