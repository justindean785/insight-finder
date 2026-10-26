import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The REAL Health panel + the REAL useThreadToolHealth hook, fed REAL-SHAPED stored tool_usage_log rows (2026-10-13).
 *
 * The wording for a LeakCheck 403 was correct in isolation and never reachable: the hook only normalised
 * needs-attention categories and http_denied is the calm bucket, so the tab showed a "Denied" chip and nothing else.
 * What the edge stores for a refused LeakCheck call is outcome "failed", ok false, status_code 403 and error_msg
 * "upstream returned HTTP 403" (cache.ts extractToolError) — LeakCheck's own message is not kept on the row. After
 * that 403 the circuit breaker suppresses the provider for the run, so later calls are logged as SKIPPED rows with no
 * status. These tests assert what the analyst reads, how it is styled, and that an equivalent 403 from an unrelated
 * tool reads exactly as before.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const m = vi.hoisted(() => ({ rows: [] as Array<Record<string, unknown>>, selects: [] as string[] }));

// Like PostgREST, hand back ONLY the columns the hook asked for: a field the query does not select never reaches the
// aggregation, so a test row carrying `cached` proves nothing unless the hook's select list actually names it.
vi.mock("@/integrations/supabase/client", () => {
  const chain = {
    select: (cols: string) => { m.selects.push(cols); return chain; },
    eq: () => chain,
    order: () => {
      const cols = (m.selects[m.selects.length - 1] ?? "").split(",").map((c) => c.trim());
      const data = m.rows.map((r) => Object.fromEntries(cols.filter((c) => c in r).map((c) => [c, r[c]])));
      return Promise.resolve({ data, error: null });
    },
  };
  const ch = { on: () => ch, subscribe: () => ch };
  return { supabase: { from: () => chain, channel: () => ch, removeChannel: () => Promise.resolve() } };
});

import { ToolHealthPanel } from "@/components/panel/ToolHealthPanel";

const STORED = "upstream returned HTTP 403";
const T = (i: number) => `2026-10-13T00:0${i}:00Z`;
const refused = (tool: string, i: number, msg = STORED) =>
  ({ tool_name: tool, outcome: "failed", ok: false, error_msg: msg, status_code: 403, cached: false, created_at: T(i) });
const refusals = (tool: string, n: number, msg = STORED) => Array.from({ length: n }, (_, i) => refused(tool, i, msg));
const skipped = (tool: string, i: number) =>
  ({ tool_name: tool, outcome: "skipped", ok: false, status_code: null, cached: false, created_at: T(i),
     error_msg: `401/403 unauthorized — provider '${tool}' suppressed for investigation` });
const answered = (tool: string, i: number) =>
  ({ tool_name: tool, outcome: "ok", ok: true, error_msg: null, status_code: 200, cached: false, created_at: T(i) });
/** What cache.ts logs for a cache replay: logUsage(cached = true, ok = true) → outcome "ok", no error, no status. */
const replayed = (tool: string, i: number, outcome: "ok" | "empty" = "ok") =>
  ({ tool_name: tool, outcome, ok: true, error_msg: null, status_code: null, cached: true, created_at: T(i) });

/** The card for one tool: the element that contains the tool-name label, its chips and its message. */
function card(tool: string): HTMLElement {
  return screen.getByText(tool, { selector: "span" }).closest("div")!.parentElement as HTMLElement;
}
/** The message block inside a card (the element that carries the lastIssue styling), or null. */
function messageBlock(c: HTMLElement): HTMLElement | null {
  return Array.from(c.querySelectorAll("div")).find((d) => /border-(destructive|warning)/.test(d.className) && d.className.includes("bg-black/30")) ?? null;
}

const EITHER = /either an inactive plan or a reached usage quota, and the stored record does not say which/;

afterEach(() => { cleanup(); m.rows = []; m.selects = []; });

