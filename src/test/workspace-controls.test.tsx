import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RecoveryBanner } from "@/components/workspace/RecoveryBanner";
import { NextSteps, type NextStepItem } from "@/components/pivots/NextSteps";
import { WorkspaceTabs } from "@/components/workspace/WorkspaceTabs";
import { CASE_VIEW_SECTIONS } from "@/lib/workspace-sections";
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
  it("keeps a malformed pivot OFF the list, disclosed behind one line, with no Run control", () => {
    render(
      <NextSteps
        items={itemsFor([{ ...validInput, action: "Review lead", target: "| Review lead | Keith family | name |", targetType: "name" }])}
        onRunPivot={vi.fn()}
        onRunAction={vi.fn()}
      />,
    );
    expect(screen.queryByText("Suggestion needs repair")).toBeNull();
    const disclosure = screen.getByRole("button", { name: /1 suggestion from the report couldn't be turned into a runnable step/ });
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(disclosure);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Suggestion needs repair")).toBeTruthy();
    expect(screen.getByText(/table cell/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Run/ })).toBeNull();
  });

  it("counts and lists only runnable steps; the repair line sits below them", () => {
    render(
      <NextSteps
        items={itemsFor([
          { ...validInput, action: "Review lead", target: "| Review lead | Keith family | name |", targetType: "name" },
          validInput,
        ])}
        onRunPivot={vi.fn()}
        onRunAction={vi.fn()}
      />,
    );
    const section = screen.getByRole("region", { name: "Next steps" });
    expect(section.querySelector("header")?.textContent).toMatch(/Next steps\s*1$/);
    expect(screen.getByRole("button", { name: "Review and run: Verify email ownership on j@example.com" })).toBeTruthy();
    const run = screen.getByRole("button", { name: /^Review and run/ });
    const disclosure = screen.getByRole("button", { name: /couldn't be turned into/ });
    expect(run.compareDocumentPosition(disclosure) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("the best pivot opens its review first, and Start dispatches exactly once", () => {
    const onRunPivot = vi.fn();
    render(<NextSteps items={itemsFor([validInput])} onRunPivot={onRunPivot} onRunAction={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Review and run: Verify email ownership on j@example.com" }));
    expect(onRunPivot).not.toHaveBeenCalled();
    expect(screen.getByText("Before this pivot runs")).toBeTruthy();
    expect(screen.getByText(/Unavailable — the backend does not publish per-pivot estimates/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start this pivot" }));
    expect(onRunPivot).toHaveBeenCalledTimes(1);
    expect(onRunPivot.mock.calls[0][0]).toMatchObject({ target: "j@example.com", targetType: "email" });
  });

  it("the best pivot has no one-click run: its only action opens the review and dispatches nothing", () => {
    const onRunPivot = vi.fn();
    render(<NextSteps items={itemsFor([validInput])} onRunPivot={onRunPivot} onRunAction={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /^Run now/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review and run: Verify email ownership on j@example.com" }));
    expect(onRunPivot).not.toHaveBeenCalled();
    expect(screen.getByText("Before this pivot runs")).toBeTruthy();
  });

  it("a searched pivot also opens its review first; it never offers Run now", () => {
    const onRunPivot = vi.fn();
    render(<NextSteps items={itemsFor([{ ...validInput, status: "searched" }])} onRunPivot={onRunPivot} onRunAction={vi.fn()} />);
    expect(screen.queryByRole("button", { name: /^Run now/ })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review and run: Verify email ownership on j@example.com" }));
    expect(onRunPivot).not.toHaveBeenCalled();
    expect(screen.getByText("Before this pivot runs")).toBeTruthy();
  });

  it("only the best pivot is the hero; the rest queue, and three show before a fold", () => {
    const mk = (n: number) => ({ ...validInput, id: `email:p${n}@example.com:a${n}`, target: `p${n}@example.com`, action: `Check ${n}` });
    render(<NextSteps items={itemsFor([mk(1), mk(2), mk(3), mk(4), mk(5)])} onRunPivot={vi.fn()} onRunAction={vi.fn()} />);
    expect(screen.getAllByTestId("best-pivot")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Review and run: Check 1 on p1@example.com" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run Check 4 on p4@example.com" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Run Check 5 on p5@example.com" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /1 more step/ }));
    expect(screen.getByRole("button", { name: "Run Check 5 on p5@example.com" })).toBeTruthy();
  });

  it("names what the agent has connected, and counts withheld rows without calling them links", () => {
    const onOpenGraph = vi.fn();
    render(
      <NextSteps
        items={itemsFor([validInput])}
        onRunPivot={vi.fn()}
        onRunAction={vi.fn()}
        connections={{ entities: 9, clusters: 2, links: 3, bridges: 1, unlinked: 4, withheld: 3 }}
        onOpenGraph={onOpenGraph}
      />,
    );
    const line = screen.getByTestId("connection-line");
    expect(line.textContent).toMatch(/9 entities, 3 shared links, 2 clusters, 4 tied to the seed only by discovery/);
    expect(line.textContent).toMatch(/3 withheld as unproven, not counted/);
    fireEvent.click(screen.getByRole("button", { name: "Open graph" }));
    expect(onOpenGraph).toHaveBeenCalled();
  });

  it("a searched target needs an explicit rerun confirmation", () => {
    const onRunPivot = vi.fn();
    render(<NextSteps items={itemsFor([{ ...validInput, status: "searched" }])} onRunPivot={onRunPivot} onRunAction={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /^Review and run: Verify email ownership/ }));
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

  it("labels the three primary sections as real tabs — Report is one tap away", () => {
    render(<WorkspaceTabs active="evidence" onChange={vi.fn()} variant="inline" />);
    for (const name of ["Investigate", "Evidence", "Report"]) {
      expect(screen.getByRole("tab", { name: new RegExp(name) })).toBeTruthy();
    }
    expect(screen.queryByRole("tab", { name: /Overview/ })).toBeNull();
    expect(screen.getByRole("tab", { name: /Evidence/ }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("button", { name: "More sections: Overview, Tools, Graph" })).toBeTruthy();
  });

  it("pads the bar by the bottom safe-area inset", () => {
    render(<WorkspaceTabs active="chat" onChange={vi.fn()} variant="inline" />);
    const nav = screen.getByRole("navigation", { name: "Workspace sections" });
    expect(nav.className).toContain("pb-[env(safe-area-inset-bottom)]");
  });

  it("opens a menu of radio items with the current section checked", async () => {
    const onChange = vi.fn();
    render(<WorkspaceTabs active="tools" onChange={onChange} variant="inline" />);
    const trigger = screen.getByRole("button", { name: "More, current section: Tools" });
    // Keyboard is the path under test: ArrowDown on the trigger opens the menu.
    trigger.focus();
    await act(async () => { fireEvent.keyDown(trigger, { key: "ArrowDown" }); });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const items = screen.getAllByRole("menuitemradio");
    expect(items.map((i) => i.textContent)).toEqual([
      expect.stringContaining("Overview"), expect.stringContaining("Tools"), expect.stringContaining("Graph"),
    ]);
    expect(items[1].getAttribute("aria-checked")).toBe("true");
    await act(async () => { fireEvent.click(items[2]); });
    expect(onChange).toHaveBeenCalledWith("graph");
  });
});

// ── Case viewer: the same component, narrowed by `sections` ────────────────
describe("WorkspaceTabs (case viewer sections)", () => {
  it("renders only the viewer's four sections, in order, under its own name", () => {
    render(<WorkspaceTabs active="report" onChange={vi.fn()} sections={CASE_VIEW_SECTIONS} label="Case views" />);
    const list = screen.getByRole("tablist", { name: "Case views" });
    expect(Array.from(list.querySelectorAll('[role="tab"]')).map((t) => t.textContent?.trim())).toEqual([
      "Report", "Evidence", "Tools", "Graph",
    ]);
    expect(screen.queryByRole("tab", { name: /Investigate|Overview/ })).toBeNull();
  });

  it("keeps roving arrow-key navigation inside the subset", () => {
    const onChange = vi.fn();
    render(<WorkspaceTabs active="graph" onChange={onChange} sections={CASE_VIEW_SECTIONS} label="Case views" />);
    fireEvent.keyDown(screen.getByRole("tab", { name: /Graph/ }), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("report");
  });

  it("on a phone puts Evidence and Report in the bar and Tools and Graph behind More", () => {
    render(<WorkspaceTabs active="report" onChange={vi.fn()} sections={CASE_VIEW_SECTIONS} label="Case views" variant="inline" />);
    expect(screen.getAllByRole("tab").map((t) => t.textContent?.trim())).toEqual(["Report", "Evidence"]);
    expect(screen.getByRole("button", { name: "More sections: Tools, Graph" })).toBeTruthy();
  });
});
