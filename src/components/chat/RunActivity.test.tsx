import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RunActivity } from "./RunActivity";

describe("settled scan activity", () => {
  it("keeps recorded tool detail available behind one accessible disclosure", () => {
    render(<RunActivity calls={13} stages={4}><p>Recorded provider result</p></RunActivity>);
    const toggle = screen.getByRole("button", { name: /Run activity/ });
    const detail = screen.getByText("Recorded provider result");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(detail).not.toBeVisible();
    expect(screen.getByText("13 calls · 4 stages")).toBeVisible();
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(detail).toBeVisible();
    expect(detail.parentElement?.id).toBe(toggle.getAttribute("aria-controls"));
    fireEvent.click(toggle);
    expect(detail).not.toBeVisible();
  });
});
