import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The REAL Health panel + the REAL useThreadToolHealth hook, fed REAL-SHAPED stored tool_usage_log rows (2026-10-13).
 *
 * The wording for a LeakCheck 403 was correct in isolation and never reachable: the hook only normalises
 * needs-attention categories and http_denied is the calm bucket, so the tab showed a "Denied" chip and nothing else.
 * What the edge actually stores for a refused LeakCheck call is outcome "failed", ok false, status_code 403 and
 * error_msg "upstream returned HTTP 403" (cache.ts extractToolError) — LeakCheck's own message never reaches the row.
 * These tests assert what the analyst reads, and that an equivalent 403 from an unrelated tool reads exactly as before.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const m = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>> }));

vi.mock("@/integrations/supabase/client", () => {
  const chain = { select: () => chain, eq: () => chain, order: () => Promise.resolve({ data: m.rows, error: null }) };
  const ch = { on: () => ch, subscribe: () => ch };
  return { supabase: { from: () => chain, channel: () => ch, removeChannel: () => Promise.resolve() } };
});

import { ToolHealthPanel } from "@/components/panel/ToolHealthPanel";

const STORED = "upstream returned HTTP 403";
const row = (tool: string, i: number, msg = STORED) =>
  ({ tool_name: tool, outcome: "failed", ok: false, error_msg: msg, status_code: 403, created_at: `2026-10-13T00:0${i}:00Z` });
const rowsOf = (tool: string, n: number, msg = STORED) => Array.from({ length: n }, (_, i) => row(tool, i, msg));

/** The card for one tool: the element that contains the tool-name label and its chips and message. */
function card(tool: string): HTMLElement {
  const label = screen.getByText(tool, { selector: "span" });
  return label.closest("div")!.parentElement as HTMLElement;
}

afterEach(() => { cleanup(); m.rows = []; });

describe("Tool Health panel — a refused LeakCheck lookup", () => {
  it.each([1, 2])("%i real-shaped 403: the analyst reads what the refusal means, once, with the Denied chip and no attention", async (n) => {
    m.rows = rowsOf("leakcheck_lookup", n);
    render(<ToolHealthPanel threadId={`t-${n}`}/>);
    await screen.findByText("leakcheck_lookup");
    const c = card("leakcheck_lookup");
    expect(within(c).getByText(`Denied ${n}`)).toBeTruthy();
    const msg = within(c).getByText(/^Refused \(HTTP 403\)\. LeakCheck documents 403 as either an inactive plan or a reached usage quota, and the response did not say which\./);
    expect(msg.textContent).toMatch(/Check the plan and remaining quota on the LeakCheck account\.$/);
    expect(msg.textContent).not.toMatch(/bot protection|IP reputation|attempts on this case/i);
    expect(c.textContent!.match(/HTTP 403/g)).toHaveLength(1); // no duplicated status text beside the message
  });

  it("three real-shaped 403s: the repetition sentence stays and the explanation follows it", async () => {
    m.rows = rowsOf("leakcheck_lookup", 3);
    render(<ToolHealthPanel threadId="t-3" />);
    const msg = await screen.findByText(/^3 attempts on this case, none returned data — stop calling it here\. Refused \(HTTP 403\)\./);
    expect(msg.textContent).toMatch(/either an inactive plan or a reached usage quota, and the response did not say which/);
    expect(msg.textContent).not.toMatch(/bot protection/i);
  });
});

describe("Tool Health panel — an equivalent 403 from an unrelated tool reads exactly as before", () => {
  it("one or two: the Denied chip and no message line at all", async () => {
    for (const n of [1, 2]) {
      m.rows = rowsOf("jina_reader_scrape", n);
      const { unmount } = render(<ToolHealthPanel threadId={`u-${n}`} />);
      await screen.findByText("jina_reader_scrape");
      const c = card("jina_reader_scrape");
      expect(within(c).getByText(`Denied ${n}`)).toBeTruthy();
      expect(c.textContent).not.toMatch(/Refused|LeakCheck|attempts on this case|Access denied/);
      unmount();
    }
  });

  it("three: only the original repetition sentence — no explanation, whatever the text says", async () => {
    for (const msg of [STORED, "403 Forbidden: Subscription required to read this article", "Active plan required"]) {
      m.rows = rowsOf("jina_reader_scrape", 3, msg);
      const { unmount } = render(<ToolHealthPanel threadId="u-3" />);
      const line = await screen.findByText(/^3 attempts on this case, none returned data — stop calling it here\.$/);
      expect(line.textContent).toBe("3 attempts on this case, none returned data — stop calling it here.");
      expect(card("jina_reader_scrape").textContent).not.toMatch(/Refused|LeakCheck|Access denied|inactive plan|usage quota/);
      unmount();
    }
  });

  it("side by side in ONE thread: LeakCheck is explained, the unrelated tool is not", async () => {
    m.rows = [...rowsOf("leakcheck_lookup", 1), ...rowsOf("reddit_user", 1)];
    render(<ToolHealthPanel threadId="both" />);
    await screen.findByText("leakcheck_lookup");
    expect(card("leakcheck_lookup").textContent).toMatch(/Refused \(HTTP 403\)\. LeakCheck documents/);
    expect(card("reddit_user").textContent).not.toMatch(/Refused|LeakCheck|Access denied/);
  });
});
