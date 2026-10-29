import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useComposerFocus } from "@/hooks/useComposerFocus";

/**
 * The composer collapses when it loses focus. A blur caused by a click elsewhere
 * must not collapse it until that click has finished, or the layout shifts
 * between mousedown and mouseup and the click lands on the wrong element (the
 * 2026-10-26 "Open Next pivots" miss, see useComposerFocus).
 */
function Probe() {
  const { focused, onFocus, onBlur } = useComposerFocus();
  return (
    <div>
      <div data-testid="shell" data-focused={focused ? "1" : "0"} onFocus={onFocus} onBlur={onBlur}>
        <textarea aria-label="box" />
        <button type="button">Continue</button>
      </div>
      <button type="button">Outside</button>
    </div>
  );
}

const shellFocused = () => screen.getByTestId("shell").getAttribute("data-focused");

describe("useComposerFocus — blur deferred until the click in flight completes", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("a keyboard blur (no pointer down) collapses at once", () => {
    render(<Probe />);
    const box = screen.getByLabelText("box");
    act(() => { box.focus(); });
    expect(shellFocused()).toBe("1");
    act(() => { fireEvent.blur(box, { relatedTarget: screen.getByText("Outside") }); });
    expect(shellFocused()).toBe("0");
  });

  it("a pointer blur waits for pointerup, then one tick, before collapsing", () => {
    render(<Probe />);
    const box = screen.getByLabelText("box");
    const outside = screen.getByText("Outside");
    act(() => { box.focus(); });
    expect(shellFocused()).toBe("1");
    // mousedown on another element: pointer goes down, focus moves, blur fires.
    act(() => { fireEvent.pointerDown(outside); });
    act(() => { fireEvent.blur(box, { relatedTarget: outside }); });
    expect(shellFocused()).toBe("1"); // still open while the pointer is down
    act(() => { fireEvent.pointerUp(outside); });
    expect(shellFocused()).toBe("1"); // the click dispatches in this task
    act(() => { vi.runAllTimers(); });
    expect(shellFocused()).toBe("0"); // collapses after it
  });

  it("focus returning inside the shell mid-click cancels the pending collapse", () => {
    render(<Probe />);
    const box = screen.getByLabelText("box");
    const cont = screen.getByText("Continue");
    act(() => { box.focus(); });
    act(() => { fireEvent.pointerDown(cont); });
    act(() => { fireEvent.blur(box, { relatedTarget: null }); });
    act(() => { fireEvent.focus(cont); });
    act(() => { fireEvent.pointerUp(cont); });
    act(() => { vi.runAllTimers(); });
    expect(shellFocused()).toBe("1");
  });

  it("a blur whose relatedTarget stays inside the shell never collapses it", () => {
    render(<Probe />);
    const box = screen.getByLabelText("box");
    act(() => { box.focus(); });
    act(() => { fireEvent.blur(box, { relatedTarget: screen.getByText("Continue") }); });
    expect(shellFocused()).toBe("1");
  });
});
