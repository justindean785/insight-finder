import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { LongProse, LONG_PROSE_CLAMP_PX } from "@/components/chat/LongProse";

// jsdom lays nothing out, so give every element a tall scrollHeight.
const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollHeight", { configurable: true, get: () => LONG_PROSE_CLAMP_PX * 4 });
});
afterEach(() => {
  if (original) Object.defineProperty(HTMLElement.prototype, "scrollHeight", original);
});

const body = () => document.querySelector("[data-long-prose]") as HTMLElement;

describe("LongProse", () => {
  it("clamps a long finished message and expands on the toggle", () => {
    render(<LongProse><p>long report</p></LongProse>);
    expect(body().dataset.longProse).toBe("clamped");
    fireEvent.click(screen.getByRole("button", { name: /Show the full message/ }));
    expect(body().dataset.longProse).toBe("expanded");
  });

  it("never clamps a streaming message", () => {
    render(<LongProse disabled><p>live</p></LongProse>);
    expect(body()?.dataset.longProse).toBeUndefined();
    expect(screen.queryByRole("button")).toBeNull();
  });

  // Codex review, PR #992: a link below the cutoff stays in the tab order, so
  // keyboard focus must not land inside masked, clipped content.
  it("expands when keyboard focus enters the clamped body", () => {
    render(<LongProse><p><a href="https://example.com/source">a source link</a></p></LongProse>);
    expect(body().dataset.longProse).toBe("clamped");
    fireEvent.focus(screen.getByRole("link", { name: "a source link" }));
    expect(body().dataset.longProse).toBe("expanded");
  });
});
