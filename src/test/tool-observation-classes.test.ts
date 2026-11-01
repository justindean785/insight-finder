import { describe, it, expect } from "vitest";
import {
  ATTENTION_MIN_ATTEMPTS,
  ATTENTION_MIN_FAILURE_SHARE,
  ATTENTION_MIN_THREADS,
  classifyFailure,
  describeAttention,
  summarizeToolObservations,
  type ObservationRow,
} from "@/lib/tool-observation-classes";

const NOW = Date.UTC(2026, 10, 1, 12, 0, 0);
const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(NOW - d * DAY).toISOString();

describe("classifyFailure — by status code", () => {
  it.each([
    [429, "rate_limited"],
    [401, "credential_plan"],
    [402, "credential_plan"],
    [403, "credential_plan"],
    [408, "transport"],
    [500, "transport"],
    [503, "transport"],
    [599, "transport"],
    [400, "input_rejected"],
    [422, "input_rejected"],
  ] as const)("status %i -> %s", (status, expected) => {
    expect(classifyFailure({ status_code: status, error_msg: null })).toBe(expected);
  });

  it("does not treat a bare HTTP 200 or 404 as any known kind", () => {
    expect(classifyFailure({ status_code: 200, error_msg: null })).toBe("other");
    expect(classifyFailure({ status_code: 404, error_msg: null })).toBe("other");
  });
});

describe("classifyFailure — by error text, when there is no status code", () => {
  it.each([
    ["request timed out after 25000ms", "transport"],
    ["fetch failed", "transport"],
    ["The operation was aborted", "transport"],
    ["connect ECONNREFUSED 10.0.0.1:443", "transport"],
    ["upstream returned HTTP 503", "transport"],
    ["fofa 200: [820001] No permission to search as_organization field", "credential_plan"],
    ["Your plan does not include this endpoint", "credential_plan"],
    ["quota exceeded for this billing period", "credential_plan"],
    ["API key invalid or expired", "credential_plan"],
    ["429 Too Many Requests", "rate_limited"],
    ["rate limit reached, retry later", "rate_limited"],
    ["Invalid input: expected object, received string", "input_rejected"],
    ["validation failed: field `kind` is required", "input_rejected"],
  ] as const)("%s -> %s", (msg, expected) => {
    expect(classifyFailure({ status_code: null, error_msg: msg })).toBe(expected);
  });

  it("puts a rate limit ahead of a credential word in the same message", () => {
    expect(classifyFailure({ status_code: null, error_msg: "rate limit exceeded for your plan" })).toBe("rate_limited");
  });

  it("matches 'plan' and 'dns' as whole words only", () => {
    expect(classifyFailure({ status_code: null, error_msg: "explanation of results unavailable" })).toBe("other");
    expect(classifyFailure({ status_code: null, error_msg: "dnsx lookup produced nothing useful" })).toBe("other");
  });

  it("returns 'other' for unrecognised text, empty text and null", () => {
    expect(classifyFailure({ status_code: null, error_msg: "tool returned no usable result" })).toBe("other");
    expect(classifyFailure({ status_code: null, error_msg: "" })).toBe("other");
    expect(classifyFailure({ status_code: null, error_msg: null })).toBe("other");
  });

  it("lets a status code win over contradictory text", () => {
    expect(classifyFailure({ status_code: 403, error_msg: "request timed out" })).toBe("credential_plan");
  });
});

let seq = 0;
function row(over: Partial<ObservationRow> = {}): ObservationRow {
  seq += 1;
  return {
    tool_name: "tool_a",
    outcome: "ok",
    cached: false,
    status_code: null,
    error_msg: null,
    thread_id: `thread-${(seq % 3) + 1}`,
    created_at: daysAgo(1),
    ...over,
  };
}
const failed = (over: Partial<ObservationRow> = {}) =>
  row({ outcome: "failed", status_code: 503, error_msg: "upstream returned HTTP 503", ...over });

describe("summarizeToolObservations — what counts", () => {
  it("counts only live ok/failed calls as attempts; skipped and empty are shown but excluded", () => {
    const { tools } = summarizeToolObservations(
      [row(), row(), failed(), row({ outcome: "skipped" }), row({ outcome: "empty" }), row({ cached: true }), row({ outcome: null })],
      NOW,
    );
    const t = tools[0];
    expect(t).toMatchObject({ tool: "tool_a", attempts: 3, ok: 2, failed: 1, skipped: 1, empty: 1 });
    expect(t.reliability).toBe(67);
  });

  it("ignores rows older than 30 days and rows with a missing or bad timestamp", () => {
    const { tools } = summarizeToolObservations([row({ created_at: daysAgo(31) }), row({ created_at: "not-a-date" }), row()], NOW);
    expect(tools[0].attempts).toBe(1);
  });

  it("reports reliability as null for a tool with only skips or empties", () => {
    const { tools } = summarizeToolObservations([row({ outcome: "skipped" }), row({ outcome: "empty" })], NOW);
    expect(tools[0].attempts).toBe(0);
    expect(tools[0].reliability).toBeNull();
    expect(tools[0].attention).toBe(false);
  });

  it("splits failures into kinds and names the dominant one", () => {
    const { tools, totals } = summarizeToolObservations(
      [
        failed(),
        failed(),
        failed({ status_code: 403, error_msg: "forbidden" }),
        failed({ status_code: 400, error_msg: "invalid input" }),
        row(),
      ],
      NOW,
    );
    expect(tools[0].classes).toEqual({ transport: 2, credential_plan: 1, rate_limited: 0, input_rejected: 1, other: 0 });
    expect(tools[0].dominantClass).toBe("transport");
    expect(totals).toMatchObject({ tools: 1, attempts: 5, failed: 4 });
    expect(totals.classes.transport).toBe(2);
  });

  it("breaks a tie between kinds in a fixed order, so the label never flickers", () => {
    const { tools } = summarizeToolObservations(
      [failed(), failed({ status_code: 403, error_msg: "forbidden" })],
      NOW,
    );
    expect(tools[0].dominantClass).toBe("credential_plan");
  });
});

