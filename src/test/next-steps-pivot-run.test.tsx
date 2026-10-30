// next-steps-pivot-run.test.tsx — what the analyst sees on the Next card while a
// pivot they started runs, and after it ends. See lib/pivot-runs.ts for why.
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { NextSteps } from "@/components/pivots/NextSteps";
import type { PivotRunView } from "@/lib/pivot-runs";
import type { Artifact } from "@/hooks/useThreadArtifacts";

afterEach(cleanup);

const row = (id: string): Artifact =>
  ({ id, kind: "email", value: `${id}@x.test`, confidence: 50, source: null, created_at: "2026-10-26T14:17:00.000Z", metadata: null });

const view = (phase: PivotRunView["phase"], newRows: Artifact[]): PivotRunView => ({
  phase,
  newRows,
  run: { key: "email:person@example.test", target: "person@example.test", targetType: "email", action: "Investigate email", sentAt: "2026-10-26T14:16:00.000Z", anchorCreatedAt: null, origin: "manual" },
});

describe("the pivot this tab started", () => {
  it("reads Running, never offers to run it again, and counts rows so far", () => {
    render(<NextSteps items={[]} onRunPivot={vi.fn()} onRunAction={vi.fn()} runs={[view("running", [row("a")])]} />);
    const strip = screen.getByTestId("pivot-run");
    expect(strip.dataset.phase).toBe("running");
    expect(strip.textContent).toContain("Running");
    expect(strip.textContent).toContain("person@example.test");
    expect(strip.textContent).toContain("1 new record so far");
    // JSX text does not interpret \u escapes: this printed a literal "\u00b7" (#886).
    expect(strip.textContent).not.toContain("\\u00b7");
    expect(strip.textContent).toContain("Running \u00b7 Investigate email");
    expect(screen.queryByRole("button", { name: /Run now/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /View changes/ })).toBeNull();
  });

  it("reads Completed with an outcome worded as a window, and View changes opens the newest row", () => {
    const onViewChanges = vi.fn();
    render(
      <NextSteps items={[]} onRunPivot={vi.fn()} onRunAction={vi.fn()} runs={[view("done", [row("newest"), row("older")])]} onViewChanges={onViewChanges} />,
    );
    const strip = screen.getByTestId("pivot-run");
    expect(strip.textContent).toContain("Pivot completed");
    expect(strip.textContent).toContain("2 new records since it was sent");
    fireEvent.click(screen.getByRole("button", { name: /View changes/ }));
    expect(onViewChanges).toHaveBeenCalledWith("newest");
  });

  it("says so plainly when nothing new arrived, with no View changes", () => {
    render(<NextSteps items={[]} onRunPivot={vi.fn()} onRunAction={vi.fn()} runs={[view("done", [])]} onViewChanges={vi.fn()} />);
    expect(screen.getByTestId("pivot-run").textContent).toContain("No new records since it was sent");
    expect(screen.queryByRole("button", { name: /View changes/ })).toBeNull();
  });

  it("an ended run with no recorded tool call reads Run ended and says the outcome is unknown, never Pivot completed", () => {
    render(<NextSteps items={[]} onRunPivot={vi.fn()} onRunAction={vi.fn()} runs={[view("ended", [])]} onViewChanges={vi.fn()} />);
    const strip = screen.getByTestId("pivot-run");
    expect(strip.dataset.phase).toBe("ended");
    expect(strip.textContent).toContain("Run ended");
    expect(strip.textContent).not.toContain("Pivot completed");
    expect(strip.textContent).toContain("No tool call was recorded against this target. That is unknown, not a negative result.");
  });

  it("an ended run still reports its window count, as a window", () => {
    render(<NextSteps items={[]} onRunPivot={vi.fn()} onRunAction={vi.fn()} runs={[view("ended", [row("a"), row("b")])]} />);
    expect(screen.getByTestId("pivot-run").textContent).toContain("2 new records since it was sent");
  });

  it("renders nothing with no items and no runs", () => {
    const { container } = render(<NextSteps items={[]} onRunPivot={vi.fn()} onRunAction={vi.fn()} />);
    expect(container.innerHTML).toBe("");
  });
});
