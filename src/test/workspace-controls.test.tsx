import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RecoveryBanner } from "@/components/workspace/RecoveryBanner";
import { NextSteps, type NextStepItem } from "@/components/pivots/NextSteps";
import { WorkspaceTabs } from "@/components/workspace/WorkspaceTabs";
import { buildCaseSnapshot, type CaseThreadRow } from "@/lib/case-snapshot";
import type { CaseSnapshot } from "@/hooks/useCaseSnapshot";
import { pivotEligibility, validatePivotSuggestion } from "@/lib/pivot-schema";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// ── Snapshot fixture ─────────────────────────────────────────────────────────
function snapshotWith(thread: Partial<CaseThreadRow>): CaseSnapshot {
  const core = buildCaseSnapshot({
    threadId: "t1",
    accountReady: true,
    thread: {
      id: "t1", seed_value: "analyst@example.com", seed_type: "email", status: "finished",
      credits_used: 0, cost_micro_usd: 120_000, recovered_at: null, recovery_reason: null,
      run_started_at: "2026-09-11T09:50:00Z", last_heartbeat_at: "2026-09-11T09:55:00Z",
      updated_at: "2026-09-11T09:55:00Z", ...thread,
    },
    threadLoaded: true,
    artifacts: { items: [], loading: false, error: false },
    tools: { events: [], persistedTotal: 46, failed: 1, degraded: 1, skipped: 0, gated: 0, ok: 44, loading: false, error: false, loadedAt: 1 },
    authority: { verified: 0, infrastructure: 0, probable: 0, review: 0, weak: 0, quarantined: 0, conflict: 0, failed: 0 },
    integrity: null,
    readiness: null,
    chatRunning: false,
    nowMs: Date.parse("2026-09-11T10:00:00Z"),
  });
  return { ...core, version: 1, capturedAt: 1, syncing: false, syncedAt: 1, syncError: false, lastChange: null };
}

describe("RecoveryBanner — an interrupted run always explains recovery", () => {
  const noop = () => {};

  it("interrupted, not resumable: 'Recovery unavailable' with its reason — and no retry of any kind", () => {
    render(<RecoveryBanner snapshot={snapshotWith({ recovery_reason: "stream_error: upstream closed" })} onViewFailedTools={noop} onStartNew={noop} />);
    expect(screen.getByRole("heading", { name: "Model connection failed" })).toBeTruthy();
    expect(screen.getByText("STREAM_ERROR")).toBeTruthy();
    const unavailable = screen.getByRole("button", { name: /Recovery unavailable/ });
    expect(unavailable.getAttribute("aria-disabled")).toBe("true");
    expect(unavailable.getAttribute("aria-describedby")).toBeTruthy();
    expect(screen.getByText(/does not issue a resumable run ID/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /retry|resume/i })).toBeNull();
    // Kept figures are stated, from the snapshot.
    expect(screen.getByText(/46 calls/)).toBeTruthy();
    expect(screen.getByText("$0.120")).toBeTruthy();
  });

  it("interrupted, resumable: offers Resume ONLY for a server-issued contract", () => {
    const onResume = vi.fn();
    render(
      <RecoveryBanner
        snapshot={snapshotWith({ recovery_reason: "stale heartbeat recovered by health sweep", recovered_at: "2026-09-11T09:58:00Z" })}
        resumeContract={{ runId: "run_1", idempotencyKey: "idem_1" }}
        onResume={onResume}
        onViewFailedTools={noop}
        onStartNew={noop}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Resume investigation" }));
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(onResume).toHaveBeenCalledWith({ runId: "run_1", idempotencyKey: "idem_1" });
  });

  it("secondary actions are read-only or start a NEW case", () => {
    const onView = vi.fn();
    const onNew = vi.fn();
    render(<RecoveryBanner snapshot={snapshotWith({ recovery_reason: "incomplete: run ended without a durable report" })} onViewFailedTools={onView} onStartNew={onNew} />);
    fireEvent.click(screen.getByRole("button", { name: /View failed tools/ }));
    fireEvent.click(screen.getByRole("button", { name: "Start new investigation" }));
    expect(onView).toHaveBeenCalledTimes(1);
    expect(onNew).toHaveBeenCalledTimes(1);
  });

  it("collapses to one line and remembers it", () => {
    render(<RecoveryBanner snapshot={snapshotWith({ recovery_reason: "stream_error: x" })} onViewFailedTools={noop} onStartNew={noop} />);
    const toggle = screen.getByRole("button", { name: "Hide details" });
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Details" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("button", { name: /Recovery unavailable/ })).toBeNull();
  });

  it("says nothing for a clean completion", () => {
    const { container } = render(<RecoveryBanner snapshot={snapshotWith({})} onViewFailedTools={noop} onStartNew={noop} />);
    expect(container.textContent).toBe("");
  });

  it("names an analyst Stop plainly, in a neutral tone", () => {
    render(<RecoveryBanner snapshot={snapshotWith({ status: "stopped" })} onViewFailedTools={noop} onStartNew={noop} />);
    expect(screen.getByRole("heading", { name: "Run stopped" })).toBeTruthy();
  });
});