describe("summarizeToolObservations — the attention flag", () => {
  const many = (n: number, make: () => ObservationRow) => Array.from({ length: n }, make);

  it("uses the plan's thresholds", () => {
    expect(ATTENTION_MIN_ATTEMPTS).toBe(5);
    expect(ATTENTION_MIN_FAILURE_SHARE).toBe(0.6);
    expect(ATTENTION_MIN_THREADS).toBe(2);
  });

  it("flags exactly at the boundary: 5 attempts, 3 failed (60%), 2 threads", () => {
    const rows = [
      failed({ thread_id: "t1" }), failed({ thread_id: "t2" }), failed({ thread_id: "t1" }),
      row({ thread_id: "t1" }), row({ thread_id: "t2" }),
    ];
    const { tools } = summarizeToolObservations(rows, NOW);
    expect(tools[0].attention).toBe(true);
    expect(tools[0].recent).toMatchObject({ attempts: 5, failed: 3, threads: 2 });
  });

  it("does not flag below the attempt floor, however bad the share", () => {
    const { tools } = summarizeToolObservations(many(4, () => failed()), NOW);
    expect(tools[0].attention).toBe(false);
  });

  it("does not flag when the failure share is below 60%", () => {
    const rows = [failed({ thread_id: "t1" }), failed({ thread_id: "t2" }), row({ thread_id: "t1" }), row({ thread_id: "t2" }), row({ thread_id: "t1" }), row({ thread_id: "t2" })];
    const { tools } = summarizeToolObservations(rows, NOW);
    expect(tools[0].attention).toBe(false);
  });

  it("does not flag when every attempt came from a single case", () => {
    const { tools } = summarizeToolObservations(many(6, () => failed({ thread_id: "only" })), NOW);
    expect(tools[0].recent.threads).toBe(1);
    expect(tools[0].attention).toBe(false);
  });

  it("judges the flag on the last 14 days, so an old bad patch does not flag a tool that has since recovered", () => {
    const old = many(8, () => failed({ created_at: daysAgo(20), thread_id: `o${seq}` }));
    const recent = many(5, () => row({ thread_id: `r${seq}` }));
    const { tools } = summarizeToolObservations([...old, ...recent], NOW);
    expect(tools[0].failed).toBe(8); // still visible in the 30-day figures
    expect(tools[0].attention).toBe(false);
  });

  it("sorts flagged tools first, then by attempts, then by name", () => {
    const flagged = many(6, () => failed({ tool_name: "zeta", thread_id: `z${seq % 2}` }));
    const busy = many(20, () => row({ tool_name: "alpha" }));
    const quiet = many(2, () => row({ tool_name: "beta" }));
    const { tools } = summarizeToolObservations([...busy, ...quiet, ...flagged], NOW);
    expect(tools.map((t) => t.tool)).toEqual(["zeta", "alpha", "beta"]);
  });
});

describe("summarizeToolObservations — empty input", () => {
  it("returns no tools and zero totals", () => {
    const s = summarizeToolObservations([], NOW);
    expect(s.tools).toEqual([]);
    expect(s.totals).toMatchObject({ tools: 0, attempts: 0, failed: 0 });
  });
});

describe("describeAttention", () => {
  const flagged = (rows: ObservationRow[]) => summarizeToolObservations(rows, NOW).tools[0];

  it("states the figures, the window and the dominant kind in plain words", () => {
    const t = flagged([
      failed({ status_code: 403, error_msg: "HTTP 403", thread_id: "t1" }),
      failed({ status_code: 403, error_msg: "HTTP 403", thread_id: "t2" }),
      failed({ status_code: 403, error_msg: "HTTP 403", thread_id: "t1" }),
      failed({ thread_id: "t2" }),
      row({ thread_id: "t1" }),
      row({ thread_id: "t2" }),
    ]);
    expect(t.attention).toBe(true);
    expect(describeAttention(t)).toBe("4 of 6 real attempts failed in the last 14 days (67%) · mostly plan or credential refusals");
  });

  it("says 'mostly' only when one kind strictly leads, and names a mix when the lead is tied", () => {
    const t = flagged([
      failed({ status_code: 403, error_msg: "HTTP 403", thread_id: "t1" }),
      failed({ thread_id: "t2" }),
      failed({ status_code: 400, error_msg: "invalid input", thread_id: "t1" }),
      failed({ status_code: 403, error_msg: "HTTP 403", thread_id: "t2" }),
      failed({ thread_id: "t1" }),
    ]);
    // Two plan refusals and two server errors tie for the lead, so no single kind is "most".
    expect(describeAttention(t)).toBe("5 of 5 real attempts failed in the last 14 days (100%) · a mix of failure kinds");
  });
});