describe("Tool Health panel — a refused LeakCheck lookup", () => {
  it.each([1, 2])("%i real-shaped 403: explained once, informational (not error-styled), Denied chip, no attention", async (n) => {
    m.rows = refusals("leakcheck_lookup", n);
    render(<ToolHealthPanel threadId={`t-${n}`} />);
    await screen.findByText("leakcheck_lookup");
    const c = card("leakcheck_lookup");
    expect(within(c).getByText(`Denied ${n}`)).toBeTruthy();
    const block = messageBlock(c)!;
    expect(block.textContent).toMatch(/^Refused \(HTTP 403\)\. LeakCheck documents 403 as/);
    expect(block.textContent).toMatch(EITHER);
    expect(block.textContent).toMatch(/Check the plan and remaining quota on the LeakCheck account\.$/);
    expect(block.textContent).not.toMatch(/bot protection|IP reputation|attempts on this case|did not say which/i);
    expect(c.textContent!.match(/HTTP 403/g)).toHaveLength(1);        // the status is not printed twice
    expect(block.className).toMatch(/warning/);                        // informational …
    expect(block.className).not.toMatch(/destructive/);              // … not an error
  });

  it("[403, skip, skip] — the normal shape after the circuit breaker — keeps the explanation, names the refusal, and keeps attention styling", async () => {
    m.rows = [refused("leakcheck_lookup", 0), skipped("leakcheck_lookup", 1), skipped("leakcheck_lookup", 2)];
    render(<ToolHealthPanel threadId="t-breaker" />);
    await screen.findByText("leakcheck_lookup");
    const c = card("leakcheck_lookup");
    expect(within(c).getByText("Denied 1")).toBeTruthy();
    expect(within(c).getByText("Skipped 2")).toBeTruthy();            // skips are skips, never extra refusals
    const block = messageBlock(c)!;
    expect(block.textContent).toMatch(/^3 attempts on this case, none returned data — stop calling it here\. Most recent LeakCheck refusal: Refused \(HTTP 403\)\./);
    expect(block.textContent).toMatch(EITHER);
    expect(block.className).toMatch(/destructive/);                  // an attention-required row keeps its styling
  });

  it("[403, skip] — one refusal and one skip — is explained, with the lead-in that says it is the most recent refusal", async () => {
    m.rows = [refused("leakcheck_lookup", 0), skipped("leakcheck_lookup", 1)];
    render(<ToolHealthPanel threadId="t-403-skip" />);
    await screen.findByText("leakcheck_lookup");
    const block = messageBlock(card("leakcheck_lookup"))!;
    expect(block.textContent).toMatch(/^Most recent LeakCheck refusal: Refused \(HTTP 403\)\./);
    expect(block.className).toMatch(/warning/);
  });

  it("three real-shaped 403s: the repetition sentence stays and the explanation follows it (attention styling)", async () => {
    m.rows = refusals("leakcheck_lookup", 3);
    render(<ToolHealthPanel threadId="t-3" />);
    await screen.findByText("leakcheck_lookup");
    const block = messageBlock(card("leakcheck_lookup"))!;
    expect(block.textContent).toMatch(/^3 attempts on this case, none returned data — stop calling it here\. Most recent LeakCheck refusal: Refused \(HTTP 403\)\./);
    expect(block.className).toMatch(/destructive/);
  });

  it("a later successful provider response makes it stale: the Denied chip, no explanation", async () => {
    m.rows = [refused("leakcheck_lookup", 0), answered("leakcheck_lookup", 1)];
    render(<ToolHealthPanel threadId="t-stale" />);
    await screen.findByText("leakcheck_lookup");
    const c = card("leakcheck_lookup");
    expect(within(c).getByText("Denied 1")).toBeTruthy();
    expect(messageBlock(c)).toBeNull();
  });
});

describe("Tool Health panel — an equivalent 403 from an unrelated tool reads exactly as before", () => {
  it("one or two: the Denied chip and no message line at all", async () => {
    for (const n of [1, 2]) {
      m.rows = refusals("jina_reader_scrape", n);
      const { unmount } = render(<ToolHealthPanel threadId={`u-${n}`} />);
      await screen.findByText("jina_reader_scrape");
      const c = card("jina_reader_scrape");
      expect(within(c).getByText(`Denied ${n}`)).toBeTruthy();
      expect(messageBlock(c)).toBeNull();
      unmount();
    }
  });

  it("three, and [403, skip, skip]: only the original repetition sentence, in the original attention styling — whatever the text says", async () => {
    for (const rows of [
      (msg: string) => refusals("jina_reader_scrape", 3, msg),
      (msg: string) => [refused("jina_reader_scrape", 0, msg), skipped("jina_reader_scrape", 1), skipped("jina_reader_scrape", 2)],
    ]) {
      for (const msg of [STORED, "403 Forbidden: Subscription required to read this article", "Active plan required"]) {
        m.rows = rows(msg);
        const { unmount } = render(<ToolHealthPanel threadId="u-3" />);
        await screen.findByText("jina_reader_scrape");
        const block = messageBlock(card("jina_reader_scrape"))!;
        expect(block.textContent).toBe("3 attempts on this case, none returned data — stop calling it here.");
        expect(block.className).toMatch(/destructive/);
        unmount();
      }
    }
  });

  it("side by side in ONE thread: LeakCheck is explained, the unrelated tool is not", async () => {
    m.rows = [...refusals("leakcheck_lookup", 1), ...refusals("reddit_user", 1)];
    render(<ToolHealthPanel threadId="both" />);
    await screen.findByText("leakcheck_lookup");
    expect(messageBlock(card("leakcheck_lookup"))!.textContent).toMatch(/Refused \(HTTP 403\)\. LeakCheck documents/);
    expect(messageBlock(card("reddit_user"))).toBeNull();
  });
});

