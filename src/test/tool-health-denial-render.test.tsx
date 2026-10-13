import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The REAL Health panel + the REAL hook, fed tool_usage_log rows for a LeakCheck 403 (2026-10-13).
 * The wording in tool-outcome.ts was never reachable from here: only needs-attention categories were
 * normalized and http_denied is the calm bucket. These tests assert what the analyst actually reads.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const m = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

vi.mock("@/integrations/supabase/client", () => {
  const chain = { select: () => chain, eq: () => chain, order: () => Promise.resolve({ data: m.rows, error: null }) };
  const ch = { on: () => ch, subscribe: () => ch };
  return { supabase: { from: () => chain, channel: () => ch, removeChannel: () => Promise.resolve() } };
});

import { ToolHealthPanel } from "@/components/panel/ToolHealthPanel";

const row = (tool: string, msg: string, i: number) =>
  ({ tool_name: tool, outcome: "failed", ok: false, error_msg: msg, status_code: 403, created_at: `2026-10-13T00:0${i}:00Z` });

afterEach(() => { cleanup(); m.rows = []; });

describe("Tool Health panel — a repeatedly refused LeakCheck lookup", () => {
  it("three 403s: the analyst reads the documented meaning, not just a count", async () => {
    m.rows = [0, 1, 2].map((i) => row("leakcheck_lookup", "upstream returned HTTP 403", i));
    render(<ToolHealthPanel threadId="t1" />);
    const text = await screen.findByText(/Last denial: Refused \(HTTP 403\)\./);
    expect(text.textContent).toMatch(/3 attempts on this case, none returned data — stop calling it here\./);
    expect(text.textContent).toMatch(/either an inactive plan or a reached usage quota, and the response did not say which/);
    expect(text.textContent).not.toMatch(/bot protection/i);
  });

  it("two 403s stay calm: the Denied chip, no message line", async () => {
    m.rows = [0, 1].map((i) => row("leakcheck_lookup", "upstream returned HTTP 403", i));
    render(<ToolHealthPanel threadId="t2" />);
    await screen.findByText("leakcheck_lookup");
    expect(screen.queryByText(/Last denial/)).toBeNull();
    expect(screen.queryByText(/attempts on this case/)).toBeNull();
  });

  it("three 403s from a web-fetch tool never read as a provider plan problem", async () => {
    m.rows = [0, 1, 2].map((i) => row("jina_reader_scrape", "403 Forbidden: Subscription required to read this article", i));
    render(<ToolHealthPanel threadId="t3" />);
    const text = await screen.findByText(/Last denial: Access denied \(HTTP 403\)/);
    expect(text.textContent).not.toMatch(/Refused|inactive plan|usage quota/i);
  });
});