describe("summarizeToolObservations — legacy rows with no recorded outcome", () => {
  // `outcome` is nullable and older rows predate it. Such a row is dropped rather than guessed,
  // but the tool accumulator was created BEFORE that check, so a tool whose only rows are legacy
  // appeared in the list with every figure zero — a ghost that inflates `totals.tools` and tells
  // the analyst a tool was exercised when nothing about it was recorded.
  it("drops a NULL-outcome row without creating a zero-attempt ghost tool", () => {
    const s = summarizeToolObservations(
      [row({ tool_name: "exa_search" }), row({ tool_name: "legacy_only_tool", outcome: null })],
      NOW,
    );
    expect(s.tools.map((t) => t.tool)).toEqual(["exa_search"]);
    expect(s.totals.tools).toBe(1);
  });

  it("drops an unrecognized outcome the same way", () => {
    const s = summarizeToolObservations([row({ tool_name: "weird_tool", outcome: "banana" })], NOW);
    expect(s.tools).toEqual([]);
    expect(s.totals.tools).toBe(0);
  });

  // A legacy row must not erase a tool that also has real rows, nor count toward its figures.
  it("keeps a tool that has real rows alongside a legacy one, counting only the real ones", () => {
    const s = summarizeToolObservations(
      [row({ tool_name: "exa_search" }), row({ tool_name: "exa_search", outcome: null })],
      NOW,
    );
    expect(s.tools).toHaveLength(1);
    expect(s.tools[0]).toMatchObject({ tool: "exa_search", attempts: 1, ok: 1, failed: 0, skipped: 0, empty: 0 });
  });

  // skipped/empty are deliberately surfaced, so they MUST still create an entry.
  it("still lists a tool whose only rows are skipped or empty", () => {
    const s = summarizeToolObservations(
      [row({ tool_name: "skip_tool", outcome: "skipped" }), row({ tool_name: "empty_tool", outcome: "empty" })],
      NOW,
    );
    expect(s.tools.map((t) => t.tool).sort()).toEqual(["empty_tool", "skip_tool"]);
  });
});

describe("classifyFailure — an explicit status code outranks the error text", () => {
  // The branches used to be ordered by severity, each ORing a code test with a text test, so a
  // lower-priority code lost to a higher-priority regex. A 5xx whose body merely mentions a
  // quota then read as "plan or credential refusal" — telling the analyst a key is dead when
  // the provider is simply down, on the one panel whose job is what works and what doesn't.
  it("a 5xx that mentions a quota is a server error, not a credential refusal", () => {
    expect(classifyFailure({ status_code: 500, error_msg: "upstream quota service unavailable" })).toBe("transport");
  });

  it("a 400 naming the api_key field is input the tool rejected, not a credential refusal", () => {
    expect(classifyFailure({ status_code: 400, error_msg: "invalid api key field type" })).toBe("input_rejected");
  });

  it("a 403 whose body says 'rate limit' is still a credential/plan refusal", () => {
    expect(classifyFailure({ status_code: 403, error_msg: "rate limit on your plan" })).toBe("credential_plan");
  });

  it("a 422 mentioning a connection is input rejected", () => {
    expect(classifyFailure({ status_code: 422, error_msg: "connection parameter invalid" })).toBe("input_rejected");
  });

  // The fallback still matters: 62% of failed calls carry no status code at all.
  it("falls back to the text when there is no status code", () => {
    expect(classifyFailure({ status_code: null, error_msg: "request timed out after 25000ms" })).toBe("transport");
    expect(classifyFailure({ status_code: null, error_msg: "Your plan does not include this endpoint" })).toBe("credential_plan");
  });

  // FOFA answers HTTP 200 with an error body (CLAUDE.md, "A 403 is not a dead credential").
  // 200 is not a recognized failure code, so the text must still decide.
  it("uses the text when the code is not a recognized failure code, as FOFA's HTTP 200 needs", () => {
    expect(
      classifyFailure({ status_code: 200, error_msg: "fofa 200: [820001] No permission to search as_organization field" }),
    ).toBe("credential_plan");
    expect(classifyFailure({ status_code: 404, error_msg: "malformed selector" })).toBe("input_rejected");
  });

  it("is 'other' when neither the code nor the text says anything useful", () => {
    expect(classifyFailure({ status_code: 418, error_msg: "teapot" })).toBe("other");
  });
});
