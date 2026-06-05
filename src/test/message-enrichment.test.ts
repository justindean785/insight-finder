import { describe, it, expect } from "vitest";
import { buildTimelineItems, buildReportMarkdown } from "@/lib/intel";

// ── Message-level timeline enrichment ────────────────────────────────
// Mirrors the shape produced by src/hooks/useThreadMessages.ts
type MessageSummary = {
  id: string;
  role: "user" | "assistant";
  created_at: string;
  summary: string;
  toolCalls: Array<{ toolName: string; resultSummary?: string }>;
};

const baseArtifact = (over: Partial<{ id: string; kind: string; value: string; source: string | null; confidence: number | null; created_at: string; metadata: Record<string, unknown> | null }> = {}) => ({
  id: over.id ?? "a1",
  thread_id: "t1",
  kind: over.kind ?? "email",
  value: over.value ?? "x@y.com",
  source: over.source ?? "hibp",
  confidence: over.confidence ?? 80,
  created_at: over.created_at ?? "2026-06-01T10:00:00Z",
  updated_at: over.created_at ?? "2026-06-01T10:00:00Z",
  metadata: over.metadata ?? null,
  label: "CONFIRMED" as const,
  is_key: false,
  is_dismissed: false,
  notes: null,
  review_state: "confirmed" as const,
  group: "contact" as const,
});

describe("buildTimelineItems — message-level enrichment", () => {
  it("returns artifact-only items when messages is omitted (backward compatible)", () => {
    const items = buildTimelineItems(
      [baseArtifact()],
      { value: "seed@x.com", type: "email", createdAt: "2026-06-01T09:00:00Z" },
    );
    const types = items.map((i) => i.type);
    expect(types).toContain("seed");
    expect(types).toContain("artifact");
    expect(items).toHaveLength(2);
  });

  it("emits a seed-typed item for each user follow-up query", () => {
    const messages: MessageSummary[] = [
      { id: "m1", role: "user", created_at: "2026-06-01T11:00:00Z", summary: "Find phone numbers for this person", toolCalls: [] },
    ];
    const items = buildTimelineItems([], null, messages);
    const followUp = items.find((i) => i.id === "msg-m1");
    expect(followUp).toBeDefined();
    expect(followUp?.type).toBe("seed");
    expect(followUp?.title).toBe("Find phone numbers for this person");
    expect(followUp?.kind).toBe("query");
  });

  it("emits a tool_result item per tool invocation with status from resultSummary", () => {
    const messages: MessageSummary[] = [
      {
        id: "m2",
        role: "assistant",
        created_at: "2026-06-01T11:05:00Z",
        summary: "running search",
        toolCalls: [
          { toolName: "hibp_lookup", resultSummary: "completed" },
          { toolName: "maigret_search", resultSummary: "failed" },
          { toolName: "dnstwist_scan" },
        ],
      },
    ];
    const items = buildTimelineItems([], null, messages);
    const tools = items.filter((i) => i.id.startsWith("tc-"));
    expect(tools).toHaveLength(3);
    expect(tools.find((t) => t.title === "hibp_lookup")?.explanation).toBe("Tool completed.");
    expect(tools.find((t) => t.title === "maigret_search")?.explanation).toBe("Tool failed.");
    expect(tools.find((t) => t.title === "dnstwist_scan")?.explanation).toBe("Tool invoked.");
  });

  it("emits a report item when an assistant summary matches /report/i", () => {
    const messages: MessageSummary[] = [
      { id: "m3", role: "assistant", created_at: "2026-06-01T12:00:00Z", summary: "Report generated", toolCalls: [] },
      { id: "m4", role: "assistant", created_at: "2026-06-01T12:01:00Z", summary: "All done.", toolCalls: [] },
    ];
    const items = buildTimelineItems([], null, messages);
    const reports = items.filter((i) => i.type === "report");
    expect(reports).toHaveLength(1);
    expect(reports[0].id).toBe("report-m3");
    expect(reports[0].title).toBe("Report generated");
  });

  it("merges artifact + message events into a single chronological stream", () => {
    const seed = { value: "s@x.com", type: "email", createdAt: "2026-06-01T09:00:00Z" };
    const messages: MessageSummary[] = [
      { id: "u1", role: "user", created_at: "2026-06-01T10:30:00Z", summary: "What about breaches?", toolCalls: [] },
    ];
    const items = buildTimelineItems(
      [baseArtifact({ id: "a1", created_at: "2026-06-01T10:45:00Z" })],
      seed,
      messages,
    );
    expect(items.map((i) => i.id)).toEqual(["seed", "msg-u1", "a1"]);
  });
});

describe("buildReportMarkdown — Activity Log section", () => {
  it("renders the Activity Log header and a no-activity fallback when messages is undefined", () => {
    const md = buildReportMarkdown({ seedValue: "x@y.com", seedType: "email", artifacts: [baseArtifact()] });
    expect(md).toContain("## Activity Log");
    expect(md).toContain("_No message activity recorded._");
  });

  it("reports user query count, tool invocation count, and tool breakdown", () => {
    const messages = [
      { id: "u1", role: "user" as const, created_at: "2026-06-01T10:30:00Z", summary: "Check breaches", toolCalls: [] },
      { id: "u2", role: "user" as const, created_at: "2026-06-01T10:35:00Z", summary: "Find social profiles", toolCalls: [] },
      {
        id: "a1",
        role: "assistant" as const,
        created_at: "2026-06-01T10:36:00Z",
        summary: "running tools",
        toolCalls: [
          { toolName: "hibp_lookup", resultSummary: "completed" },
          { toolName: "hibp_lookup", resultSummary: "completed" },
          { toolName: "maigret_search", resultSummary: "failed" },
        ],
      },
    ];
    const md = buildReportMarkdown({ seedValue: "x@y.com", seedType: "email", artifacts: [baseArtifact()], messages });
    expect(md).toContain("## Activity Log");
    expect(md).toContain("**User queries:** 2");
    expect(md).toContain("**Tool invocations:** 3");
    expect(md).toContain("`hibp_lookup`×2");
    expect(md).toContain("`maigret_search`×1");
  });

  it("includes a Recent activity sub-list for user queries, tool runs, and report markers", () => {
    const messages = [
      { id: "u1", role: "user" as const, created_at: "2026-06-01T10:30:00Z", summary: "Look up this email", toolCalls: [] },
      {
        id: "a1",
        role: "assistant" as const,
        created_at: "2026-06-01T10:31:00Z",
        summary: "Tool results returned",
        toolCalls: [{ toolName: "hibp_lookup", resultSummary: "completed" }],
      },
      { id: "a2", role: "assistant" as const, created_at: "2026-06-01T10:32:00Z", summary: "Report generated", toolCalls: [] },
    ];
    const md = buildReportMarkdown({ seedValue: "x@y.com", seedType: "email", artifacts: [baseArtifact()], messages });
    expect(md).toContain("**Recent activity:**");
    expect(md).toMatch(/\*\*query\*\*.*Look up this email/);
    expect(md).toMatch(/\*\*tools\*\*.*`hibp_lookup`\(completed\)/);
    expect(md).toMatch(/\*\*report\*\*.*Report generated/);
  });

  it("includes a Report markers count when assistant summaries match /report/i", () => {
    const messages = [
      { id: "r1", role: "assistant" as const, created_at: "2026-06-01T10:32:00Z", summary: "Final report generated", toolCalls: [] },
    ];
    const md = buildReportMarkdown({ seedValue: "x@y.com", seedType: "email", artifacts: [baseArtifact()], messages });
    expect(md).toContain("**Report markers:** 1");
  });
});
