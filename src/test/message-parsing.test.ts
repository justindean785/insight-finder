import { describe, it, expect } from "vitest";
import { summarizeMessageRow } from "@/hooks/useThreadMessages";
import { buildReportMarkdown } from "@/lib/intel";

// Regression for the report "Tool invocations: 0" bug: messages are persisted
// as AI SDK v6 UIMessage parts (typed `tool-<name>` / `dynamic-tool`), but the
// summary parser used to look for the v4 `tool-invocation` shape and found
// nothing. These tests pin the v6 shapes (and legacy v4 fallback).

const row = (role: string, parts: unknown[], id = "m1") => ({
  id, role, parts, created_at: "2026-06-12T00:00:00.000Z",
});

describe("summarizeMessageRow — AI SDK v6 tool parts", () => {
  it("extracts a typed tool part (tool-<name>) with a successful output", () => {
    const s = summarizeMessageRow(row("assistant", [
      { type: "tool-breach_check", toolCallId: "c1", state: "output-available", input: { email: "a@b.com" }, output: { ok: true, hits: 0 } },
    ]));
    expect(s.toolCalls).toHaveLength(1);
    expect(s.toolCalls[0].toolName).toBe("breach_check");
    expect(s.toolCalls[0].resultSummary).toBe("completed");
  });

  it("marks an output-error typed tool part as failed", () => {
    const s = summarizeMessageRow(row("assistant", [
      { type: "tool-github_user", toolCallId: "c2", state: "output-error", input: {}, errorText: "404" },
    ]));
    expect(s.toolCalls).toHaveLength(1);
    expect(s.toolCalls[0].resultSummary).toBe("failed");
  });

  it("extracts a dynamic-tool part using its explicit toolName", () => {
    const s = summarizeMessageRow(row("assistant", [
      { type: "dynamic-tool", toolName: "socialfetch_lookup", toolCallId: "c3", state: "output-available", input: {}, output: { ok: false } },
    ]));
    expect(s.toolCalls).toHaveLength(1);
    expect(s.toolCalls[0].toolName).toBe("socialfetch_lookup");
    expect(s.toolCalls[0].resultSummary).toBe("failed");
  });

  it("counts every tool part on a message (the core invocations-count fix)", () => {
    const s = summarizeMessageRow(row("assistant", [
      { type: "text", text: "working on it" },
      { type: "tool-google_dorks", toolCallId: "a", state: "output-available", input: {}, output: { ok: true } },
      { type: "tool-breach_check", toolCallId: "b", state: "output-available", input: {}, output: { ok: true } },
      { type: "dynamic-tool", toolName: "exa_find_similar", toolCallId: "c", state: "input-available", input: {} },
    ]));
    expect(s.toolCalls).toHaveLength(3);
    // A still-running tool (no output yet) carries no result summary.
    expect(s.toolCalls[2].resultSummary).toBeUndefined();
  });

  it("recognizes a report-producing tool output", () => {
    const s = summarizeMessageRow(row("assistant", [
      { type: "tool-record_artifacts", toolCallId: "r", state: "output-available", input: {}, output: { data: { report_markdown: "# Report" } } },
    ]));
    expect(s.summary).toBe("Report generated");
  });

  it("still parses legacy v4 tool-invocation + tool-result pairs", () => {
    const s = summarizeMessageRow(row("assistant", [
      { type: "tool-invocation", toolName: "leakcheck_lookup", toolCallId: "x", args: {} },
      { type: "tool-result", toolCallId: "x", output: { ok: true } },
    ]));
    expect(s.toolCalls).toHaveLength(1);
    expect(s.toolCalls[0].toolName).toBe("leakcheck_lookup");
    expect(s.toolCalls[0].resultSummary).toBe("completed");
  });

  it("summarizes a user text message with no tool calls", () => {
    const s = summarizeMessageRow(row("user", [{ type: "text", text: "find richbrat444" }]));
    expect(s.toolCalls).toHaveLength(0);
    expect(s.summary).toBe("find richbrat444");
  });
});

describe("report Activity Log reflects parsed v6 tool calls", () => {
  it("shows the real invocation count instead of 0", () => {
    const messages = [
      row("user", [{ type: "text", text: "find richbrat444" }], "u1"),
      row("assistant", [
        { type: "tool-username_sweep", toolCallId: "a", state: "output-available", input: {}, output: { ok: true } },
        { type: "tool-socialfetch_lookup", toolCallId: "b", state: "output-available", input: {}, output: { ok: true } },
      ], "a1"),
    ].map(summarizeMessageRow);

    const md = buildReportMarkdown({
      seedValue: "richbrat444",
      seedType: "username",
      artifacts: [],
      messages,
    });
    expect(md).toContain("**Tool invocations:** 2");
    expect(md).not.toContain("**Tool invocations:** 0");
  });
});

/**
 * ⚠️ The report's Activity Log was a THIRD definition of "did this call fail".
 *
 * `classifyActivityRow` already reconciled the Activity feed and the Health
 * panel, but this path reads AI SDK message parts rather than `tool_usage_log`
 * rows, so it kept collapsing every non-OK outcome to "failed". Measured on a
 * production export (2026-09-22): the report listed seven failures for a run
 * where Activity showed `Failed 0` and Health showed `0 Needs attention` — a
 * denied provider, an internal cap and a clean no-record all reading as faults.
 *
 * A healthy run must not read as broken. These pin the shared vocabulary.
 */
describe("summarizeMessageRow — non-OK outcomes are not all failures", () => {
  const out = (output: unknown) =>
    summarizeMessageRow(row("assistant", [
      { type: "tool-deepfind_email_breach", toolCallId: "c1", state: "output-available", input: {}, output },
    ])).toolCalls[0].resultSummary;

  it("a denied provider (403) is degraded, not failed", () => {
    expect(out({ ok: false, error: "deepfind 403 forbidden" })).toBe("degraded");
  });

  it("a missing key / unconfigured provider is gated, not failed", () => {
    expect(out({ ok: false, error: "skipped: missing key for provider" })).toBe("gated");
  });

  it("an internal paid-call cap is degraded, not failed", () => {
    expect(out({ ok: false, error: "paid-call cap reached for this cycle" })).toBe("degraded");
  });

  it("a rate limit is degraded, not failed", () => {
    expect(out({ ok: false, error: "429 rate limit" })).toBe("degraded");
  });

  it("a genuine fault is still failed", () => {
    expect(out({ ok: false, error: "TypeError: cannot read property of undefined" })).toBe("failed");
  });

  it("a successful call is still completed, and an uncharacterised one still returns", () => {
    expect(out({ ok: true, hits: 3 })).toBe("completed");
    expect(out({ hits: 3 })).toBe("returned");
  });
});
