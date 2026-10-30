import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import type { Artifact } from "@/hooks/useThreadArtifacts";
import { computePivots } from "@/lib/pivot-engine";
import { normalizeTarget } from "@/lib/next-step-cards";
import { summarizeAttempts, type AttemptRow, type AttemptSummary } from "@/lib/pivot-attempts";
import { buildRationale } from "@/lib/pivot-rationale";

// One shared spy surface: every supabase call the Stage 1 code could make is
// recorded here. The ranking and rationale code must never touch it, and the
// attempts hook may only read `tool_usage_log`.
const sb = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  invoke: vi.fn(),
  channel: vi.fn(),
  removeChannel: vi.fn(),
  rows: [] as unknown[],
}));

vi.mock("@/integrations/supabase/client", () => {
  const chain: Record<string, unknown> = {};
  const api = () => chain;
  for (const m of ["select", "eq", "order", "limit"]) chain[m] = vi.fn(api);
  chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: sb.rows, error: null });
  return {
    supabase: {
      from: (table: string) => { sb.from(table); return chain; },
      rpc: (...a: unknown[]) => sb.rpc(...a),
      functions: { invoke: (...a: unknown[]) => sb.invoke(...a) },
      channel: (...a: unknown[]) => {
        sb.channel(...a);
        return { on: () => ({ subscribe: () => ({}) }) };
      },
      removeChannel: (...a: unknown[]) => sb.removeChannel(...a),
    },
  };
});

let seq = 0;
function art(partial: Partial<Artifact> & { kind: string; value: string }): Artifact {
  seq += 1;
  return {
    id: partial.id ?? `art-${seq}`,
    kind: partial.kind,
    value: partial.value,
    confidence: partial.confidence ?? 60,
    source: partial.source ?? "hunter",
    created_at: partial.created_at ?? `2026-01-01T00:00:${String(seq).padStart(2, "0")}Z`,
    metadata: partial.metadata ?? {},
  };
}

const NONE = new Set<string>();
const attemptsFor = (entries: [string, Partial<AttemptSummary>][]) =>
  new Map(entries.map(([value, s]) => [normalizeTarget(value), {
    liveCount: 0, okCount: 0, failedCount: 0, cachedCount: 0, tools: [], ...s,
  } as AttemptSummary]));

beforeEach(() => {
  sb.from.mockClear();
  sb.rpc.mockClear();
  sb.invoke.mockClear();
  sb.channel.mockClear();
  sb.removeChannel.mockClear();
  sb.rows = [];
});

describe("Stage 1 — prior attempts are summarised from the tool log", () => {
  it("counts live and cached calls apart, and keeps every selector a call was run against", () => {
    const rows: AttemptRow[] = [
      { tool_name: "hunter", ok: true, cached: false, input_json: { input: { email: "a@x.example" } } },
      { tool_name: "hunter", ok: true, cached: true, input_json: { input: { email: "a@x.example" } } },
      { tool_name: "indicia", ok: false, cached: false, input_json: { runtime: { selector: "a@x.example" } } },
      { tool_name: "web_search", ok: true, cached: false, input_json: { input: { query: 'the "Gregory Bradley" record' } } },
    ];
    const s = summarizeAttempts(rows);
    expect(s.get(normalizeTarget("a@x.example"))).toEqual({
      liveCount: 2, okCount: 1, failedCount: 1, cachedCount: 1, tools: ["hunter", "indicia"],
    });
    // A quoted phrase inside a free-text query is the analyst's stated target.
    expect(s.get(normalizeTarget("Gregory Bradley"))?.liveCount).toBe(1);
  });
});

