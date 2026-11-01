import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToolObservationsPanel, OBS_VISIBLE_ROWS } from "@/components/brain/ToolObservationsPanel";
import { summarizeToolObservations, type ObservationRow } from "@/lib/tool-observation-classes";
import type { ToolObservationsState } from "@/hooks/useToolObservations";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const NOW = Date.now();
const recent = () => new Date(NOW - 86_400_000).toISOString();
const rows = (tool: string, n: number): ObservationRow[] =>
  Array.from({ length: n }, () => ({ tool_name: tool, outcome: "ok", cached: false, status_code: null, error_msg: null, thread_id: "t1", created_at: recent() }));

const stateFor = (tools: number, over: Partial<ToolObservationsState> = {}): ToolObservationsState => ({
  loading: false,
  error: null,
  truncated: false,
  // tool_00 has the most attempts, so the order is deterministic: tool_00, tool_01, ...
  summary: summarizeToolObservations(Array.from({ length: tools }, (_, i) => rows(`tool_${String(i).padStart(2, "0")}`, 100 - i)).flat(), NOW),
  ...over,
});

describe("ToolObservationsPanel — a long tool list", () => {
  it(`shows the first ${OBS_VISIBLE_ROWS} tools and puts the rest behind a disclosure that says how many`, () => {
    const total = OBS_VISIBLE_ROWS + 5;
    const { container } = render(<ToolObservationsPanel state={stateFor(total)} />);
    const all = screen.getAllByTestId("obs-row");
    expect(all).toHaveLength(total); // every tool is in the page, none dropped
    const details = container.querySelector("details");
    expect(details).not.toBeNull();
    expect(details!.hasAttribute("open")).toBe(false);
    expect(within(details as HTMLElement).getAllByTestId("obs-row")).toHaveLength(5);
    expect(screen.getByText("Show the other 5 tools")).toBeTruthy();
    // the count is its own <span>, so read the heading's whole text
    expect(screen.getByText(/^All tools/).textContent).toBe(`All tools · ${total}`);
  });

  it("has no disclosure when every tool fits", () => {
    const { container } = render(<ToolObservationsPanel state={stateFor(OBS_VISIBLE_ROWS)} />);
    expect(screen.getAllByTestId("obs-row")).toHaveLength(OBS_VISIBLE_ROWS);
    expect(container.querySelector("details")).toBeNull();
  });
});

describe("ToolObservationsPanel — states", () => {
  it("says the read failed instead of listing nothing", () => {
    render(<ToolObservationsPanel state={stateFor(0, { error: "permission denied" })} />);
    expect(screen.getByTestId("obs-error").textContent).toMatch(/could not be read \(permission denied\)/);
    expect(screen.queryByTestId("obs-row")).toBeNull();
  });

  it("says there were no calls, and shows a loading line while reading", () => {
    const { rerender } = render(<ToolObservationsPanel state={stateFor(0)} />);
    expect(screen.getByTestId("obs-empty").textContent).toMatch(/No tool calls in the last 30 days/);
    rerender(<ToolObservationsPanel state={stateFor(0, { loading: true })} />);
    expect(screen.getByText(/Reading tool outcomes/)).toBeTruthy();
  });

  it("relabels a capped read so it does not wear the 30-day label", () => {
    render(<ToolObservationsPanel state={stateFor(2, { truncated: true })} />);
    expect(screen.getByText(/newest 20,000 calls/)).toBeTruthy();
    expect(screen.getByText(/covers only the newest 20,000/)).toBeTruthy();
  });
});
