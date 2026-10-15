import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTabs } from "./WorkspaceTabs";

afterEach(() => vi.unstubAllGlobals());

describe("workspace tab overflow", () => {
  it("exposes scroll controls only for hidden tabs without changing the active section", () => {
    let resized: (() => void) | undefined;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resized = callback; }
      observe() {}
      disconnect() {}
    });
    const onChange = vi.fn();
    render(<WorkspaceTabs active="chat" onChange={onChange} />);
    const strip = screen.getByRole("tablist").parentElement;
    if (!strip) throw new Error("Missing tab scroll container");
    const scrollBy = vi.fn();
    Object.defineProperties(strip, {
      clientWidth: { configurable: true, value: 400 },
      scrollWidth: { configurable: true, value: 700 },
      scrollLeft: { configurable: true, writable: true, value: 0 },
      scrollBy: { configurable: true, value: scrollBy },
    });
    act(() => resized?.());
    expect(screen.queryByRole("button", { name: "Scroll workspace tabs left" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Scroll workspace tabs right" }));
    expect(scrollBy).toHaveBeenCalledWith({ left: 240, behavior: "smooth" });
    expect(onChange).not.toHaveBeenCalled();
    strip.scrollLeft = 300;
    fireEvent.scroll(strip);
    expect(screen.getByRole("button", { name: "Scroll workspace tabs left" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Scroll workspace tabs right" })).toBeNull();
  });
});