describe("Stage 1 — adaptive labels (display only; order unchanged until N1 is signed off)", () => {
  it("a lead repeated with one tool is labelled repeated, and the order is byte-identical to the no-attempts order", () => {
    const repeated = art({ kind: "email", value: "repeat@x.example", confidence: 70 });
    const fresh = art({ kind: "email", value: "fresh@x.example", confidence: 70 });
    const queried = new Set([normalizeTarget(repeated.value), normalizeTarget(fresh.value)]);
    const attempts = attemptsFor([
      [repeated.value, { liveCount: 2, okCount: 2, tools: ["hunter"] }],
      [fresh.value, { liveCount: 1, okCount: 1, tools: ["indicia"] }],
    ]);
    const out = computePivots({
      artifacts: [repeated, fresh], seedValue: null, reportPivots: [], skipSet: NONE,
      queriedSet: queried, attempts,
    });
    const baseline = computePivots({
      artifacts: [repeated, fresh], seedValue: null, reportPivots: [], skipSet: NONE, queriedSet: queried,
    });
    expect(out.map((p) => p.value)).toEqual(baseline.map((p) => p.value));
    expect(out.map((p) => p.score)).toEqual(baseline.map((p) => p.score));
    const r = out.find((p) => p.value === repeated.value)!;
    expect(r.rationale?.gap).toBe("repeated");
    expect(r.rationale?.repeated).toBe(true);
    expect(r.rationale?.previous).toBe("2 live runs, 2 ok, 0 failed (hunter).");
    // The repeat is a label, never a score or confidence change.
    expect(r.confidence).toBe(70);
  });

  it("failed runs are not counted as a repeat", () => {
    const lead = art({ kind: "email", value: "failing@x.example", confidence: 70 });
    const attempts = attemptsFor([[lead.value, { liveCount: 2, okCount: 0, failedCount: 2, tools: ["hunter"] }]]);
    const out = computePivots({
      artifacts: [lead], seedValue: null, reportPivots: [], skipSet: NONE,
      queriedSet: new Set([normalizeTarget(lead.value)]), attempts,
    });
    expect(out.find((p) => p.value === lead.value)?.rationale?.repeated).toBe(false);
  });

  it("a conflicting source row is labelled contradiction without changing its score", () => {
    const row = { kind: "domain", value: "northgate.example", confidence: 80, created_at: "2026-02-01T00:00:00Z" };
    const conflict = art({ ...row, metadata: { conflict: true } });
    const plain = art({ ...row });
    const highYield = art({ kind: "email", value: "jane@corp.example", confidence: 80, created_at: "2026-01-01T00:00:00Z" });
    const withConflict = computePivots({ artifacts: [highYield, conflict], seedValue: null, reportPivots: [], skipSet: NONE });
    const without = computePivots({ artifacts: [highYield, plain], seedValue: null, reportPivots: [], skipSet: NONE });
    const c = withConflict.find((p) => p.value === "northgate.example")!;
    expect(c.rationale?.gap).toBe("contradiction");
    expect(c.score).toBe(without.find((p) => p.value === "northgate.example")!.score);
    expect(withConflict.map((p) => p.value)).toEqual(without.map((p) => p.value));
  });

  it("a dismissed match never reappears, even with prior attempts present", () => {
    const dismissed = art({ kind: "email", value: "dismissed@x.example", id: "dismissed-1" });
    const attempts = attemptsFor([[dismissed.value, { liveCount: 2, okCount: 2, tools: ["hunter"] }]]);
    const out = computePivots({
      artifacts: [dismissed], seedValue: null, reportPivots: [], skipSet: NONE,
      reviews: { "dismissed-1": "dismissed" }, attempts,
    });
    expect(out.find((p) => p.value === dismissed.value)).toBeUndefined();
  });

  it("three providers returning one breach do not raise its confidence or change its gap", () => {
    const single = computePivots({
      artifacts: [art({ kind: "email", value: "leak@x.example", confidence: 60, source: "hunter" })],
      seedValue: null, reportPivots: [], skipSet: NONE,
    });
    const triplicate = computePivots({
      artifacts: [
        art({ kind: "email", value: "leak@x.example", confidence: 60, source: "hunter" }),
        art({ kind: "email", value: "leak@x.example", confidence: 60, source: "exa" }),
        art({ kind: "email", value: "leak@x.example", confidence: 60, source: "indicia" }),
      ],
      seedValue: null, reportPivots: [], skipSet: NONE,
    });
    expect(triplicate).toHaveLength(1);
    expect(triplicate[0].confidence).toBe(single[0].confidence);
    expect(triplicate[0].rationale?.gap).toBe(single[0].rationale?.gap);
    expect(triplicate[0].rationale?.factors.join(" ")).not.toMatch(/corroborat|independent/i);
  });

  it("a lead with no prior attempts is not marked repeated and keeps its order", () => {
    const a = art({ kind: "email", value: "a@x.example", confidence: 70 });
    const b = art({ kind: "email", value: "b@x.example", confidence: 70 });
    const without = computePivots({ artifacts: [a, b], seedValue: null, reportPivots: [], skipSet: NONE });
    const withEmpty = computePivots({
      artifacts: [a, b], seedValue: null, reportPivots: [], skipSet: NONE, attempts: new Map(),
    });
    expect(withEmpty.map((p) => p.value)).toEqual(without.map((p) => p.value));
    expect(withEmpty.every((p) => p.rationale?.repeated === false)).toBe(true);
  });
});

describe("Stage 1 — zero paid calls and read-only reads", () => {
  it("sorting, re-ranking and rendering the rationale make no tool or RPC call", () => {
    const lead = art({ kind: "email", value: "quiet@x.example", confidence: 70 });
    const attempts = summarizeAttempts([{ tool_name: "hunter", ok: true, cached: false, input_json: { input: { email: lead.value } } }]);
    const ranked = computePivots({
      artifacts: [lead], seedValue: null, reportPivots: [], skipSet: NONE,
      queriedSet: new Set([normalizeTarget(lead.value)]), attempts,
    });
    const rationale = buildRationale({ type: "email", gap: "repeated", attempts: attempts.get(normalizeTarget(lead.value)), factors: [] });
    expect(ranked).toHaveLength(1);
    expect(rationale.cost).toBe("unknown");
    expect(sb.rpc).not.toHaveBeenCalled();
    expect(sb.invoke).not.toHaveBeenCalled();
  });
});

describe("Stage 1 — attempts hook is scoped to one case and only reads the log", () => {
  it("queries tool_usage_log for this thread alone and never invokes a tool", async () => {
    const { useThreadPivotAttempts } = await import("@/hooks/useThreadPivotAttempts");
    sb.rows = [
      { tool_name: "hunter", ok: true, cached: false, input_json: { input: { email: "case-a@x.example" } } },
    ];
    const { result } = renderHook(() => useThreadPivotAttempts("thread-A"));
    await waitFor(() => expect(result.current.size).toBe(1));
    expect(sb.from).toHaveBeenCalledWith("tool_usage_log");
    expect(sb.invoke).not.toHaveBeenCalled();
    expect(sb.rpc).not.toHaveBeenCalled();
    expect(result.current.get(normalizeTarget("case-a@x.example"))?.okCount).toBe(1);
  });
});