// ── Next steps ──────────────────────────────────────────────────────────────
const validInput = {
  id: "email:j@example.com:a1", priority: "high", action: "Verify email ownership", target: "j@example.com",
  targetType: "email", reason: "Email discovered via hunter verify.", sourceArtifactIds: [], basis: "Recommended in the agent's report text",
  prompt: "Run this pivot on j@example.com", status: "new",
};

function itemsFor(inputs: Record<string, unknown>[]): NextStepItem[] {
  return inputs.map((input, i) => {
    const validation = validatePivotSuggestion(input);
    return {
      kind: "pivot",
      key: `k${i}`,
      validation,
      eligibility: validation.status === "valid" ? pivotEligibility(validation.pivot, { artifactsById: new Map(), review: () => "new" }) : null,
    };
  });
}

describe("NextSteps — a malformed pivot cannot run, a valid one previews first", () => {
  it("renders a malformed pivot as 'Suggestion needs repair' with no Run control", () => {
    render(
      <NextSteps
        items={itemsFor([{ ...validInput, action: "Review lead", target: "| Review lead | Keith family | name |", targetType: "name" }])}
        onRunPivot={vi.fn()}
        onRunAction={vi.fn()}
      />,
    );
    expect(screen.getByText("Suggestion needs repair")).toBeTruthy();
    expect(screen.getByText(/table cell/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Run/ })).toBeNull();
  });

  it("Run opens the preview and starts NOTHING; Start dispatches exactly once", () => {
    const onRunPivot = vi.fn();
    render(<NextSteps items={itemsFor([validInput])} onRunPivot={onRunPivot} onRunAction={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Run Verify email ownership on j@example.com" }));
    expect(onRunPivot).not.toHaveBeenCalled();
    expect(screen.getByText("Before this pivot runs")).toBeTruthy();
    expect(screen.getByText(/Unavailable — the backend does not publish per-pivot estimates/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start this pivot" }));
    expect(onRunPivot).toHaveBeenCalledTimes(1);
    expect(onRunPivot.mock.calls[0][0]).toMatchObject({ target: "j@example.com", targetType: "email" });
  });

  it("a searched target needs an explicit rerun confirmation", () => {
    const onRunPivot = vi.fn();
    render(<NextSteps items={itemsFor([{ ...validInput, status: "searched" }])} onRunPivot={onRunPivot} onRunAction={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /^Run Verify email ownership/ }));
    const start = screen.getByRole("button", { name: "Start this pivot" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Run it again anyway/));
    expect(start.disabled).toBe(false);
  });
});

// ── Mobile navigation ───────────────────────────────────────────────────────
describe("WorkspaceTabs (mobile) — labelled, never an unnamed icon", () => {
  it("names the More trigger with the current section when a More section is active", () => {
    render(<WorkspaceTabs active="graph" onChange={vi.fn()} variant="inline" />);
    const trigger = screen.getByRole("button", { name: "More, current section: Graph" });
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    // Its visible text states the section too — not an icon alone.
    expect(trigger.textContent).toContain("Graph");
  });

  it("labels the three primary sections as real tabs", () => {
    render(<WorkspaceTabs active="evidence" onChange={vi.fn()} variant="inline" />);
    for (const name of ["Overview", "Investigate", "Evidence"]) {
      expect(screen.getByRole("tab", { name: new RegExp(name) })).toBeTruthy();
    }
    expect(screen.getByRole("tab", { name: /Evidence/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: "More sections: Tools, Graph, Report" })).toBeTruthy();
  });

  it("opens a menu of radio items with the current section checked", async () => {
    const onChange = vi.fn();
    render(<WorkspaceTabs active="report" onChange={onChange} variant="inline" />);
    const trigger = screen.getByRole("button", { name: "More, current section: Report" });
    // Keyboard is the path under test: ArrowDown on the trigger opens the menu.
    trigger.focus();
    await act(async () => { fireEvent.keyDown(trigger, { key: "ArrowDown" }); });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const items = screen.getAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining("Tools"), expect.stringContaining("Graph"), expect.stringContaining("Report"),
    ]);
    expect(items[2].getAttribute("aria-checked")).toBe("true");
    await act(async () => { fireEvent.click(items[1]); });
    expect(onChange).toHaveBeenCalledWith("graph");
  });
});