describe("Tool Health panel — a cache replay after a LeakCheck 403 is not a provider answer", () => {
  it("the hook's query names the cached column (and still every column it read before)", async () => {
    m.rows = refusals("leakcheck_lookup", 1);
    render(<ToolHealthPanel threadId="cols" />);
    await screen.findByText("leakcheck_lookup");
    expect(m.selects.length).toBeGreaterThan(0);
    expect(m.selects[0].split(",").map((c) => c.trim()).sort())
      .toEqual(["cached", "created_at", "error_msg", "ok", "outcome", "status_code", "tool_name"]);
  });

  it("[403, replay]: the explanation stays, informational, with the OK chip counting the replay and the Denied chip the one refusal", async () => {
    m.rows = [refused("leakcheck_lookup", 0), replayed("leakcheck_lookup", 1)];
    render(<ToolHealthPanel threadId="t-replay" />);
    await screen.findByText("leakcheck_lookup");
    const c = card("leakcheck_lookup");
    expect(within(c).getByText("Denied 1")).toBeTruthy();
    expect(within(c).getByText("OK 1")).toBeTruthy();
    const block = messageBlock(c)!;
    expect(block.textContent).toMatch(/^Most recent LeakCheck refusal: Refused \(HTTP 403\)\./);
    expect(block.textContent).toMatch(EITHER);
    expect(block.className).toMatch(/warning/);
    expect(block.className).not.toMatch(/destructive/);
  });

  it("[403, replay of a no-record result] and [403, replay, skip]: same explanation, skips counted as skips", async () => {
    for (const [id, rows, chip] of [
      ["empty", [refused("leakcheck_lookup", 0), replayed("leakcheck_lookup", 1, "empty")], "No record 1"],
      ["skip", [refused("leakcheck_lookup", 0), replayed("leakcheck_lookup", 1), skipped("leakcheck_lookup", 2)], "Skipped 1"],
      ["skips", [refused("leakcheck_lookup", 0), skipped("leakcheck_lookup", 1), skipped("leakcheck_lookup", 2), replayed("leakcheck_lookup", 3)], "Skipped 2"],
    ] as Array<[string, Array<Record<string, unknown>>, string]>) {
      m.rows = rows;
      const { unmount } = render(<ToolHealthPanel threadId={`t-${id}`} />);
      await screen.findByText("leakcheck_lookup");
      const c = card("leakcheck_lookup");
      expect(within(c).getByText("Denied 1")).toBeTruthy();         // the skips and the replay are not extra refusals
      expect(within(c).getByText(chip)).toBeTruthy();
      const block = messageBlock(c)!;
      expect(block.textContent).toMatch(/^Most recent LeakCheck refusal: Refused \(HTTP 403\)\./);
      expect(block.textContent).toMatch(EITHER);
      expect(block.className).toMatch(/warning/);
      unmount();
    }
  });

  it("a LIVE successful response after the replay does clear it", async () => {
    m.rows = [refused("leakcheck_lookup", 0), replayed("leakcheck_lookup", 1), answered("leakcheck_lookup", 2)];
    render(<ToolHealthPanel threadId="t-live" />);
    await screen.findByText("leakcheck_lookup");
    const c = card("leakcheck_lookup");
    expect(within(c).getByText("Denied 1")).toBeTruthy();
    expect(messageBlock(c)).toBeNull();
  });

  it("an equivalent 403 + replay on an unrelated tool still shows no message, and its attention rule is untouched", async () => {
    m.rows = [refused("reddit_user", 0), replayed("reddit_user", 1)];
    render(<ToolHealthPanel threadId="u-replay" />);
    await screen.findByText("reddit_user");
    const c = card("reddit_user");
    expect(within(c).getByText("Denied 1")).toBeTruthy();
    expect(messageBlock(c)).toBeNull();
  });
});
