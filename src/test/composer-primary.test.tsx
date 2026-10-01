import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { composerPrimary } from "@/lib/composer-primary";
import { RunChips, RunMenu } from "@/components/pivots/RunControls";

const base = {
  isLoading: false, stopping: false, isFollowUp: true, canContinue: true,
  empty: true, canSubmit: false, uploading: false,
};

describe("composerPrimary — one primary action that says what it does", () => {
  it("a live run is always Stop", () => {
    expect(composerPrimary({ ...base, isLoading: true })).toEqual({ kind: "stop", stopping: false });
    expect(composerPrimary({ ...base, isLoading: true, stopping: true })).toEqual({ kind: "stop", stopping: true });
  });

  it("no case yet is Start investigation, gated on the preflight", () => {
    expect(composerPrimary({ ...base, isFollowUp: false })).toEqual({ kind: "start", disabled: true });
    expect(composerPrimary({ ...base, isFollowUp: false, empty: false, canSubmit: true })).toEqual({ kind: "start", disabled: false });
  });

  it("an open case with an empty box is Continue — when a cycle may run", () => {
    expect(composerPrimary(base)).toEqual({ kind: "continue" });
    // No cycle may start (e.g. a live error): the empty box is a disabled Send, never Continue.
    expect(composerPrimary({ ...base, canContinue: false })).toEqual({ kind: "send", disabled: true });
  });

  it("typing on an open case turns it into Send, gated on the preflight and uploads", () => {
    expect(composerPrimary({ ...base, empty: false, canSubmit: true })).toEqual({ kind: "send", disabled: false });
    expect(composerPrimary({ ...base, empty: false, canSubmit: true, uploading: true })).toEqual({ kind: "send", disabled: true });
    expect(composerPrimary({ ...base, empty: false, canSubmit: false })).toEqual({ kind: "send", disabled: true });
  });
});

describe("run actions inside the composer", () => {
  const props = { busy: false, autoRunEnabled: false, autoRunCyclesRun: 0, onToggleAutoRun: vi.fn(), onWriteReport: vi.fn() };

  it("desktop chips: Auto-run is a switch, Write report a button, and there is no Continue", () => {
    const onToggle = vi.fn(); const onReport = vi.fn();
    render(<RunChips {...props} onToggleAutoRun={onToggle} onWriteReport={onReport} />);
    const sw = screen.getByRole("switch", { name: /Auto-run/ });
    expect(sw.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(sw);
    expect(onToggle).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: /Write report/ }));
    expect(onReport).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: /Continue/ })).toBeNull();
  });

  it("while a run is live, Write report is disabled but Auto-run can still be turned OFF", () => {
    render(<RunChips {...props} busy autoRunEnabled autoRunCyclesRun={1} />);
    expect((screen.getByRole("button", { name: /Write report/ }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("switch", { name: /Auto-run/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("phone menu trigger is named, and says when Auto-run is on", () => {
    const { rerender } = render(<RunMenu {...props} />);
    expect(screen.getByRole("button", { name: "Run options" })).toBeTruthy();
    rerender(<RunMenu {...props} autoRunEnabled autoRunCyclesRun={2} />);
    expect(screen.getByRole("button", { name: "Run options, Auto-run on (2 of 3)" })).toBeTruthy();
  });
});
