import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { RunCockpit } from "@/components/workspace/RunCockpit";
import type { RunCockpitInput } from "@/lib/run-cockpit";
import type { ToolEvent } from "@/hooks/useThreadToolActivity";

afterEach(cleanup);

const base = (run: Partial<RunCockpitInput["run"]> = {}, over: Partial<Omit<RunCockpitInput, "nowMs">> = {}): Omit<RunCockpitInput, "nowMs"> => ({
  run: {
    state: "completed", label: "Complete", terminal: true, recoveryReason: null, recoveredAt: null,
    startedAt: "2026-10-20T09:58:00Z", heartbeatAt: "2026-10-20T09:59:30Z", ...run,
  },
  tools: {
    total: 2, failed: 0, lastStage: "VERIFY", lastAt: "2026-10-20T09:59:20Z", available: true,
    events: [{ id: "e1", toolName: "whois_lookup", at: "2026-10-20T09:59:20Z", status: "succeeded" } as unknown as ToolEvent],
  },
  spendText: "$0.012",
  pendingDecisions: 3,
  ...over,
});

function mount(input = base()) {
  const onOpenDecisions = vi.fn();
  const onOpenTools = vi.fn();
  render(<RunCockpit input={input} onOpenDecisions={onOpenDecisions} onOpenTools={onOpenTools} />);
  return { region: screen.getByRole("region", { name: "Run status" }), onOpenDecisions, onOpenTools };
}

describe("RunCockpit", () => {
  it("shows state, elapsed with its basis, stage and calls", () => {
    const { region } = mount();
    expect(within(region).getByText("Complete")).toBeInTheDocument();
    expect(within(region).getByText(/1m 30s/)).toBeInTheDocument();
    expect(within(region).getByText(/to last heartbeat/)).toBeInTheDocument();
    expect(within(region).getByText("Verify")).toBeInTheDocument();
    expect(within(region).getByText("$0.012")).toBeInTheDocument();
  });

  it("labels the acting role as inferred", () => {
    const { region } = mount();
    expect(within(region).getByText(/role \(inferred\)/)).toBeInTheDocument();
  });

  it("explains why a finished run ended without inventing a stop reason", () => {
    mount();
    expect(screen.getByTestId("run-cockpit-stop")).toHaveTextContent(/Why it ended: Finished/);
    expect(screen.getByTestId("run-cockpit-stop")).toHaveTextContent(/not shown in this view/);
  });

  it("explains an interrupted run with the recovery classification", () => {
    mount(base({ state: "interrupted", label: "Interrupted", recoveryReason: "stale heartbeat recovered by health sweep" }));
    expect(screen.getByTestId("run-cockpit-stop")).toHaveTextContent(/Why it stopped: Run stopped responding/);
  });

  it("decision and last-action links jump to their tabs", () => {
    const { region, onOpenDecisions, onOpenTools } = mount();
    fireEvent.click(within(region).getByRole("button", { name: /3 need your call/ }));
    fireEvent.click(within(region).getByRole("button", { name: /whois|domain|registr/i }));
    expect(onOpenDecisions).toHaveBeenCalledOnce();
    expect(onOpenTools).toHaveBeenCalledOnce();
  });

  it("an unread ledger prints '—' and 'not recorded', never 0", () => {
    const { region } = mount(base({}, { tools: { total: 0, failed: 0, lastStage: null, lastAt: null, events: [], available: false } }));
    expect(within(region).getByText("—")).toBeInTheDocument();
    expect(within(region).getAllByText("not recorded").length).toBeGreaterThan(0);
    expect(within(region).queryByText(/^0$/)).toBeNull();
  });

  it("unread verdicts show 'not recorded' for what is waiting, not 0", () => {
    const { region } = mount(base({}, { pendingDecisions: null }));
    expect(within(region).queryByRole("button", { name: /your call/ })).toBeNull();
    expect(within(region).getByText("Waiting on you").nextElementSibling).toHaveTextContent("not recorded");
  });

  it("has no steering control", () => {
    const { region } = mount();
    const names = within(region).queryAllByRole("button").map((b) => b.textContent ?? "");
    expect(names.some((n) => /stop|cancel|resume|pause|run next/i.test(n))).toBe(false);
  });
});
